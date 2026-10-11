/**
 * 分批评析 · 批次切分
 *
 * 为什么需要：原来整本书一次性送进 Step 1/2，长篇（>30 章）有两个后果 ——
 *   ① 单批文本量远超上下文，抽取质量断崖下降；
 *   ② 中途一次失败，前面所有抽取结果全废（没有任何落盘）。
 *
 * 现在把切好章的小说按「每 N 章或每 M 字」切批（先到者为准），
 * 逐批执行逐批落盘，任何一批失败都不影响已完成的批次。
 *
 * 设计上有三个刻意的取舍：
 *   1. **章节不可拆分**。批次边界永远落在章与章之间 —— 一章被劈成两半，
 *      Step 2 会从一个句子中间开始读，事件抽取必然出错。
 *      单章超过字数上限时它**独占一批**并记 warning，而不是硬切。
 *   2. **chapter.title 保持原样**。批内不做任何重命名，因为
 *      `solveTimeline` 靠 `chunks.map(c => c.title)` 把提及映射回章序，
 *      全局归并时也要靠这个标题对齐时间线。改名会让整条时间线错位。
 *   3. **token 只在批次层面估算**（不按单章），用于给用户看"每批多大"。
 */
import { estimateTokens } from './utils.js';

/** 默认批大小：10 章 / 3 万字，先到者为准 */
export const DEFAULT_BATCH = {
  /** 每批最多多少章 */
  chapters: 10,
  /** 每批最多多少字（按 UTF-16 长度计，与 chunkText 一致） */
  chars: 30000,
};

/**
 * 把章节切成批次。
 *
 * @param {Array<{index:number, title:string, text:string}>} chapters 切好章的小说（chunkText 的产出）
 * @param {{chapters?:number, chars?:number}} [opts]
 * @returns {{
 *   batches: Array<{index:number, chapters:Array, chars:number, tokens:number,
 *                   firstTitle:string, lastTitle:string, oversized:boolean}>,
 *   warnings: string[],
 *   totalChapters: number,
 *   totalChars: number,
 *   totalTokens: number,
 * }}
 */
export function splitIntoBatches(chapters, opts = {}) {
  const list = Array.isArray(chapters) ? chapters.filter(c => c && typeof c.text === 'string') : [];
  const maxChapters = Math.max(1, Number(opts.chapters) || DEFAULT_BATCH.chapters);
  const maxChars = Math.max(1, Number(opts.chars) || DEFAULT_BATCH.chars);

  const batches = [];
  const warnings = [];
  let cur = [];
  let curChars = 0;

  const flush = () => {
    if (!cur.length) return;
    batches.push(makeBatch(batches.length, cur));
    cur = [];
    curChars = 0;
  };

  for (const c of list) {
    const len = c.text.length;

    // 单章超上限：先收尾当前批，再让它独占一批。
    // 不硬切是因为切开会破坏句意边界，抽取质量反而比"一批大一点"更差；
    // 但必须独占 —— 否则这一批会变成"上限 + 这一章"，既撑爆上下文，
    // 又让后面所有批次的 token 估算失真。
    if (len > maxChars) {
      flush();
      warnings.push(`「${c.title}」单章 ${len} 字，超过每批上限 ${maxChars} 字，已独占一批`);
      batches.push(makeBatch(batches.length, [c], true));
      continue;
    }

    // 加上这一章会超限 → 先把当前批收尾（章数或字数任一先到都切）
    if (cur.length && (cur.length >= maxChapters || curChars + len > maxChars)) flush();

    cur.push(c);
    curChars += len;

    if (cur.length >= maxChapters) flush();
  }
  flush();

  const totalChars = list.reduce((s, c) => s + c.text.length, 0);
  return {
    batches,
    warnings,
    totalChapters: list.length,
    totalChars,
    // 批次 token 之和 ≈ 全文 token：批次之间不重叠、也不留空隙
    totalTokens: batches.reduce((s, b) => s + b.tokens, 0),
  };
}

function makeBatch(index, chapters, oversized = false) {
  const chars = chapters.reduce((s, c) => s + c.text.length, 0);
  return {
    index,
    chapters: chapters.map(c => ({ ...c })),
    chars,
    tokens: estimateTokens(chapters.map(c => c.text).join('')),
    firstTitle: chapters[0]?.title || '',
    lastTitle: chapters[chapters.length - 1]?.title || '',
    oversized,
  };
}

/**
 * 批次摘要（**确定性**，不调用 LLM）。
 *
 * 这是"摘要链断裂"的兜底：无论 LLM 摘要成功与否，这个摘要一定能算出来，
 * 因为它的输入就是前面批次已经落盘的抽取结果。
 *
 * 它的作用不是"讲故事"，而是给后面的批次三样容易搞错的东西：
 *   ① 已经出场的人物名与别名 —— 后面的批次若把同一个人换个名字再抽一遍，
 *      全局归并就得靠猜；先把名字喂过去能大幅减少这种情况；
 *   ② 已经抽到的事件名 —— 同上，避免同一事件被反复抽出不同名字；
 *   ③ 时间线已经推进到哪里 —— 让后面的批次知道"现在处于哪个阶段"。
 *
 * @param {{mentions?:Array, events?:Array, roster?:Array, worldbook?:Array, phase?:string}} input
 * @param {{maxNames?:number, maxEvents?:number}} [opts]
 */
export function buildDigest(input = {}, opts = {}) {
  const maxNames = Math.max(1, Number(opts.maxNames) || 40);
  const maxEvents = Math.max(1, Number(opts.maxEvents) || 40);

  const chapters = (input.mentions || []).map(m => m.chapter).filter(Boolean);
  const events = (input.events || []).map(e => e?.name).filter(Boolean);
  const names = [];
  for (const r of input.roster || []) {
    const n = String(r?.name || '').trim();
    if (!n) continue;
    const aliases = (Array.isArray(r?.aliases) ? r.aliases : []).map(a => String(a || '').trim()).filter(Boolean);
    names.push(aliases.length ? `${n}（${aliases.join('、')}）` : n);
  }

  return {
    chapters,
    characters: names.slice(0, maxNames),
    // 截断时也要让调用方知道被截了 —— 否则会以为"就这么几个"
    charactersTruncated: Math.max(0, names.length - maxNames),
    events: events.slice(0, maxEvents),
    eventsTruncated: Math.max(0, events.length - maxEvents),
    worldbook: (input.worldbook || []).map(w => String(w?.name || '').trim()).filter(Boolean).slice(0, maxNames),
    phase: input.phase || null,
  };
}

/** 把上一批的 digest 渲染成塞进 prompt 的文本块；没有内容时返回空串 */
export function formatDigest(digest) {
  if (!digest) return '';
  const lines = [];
  if (digest.summary) lines.push(`【前情摘要】\n${String(digest.summary).trim()}`);
  if (digest.characters?.length) {
    lines.push(`【已出场人物】\n${digest.characters.join('、')}`
      + (digest.charactersTruncated ? `…等 ${digest.characters.length + digest.charactersTruncated} 人` : '')
      + '\n（若本批出现的是其中某人的另一个称呼，请沿用上面已有的名字，不要另起新名）');
  }
  if (digest.events?.length) {
    lines.push(`【已抽取事件】\n${digest.events.join('、')}`
      + (digest.eventsTruncated ? `…等 ${digest.events.length + digest.eventsTruncated} 个` : '')
      + '\n（本批若延续其中某个事件，请沿用同名，不要另起新名）');
  }
  if (digest.phase) lines.push(`【当前阶段】${digest.phase}`);
  return lines.length ? `\n\n——— 前文上下文 ———\n${lines.join('\n\n')}\n——— 上下文结束 ———` : '';
}

/**
 * 跨批累积上下文。
 *
 * 这是一个**只增不减**的累积器：每批结束后把该批的人物/事件并进来，
 * 下一批开始前把累积结果格式化进 prompt。所以第 N 批能看到前 N-1 批的全部名字，
 * 而不只是紧邻的上一批 —— 长篇里人物可能隔十几章再出场。
 */
export function createContextChain() {
  const roster = [];
  const events = [];
  const seenNames = new Set();
  const seenEvents = new Set();
  let summary = '';
  let phase = null;

  return {
    /** 并入一批的抽取结果 + 该批的 LLM 摘要（摘要有就覆盖，没有就沿用旧的） */
    add({ roster: r = [], events: e = [], summary: s = '', phase: p = null } = {}) {
      for (const item of r) {
        const name = String(item?.name || '').trim();
        if (!name) continue;
        const key = name;
        if (seenNames.has(key)) continue;
        seenNames.add(key);
        roster.push(item);
      }
      for (const item of e) {
        const name = String(item?.name || '').trim();
        if (!name || seenEvents.has(name)) continue;
        seenEvents.add(name);
        events.push(item);
      }
      // 摘要链：拿到了就用最新的。拿不到（模型失败/关了摘要）就保留上一批的 ——
      // 这样即使中间某几批摘要失败，链条也不会突然断成空白。
      if (s && String(s).trim()) summary = String(s).trim();
      if (p) phase = p;
      return this;
    },
    /** 当前累积状态（确定性部分 + 摘要） */
    state() {
      return { roster, events, summary, phase };
    },
    /** 从落盘的累积状态恢复（断点续跑用） */
    restore(state) {
      if (!state) return this;
      for (const item of state.roster || []) {
        const name = String(item?.name || '').trim();
        if (!name || seenNames.has(name)) continue;
        seenNames.add(name);
        roster.push(item);
      }
      for (const item of state.events || []) {
        const name = String(item?.name || '').trim();
        if (!name || seenEvents.has(name)) continue;
        seenEvents.add(name);
        events.push(item);
      }
      if (state.summary) summary = String(state.summary);
      if (state.phase) phase = state.phase;
      return this;
    },
    /** 直接给出可塞进 prompt 的上下文块 */
    format(extra = {}) {
      const d = buildDigest({ roster, events, phase });
      return formatDigest({ ...d, ...extra, summary });
    },
    /** 已累积的人物 / 事件（供归并与统计使用） */
    get roster() { return roster; },
    get events() { return events; },
    get summary() { return summary; },
    get size() { return { characters: roster.length, events: events.length }; },
  };
}

/**
 * 批次统计信息，给 SSE 进度与前端展示用。
 * @param {Array} batches splitIntoBatches 的产出
 */
export function describeBatches(batches) {
  const list = Array.isArray(batches) ? batches : [];
  return {
    total: list.length,
    chapters: list.reduce((s, b) => s + b.chapters.length, 0),
    chars: list.reduce((s, b) => s + b.chars, 0),
    tokens: list.reduce((s, b) => s + b.tokens, 0),
    sizes: list.map(b => ({ index: b.index, chapters: b.chapters.length, chars: b.chars, tokens: b.tokens })),
  };
}
