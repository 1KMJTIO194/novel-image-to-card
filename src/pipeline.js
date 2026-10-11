/**
 * 生成主流程：小说文本 → SillyTavern 角色卡
 *
 * 产物：
 *   character_card.json  完整角色卡（chara_card_v3，一次导入即可用）
 *   worldbook.json       A 包世界书（保留）
 *   preset_fragment.json B 包预设片段（保留）
 *   以及 timeline / events / storylines / phases / variables / user_mode / meta
 *
 * 阶段：
 *   Step 0.5  user 角色定位
 *   Step 1    时间线（提及 → 原点 → 求解）
 *   Step 2    事件抽取 + 故事线归并
 *   Step 3    阶段划分
 *   Step 4    人设增量
 *   Step 5    世界观 + 人物档案
 *   Step 6    变量树构建
 *   Step 7    头像
 *   Step 8    组装与校验
 *   Step 8.5  角色卡字段 + 完整角色卡组装
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { makeLLM } from './llm.js';
import { chunkText, pMap, estimateTokens, generateUUID, varKey, asArray, pickArrayByKeys } from './utils.js';
import { describePreset } from './preset.js';
import { readNovelText } from './encoding.js';
import * as S from './steps.js';
import * as T from './templates.js';
import { generateStatusbar } from './step75_statusbar.js';
import { splitIntoBatches, createContextChain, describeBatches, DEFAULT_BATCH } from './batcher.js';
import { mergeBatches } from './merge_batches.js';
import { NPC_TIERS, TIER_RANK, TIER_THRESHOLDS, TIER_DETAIL, LEGACY_ROLE_MAP, normalizeTier } from './tiers.js';
import { resolveDateYears, formatDate, parseChainedTime, dateTriggerToken, compareDateParts } from './dates.js';

// 分层常量从 src/tiers.js 引入；这里再导出一次，方便老调用方与测试按原路径取用
export { NPC_TIERS, TIER_RANK, TIER_THRESHOLDS, LEGACY_ROLE_MAP, normalizeTier } from './tiers.js';

import {
  summarizeGenerate, renderSummaryMarkdown,
} from './summary.js';

const DEFAULT_LIMITS = { maxA: 2000, maxB: 3500 };

/**
 * A 包常驻条目的 token 预算 —— 与 DEFAULT_LIMITS.maxA 一致。
 *
 * 单独留个常量是因为 `validate()` 只用它发**警告**，而这里要做**实际裁剪**：
 * 常驻条目每轮都注入，超支不会被发现（只多一行日志），
 * 却会稳定吃掉上下文预算。实测一本 47.7k 字的小说把它顶到 3510 tok（超 75%）。
 */
const A_PACK_TOKEN_BUDGET = DEFAULT_LIMITS.maxA;
/**
 * 分批处理的中间产物目录名。
 * 放在 task 目录下（`output/<taskId>/batches/`），断点续跑就是靠扫描这个目录。
 */
const BATCH_DIR = 'batches';

/** 批次进度通过 SSE 之外还要让轮询能读到，所以单独记一个文件 */
const BATCH_STATE_FILE = 'batch_state.json';

/**
 * key 触发条目（人物 / 事件 / 世界观非永驻）的预算。
 *
 * 这些条目**只在相关内容出现时才注入**，不占常驻上下文，所以单条可以写得很详细；
 * 但用户可能在一轮里同时触发多条（5 个角色同场），所以要单独看"单轮注入峰值"。
 *
 * 单位是估算 token（estimateTokens）。
 */
const KEY_ENTRY_LIMITS = {
  /** 单条上限：允许 800-2000 token 的详细条目 */
  single: 2200,
  /** 单轮峰值：同时触发多条时的合计上限 */
  peak: 6000,
};

/**
 * @param {object} config
 * @param {string} config.outDir        本次任务的输出目录（绝对或相对路径）
 * @param {string} config.novelPath     小说文本路径
 * @param {string[]} [config.imagePaths] 图片路径，第一张作为头像
 * @param {string} config.baseUrl/apiKey/model
 * @param {'auto'|'protagonist'|'participant'|'observer'} [config.userMode]
 * @param {number} [config.concurrency] 并发数，默认 3
 * @param {number} [config.chunkMaxLen] 无章节标记时的分块长度，默认 6000
 * @param {number} [config.maxCharacters] 人物条目上限，默认 15
 * @param {number} [config.probeChars]  世界观/人物抽样字符数上限
 * @param {object} [config.limits]      token 上限 {maxA, maxB}
 * @param {number} [config.batchChapters] 每批最多章节数，默认 10
 * @param {number} [config.batchChars]    每批最多字数，默认 30000
 * @param {boolean} [config.batchSummaries] 每批生成 LLM 摘要传给下一批，默认 true
 * @param {boolean} [config.resumeBatches] 断点续跑：复用 batches/ 里已完成的批次，默认 true
 * @param {(event: string, data: any) => void} send 事件回调
 */
export async function runPipeline(config, send) {
  const t0 = Date.now();
  const llm = makeLLM(config, config.preset || null);
  const outDir = config.outDir;
  const taskId = path.basename(outDir);
  await mkdir(outDir, { recursive: true });

  const concurrency = Math.max(1, Number(config.concurrency) || 3);
  const maxCharacters = Math.max(1, Number(config.maxCharacters) || 15);
  const limits = { ...DEFAULT_LIMITS, ...(config.limits || {}) };
  const worldProbeChars = Number(config.worldProbeChars) || 15000;
  const charProbeChars = Number(config.charProbeChars) || 10000;
  const startedAt = new Date().toISOString();

  // 分批参数（10 章 / 3 万字，先到者为准；都可在设置里改）
  const batchOpts = {
    chapters: Math.max(1, Number(config.batchChapters) || DEFAULT_BATCH.chapters),
    chars: Math.max(1, Number(config.batchChars) || DEFAULT_BATCH.chars),
  };
  const batchSummaries = config.batchSummaries !== false;
  const resumeBatches = config.resumeBatches !== false;

  /**
   * 合并调用的开关（同一段正文只喂一次）。
   *
   * 动机（实测 30 章小说的字符账）：
   *   · 逐章：同一章正文为「时间提及」发一次、为「事件」再发一次 → 各 12.8% / 12.4%
   *   · 逐批：同一批正文为世界观/物品/人物名单/摘要各发一次 → 合计约 30%
   *   · 逐角色：同一份全文抽样为每个角色各发一份 → 15 个角色时占 30.4%
   *
   * 三个开关都能单独关闭，回退到原来的"按任务各发一次"路径。
   * 保留回退不是因为合并有已知缺陷，而是因为**合并后的质量只能在真实长篇上验证**，
   * 沙箱里的假 LLM 证明不了"一次抽 4 类"不比"分 4 次抽"差。
   * 真实使用中发现某一步质量下降时，可以只关那一个开关定位问题。
   */
  const mergeChapterCalls = config.mergeChapterCalls !== false;
  const mergeWorldCalls = config.mergeWorldCalls !== false;
  const mergeCharCalls = config.mergeCharCalls !== false;
  /** 人物档案批量：每批的角色数（1 = 回退到逐角色调用） */
  const charBatchSize = Math.max(1, Number(config.charBatchSize) || 6);
  /** 事件条目 + 剧情简介合并为一次调用 */
  const mergeSynopsisCalls = config.mergeSynopsisCalls !== false;

  const log = (step, msg) => {
    console.log(`[${step}] ${msg}`);
    send('progress', { step, msg, ts: Date.now() });
  };

  // 预设生效情况：进日志、进 meta，便于事后确认这次生成用了什么预设
  const presetDesc = describePreset(config.preset || null);
  if (presetDesc.active) {
    log('Init', `已应用预设「${presetDesc.name || '未命名'}」（${presetDesc.mode}）：${presetDesc.lines.length} 处后缀`);
    if (presetDesc.mode === 'replace') log('WARN', '预设为 replace 模式：原始抽取指令已被替换');
  } else {
    log('Init', '未使用预设，按内置 prompt 抽取');
  }

  /** 协作式取消：每个阶段开始前检查一次 */
  const checkAbort = () => {
    if (config.signal?.aborted) {
      const err = new Error('任务已被用户取消');
      err.name = 'AbortError';
      throw err;
    }
    // 暂停 = 在下一个检查点挂起。挂起期间用 setTimeout 轮询而不是事件，
    // 这样"暂停 → 用户关页面 → 关服务"时进程不会被一个永不 resolve 的 Promise 卡住。
    if (config.isPaused?.()) {
      send('paused', { at: new Date().toISOString() });
      return waitWhilePaused();
    }
  };

  /**
   * 挂起直到恢复。
   * 轮询间隔取 400ms：既不会让恢复有明显延迟，也不至于空转烧 CPU。
   */
  const waitWhilePaused = async () => {
    if (!config.isPaused?.()) return;
    log('Pause', '已暂停，等待恢复…');
    while (config.isPaused?.()) {
      if (config.signal?.aborted) {
        const err = new Error('任务已被用户取消');
        err.name = 'AbortError';
        throw err;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    log('Pause', '已恢复');
  };

  // ===== 读入（自动检测编码：GBK/Big5 等中文编码不再乱码）=====
  const decoded = await readNovelText(config.novelPath);
  const text = decoded.text;
  const encoding = {
    encoding: decoded.encoding,
    original: decoded.originalEncoding,
    confidence: decoded.confidence,
    source: decoded.source,
    bomStripped: decoded.bomStripped,
    transcoded: decoded.transcoded,
    bytes: decoded.bytes,
    warnings: decoded.warnings,
  };

  log('Init', `读入 ${text.length} 字（${decoded.bytes} 字节）`);
  if (decoded.source === 'detected') {
    log('Init', `检测到编码：${decoded.originalEncoding}（置信度 ${decoded.confidence.toFixed(2)}），已自动转码`);
  } else if (decoded.source === 'bom') {
    log('Init', `检测到 BOM：${decoded.originalEncoding}，已剥除 BOM`);
  } else if (decoded.source === 'fallback') {
    log('WARN', `未能识别编码，已按 UTF-8 读取（${decoded.originalEncoding}）`);
  }
  for (const w of decoded.warnings) log('WARN', w);
  if (decoded.bytes > 0 && text.length / decoded.bytes > 1.2) {
    // 单字节编码不会膨胀这么多，出现说明可能选错了编码
    log('WARN', `转码后文本量异常（${text.length} 字 / ${decoded.bytes} 字节），请确认原文编码`);
  }

  if (text.length < 500) throw new Error('文本少于 500 字，无法生成');

  const chunks = chunkText(text, {
    maxLen: Number(config.chunkMaxLen) || 6000,
    chapterRange: config.chapterRange,     // 空 / 'all' → 全部
  });
  log('Init', `切分为 ${chunks.length} 块`);
  {
    const selectedChars = chunks.reduce((s, c) => s + c.text.length, 0);
    if (config.chapterRange && config.chapterRange !== 'all') {
      log('Init', `章节范围「${config.chapterRange}」→ 选中 ${chunks.length} 块，共 ${selectedChars} 字`);
    }
  }
  if (chunks.length < 3) log('WARN', '章节数 < 3，阶段划分可能降级');

  // ===== Step 0.5 user 角色定位 =====
  checkAbort();
  log('Step 0.5', 'user 角色定位');
  let userMode;
  if (config.userMode && config.userMode !== 'auto') {
    userMode = { mode: config.userMode, autoDetected: false };
  } else {
    try {
      const probeText = chunks.slice(0, 3).map(c => c.text).join('\n\n').slice(0, 8000);
      const probe = await llm.chatJSON(S.STEP_0_5_PROBE, probeText, 'step0.5');
      userMode = probe.hasSingleProtagonist
        ? { mode: 'protagonist', protagonistName: probe.protagonistName, autoDetected: true, reason: probe.reason }
        : { mode: 'participant', autoDetected: true, userIdentity: '外来者', reason: probe.reason };
    } catch (e) {
      log('Step 0.5', `探测失败，默认 protagonist：${e.message}`);
      userMode = { mode: 'protagonist', autoDetected: true };
    }
  }
  log('Step 0.5', `模式：${userMode.mode}${userMode.protagonistName ? `（${userMode.protagonistName}）` : ''}`);

  // ===== 批次切分（Step 0 之后）=====
  // 切批必须在 Step 0.5 之后：Step 0.5 要看开头几章判断 user 角色，
  // 而且用户可能在暂停后续跑时改变 userMode —— 那时应该重跑 Step 0.5 而不是复用旧结论。
  checkAbort();
  const split = splitIntoBatches(chunks, batchOpts);
  const batchStats = describeBatches(split.batches);
  log('Step 1', `批次：${batchStats.total} 批（每批 ≤${batchOpts.chapters} 章 / ≤${batchOpts.chars} 字，`
    + `共 ${batchStats.chapters} 章 ${batchStats.chars} 字，约 ${batchStats.tokens} tok）`);
  for (const w of split.warnings) log('WARN', w);

  // ---------- 批次落盘 / 续跑 / 暂停 ----------
  const batchDir = path.join(outDir, BATCH_DIR);
  await mkdir(batchDir, { recursive: true });
  const batchFileOf = (i) => path.join(batchDir, `batch_${String(i).padStart(3, '0')}.json`);

  /**
   * 批次是否已完成。
   *
   * 判据不只是"文件存在"：批次内部的每个章节都要成功。
   * 只写了个空壳（比如写到一半被 kill）的文件会被判为未完成并重跑。
   * 章节级状态让"跑到第 7 章中断"这种情况只重跑第 7 章往上，而不是整批。
   */
  const isBatchDone = (rec) => {
    if (!rec || rec.complete !== true) return false;
    const done = new Set(rec.doneChapterTitles || []);
    return Array.isArray(rec.chapterTitles) && rec.chapterTitles.every(t => done.has(t));
  };

  const loadBatch = async (i) => {
    try {
      return JSON.parse(await readFile(batchFileOf(i), 'utf-8'));
    } catch {
      return null;
    }
  };

  const saveBatch = async (rec) => {
    await writeFile(batchFileOf(rec.index), JSON.stringify(rec, null, 2), 'utf-8');
  };

  /** 批次的进度概览：轮询与刷新页面后靠它恢复"批次 N / 总批数" */
  const writeBatchState = async (extra = {}) => {
    const state = {
      // extra 放前面：批处理参数是配置快照，不允许被调用方的临时字段覆盖
      ...extra,
      total: batchStats.total,
      sizes: batchStats.sizes,
      batchChapters: batchOpts.chapters,
      batchChars: batchOpts.chars,
      summaries: batchSummaries,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, BATCH_STATE_FILE), JSON.stringify(state, null, 2), 'utf-8').catch(() => {});
  };

  /**
   * 暂停检查点。
   *
   * 抛出的 'checkpoint' 事件会被 server.js 的 emit 转成 PausedError，
   * 于是这次生成干净地停在这里 —— 已完成的批次都已在盘上，续跑接着来。
   */
  const checkpoint = (phase, index) => {
    if (!config.isPaused?.()) return;
    send('checkpoint', {
      phase,
      batch: index + 1,
      total: batchStats.total,
      at: new Date().toISOString(),
    });
  };

  /**
   * 单批摘要（LLM）。失败返回空字符串，由上下文链沿用上一批的摘要兜底。
   *
   * ⚠️ **不要给这一步设小的 `maxTokens`。**
   * 原来这里写的是 `{ maxTokens: 800 }`，而推理模型（如 deepseek-flash）的
   * 思考也计入 completion 额度。实测：
   *
   *     finish_reason: "length"
   *     completion_tokens: 800
   *     completion_tokens_details: { reasoning_tokens: 800 }   ← 全用在思考
   *     content: ""                                            ← 正文一个字没写
   *
   * 于是 `JSON.parse('')` 必然抛错，批次摘要**每次都是空**，静默退回确定性摘要；
   * 同时白烧掉一次整批正文的输入（实测占全部输入的 11.8%）。
   * 多批长篇里还会失去"前情摘要"的传递，只剩人名/事件名。
   *
   * 现在不设上限，由模型自己收尾；prompt 里本来就要求"简短摘要"。
   */
  const summarizeBatch = async (batch, leads) => {
    if (!batchSummaries) return '';
    try {
      const body = batch.chapters.map(c => `${c.title}\n${c.text}`).join('\n\n').slice(0, batchOpts.chars);
      const r = await llm.chatJSON(S.STEP_BATCH_SUMMARY, `本批章节：\n\n${body}`, 'step-batch');
      const summary = String(r?.summary || '').trim();
      if (summary) {
        log('Step 1', `批次 ${batch.index + 1} 摘要：${summary.length} 字`
          + `${r?.phase ? `，阶段「${r.phase}」` : ''}`
          + `${leads?.length ? `，新人物 ${leads.length} 人` : ''}`);
      } else {
        log('WARN', `批次 ${batch.index + 1} 摘要为空，沿用上一批摘要`);
      }
      return summary;
    } catch (e) {
      // 摘要链断裂的兜底：上下文链里还有确定性摘要（人物名/事件名），不会变成空白
      log('WARN', `批次 ${batch.index + 1} 摘要生成失败（将用确定性摘要兜底）：${e.message}`);
      return '';
    }
  };

  // ---------- 逐批执行 Step 1 + Step 2 ----------
  const perBatch = [];
  const contextChain = createContextChain();
  let resumedCount = 0;
  const t1 = Date.now();

  for (let bi = 0; bi < split.batches.length; bi++) {
    checkAbort();
    checkpoint('before', bi);

    const batch = split.batches[bi];
    const titles = batch.chapters.map(c => c.title);

    // 已完成的批次：直接复用盘上的结果，一个 LLM 调用都不发
    if (resumeBatches) {
      const prev = await loadBatch(bi);
      if (isBatchDone(prev)) {
        resumedCount++;
        perBatch.push({
          index: bi,
          mentions: prev.mentions || [],
          events: prev.events || [],
          roster: prev.roster || [],
          worldbook: prev.worldbook || [],
          summary: prev.summary || '',
        });
        contextChain.add({
          roster: prev.roster || [],
          events: prev.events || [],
          summary: prev.summary || '',
          phase: prev.phase || null,
        });
        log('Step 1', `批次 ${bi + 1}/${batchStats.total}：已完成，跳过（复用 ${(prev.mentions || []).length} 条提及 / ${(prev.events || []).length} 个事件）`);
        await writeBatchState({ done: bi + 1, current: bi, resumed: true });
        continue;
      }
    }

    send('batch', {
      phase: 'start', index: bi, total: batchStats.total,
      chapters: batch.chapters.length, chars: batch.chars, tokens: batch.tokens,
      firstTitle: batch.firstTitle, lastTitle: batch.lastTitle,
    });
    log('Step 1', `批次 ${bi + 1}/${batchStats.total} 开始：${batch.chapters.length} 章 / ${batch.chars} 字`
      + `（${batch.firstTitle} … ${batch.lastTitle}）`);

    // 上一批（以及更早所有批）的上下文：人物名 + 事件名 + 摘要。
    // 这是"同一个人的不同称呼被不同批次抽出"的主要防线。
    const ctx = contextChain.format();

    // 续跑时这一批可能只完成了一部分章节 —— 逐章续
    const partial = resumeBatches ? await loadBatch(bi) : null;
    const doneTitles = new Set(partial?.doneChapterTitles || []);
    const mentionsByTitle = new Map((partial?.mentions || []).map(m => [m.chapter, m]));
    const eventsByTitle = new Map();
    for (const e of partial?.events || []) {
      const key = e.chapter || '';
      if (!eventsByTitle.has(key)) eventsByTitle.set(key, []);
      eventsByTitle.get(key).push(e);
    }
    const todo = batch.chapters.filter(c => !doneTitles.has(c.title));
    if (doneTitles.size) {
      log('Step 1', `批次 ${bi + 1}：${doneTitles.size} 章已完成，续跑剩余 ${todo.length} 章`);
    }

    // ---- 批内 Step 1：时间提及 ----
    if (mergeChapterCalls) {
      // ---- 合并路径：一章正文只发一次，一次拿回「时间提及 + 事件」 ----
      //
      // 两个任务本来就读同一章正文（`章节：标题 + 正文 + ctx`），拆成两次调用
      // 等于把同一章发两遍。合并后请求数减半、正文只发一遍。
      //
      // 拆回来时必须分别用 pickArrayByKeys 取各自那个键：
      // 用 asArray 的话它会按"第一个数组值"兜底，拿 mentions 时可能拿到 events。
      const raw = await pMap(todo, async (c) => {
        try {
          const r = await llm.chatJSON(
            // step 名传数组：这次调用同时承担 step1（时间线）与 step2（事件），
            // 两个 Step 上各自配置的预设后缀都要生效 —— 不能因为合并调用就静默丢掉一个。
            S.STEP_CHAPTER_EXTRACT, `章节：${c.title}\n\n${c.text}${ctx}`, ['step1', 'step2'],
          );
          return {
            chapter: c.title,
            mentions: pickArrayByKeys(r, ['mentions', 'timeline', '时间提及', '时间线']),
            events: pickArrayByKeys(r, ['events', 'event', '事件', '剧情事件']),
            ok: true,
          };
        } catch (e) {
          // 不允许静默吞错：日志 + SSE 都要有
          log('WARN', `章节抽取失败（${c.title}）：${e.message}`);
          return { chapter: c.title, mentions: [], events: [], error: e.message };
        }
      }, concurrency);
      for (const r of raw.filter(Boolean)) {
        mentionsByTitle.set(r.chapter, { chapter: r.chapter, mentions: r.mentions, error: r.error });
        eventsByTitle.set(r.chapter, r.events);
      }
      // 解析异常告警：两个键都空但请求成功，多半是模型没按对象形态返回
      const bothEmpty = raw.filter(r => r?.ok && !r.mentions.length && !r.events.length).length;
      if (bothEmpty === todo.length && todo.length > 0) {
        log('WARN', `批次 ${bi + 1} 全部 ${todo.length} 章都返回空的 mentions 与 events —— `
          + '可能是模型没按 {mentions, events} 对象形态输出；如持续出现请关闭「逐章合并」选项');
      }
    } else {
      // ---- 回退路径：原来的两次调用 ----
      const mRaw = await pMap(todo, async (c) => {
        try {
          const arr = asArray(await llm.chatJSON(
            S.STEP_1_MENTIONS, `章节：${c.title}\n\n${c.text}${ctx}`, 'step1',
          ));
          return { chapter: c.title, mentions: arr };
        } catch (e) {
          // 不允许静默吞错：日志 + SSE 都要有
          log('WARN', `Step 1 时间提及失败（${c.title}）：${e.message}`);
          return { chapter: c.title, mentions: [], error: e.message };
        }
      }, concurrency);
      for (const m of mRaw.filter(Boolean)) mentionsByTitle.set(m.chapter, m);

      // ---- 批内 Step 2：事件 ----
      //
      // ⚠️ 历史上这里出过"事件全空"事故：`Array.isArray(arr) ? arr : []` +
      // `catch { return [] }`，模型把数组包成 `{"events":[...]}` 时静默变空，
      // catch 又把真实错误吞掉，于是 0 事件 → 阶段/变量树/世界书事件条目/导演指令全部空转，
      // 而日志只有一行"0 事件"。现在用 asArray 归一化 + 非静默 catch。
      const eRaw = await pMap(todo, async (c) => {
        try {
          return { chapter: c.title, events: asArray(await llm.chatJSON(
            S.STEP_2_EVENTS, `章节：${c.title}\n\n${c.text}${ctx}`, 'step2',
          )) };
        } catch (e) {
          log('WARN', `Step 2 事件抽取失败（${c.title}）：${e.message}`);
          return { chapter: c.title, events: [], error: e.message };
        }
      }, concurrency);
      for (const r of eRaw.filter(Boolean)) eventsByTitle.set(r.chapter, r.events);
    }

    // ---- 批内 Step 5 之一：世界观 / 物品（按批取样，而不是只抽全文一次）----
    //
    // 每批都过一遍能保证**每一段**原文都被看过；全文分层采样在长篇上只覆盖 6-7 个窗口，
    // 后半本的部分设定会整体漏掉。批次结果最后由 merge_batches 合并去重。
    //
    // 合并调用（默认开）：世界观与物品**从来都是读同一段批正文**，分成两次调用
    // 等于把同一段文本发两遍。合并后一次返回 `{worldbook, items}`。
    const batchWorldProbe = batch.chapters.map(c => c.text).join('\n\n').slice(0, worldProbeChars);
    let batchWorld = [];
    if (mergeWorldCalls) {
      try {
        const r = await llm.chatJSON(S.STEP_5_WORLDBOOK_ITEMS, batchWorldProbe, 'step5');
        const world = normalizeWorldbookItems(pickArrayByKeys(r, ['worldbook', 'world', '世界观']));
        const items = normalizeWorldbookItems(pickArrayByKeys(r, ['items', 'item', '物品', '条目']));
        batchWorld = dedupeWorldbook([...world, ...items]);
        // 严格版抽取不够时走宽松版重试：只重试世界观那一半，
        // 因为"抽不到"通常是分类判断太严，不是原文没有设定。
        if (world.length < 2) {
          try {
            const r2 = await llm.chatJSON(S.STEP_5_WORLDBOOK_LOOSE, batchWorldProbe, 'step5');
            const retry = normalizeWorldbookItems(pickArrayByKeys(r2, ['worldbook', 'world', '世界观', 'items']));
            if (retry.length > world.length) batchWorld = dedupeWorldbook([...retry, ...items]);
          } catch { /* 宽松重试失败就保留原结果 */ }
        }
      } catch (e) {
        log('WARN', `批次 ${bi + 1} 世界观/物品合并抽取失败：${e.message}`);
      }
    } else {
      try {
        const r = await llm.chatJSON(S.STEP_5_WORLDBOOK, batchWorldProbe, 'step5');
        batchWorld = normalizeWorldbookItems(asArray(r));
        if (batchWorld.length < 2) {
          try {
            const r2 = await llm.chatJSON(S.STEP_5_WORLDBOOK_LOOSE, batchWorldProbe, 'step5');
            const retry = normalizeWorldbookItems(asArray(r2));
            if (retry.length > batchWorld.length) batchWorld = retry;
          } catch { /* 宽松重试失败就保留原结果 */ }
        }
      } catch (e) {
        log('WARN', `批次 ${bi + 1} 世界观抽取失败：${e.message}`);
      }
      try {
        const r = await llm.chatJSON(S.STEP_5_ITEM, batchWorldProbe, 'step5');
        const items = normalizeWorldbookItems(asArray(r));
        batchWorld = dedupeWorldbook([...batchWorld, ...items]);
      } catch (e) {
        log('WARN', `批次 ${bi + 1} 物品/技能抽取失败：${e.message}`);
      }
    }

    // ---- 批内 Step 5 之二：人物名单 ----
    // 名单是人物数据的**唯一入口**，所以每批都要抽，最后全局归并别名。
    // 直接用整批原文（而不是抽样）—— 批本身只有 3 万字，塞得下。
    let batchRoster = [];
    try {
      const raw = await llm.chatJSON(
        S.STEP_5_CHARACTER_LIST,
        `原文：\n${batchWorldProbe}${ctx}`,
        'step5',
      );
      const { roster: clean } = sanitizeRoster(raw, batch.chapters.map(c => c.text).join('\n\n'), { max: maxCharacters });
      batchRoster = clean;
    } catch (e) {
      log('WARN', `批次 ${bi + 1} 人物名单抽取失败：${e.message}`);
    }

    // 本批内的出场章节统计：喂给分层用，也随批次落盘，
    // 这样全局归并时不必重扫原文就能拿到"这人出现在多少章里"。
    if (batchRoster.length) {
      batchRoster = classifyByStoryShare(batchRoster, batch.chapters, {
        protagonistName: userMode.protagonistName || '',
      }).map(r => ({ ...r, role: r.tier }));
      log('Step 5', `批次 ${bi + 1} 名单分层：`
        + NPC_TIERS.map(t => {
          const g = batchRoster.filter(r => r.tier === t);
          return g.length ? `${t}×${g.length}` : null;
        }).filter(Boolean).join(' / '));
    }

    // ---- 汇总本批结果 ----
    const batchMentions = titles.map(t => mentionsByTitle.get(t)).filter(Boolean);
    const batchEvents = titles.flatMap(t => eventsByTitle.get(t) || []);
    const doneChapterTitles = titles.filter(t => mentionsByTitle.has(t) && eventsByTitle.has(t));

    // 摘要（在写入上下文链之前算，让链里存的是"截至本批"的最新摘要）
    const leads = batchRoster.filter(r => !contextChain.roster.some(x => x.name === r.name)).map(r => r.name);
    const summary = await summarizeBatch(batch, leads);
    const phase = null;

    contextChain.add({ roster: batchRoster, events: batchEvents, summary, phase });

    await saveBatch({
      index: bi,
      chapters: titles,
      chapterTitles: titles,
      doneChapterTitles,
      chars: batch.chars,
      tokens: batch.tokens,
      firstTitle: batch.firstTitle,
      lastTitle: batch.lastTitle,
      complete: doneChapterTitles.length === titles.length,
      mentions: batchMentions,
      events: batchEvents,
      roster: batchRoster,
      worldbook: batchWorld,
      summary,
      extractedAt: new Date().toISOString(),
    });

    perBatch.push({
      index: bi,
      mentions: batchMentions,
      events: batchEvents,
      roster: batchRoster,
      worldbook: batchWorld,
      summary,
    });

    send('batch', {
      phase: 'done', index: bi, total: batchStats.total,
      chapters: titles.length, chars: batch.chars,
      mentions: batchMentions.reduce((s, m) => s + (m.mentions?.length || 0), 0),
      events: batchEvents.length,
      characters: batchRoster.length,
      worldbook: batchWorld.length,
      summaryChars: summary.length,
      elapsedMs: Date.now() - t1,
    });
    log('Step 1', `批次 ${bi + 1}/${batchStats.total} 完成：`
      + `${batchMentions.reduce((s, m) => s + (m.mentions?.length || 0), 0)} 条提及 / `
      + `${batchEvents.length} 个事件 / ${batchRoster.length} 人 / ${batchWorld.length} 条世界观`
      + `${summary ? ` / 摘要 ${summary.length} 字` : ''}`);

    await writeBatchState({ done: bi + 1, current: bi + 1 });
    checkpoint('after', bi);
  }

  if (resumedCount) {
    log('Step 1', `续跑：复用 ${resumedCount}/${batchStats.total} 个已完成批次`);
  }
  if (!split.batches.length) throw new Error('批次切分结果为空，无法继续');
  // 全部批次到齐才写 finished —— 前端据此判断"这批任务能不能续跑"
  await writeBatchState({ done: batchStats.total, current: batchStats.total, finished: true, resumed: resumedCount });

  // ===== 全局归并（所有批次完成后）=====
  checkAbort();
  log('Step 2.5', '全局归并各批结果');
  const merged = mergeBatches({ perBatch, chapterTitles: chunks.map(c => c.title) });
  const mentions = merged.mentions;
  const events = merged.events;
  const storylines = groupByStoryline(events);
  log('Step 2.5', `归并：提及 ${merged.report.mentions.inputCount} 条 → `
    + `事件 ${merged.report.events.inputCount} → ${merged.report.events.outputCount}（去重 ${merged.report.events.dropped}）/ `
    + `人物 ${merged.report.roster.inputCount} → ${merged.report.roster.outputCount}`
    + `${merged.report.roster.merged.length ? `（合并 ${merged.report.roster.merged.length} 组）` : ''} / `
    + `世界观 ${merged.report.worldbook.inputCount} → ${merged.report.worldbook.outputCount}`);
  for (const m of merged.report.roster.merged) {
    log('Step 2.5', `人物归并：「${m.name}」⇐ ${m.from.join('、')}（批次 ${m.batches.join('/')}）`);
  }
  for (const n of merged.report.roster.suspicious) {
    log('WARN', `人物名疑似同一人的不同写法（未自动合并，请人工确认）：${n}`);
  }
  for (const n of merged.report.events.nearDuplicates) {
    log('WARN', `事件名高度相近（未自动合并）：${n}`);
  }
  if (merged.report.orphanChapters.length) {
    log('WARN', `有提及的章节号不在章节表里：${merged.report.orphanChapters.slice(0, 5).join('、')}`);
  }
  // 人物名单（全局）：Step 5 的人物档案按这份名单逐个生成
  const mergedRoster = merged.roster;

  // ===== Step 1（全局）时间线 =====
  // 原点识别与时间线求解必须**全局做一次**：
  // 分批各解一次的话，每批都会把自己的第一个事件当"开场"，
  // 拼起来的时间线整体错位，导演指令与「角色阶段」会指向错误的时间点。
  checkAbort();
  log('Step 1', '识别原点（全局）');
  let origin;
  try {
    origin = await llm.chatJSON(S.STEP_1_ORIGIN, JSON.stringify(mentions), 'step1');
  } catch {
    origin = { base: '相对纪元', origin: { raw: '开场', event: '开场', reason: 'fallback' } };
  }

  /**
   * 时间线由**剧情事件**构成（而不是"时间提及里的事件名"）。
   *
   * 见 solveTimeline 的 displayEvents 注释：抽取器把 `今天`／`第二天`／`四点了`
   * 标成 relative，旧实现按 `type === 'absolute'` 过滤，实测 74 条提及里只剩 1 条进时间线。
   *
   * ⚠️ 顺序：先解一次时间线拿到**时间提及**（回填需要它对照），
   * 用它回填事件的时间/日期，再解第二次让时间线**由事件构成**并带上日期。
   * 回填放在这里而不是 Step 8，就是为了让第二次解析拿到完整数据。
   */
  const timelineFromEvents = () => events.map(e => ({
    name: e.name,
    time: e.time || '',
    dateText: e.dateText || '',
    dateKey: e.dateKey || null,
    chapter: e.chapter || '',
    quote: e.quote || '',
    pressure: e.pressure || null,
  }));

  let timeline = solveTimeline(mentions, origin, chunks.map(c => c.title));
  {
    const bf = backfillEventTimes(events, timeline);
    if (bf.filled) log('Step 1', `事件时间回填 ${bf.filled}/${bf.total} 条`);
  }
  timeline = solveTimeline(mentions, origin, chunks.map(c => c.title), timelineFromEvents());
  log('Step 1', `时间线：${timeline.events.length} 事件 / ${timeline.characters.length} 人物`
    + (timeline.fromEvents ? '（取自剧情事件）' : '（退化自时间提及）'));
  if (timeline.relativeStats) {
    const { relative, vague, periodic } = timeline.relativeStats;
    const total = timeline._mentionTotal || 0;
    if (relative || vague || periodic) {
      log('Step 1', `另有 ${relative} 条相对时间、${vague} 条模糊时间、${periodic} 条周期时间未进时间线`
        + '（锚点多为「当前叙事」这类伪锚点，写进去只会是噪音）');
    }
    /**
     * 时间线稀疏的诊断：**按"有日期的条目数"判定**，不是按条目总数。
     *
     * 踩过的坑：一开始用 `timeline.events.length` 当判据，于是这次「15 个事件里
     * 只有 1 个拿到时间、其余全是（未定）」反而**没有告警** —— 条目总数看着不少。
     * 真正影响下游（按天打包、状态栏日期、阶段取文）的是**有多少条带上了日期**。
     *
     * 这种情况的实际原因是抽取器几乎没产出 `absolute` 提及 ——
     * 实测一篇小说 61 条提及里只有 3 条 absolute、且都挂在同一个事件名下。
     * 这是数据/模型口径问题、不是代码问题，但不说出来用户只会看到一堆「（未定）」。
     */
    const dated = timeline.events.filter(e => e?.dateKey || e?.date?.text || e?.time).length;
    if (total >= 20 && timeline.events.length > 0 && dated / timeline.events.length < 0.3) {
      log('WARN', `时间线偏稀疏：${timeline.events.length} 个事件里只有 ${dated} 个带上了时间`
        + `（${total} 条时间提及中可定位的时间点太少）。`
        + '通常是模型把时间都判成了"相对/模糊"（如「今天」「四点了」）——'
        + '可换更强的模型，或检查原文是否本来就缺少年月日');
    }
  }

  // ===== Step 2（全局）事件统计 =====
  log('Step 2', `${events.length} 事件 / ${Object.keys(storylines).length} 条线`);
  if (events.length === 0) {
    const failed = perBatch.filter(b => (b.events || []).length === 0).length;
    log('WARN', `Step 2 未抽到任何事件（${batchStats.total} 批${failed ? `，其中 ${failed} 批为空` : ''}）`
      + '：变量树将没有事件、导演指令与角色阶段会空转');
  }

  // ===== Step 3 阶段 =====
  checkAbort();
  log('Step 3', '阶段划分');
  let phases = [];
  if (events.length >= 3) {
    try {
      const r = await llm.chatJSON(
        S.STEP_3_PHASES,
        JSON.stringify(events.map(e => ({ name: e.name, canon: e.canon, pressure: e.pressure })), null, 2),
        'step3'
      );
      phases = asArray(r?.phases ?? r).filter(p =>
        events.some(e => e.name === p.startEvent) &&
        events.some(e => e.name === p.endEvent)
      );
    } catch (e) {
      log('Step 3', `阶段划分失败：${e.message}`);
    }
  }
  log('Step 3', `${phases.length} 个阶段`);

  // ===== Step 4 人设增量 =====
  checkAbort();
  log('Step 4', '人设增量');
  const phasesWithDeltas = await pMap(phases, async (phase, i) => {
    if (i === 0) return { ...phase, characterDeltas: [] };
    try {
      const phaseText = extractPhaseText(phase, events, chunks);
      const r = await llm.chatJSON(
        S.STEP_4_DELTAS,
        `阶段名：${phase.name}\n核心变化：${phase.coreChange}\n原文：\n${phaseText.slice(0, 8000)}`,
        'step4'
      );
      return { ...phase, characterDeltas: asArray(r?.deltas ?? r) };
    } catch (e) {
      log('WARN', `Step 4 人设增量失败（${phase.name}）：${e.message}`);
      return { ...phase, characterDeltas: [] };
    }
  }, Math.max(1, Math.min(concurrency, 2)), (d, t) => log('Step 4', `增量 ${d}/${t}`));
  log('Step 4', `${phasesWithDeltas.reduce((s, p) => s + (p.characterDeltas?.length || 0), 0)} 条增量`);

  // ===== Step 5 世界观 / 人物 =====
  checkAbort();
  log('Step 5', '探测作品热度');
  let popularity = { wellKnown: false };
  try {
    popularity = await llm.chatJSON(S.STEP_5_PROBE, text.slice(0, 2000), 'step5');
  } catch {}
  log('Step 5', popularity.wellKnown ? '判定为知名作品' : '判定为冷门/原创作品');

  // ---- 世界观：直接用各批归并结果 ----
  //
  // 以前这里是对全文做一次分层采样再抽（`sampleAcrossText` 只覆盖 6-7 个窗口），
  // 长篇的后半本有大量段落从未被看过。现在每批各自抽过一遍，这里只做归并 ——
  // 覆盖面从"6 个窗口"变成"每一段原文"。
  checkAbort();
  log('Step 5', '归并世界观条目');
  let worldbookItems = merged.worldbook;
  log('Step 5', `世界观 ${worldbookItems.length} 条`
    + `（各批合计 ${merged.report.worldbook.inputCount} 条，同名同分类去重 ${merged.report.worldbook.dropped} 条）`);
  /**
   * 处置明细日志：把"同名跨分类"和"超上限已并入"两类结构处理说清楚。
   *
   * 这两类都会让条目数减少，但**内容没丢**（超上限的是并入而不是丢弃）——
   * 不说明的话，看到"去重 N 条"会以为是内容丢失。
   */
  {
    const dd = merged.report.worldbook.crossCategoryDropped || [];
    const sameName = dd.filter(d => d.reason === 'same-name-other-category');
    const overCap = dd.filter(d => d.reason === 'over-cap-merged-into');
    if (sameName.length) {
      log('Step 5', `同名跨分类去重 ${sameName.length} 条（保留信息更全的那条）：`
        + sameName.slice(0, 5).map(d => `${d.name}(${d.category} ${d.chars}字)`).join('、'));
    }
    if (overCap.length) {
      const groups = {};
      for (const d of overCap) (groups[d.category] = groups[d.category] || []).push(d);
      for (const [cat, list] of Object.entries(groups)) {
        log('Step 5', `${cat} 超过分类上限：${list.length} 条已把独有内容并入 `
          + `${[...new Set(list.map(d => d.mergedInto))].join('、')}（内容不丢）`);
      }
    }
  }

  // 兜底：分批抽取全失败时，退回"全文分层采样 + 宽松 prompt"，至少给一条世界概览。
  // 没有世界观的卡没有任何世界锚点，模型只能靠人物和事件条目猜世界长什么样。
  if (!worldbookItems.length) {
    log('WARN', '各批都没抽到世界观条目，退回全文分层采样重试一次');
    try {
      const probeText = sampleAcrossText(text, worldProbeChars);
      const r = await llm.chatJSON(S.STEP_5_WORLDBOOK_LOOSE, probeText, 'step5');
      worldbookItems = normalizeWorldbookItems(asArray(r));
      log('Step 5', `全文采样兜底拿到 ${worldbookItems.length} 条`);
    } catch (e) {
      log('WARN', `世界观兜底抽取也失败：${e.message}`);
    }
  }

  // ---- 人物名单：用归并后的全局名单 ----
  //
  // 名单是人物数据的**唯一入口**。以前直接用 timeline.characters
  //（＝时间提及里 age 的主语），抽出来的"人名"全是「小女孩」「中年女人」这种描述词，
  // 连锁导致：keys 只能照抄 prompt 字段名、同一人被拆成多条、原文没有的角色被编出档案。
  //
  // 现在的名单来自各批的 STEP_5_CHARACTER_LIST 归并（别名合并 + 主名优选），
  // 比单次全文采样更全：长篇里后半本才出场的角色也能进名单。
  checkAbort();
  log('Step 5', '归并人物名单');
  let roster = mergedRoster;
  log('Step 5', `名单 ${roster.length} 人`
    + `（各批合计 ${merged.report.roster.inputCount} 条，合并 ${merged.report.roster.merged.length} 组）`);
  if (roster.length) {
    const aliasCount = roster.filter(r => (r.aliases || []).length).length;
    log('Step 5', `其中 ${aliasCount} 人有别名：`
      + roster.filter(r => (r.aliases || []).length).slice(0, 6)
        .map(r => `${r.name}(${r.aliases.join('/')})`).join('、'));
  }

  // 兜底：名单为空时，从时间线回收"人名形态"的候选。
  // 人物层全空的后果远比多一条脏条目严重（状态栏没有可互动角色、
  // 好感度变量没有对象、导演指令里的角色全失效），所以这里必须保底。
  if (!roster.length) {
    const salvage = [];
    for (const c of timeline.characters || []) {
      const n = String(c?.name || '').trim();
      if (!n || isDescriptorName(n) || looksLikeNonPerson(n) || KEY_STOPWORDS.has(n)) continue;
      if (!appearsInTextLoose(n, text)) continue;
      salvage.push({ name: n, aliases: [], role: '主要配角' });
    }
    // 主角优先
    if (userMode.protagonistName) {
      const p = String(userMode.protagonistName).trim();
      if (p && !salvage.some(s => s.name === p) && appearsInTextLoose(p, text)) {
        salvage.unshift({ name: p, aliases: [], role: '主角' });
      }
    }
    roster = salvage.slice(0, maxCharacters);
    if (roster.length) {
      log('WARN', `人物名单为空，已从时间线回收 ${roster.length} 个候选：${roster.map(r => r.name).join('、')}`);
    } else {
      log('WARN', '人物名单为空且无法回收 —— 这张卡不会有人物条目，请检查所选模型是否支持严格 JSON 输出');
    }
  }
  // 名单上限（各批各自按 maxCharacters 截过，归并后可能超出）
  //
  // 截断必须在**分层之后**做：分层按剧情占比，先把戏份少的切掉再分层，
  // 会让阈值失去意义（名单越短，占比越虚高）。所以这里先分层、再按层+占比截断。
  checkAbort();
  const classified = classifyByStoryShare(roster, chunks, {
    protagonistName: userMode.protagonistName || '',
  });
  log('Step 5', `按剧情占比分层（统计 ${chunks.length} 章）`);
  for (const t of NPC_TIERS) {
    const group = classified.filter(r => r.tier === t);
    if (!group.length) continue;
    log('Step 5', `  ${t} ${group.length} 人：`
      + group.slice(0, 8).map(r => `${r.name}(${r.storyChapters}章/${Math.round(r.storyRatio * 100)}%)`).join('、')
      + (group.length > 8 ? ` …等 ${group.length} 人` : ''));
  }
  // role 写回实测分层：它会被下游（世界书条目标注、诊断日志）读到，
  // 留着模型原来的提示值会让人误以为那是最终分层。
  roster = classified.map(r => ({ ...r, role: r.tier }));
  const tierMissing = roster.filter(r => r.tier === '路人NPC' && r.storyChapters === 0);
  if (tierMissing.length) {
    // 占比为 0 说明"名字在原文里一次都没匹配到" —— 可能是别名没覆盖原文写法
    log('WARN', `${tierMissing.length} 人在原文里一次都没匹配到（可能是别名没覆盖原文写法）：`
      + tierMissing.slice(0, 6).map(r => r.name).join('、'));
  }

  roster = [...roster].sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)
    || b.storyRatio - a.storyRatio
    || b.storyChapters - a.storyChapters);
  if (roster.length > maxCharacters) {
    log('Step 5', `名单 ${roster.length} 人超过上限 ${maxCharacters}，按「分层 → 剧情占比」截断`);
    roster = roster.slice(0, maxCharacters);
  }

  log('Step 5', '抽取人物档案');
  const probe = sampleAcrossText(text, charProbeChars);

  /** 把一条档案的结果补齐名单侧的权威字段（name/keys 以名单为准，不信模型改写） */
  const finalizeCharItem = (item, r) => {
    if (!item || typeof item !== 'object') return null;
    const content = pickContent(item);
    if (isPlaceholderBody(content)) {
      log('WARN', `人物「${r.name}」档案为空或占位，已跳过（返回键：${Object.keys(item).join('/')}）`);
      return null;
    }
    return {
      ...item,
      name: r.name,
      keys: [r.name, ...r.aliases],
      content,
      tier: r.tier,
      storyChapters: r.storyChapters,
      storyRatio: r.storyRatio,
    };
  };

  /** 单角色调用（回退路径，也是批量路径失败后的补救） */
  const fetchOneProfile = async (r) => {
    // 分层决定档案写多详细（TIER_DETAIL）：路人NPC 只要身份与出处，
    // 让模型把笔墨花在主要NPC 上 —— 一条 1500 字的路人档案既浪费 token
    // 又会在世界书里抢注意力。
    const detail = TIER_DETAIL[r.tier] || TIER_DETAIL['次要NPC'];
    const item = await llm.chatJSON(
      S.STEP_5_CHARACTER,
      `角色名：${r.name}\n`
      + `已知称呼：${[r.name, ...r.aliases].join('、')}\n`
      + `剧情分层：${detail.label}（出现在 ${r.storyChapters} 章，约全书 ${Math.round((r.storyRatio || 0) * 100)}%）\n`
      + `本档要求：${detail.fields}\n\n原文节选：\n${probe}`,
      'step5'
    );
    return finalizeCharItem(item, r);
  };

  /**
   * 一组（≤charBatchSize 个）角色共用同一份抽样，一次调用写完。
   *
   * 为什么按角色分批而不是每人一次：同一份 `probe` 原本要发 N 遍。
   * 实测 15 个角色、每次约 11,255 字符里约 10,042 是那份抽样 ——
   * 这一项能占整个输入 30% 左右，是整条链路里最大的一块。
   * 抽出来只发一次，N 个角色省掉 N-1 份。
   */
  const fetchProfileGroup = async (group) => {
    const lines = group.map(r => {
      const detail = TIER_DETAIL[r.tier] || TIER_DETAIL['次要NPC'];
      return `- ${r.name}｜已知称呼：${[r.name, ...r.aliases].join('、')}`
        + `｜剧情分层：${detail.label}（出现在 ${r.storyChapters} 章，约全书 ${Math.round((r.storyRatio || 0) * 100)}%）`
        + `｜本档要求：${detail.fields}`;
    }).join('\n');
    const raw = await llm.chatJSON(
      S.STEP_5_CHARACTER_BATCH,
      `角色清单（共 ${group.length} 个，每个都要写）：\n${lines}\n\n原文节选：\n${probe}`,
      'step5'
    );
    // 只认 profiles 键，绝不猜 —— 拿到别的数组会把人物档案写成事件或世界观
    const list = pickArrayByKeys(raw, ['profiles', 'characters', '人物', '档案']);
    const byName = new Map();
    for (const p of list) {
      const n = String(p?.name || '').trim();
      if (n) byName.set(varKey(n), p);
    }
    // 按名单顺序回填：模型可能改序、漏项、或把名字写错（加后缀）
    return group.map(r => {
      const hit = byName.get(varKey(r.name));
      if (!hit) {
        log('WARN', `批量档案里缺「${r.name}」（模型返回 ${list.length} 份），将单独补抽`);
        return { roster: r, item: null, missing: true };
      }
      return { roster: r, item: finalizeCharItem(hit, r), missing: false };
    });
  };

  /** 单角色失败不让整组失败：批量拿不到的/拿成占位的，逐个补抽 */
  const recoverOne = async (r) => {
    try {
      return await fetchOneProfile(r);
    } catch (e) {
      log('WARN', `人物「${r.name}」档案生成失败：${e.message}`);
      return null;
    }
  };

  const charItems = (await (async () => {
    if (!mergeCharCalls || charBatchSize <= 1 || roster.length <= 1) {
      // 回退路径：逐角色调用
      return await pMap(roster, async (r) => {
        try {
          return await fetchOneProfile(r);
        } catch (e) {
          log('WARN', `人物「${r.name}」档案生成失败：${e.message}`);
          return null;
        }
      }, concurrency, (d, t) => log('Step 5', `人物 ${d}/${t}`));
    }

    /**
     * 分组：保持名单顺序（分层 + 剧情占比），每组 `size` 个。
     * `size` 会随首组的成功率**动态下调** —— 见下面的自适应逻辑。
     */
    const makeGroups = (n) => {
      const gs = [];
      for (let i = 0; i < roster.length; i += n) gs.push(roster.slice(i, i + n));
      return gs;
    };

    let size = charBatchSize;
    let groups = makeGroups(size);
    log('Step 5', `人物档案批量生成：${roster.length} 人 → ${groups.length} 组（每组 ≤${size} 人，共享同一份抽样）`);

    /**
     * 首组超期缺员 → 自动缩小批次。
     *
     * 为什么需要：推理模型的**思考 token 也计入 completion**。实测 deepseek-flash
     * 生成 5 份档案需要 11,400 输出 token（其中 7,300 是思考），而 pipeline 里那次
     * 只吐回 1 份就结束了，剩下 4 人走逐个补抽 —— 一次批量调用白花，成本反而更高。
     *
     * 判据用"返回比例 < 60%"：偶尔漏 1 个人属正常（后面会补抽），
     * 但只回来一小半说明是能力/额度问题，继续按原批次跑只会重复浪费。
     */
    const reduceCharBatch = config.reduceCharBatchSize !== false;
    if (reduceCharBatch && groups.length > 1) {
      try {
        const first = await fetchProfileGroup(groups[0]);
        const got = first.filter(x => x.item).length;
        const ratio = groups[0].length ? got / groups[0].length : 1;
        log('Step 5', `档案首组 ${got}/${groups[0].length} 人（${Math.round(ratio * 100)}%）`);
        if (ratio < 0.6 && size > 2) {
          const next = Math.max(2, Math.min(size - 1, Math.ceil(size * ratio) || 2));
          log('WARN', `批量档案一次写 ${size} 份明显超期（只回来 ${got} 份）——`
            + `已自动把批次降到 ${next} 人/组。想固定批次可关掉「档案批量自适应」`);
          size = next;
          groups = makeGroups(size);
        }
        const restGroups = groups.slice(1);
        const restResults = restGroups.length
          ? await pMap(restGroups, async (group, gi) => {
            try {
              const res = await fetchProfileGroup(group);
              log('Step 5', `档案组 ${gi + 2}/${groups.length}：${res.filter(x => x.item).length}/${group.length} 人`);
              return res;
            } catch (e) {
              log('WARN', `档案组 ${gi + 2}/${groups.length} 失败（将逐个补抽）：${e.message}`);
              return group.map(r => ({ roster: r, item: null, missing: true }));
            }
          }, Math.max(1, Math.min(concurrency, 2)))
          : [];

        const flat = [...first, ...restResults.flat()];
        const out = [];
        const needRetry = [];
        for (const x of flat) {
          if (x.item) out.push(x.item); else needRetry.push(x.roster);
        }
        if (needRetry.length) {
          log('Step 5', `${needRetry.length} 人需要单独补抽：${needRetry.map(r => r.name).join('、')}`);
          const recovered = await pMap(needRetry, recoverOne, concurrency);
          out.push(...recovered.filter(Boolean));
        }
        const order = new Map(roster.map((r, i) => [r.name, i]));
        return out.sort((a, b) => (order.get(a.name) ?? 1e9) - (order.get(b.name) ?? 1e9));
      } catch (e) {
        log('WARN', `首组批量失败，回退到常规批量：${e.message}`);
      }
    }

    const groupResults = await pMap(groups, async (group, gi) => {
      try {
        const res = await fetchProfileGroup(group);
        const got = res.filter(x => x.item).length;
        log('Step 5', `档案组 ${gi + 1}/${groups.length}：${got}/${group.length} 人`);
        return res;
      } catch (e) {
        log('WARN', `档案组 ${gi + 1}/${groups.length} 失败（将逐个补抽）：${e.message}`);
        return group.map(r => ({ roster: r, item: null, missing: true }));
      }
    }, Math.max(1, Math.min(concurrency, 2)));

    const flat = groupResults.flat();
    const out = [];
    const needRetry = [];
    for (const x of flat) {
      if (x.item) out.push(x.item);
      else needRetry.push(x.roster);
    }
    if (needRetry.length) {
      log('Step 5', `${needRetry.length} 人需要单独补抽：${needRetry.map(r => r.name).join('、')}`);
      const recovered = await pMap(needRetry, recoverOne, concurrency);
      out.push(...recovered.filter(Boolean));
    }
    // 保持名单顺序（分组是保序的，补抽追加在后面）
    const order = new Map(roster.map((r, i) => [r.name, i]));
    return out.sort((a, b) => (order.get(a.name) ?? 1e9) - (order.get(b.name) ?? 1e9));
  })()).filter(Boolean);
  // 档案详细度诊断：新模板要求 600-1500 字，太短说明模型没按模板写
  if (charItems.length) {
    const brief = charItems.map(c => ({ name: c.name, ...inspectContentYaml(c.content) }));
    const avg = Math.round(brief.reduce((s, b) => s + b.chars, 0) / brief.length);
    log('Step 5', `人物 ${charItems.length} 份，平均 ${avg} 字`
      + `（字段数 ${Math.min(...brief.map(b => b.keyCount))}-${Math.max(...brief.map(b => b.keyCount))}）`);
    const thin = brief.filter(b => b.chars < 400);
    if (thin.length) {
      log('WARN', `${thin.length} 份档案偏短（<400 字）：${thin.slice(0, 5).map(b => `${b.name}(${b.chars})`).join('、')}`
        + ' —— 可能没按详细模板输出');
    }
  }
  log('Step 5', `世界观 ${worldbookItems.length} / 人物 ${charItems.length}`);

  // ---------- Step 5.5 事件条目（起因/经过/结果/影响/干预分支）----------
  // 事件条目原来的正文只有「时间 + 原著 + 压力」三行，玩家看不出前因后果。
  // 这里单独再调一次，把 Step 2 抽到的事件补成完整条目。
  let eventEntries = [];
  /**
   * 原著剧情简介：作为**常驻世界书条目**喂给 AI，回答"这本书整体在讲什么"。
   * 事件条目只讲单个节点，没有梗概时 AI 的人设与对话容易跑偏。
   */
  let synopsis = '';
  if (events.length) {
    checkAbort();
    log('Step 5.5', `撰写事件条目（${events.length} 个）`);
    try {
      const payload = events.map(e => ({
        name: e.name,
        time: e.time || '',
        chapter: e.chapter || '',
        pressure: e.pressure || 'buffer',
        canon: e.canon || '',
        interventions: e.interventions || [],
      }));
      const excerpt = chunks.slice(0, 4).map(c => `${c.title}\n${c.text}`).join('\n\n').slice(0, worldProbeChars);
      /**
       * 合并调用（默认）：一次拿回事件条目 + 剧情简介。
       * 两者需要的信息完全一样（事件清单 + 原文节选），拆开就是同一段原文发两遍。
       */
      const merged = mergeSynopsisCalls !== false;
      const raw = await llm.chatJSON(
        merged ? S.STEP_5_EVENT_WITH_SYNOPSIS : S.STEP_5_EVENT,
        `事件清单：\n${JSON.stringify(payload, null, 2)}\n\n原文节选：\n${excerpt}`,
        'step5',
      );
      const byName = new Map();
      // 不合并时 raw 是数组；合并时是 {events, synopsis}
      const rawItems = merged ? pickArrayByKeys(raw, ['events', '事件', 'items']) : asArray(raw);
      if (merged) {
        synopsis = String(pickField(raw, ['synopsis', '简介', '剧情简介', 'synopsisText']) || '').trim();
        if (synopsis && synopsis.length < 100) {
          log('WARN', `剧情简介过短（${synopsis.length} 字），已丢弃`);
          synopsis = '';
        }
      }
      for (const it of rawItems) {
        const nm = String(pickField(it, ['name', '事件名', '名称']) ?? '').trim();
        const content = pickContent(it);
        if (!nm) { log('WARN', `事件条目缺少事件名，已跳过（返回键：${Object.keys(it || {}).join('/')}）`); continue; }
        if (isPlaceholderBody(content)) {
          log('WARN', `事件条目「${nm}」正文为空或占位，已跳过（${content.length} 字，返回键：${Object.keys(it || {}).join('/')}）`);
          continue;
        }
        byName.set(nm, { name: nm, content, keys: asArray(it.keys) });
      }
      if (!rawItems.length) log('WARN', '事件条目撰写返回了空数组');
      // 只保留能对上 Step 2 事件名的（对不上的会污染变量树）
      eventEntries = events
        .map(e => {
          const hit = byName.get(e.name)
            || [...byName.values()].find(v => v.name.includes(e.name) || e.name.includes(v.name));
          return hit ? { event: e, content: hit.content, keys: e.name ? [e.name] : [] } : null;
        })
        .filter(Boolean);
      const missed = events.length - eventEntries.length;
      log('Step 5.5', `事件条目 ${eventEntries.length}/${events.length} 条`
        + (missed ? `（${missed} 条没拿到正文，将回退到简洁格式）` : ''));
      if (synopsis) {
        log('Step 5.5', `原著剧情简介 ${synopsis.length} 字（作为常驻参考条目）`);
      } else if (mergeSynopsisCalls !== false) {
        log('WARN', '剧情简介为空 —— 扮演时缺少"整部作品在讲什么"的参考，建议检查模型是否按 {events, synopsis} 输出');
      }
    } catch (e) {
      log('WARN', `事件条目撰写失败，回退到简洁格式：${e.message}`);
    }
  }

  // ===== Step 8.5 角色卡基础字段 =====
  checkAbort();
  log('Step 8.5', '生成角色卡基础字段');
  let cardFields = null;
  try {
    const excerpt = chunks.slice(0, 3).map(c => c.text).join('\n\n').slice(0, 8000);
    const raw = await llm.chatJSON(
      T.buildCharacterCardFieldsPrompt({
        firstEvent: timeline.events[0] || null,
        protagonist: userMode.protagonistName || null,
        userMode: userMode.mode,
        worldbook: worldbookItems,
        excerpt,
      }),
      '请按 system 要求输出角色卡字段 JSON。',
      'step8.5'
    );
    cardFields = normalizeCardFields(raw, {
      title: config.title || null,
      protagonist: userMode.protagonistName || null,
    });
    log('Step 8.5', `字段已生成：first_mes ${cardFields.first_mes.length} 字 / `
      + `${cardFields.alternate_greetings.length} 个备选开场 / ${cardFields.tags.length} 个标签`);
  } catch (e) {
    log('Step 8.5', `字段生成失败，使用兜底内容：${e.message}`);
    cardFields = normalizeCardFields(null, {
      title: config.title || null,
      protagonist: userMode.protagonistName || null,
      firstEvent: timeline.events[0] || null,
    });
  }

  // ===== Step 6 变量树 =====
  checkAbort();
  log('Step 6', '构建变量树');
  const variables = buildVariables(timeline, events, storylines, charItems, phasesWithDeltas);
  initializeUserNamespace(variables, userMode);
  log('Step 6', `变量：${Object.keys(variables.characters).length} 人物 / ${Object.keys(variables.events).length} 事件`);
  // phase 与「角色阶段」增量表对齐检查：对不上会让那条 EJS 静默不输出
  for (const p of checkPhaseAlignment(variables, phasesWithDeltas)) log('WARN', `阶段对齐：${p}`);

  // ===== Step 7.5 状态栏 + 正则体系 =====
  // 必须在 Step 6 之后（要读最终变量树，状态栏只展示真实存在的字段），
  // 在 Step 8 之前（B5-5 输出纪律要写进占位符与正文包裹标签，
  // 完整角色卡要写入 regex_scripts）。
  checkAbort();
  log('Step 7.5', '生成状态栏与正则体系');
  let statusbarResult = null;
  try {
    // 本项目没有 genre 字段，用 tags + 作品名拼一个类型串供主题匹配
    const genreHint = [
      ...(Array.isArray(cardFields?.tags) ? cardFields.tags : []),
      cardFields?.wellKnown || '',
      config.title || '',
      timeline?.origin?.event || '',
    ].filter(Boolean).join(' ');
    statusbarResult = await generateStatusbar({
      variables,
      genre: genreHint,
      worldName: cardFields?.name || config.title || '',
      characterName: userMode.protagonistName || '',
    });
    const sb = statusbarResult.statusbar;
    log('Step 7.5', `状态栏：主题 ${sb.theme} / 布局 ${sb.layout}（${sb.tabCount} 页：`
      + `${sb.tabs.map(t => `${t.label}×${t.fieldCount}`).join('、')}）/ `
      + `${Buffer.byteLength(sb.html, 'utf8')} 字节 HTML / ${statusbarResult.regexScripts.length} 条正则`);
    for (const w of statusbarResult.validation.warnings) log('WARN', `状态栏：${w}`);
    for (const e of statusbarResult.validation.errors) log('WARN', `状态栏校验未通过：${e}`);
  } catch (e) {
    // 状态栏是"锦上添花"：生成失败不应该让整张卡作废。
    // 但绝不能静默 —— 没有状态栏时 B5-5 也不会写占位符，用户必须知道原因。
    log('WARN', `状态栏生成失败，本次不产出状态栏与正则：${e.message}`);
    statusbarResult = null;
  }

  // ===== Step 8 组装 =====
  log('Step 8', '组装 A/B 包');
  const bookTitle = cardFields?.name || config.title || null;
  // 世界观全缺时至少给一条世界概览 —— 否则整张卡没有任何世界观锚点，
  // 模型只能靠"设定集"里的人物和事件条目猜世界长什么样
  if (!worldbookItems.length) {
    worldbookItems = fallbackWorldbook(timeline, events, bookTitle, phasesWithDeltas, text);
    if (worldbookItems.length) {
      log('WARN', `未抽到可用世界观条目，已兜底 ${worldbookItems.length} 条`
        + `（map_world 取自原文客观摘录 + 结构信息，非编造）`);
    } else {
      log('WARN', '未抽到世界观条目，且原文不足以生成兜底 —— 这张卡不会有世界观条目');
    }
  }
  const worldbook = assembleWorldbook(timeline, events, charItems, worldbookItems, {
    title: bookTitle,
    // Step 5.5 写好的事件条目正文（按事件名索引）
    eventContents: new Map(eventEntries.map(x => [x.event.name, x.content])),
    // 派生事件触发词时要排除主角（主角几乎每轮在场，当 key 会让所有事件常驻）
    protagonist: userMode.protagonistName || '',
    // 故事线：一条线一条分段触发条目（不再进变量树）
    storylines,
    // 原著剧情简介：常驻参考条目
    synopsis,
  });
  const b1 = YAML.stringify(variables);
  const b2 = generateB2(variables);
  const b4 = T.generateB4(phasesWithDeltas);
  const b3 = userMode.mode === 'participant' ? T.B3_PARTICIPANT
            : userMode.mode === 'observer' ? T.B3_OBSERVER
            : T.B3_PROTAGONIST;
  const b5timeline = userMode.mode === 'participant' ? T.B5_2_PARTICIPANT
                  : userMode.mode === 'observer' ? T.B5_2_OBSERVER
                  : T.B5_2_PROTAGONIST;
  const b5intervention = userMode.mode === 'observer' ? T.B5_4_OBSERVER : T.B5_4;

  const preset = {
    b1_variables: b1,
    b2_update_rules: b2,
    b3_director: b3,
    b4_persona_delta: b4,
    b5_rules: {
      identity: T.B5_1,
      timeline: b5timeline,
      fence: T.B5_3,
      intervention: b5intervention,
      // A/B 包也要写上占位符与正文包裹标签：否则只用 B 包的用户，
      // 输出纪律里没有占位符指令，AI 不会输出 <StatusPlaceHolderImpl/>，
      // 之后就算手动加了正则也没有可替换的目标。
      output: T.buildOutputDiscipline(statusbarResult || {}),
    },
    config: { userMode: userMode.mode },
  };

  const warnings = validate(worldbook, preset, limits);
  const aTokens = estimateTokens(
    worldbook.entries.filter(e => e.constant).map(e => e.content).join('')
  );
  const bTokens = estimateTokens(JSON.stringify(preset));

  // ===== Step 8.5 组装完整角色卡（chara_card_v3）=====
  // 输出模式：
  //   'card' 只产出 character_card.json（一次导入）
  //   'ab'   只产出 A 包 + B 包（分开导入）
  //   'both' 两者都产出
  const outputMode = ['card', 'ab', 'both'].includes(config.outputMode) ? config.outputMode : 'both';
  const wantCard = outputMode === 'card' || outputMode === 'both';
  const wantAb = outputMode === 'ab' || outputMode === 'both';
  log('Init', `输出模式：${outputMode === 'card' ? '完整角色卡' : outputMode === 'ab' ? 'A 包 + B 包' : '完整角色卡 + A/B 包'}`);

  let characterCard = null;
  if (wantCard) {
    checkAbort();
    log('Step 8.5', '组装完整角色卡');
    characterCard = assembleCharacterCard({
      timeline, events, characters: charItems, worldbook: worldbookItems,
      variables, phasesWithDeltas, userMode, cardFields,
      worldbookName: worldbook.name,
      // 完整卡模式也必须用上 Step 5.5 的事件条目正文
      eventContents: new Map(eventEntries.map(x => [x.event.name, x.content])),
      // Step 7.5 的产出：正则体系 + 占位符/正文包裹标签 + MVU 脚本注册
      statusbar: statusbarResult,
      // 故事线条目（与 A 包同一份，保证两条路径产出一致）
      storylines,
      // 原著剧情简介（常驻参考条目）
      synopsis,
    });
    const cardEntries = characterCard.data.character_book.entries;
    const cardBytes = Buffer.byteLength(JSON.stringify(characterCard, null, 2), 'utf8');
    log('Step 8.5', `角色卡：${cardEntries.length} 条世界书条目 / `
      + `${characterCard.data.extensions.regex_scripts.length} 条正则 / ${(cardBytes / 1024).toFixed(1)} KB`);
  } else {
    log('Step 8.5', '按输出模式跳过完整角色卡');
  }

  // ===== 导出 =====
  const meta = {
    taskId,
    createdAt: startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    title: config.title || null,
    model: config.model,
    baseUrl: config.baseUrl,
    sourceEncoding: encoding,
    userMode: userMode.mode,
    protagonist: userMode.protagonistName || null,
    userModeAuto: !!userMode.autoDetected,
    wellKnown: !!popularity.wellKnown,
    counts: {
      chars: text.length,
      chapters: chunks.length,
      events: events.length,
      storylines: Object.keys(storylines).length,
      phases: phasesWithDeltas.length,
      worldbookEntries: worldbook.entries.length,
      characters: charItems.length,
      // 人物分层：状态栏、变量树、条目详略都按它走，值得进 meta 便于事后核对
      tiers: NPC_TIERS.reduce((acc, t) => {
        const n = charItems.filter(c => (c.tier || normalizeTier(c.role)) === t).length;
        if (n) acc[t] = n;
        return acc;
      }, {}),
      mentions: mentions.reduce((s, m) => s + (m.mentions?.length || 0), 0),
    },
    tokens: { a: aTokens, b: bTokens, limits },
    /**
     * LLM 用量记账（按字符数，见 llm.js 的 usage）。
     *
     * 上游不一定返回 token usage，所以按字符数记 —— 足够看出"钱花在哪一步"。
     * 落进 meta.json 是为了让"优化前后对比"不必再插桩：
     * 同一条小说跑两次（合并开/关），直接比 `usage.inputChars` 与 `usage.byStep`。
     */
    usage: {
      /** 送出去的输入字符总数（system + user） */
      inputChars: llm.usage.inputChars,
      outputChars: llm.usage.outputChars,
      calls: llm.usage.calls.length,
      failedCalls: llm.usage.calls.filter(c => !c.ok).length,
      /** 按 Step 汇总（合并调用记成 `step1+step2` 这种合成键） */
      byStep: llm.usage.byStep,
      /** 与正文的比值：一眼看出"同一段正文被喂了几遍" */
      inputPerNovelChar: text.length ? Number((llm.usage.inputChars / text.length).toFixed(2)) : null,
    },
    outputMode,
    hasCharacterCard: wantCard,
    warnings,
    preset: presetDesc.active ? {
      name: presetDesc.name,
      mode: presetDesc.mode,
      applied: presetDesc.lines,
      version: config.preset?.version || null,
      author: config.preset?.author || null,
    } : null,
    options: {
      concurrency,
      chunkMaxLen: Number(config.chunkMaxLen) || 6000,
      maxCharacters,
      worldProbeChars,
      charProbeChars,
      // 合并调用的开关：记进 meta 才能在事后分清"这次跑的是合并版还是拆分版"，
      // 否则同两套产物混在一起无法对比质量与用量
      mergeChapterCalls,
      mergeWorldCalls,
      mergeCharCalls,
      charBatchSize,
    },
    // 分批评析概览：批次规模、归并账本、续跑情况
    batch: {
      enabled: true,
      total: batchStats.total,
      chaptersPerBatch: batchOpts.chapters,
      charsPerBatch: batchOpts.chars,
      summaries: batchSummaries,
      resumed: resumedCount,
      sizes: batchStats.sizes,
      merged: {
        mentions: merged.report.mentions,
        events: merged.report.events,
        roster: {
          inputCount: merged.report.roster.inputCount,
          outputCount: merged.report.roster.outputCount,
          mergedGroups: merged.report.roster.merged.length,
          merged: merged.report.roster.merged,
          suspicious: merged.report.roster.suspicious,
        },
        worldbook: merged.report.worldbook,
        orphanChapters: merged.report.orphanChapters,
      },
    },
    // Step 7.5：状态栏与正则概览（HTML 本身不写进 meta，它在 character_card.json 与正则里）
    statusbar: statusbarResult ? {
      theme: statusbarResult.statusbar.theme,
      layout: statusbarResult.statusbar.layout,
      tabCount: statusbarResult.statusbar.tabCount,
      tabs: statusbarResult.statusbar.tabs,
      fieldCount: statusbarResult.statusbar.fieldCount,
      placeholder: statusbarResult.placeholder,
      regexCount: statusbarResult.regexScripts.length,
      htmlBytes: Buffer.byteLength(statusbarResult.statusbar.html, 'utf8'),
      errors: statusbarResult.validation.errors,
      warnings: statusbarResult.validation.warnings,
    } : null,
  };

  const files = {
    // 按输出模式决定**主产物**：完整角色卡 / A 包 + B 包
    ...(wantCard ? { 'character_card.json': JSON.stringify(characterCard, null, 2) } : {}),
    /**
     * A 包与 B 包始终落盘，不随输出模式省略。
     *
     * 它们在这里**已经构建好了**（worldbook / preset 在 Step 8 无条件生成），
     * 省略它们只省几百 KB 磁盘，代价是两个下游功能直接坏掉：
     *   · 「预设规则」页读 preset_fragment.json → 卡模式任务点「↓ 下载 JSON」拿到 404
     *   · 「角色卡内容」页读 worldbook.json    → 卡模式任务的世界书标签页报
     *     "该任务没有 worldbook.json"，整页内容打不开
     * 这两个文件也是排查时最常看的东西（B1–B5 到底写了什么），
     * 不该因为选了"完整角色卡"就看不到。
     *
     * `outputMode` 仍然决定主产物：卡模式不会生成 character_card.json 之外的
     * "导入用"文件，只是这两份检视副本一直在。
     */
    'worldbook.json': JSON.stringify(worldbook, null, 2),
    'preset_fragment.json': JSON.stringify(preset, null, 2),
    'variables.json': JSON.stringify(variables, null, 2),
    'timeline.json': JSON.stringify(timeline, null, 2),
    'events.json': JSON.stringify(events, null, 2),
    'storylines.json': JSON.stringify(storylines, null, 2),
    'phases.json': JSON.stringify(phasesWithDeltas, null, 2),
    'user_mode.json': JSON.stringify(userMode, null, 2),
    'card_fields.json': JSON.stringify(cardFields, null, 2),
    // 分批评析的归并账本：合并了谁、哪些名字可疑、有没有章节错位
    'merge_report.json': JSON.stringify({
      batches: batchStats.total,
      sizes: batchStats.sizes,
      resumed: resumedCount,
      ...merged.report,
    }, null, 2),
    // 批次进度概览：即使生成中断也在盘上，续跑与"批次 N / 总批数"都靠它
    'batch_state.json': JSON.stringify({
      total: batchStats.total,
      sizes: batchStats.sizes,
      batchChapters: batchOpts.chapters,
      batchChars: batchOpts.chars,
      summaries: batchSummaries,
      done: batchStats.total,
      current: batchStats.total,
      finished: true,
      resumed: resumedCount,
      updatedAt: new Date().toISOString(),
    }, null, 2),
    // Step 7.5 产出：正则清单 + 变量树里真实存在的状态栏字段
    ...(statusbarResult ? {
      'statusbar.json': JSON.stringify({
        theme: statusbarResult.statusbar.theme,
        themeTitle: statusbarResult.statusbar.themeTitle,
        layout: statusbarResult.statusbar.layout,
        tabCount: statusbarResult.statusbar.tabCount,
        tabs: statusbarResult.statusbar.tabs,
        fieldCount: statusbarResult.statusbar.fieldCount,
        placeholder: statusbarResult.placeholder,
        bodyWrapper: statusbarResult.bodyWrapper,
        fields: statusbarResult.statusbar.fields?.map(f => ({
          path: f.path, label: f.label, group: f.group, valueType: f.valueType,
        })),
        validation: statusbarResult.validation,
      }, null, 2),
      'regex_scripts.json': JSON.stringify(statusbarResult.regexScripts, null, 2),
      // 可直接用浏览器打开的预览：宏替换成占位示意文本，脚本去掉
      'statusbar_preview.html': makeStatusbarPreview(statusbarResult),
    } : {}),
    'meta.json': JSON.stringify(meta, null, 2),
    // 本次使用的「生成预设」（prompt 附加/替换），便于复现与排查
    ...(config.preset ? { 'generation_preset.json': JSON.stringify(config.preset, null, 2) } : {}),
    'README.md': generateREADME({
      chapters: chunks.length,
      events: events.length,
      phases: phasesWithDeltas.length,
      characters: charItems.length,
      warnings,
      userMode: userMode.mode,
      encoding: decoded.originalEncoding,
      outputMode,
    }),
  };

  /**
   * 生成总结：用户要看"这次产出了什么"。
   *
   * 从零生成没有"改动前"的基线（原本就是空），所以总结的是产出清单而不是差异 ——
   * 与完善路径共用同一个渲染器（src/summary.js），保证两种任务的总结长得一样。
   */
  const genSummary = summarizeGenerate(meta, {
    characters: charItems.length,
    events: events.length,
    worldbookEntries: worldbookItems.length,
    storylines: Object.keys(storylines).length,
    phases: phasesWithDeltas.length,
    tiers: meta.counts?.tiers || {},
    chapters: chunks.length,
    chars: text.length,
    // 成品规格：条目数 / 正则数 / 体积
    kit: {
      entries: characterCard?.data?.character_book?.entries?.length
        ?? (worldbook.entries.length + charItems.length + events.length),
      regex: characterCard?.data?.extensions?.regex_scripts?.length
        ?? statusbarResult?.regexScripts?.length ?? 0,
      cardBytes: characterCard ? Buffer.byteLength(JSON.stringify(characterCard, null, 2), 'utf8') : 0,
    },
  });
  files['summary.json'] = JSON.stringify(genSummary, null, 2);
  files['SUMMARY.md'] = renderSummaryMarkdown(genSummary);

  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(outDir, name), content);
  }
  if (!wantAb) {
    log('Init', '输出模式为「完整角色卡」：主产物只有 character_card.json；'
      + 'worldbook.json 与 preset_fragment.json 作为检视副本一并写出（预设规则页与角色卡内容页要读它们）');
  }

  let hasAvatar = false;
  if (config.imagePaths?.length) {
    try {
      const ext = path.extname(config.imagePaths[0]).toLowerCase();
      const target = `${outDir}/avatar${['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.png'}`;
      await copyFile(config.imagePaths[0], target);
      hasAvatar = true;
      log('Step 7', `头像已保存 ${path.basename(target)}`);
    } catch (e) {
      log('Step 7', `图片处理失败：${e.message}`);
    }
  }

  log('Done', `A 包常驻 ${aTokens} tok / B 包常驻 ${bTokens} tok，耗时 ${(meta.durationMs / 1000).toFixed(1)}s`);

  const fileList = Object.keys(files);
  if (hasAvatar) {
    const { readdir } = await import('node:fs/promises');
    fileList.push((await readdir(outDir)).find(f => f.startsWith('avatar')));
  }

  send('files', {
    taskId,
    taskDir: outDir,
    meta,
    files: fileList.filter(Boolean),
    // 结构化总结直接带上，前端不必再请求一次
    summary: genSummary,
  });

  return { taskId, outDir, meta, usage: llm.usage };
}

// ============ 辅助函数 ============

/**
 * 生成可直接双击打开的 `statusbar_preview.html`。
 *
 * 不能直接把 `statusbar.html` 落盘给用户看：它里面的值全是没有被替换的
 * `{{get_message_variable::…}}` ST 宏，而且脚本会在纯浏览器里抛错
 * （`waitGlobalInitialized` / `$` / `errorCatched` 都是酒馆助手提供的全局函数，
 * 一个都不存在）。那样用户打开只会看到一堆花括号加一片报错。
 *
 * 所以预览版做两件事：把宏换成示例值，把 <script> 整段去掉。
 * 这是**仅供看配色与排版**的快照，真正生效的是卡片里的正则替换结果。
 */
export function makeStatusbarPreview(statusbarResult) {
  const html = String(statusbarResult?.statusbar?.html || '');
  const fields = statusbarResult?.statusbar?.fields || [];
  const sample = { affinity: '50', state: '正常', time: '示例时间', phase: '示例阶段' };
  const valueOf = (path) => {
    const f = fields.find(x => path === x.path || path.startsWith(`${x.path}.`));
    if (!f) return '示例';
    if (f.valueType === 'record') {
      const sub = path.slice(f.path.length + 1);
      return sample[sub] || '示例';
    }
    return sample[f.key] || '示例';
  };
  return html
    .replace(/\{\{get_message_variable::([^}]+)\}\}/g, (_, p) => valueOf(p.trim()))
    .replace(/<script[\s\S]*?<\/script>/gi, '<!-- 预览已移除脚本：面板脚本依赖酒馆助手提供的全局函数 -->');
}

/**
 * 找出名字在原文里的**实际形式**。
 *
 * 用途：LLM 常返回「林昭小姐」「「林昭」」这类带敬称/书名号的形式，而原文里只是「林昭」。
 * 直接采用外层形式会让条目名、变量键、触发关键词都跟原文对不上（还会带上引号），
 * 所以返回原文里真正出现的那个串；都找不到时返回 null（调用方据此丢弃）。
 *
 * 从最严到最松依次试：
 *   1. 去掉装饰字符后的完整名字
 *   2. 去掉常见称谓后缀（小姐/先生/公子…）
 *   3. 取前 3 字 / 前 2 字（「凯瑟琳·埃德森」→「凯瑟琳」在原文里就够了）
 */
export function resolveNameInText(rawName, text) {
  if (!text) return null;
  const cleaned = String(rawName || '')
    .replace(/[「」『』《》〈〉【】\[\]()（）"'“”‘’\s]/g, '')
    .trim();
  if (cleaned.length < 2) return null;

  if (text.includes(cleaned)) return cleaned;

  const stripped = cleaned.replace(
    /(小姐|先生|女士|大人|公子|姑娘|夫人|太太|老板|长老|前辈|师兄|师姐|师弟|师妹|殿下|陛下|阁下|君|酱|桑)$/,
    '',
  );
  if (stripped.length >= 2 && text.includes(stripped)) return stripped;

  for (const n of [3, 2]) {
    if (cleaned.length > n) {
      const head = cleaned.slice(0, n);
      if (text.includes(head)) return head;
    }
  }
  return null;
}

/** 该名字在原文里是否存在（resolveNameInText 的布尔版，保留给需要判断的场合） */
export function appearsInTextLoose(name, text) {
  return resolveNameInText(name, text) !== null;
}

/**
 * 判断某个名字是否真的在原文里出现过（严格版：逐字匹配）。
 * 用于"别名"这类不该被前缀截断的场合。
 */
export function appearsInText(name, text) {
  const n = String(name || '').trim();
  if (n.length < 2) return false;          // 单字太短，误判率高
  if (n.length > 24) return false;
  return text.includes(n);
}

/**
 * 把 LLM 返回的名单**任意形态**归一化成 [{name, aliases, role}]。
 *
 * 这一步是"人物条目全丢"的关键防线。实测同样的 prompt，LLM 可能返回：
 *   [{name,aliases,role}] / ["林昭","沈砚"] / {characters:[...]} / {list:[...]}
 *   / [{姓名:'林昭'}] / [{character:'林昭'}] / {name:'林昭'}
 * 只要形态对不上，后面 sanitizeRoster 就会静默返回空数组 —— 整张卡没有人物。
 * 这里把所有已知形态都吃下来，拿不到就返回空数组（由调用方兜底）。
 */
export function normalizeRosterShape(raw) {
  const pick = (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      return s ? { name: s, aliases: [], role: '' } : null;
    }
    if (!v || typeof v !== 'object') return null;
    const name = v.name ?? v['姓名'] ?? v['名字'] ?? v.character ?? v['角色名'] ?? v['角色'] ?? v.title;
    if (typeof name !== 'string' || !name.trim()) return null;
    const aliasesRaw = v.aliases ?? v['别名'] ?? v['别称'] ?? v['称呼'] ?? v['昵称'] ?? [];
    const aliases = Array.isArray(aliasesRaw)
      ? aliasesRaw
      : (typeof aliasesRaw === 'string' ? aliasesRaw.split(/[、,，/|]/) : []);
    const role = String(v.role ?? v['角色定位'] ?? v['定位'] ?? v['重要度'] ?? '').trim();
    return { name: name.trim(), aliases, role };
  };

  if (Array.isArray(raw)) return raw.map(pick).filter(Boolean);
  if (typeof raw === 'string') {
    // LLM 有时不返回 JSON 数组，而是一句「林昭、沈砚」或换行分隔的名单
    return raw
      .split(/[、,，;；/|\n\r]+/)
      .map(s => s.replace(/^[\s\d.、)）-]+/, '').replace(/[（(].*$/, '').trim())
      .filter(s => s.length >= 2 && s.length <= 24)
      .map(s => ({ name: s, aliases: [], role: '' }));
  }
  if (raw && typeof raw === 'object') {
    // {characters:[...]} / {list:[...]} / {roster:[...]} / {人物:[...]}
    for (const k of ['characters', 'list', 'roster', '人物', 'result', 'data', 'items']) {
      if (Array.isArray(raw[k])) return raw[k].map(pick).filter(Boolean);
    }
    const single = pick(raw);      // {name:'林昭'} 这种单对象
    if (single) return [single];
  }
  return [];
}

/** 这些是"字段名 / 占位符"，LLM 会照抄进 keys，必须剔除 */
const KEY_STOPWORDS = new Set([
  '本名', '别名', '称号', '昵称', '姓名', '名字', '身份', '职位', '别称', '曾用名',
  '未提及', '不详', '未知', '无', '暂无', 'none', 'unknown', 'n/a', 'null',
  '本名：未提及', '别名：', '称号：无',
]);

/**
 * 描述性称呼 / 泛指词：它们不是名字，不能当人名也不能当关键词。
 *
 * 两字修饰语（中年/老年/年轻/年迈）必须**整体**列出，不能拆成 (中|老)*(年女人) ——
 * 拆开后「中」被吃掉、剩下「年女人」不匹配，就漏网了。
 * 只做完整匹配，不剥前缀：剥前缀会把「周管事」这类"姓氏+职务"的正常称呼误伤，
 * 而误伤的代价（真人物被丢掉）比漏网（多一条描述词条目）大得多。
 */
const DESCRIPTOR_CORE = /^(那个?|这|某)?(年轻|年迈|中年|老年|少女|少年|小女孩|小男孩|小女孩儿|小男孩儿|小|老|大|中|青|少|男|女)*(女孩儿|男孩儿|女孩子|男孩子|小女孩|小男孩|女孩|男孩|女人|男人|孩子|孩童|婴儿|少女|少年|青年|中年人|老年人|老人|妇人|母亲|父亲|妈妈|爸爸|老师|医生|护士|士兵|警察|工人|农民|商人|学生|主角|配角|众人|人们|对方|那人|某人|大家|旁人|管事|店主|掌柜|老板|司机|侍者|仆人|守卫|村长|族长|皇帝|国王|王子|公主|人|神|魔|妖|鬼|兽)$/;

export function isDescriptorName(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  return DESCRIPTOR_CORE.test(n);
}

/**
 * 机构 / 组织 / 地名 / 体系的后缀。
 * LLM 抽人物名单时经常把势力、地点、功法体系一起列进来
 * （实测「清微宗」被当成人物抽了一份档案，正文还写着"X：人物，与主角有交集"）。
 * 这类词能通过"原文里存在"的校验，所以必须靠后缀单独挡一道。
 */
const NON_PERSON_RE = /(宗|门|派|教|帮|会|盟|族|家|府|阁|楼|殿|堂|院|观|寺|军|营|司|局|部|团|社|国|朝|州|城|镇|村|山|谷|林|海|岛|界|域|洲|宫|塔|窟|洞|庄|铺|号|坊|体系|境界|功法|心法|秘术|神术|魔法|灵根|血脉|学院|公司|集团|组织|协会|世家)$/;

export function looksLikeNonPerson(name) {
  const n = String(name || '').trim();
  if (n.length < 2 || n.length > 12) return false;
  return NON_PERSON_RE.test(n);
}

/**
 * 校验并清洗人物名单。
 *
 * 这一步存在的意义：人名由 LLM 从原文抽取，它会**编造原文里没有的角色**
 * （实测出现过：档案正文自己写着"在提供的原文节选中，并未出现名为 X 的角色"）。
 * 只要档案里出现了查无此人的条目，整张人物层就不可信。
 *
 * ⚠️ 但"宁可错杀"在这里是错的方向：**人物层全空比多一条脏条目严重得多**
 * （全空 = 状态栏没有可互动角色、好感度变量没有对象、导演指令里的角色全失效）。
 * 所以：
 *   - 匹配用 appearsInTextLoose() 的宽松三档，而不是严格 includes
 *   - 返回 { roster, dropped }，把丢弃原因一并交出去，便于日志与排错
 */
export function sanitizeRoster(rawList, text, { max = 20 } = {}) {
  const out = [];
  const dropped = [];
  const seen = new Set();

  // 形态归一化：裸字符串 / 对象包裹 / 别名字段名都能吃下来
  const items = Array.isArray(rawList) && rawList.some(r => r && typeof r === 'object' && ('name' in r || 'aliases' in r))
    ? rawList
    : normalizeRosterShape(rawList);

  for (const r of items) {
    const rawName = String(r?.name || '').trim();
    if (!rawName) continue;

    const rawAliases = (Array.isArray(r?.aliases) ? r.aliases : [])
      .map(a => String(a || '').trim())
      .filter(a => a && a !== rawName && !KEY_STOPWORDS.has(a))
      .filter((a, i, arr) => arr.indexOf(a) === i);

    // 主名要能在原文里找到；找不到时**再看别名**。
    // LLM 常给全名（「旗木卡卡西」）而原文只写简称（「卡卡西」），
    // 只看主名会把真人当成"查无此人"整条丢掉（实测踩过）。
    // 用原文里真正出现的那个形式做名字，其余形式进别名 —— 这样触发词也覆盖到了。
    // resolveNameInText 顺带把名字收敛成原文形式
    //（「林昭小姐」→「林昭」、「「林昭」」→「林昭」），避免条目名/变量键带上引号与敬称。
    let name = resolveNameInText(rawName, text);
    if (!name) {
      for (const a of rawAliases) {
        const hit = resolveNameInText(a, text);
        if (hit) { name = hit; break; }
      }
    }
    if (!name) { dropped.push(`${rawName}(原文查无此人)`); continue; }
    // 描述性称呼、机构名、字段名不收
    if (isDescriptorName(name)) { dropped.push(`${rawName}(描述性称呼)`); continue; }
    if (looksLikeNonPerson(name)) { dropped.push(`${rawName}(机构/地名/体系)`); continue; }
    if (KEY_STOPWORDS.has(name)) { dropped.push(`${rawName}(字段名)`); continue; }

    const uniq = varKey(name);
    if (seen.has(uniq)) { dropped.push(`${name}(重复)`); continue; }
    seen.add(uniq);

    // 别名同样要回原文验证 + 剔除字段名/描述词
    const aliases = [rawName, ...rawAliases]
      .map(a => String(a || '').trim())
      .filter(a => a && a !== name && !KEY_STOPWORDS.has(a))
      .filter(a => !isDescriptorName(a))
      .filter(a => !looksLikeNonPerson(a))
      .filter(a => appearsInText(a, text))
      .filter((a, i, arr) => arr.indexOf(a) === i)
      .slice(0, 4);

    let role = String(r?.role || '').trim();
    if (!NPC_TIERS.includes(role) && !LEGACY_ROLE_MAP[role]) role = '次要NPC';

    out.push({ name, aliases, role });
    if (out.length >= max) break;
  }

  // 主角排最前（后面按重要度截断时不会把主角丢掉）
  out.sort((a, b) => (TIER_RANK[a.role] ?? 9) - (TIER_RANK[b.role] ?? 9));
  return { roster: out, dropped };
}

/**
 * 人物分层：按**剧情占比**把角色分成主角 / 主要NPC / 次要NPC / 路人NPC。
 *
 * 档位常量与阈值定义在 src/tiers.js（merge_batches 与测试也要用；
 * 定义在这里会让那些模块在顶层读到未求值完的绑定）。这里只放"怎么量"。
 */

/**
 * 数一个角色出现在**多少个章节**里。
 *
 * @param {string} name     主名
 * @param {string[]} aliases 别名
 * @param {Array<{title:string,text:string}>} chunks 章节
 * @returns {{chapters:number, examples:string[]}}
 */
export function countChaptersPresent(name, aliases = [], chunks = []) {
  const forms = [name, ...(Array.isArray(aliases) ? aliases : [])]
    .map(s => String(s || '').trim())
    .filter(Boolean);
  if (!forms.length) return { chapters: 0, examples: [] };

  const hit = [];
  for (const c of chunks) {
    const body = String(c?.text || '');
    if (!body) continue;
    // 用宽松匹配：原文里的称呼形式可能与名单不完全一致（全名/简称/加敬称）
    if (forms.some(f => appearsInTextLoose(f, body))) hit.push(c.title);
  }
  return { chapters: hit.length, examples: hit.slice(0, 3) };
}

/**
 * 按剧情占比给名单分层。
 *
 * @param {Array<{name:string, aliases?:string[], role?:string}>} roster
 * @param {Array<{title:string,text:string}>} chunks 参与统计的章节
 * @param {{protagonistName?:string}} [opts] 主角名（userMode 判定出来的，优先级最高）
 * @returns {Array} 原数组的副本，每条补上 tier / storyChapters / storyRatio
 */
export function classifyByStoryShare(roster, chunks, { protagonistName = '' } = {}) {
  const list = Array.isArray(roster) ? roster : [];
  const total = Array.isArray(chunks) ? chunks.filter(c => String(c?.text || '').trim()).length : 0;
  const proto = String(protagonistName || '').trim();

  const scored = list.map(r => {
    const name = String(r?.name || '').trim();
    const aliases = Array.isArray(r?.aliases) ? r.aliases : [];
    const { chapters } = countChaptersPresent(name, aliases, chunks);
    const ratio = total > 0 ? chapters / total : 0;
    return { ...r, storyChapters: chapters, storyRatio: Number(ratio.toFixed(4)) };
  });

  return scored.map(r => {
    let tier;
    if (proto && r.name === proto) {
      // 主角由 userMode 判定，不看占比 —— 群像作品里主角可能只占 15%，
      // 那份占比不该把它降级成次要NPC。
      tier = '主角';
    } else if (total === 0) {
      // 没有章节可统计（单块文本 / 统计失效）：退回模型给的 role，别硬编一个档
      tier = normalizeTier(r.role, '次要NPC');
    } else if (r.storyRatio >= TIER_THRESHOLDS.major) {
      tier = '主要NPC';
    } else if (r.storyRatio >= TIER_THRESHOLDS.minor) {
      tier = '次要NPC';
    } else {
      tier = '路人NPC';
    }
    // `role` 保留原值（老代码与老卡还在读它），`tier` 是新的权威字段
    return { ...r, tier };
  });
}

/**
 * 给 LLM 一份"谁在多少章里出现过"的客观清单，让它据此分层。
 *
 * 模型很擅长判断"哪两个人是同一个人"，但不擅长数比例 ——
 * 所以比例由我们算好喂进去，模型只负责结合剧情语义微调。
 */
export function formatShareHint(roster) {
  const list = (Array.isArray(roster) ? roster : [])
    .filter(r => Number.isFinite(r?.storyRatio))
    .sort((a, b) => b.storyRatio - a.storyRatio)
    .slice(0, 30);
  if (!list.length) return '';
  return list.map(r => {
    const pct = Math.round(r.storyRatio * 100);
    return `- ${r.name}：出现在 ${r.storyChapters} 章（约全书 ${pct}%）`;
  }).join('\n');
}

/**
 * 为"整本抽样"的抽取步骤取样本：开头权重高，但**首、中、尾都必须覆盖到**。
 *
 * 之前世界观抽取是 `text.slice(0, 15000)` —— 大于这个长度的长篇，
 * 后半本的世界观（势力、地点、境界体系）一条都抽不到，表现就是"世界观条目全缺"。
 * 现在按 40% 开头 + 60% 均匀铺满全文的窗口取样。
 *
 * ⚠️ 关键点：末尾窗口必须**贴住文本结尾**（`text.length - win`），
 * 不能只靠等比步长推 —— 那样最容易漏掉的恰恰是全书最后一章
 * （实测 40 章的文本只覆盖到第 26 章，结局部分完全没进样本）。
 */
export function sampleAcrossText(text, budget) {
  const n = Number(budget) || 15000;
  if (text.length <= n) return text;

  const headLen = Math.floor(n * 0.4);
  const restBudget = n - headLen;
  const slots = 6;
  const win = Math.max(400, Math.floor(restBudget / slots));
  const rest = text.slice(headLen);

  const parts = [text.slice(0, headLen)];
  const starts = [];
  for (let i = 0; i < slots; i++) {
    // 等距铺开，最后一个槽位贴住结尾
    const s = i === slots - 1
      ? Math.max(0, rest.length - win)
      : Math.round((rest.length - win) * (i / (slots - 1)));
    starts.push(Math.max(0, Math.min(s, rest.length - 1)));
  }
  for (const s of starts) parts.push(rest.slice(s, s + win));
  return parts.join('\n\n……\n\n');
}

/** 世界观分类：中文/别名 → 规范分类名 */
const CATEGORY_ALIASES = {
  世界观: 'map_world', 世界: 'map_world', 世界设定: 'map_world', 大陆: 'map_world', 背景: 'map_world',
  地图: 'map_region', 区域: 'map_region', 地区: 'map_region',
  地点: 'map_location', 场所: 'map_location', 场景: 'map_location',
  境界: 'system_realm', 等级: 'system_realm', 修为: 'system_realm', 体系: 'system_realm',
  物品: 'system_item', 道具: 'system_item',
  技能: 'system_skill', 功法: 'system_skill', 法术: 'system_skill',
  势力: 'system_faction', 组织: 'system_faction', 门派: 'system_faction', 宗门: 'system_faction',
  血脉: 'system_bloodline', 血统: 'system_bloodline', 灵根: 'system_bloodline',
  历史: 'history', 历史事件: 'history',
};

/** 常见字段别名 → 规范字段名 */
function pickField(obj, names) {
  for (const n of names) {
    if (obj && obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return undefined;
}

/** 把一条世界观的字段名归一化（模型常用中文键名） */
function normalizeWorldbookItem(w) {
  if (!w || typeof w !== 'object') return null;
  const rawCat = String(pickField(w, ['category', '分类', '类别', '类型', 'cat']) ?? '').trim();
  const category = CATEGORY_ALIASES[rawCat] || rawCat;
  const name = String(pickField(w, ['name', '名称', '条目名', '名字', '标题', 'title']) ?? '').trim();
  // content_yaml 优先（新模板就是它），其次才是 content / 正文
  const content = pickContent(w);
  const keysRaw = pickField(w, ['keys', 'key', '关键词', '触发词', '触发关键词']);
  return { category, name, content, keysRaw, dynamicHint: pickField(w, ['dynamicHint', '动态提示']) };
}

/**
 * 把两批世界观条目合起来并按 `分类::条目名` 去重（先到先得）。
 *
 * 合并调用会同时返回 worldbook 与 items 两个数组，最后都要进同一个池子；
 * 宽松重试的结果也要并回同一个池子。抽出来是为了三处用同一套去重口径 ——
 * 之前是内联写的，合并路径一多就会有地方漏掉去重。
 */
export function dedupeWorldbook(list) {
  const out = [];
  const seen = new Set();
  for (const w of Array.isArray(list) ? list : []) {
    if (!w) continue;
    const key = `${w.category || ''}::${w.name || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/**
 * 世界观条目的兜底校验：
 *   - 剔除没有 content / 分类非法的条目
 *   - keys 为空时用条目名兜底 —— keys 空的 key 触发条目永远不可能被触发
 */
export function normalizeWorldbookItems(rawInput) {
  // 先归一化容器形态（模型常把数组包成 {"worldbook":[...]} / {"世界观":[...]}）
  const raw = asArray(rawInput);
  const VALID = new Set([
    'map_world', 'map_region', 'map_location',
    'system_realm', 'system_item', 'system_skill', 'system_faction', 'system_bloodline',
    'history',
  ]);
  // 占位符条目名：这类词本身不承载任何设定信息
  const PLACEHOLDER_NAMES = new Set([
    '世界观', '世界设定', '设定集', '世界', '背景', '背景设定', '设定',
    '未知', '无', '暂无', '待补充', '略', '其他', '其它', 'xxx', 'xxx设定',
    'name', 'content', '条目', '示例',
  ]);
  // 占位符正文特征
  const PLACEHOLDER_CONTENT_RE = /^(原文未(提及|说明|给出)|暂无(相关)?(信息|资料|内容)|待补充|此处(填写|省略)|略|无|n\/?a|todo|tbd|待定)[。.！!]?$/i;

  const out = [];
  const seen = new Set();
  const dropped = [];
  // raw 已在函数开头做过 asArray 归一化
  for (const rawItem of raw) {
    // 字段名归一化：模型常用中文键名（分类/名称/关键词/正文），
    // 不归一化就会被当成"分类非法"全部丢掉 —— 又是一次静默清空
    const w = normalizeWorldbookItem(rawItem);
    if (!w) { dropped.push('(不是对象)'); continue; }
    const { category, name, content } = w;
    if (!VALID.has(category)) {
      // 把实际键名也带出来，便于事后诊断（原来只报"分类非法:"看不出是键名问题）
      dropped.push(`${name || '?'}(分类非法:${JSON.stringify(category)}`
        + `；该条键名:${Object.keys(rawItem).slice(0, 6).join('/')})`);
      continue;
    }
    if (!name) { dropped.push('(无条目名)'); continue; }

    // 占位符拦截（这是"map_world 是占位符"的直接对策）
    if (PLACEHOLDER_NAMES.has(name.toLowerCase())) { dropped.push(`${name}(占位符条目名)`); continue; }
    if (content.length < 10) { dropped.push(`${name}(内容过短)`); continue; }
    if (PLACEHOLDER_CONTENT_RE.test(content)) { dropped.push(`${name}(占位符正文)`); continue; }
    // 正文只是重复条目名（name=云京, content=云京）→ 没有信息量
    if (content.replace(/[。.，,、\s]/g, '') === name.replace(/[。.，,、\s]/g, '')) {
      dropped.push(`${name}(正文只重复条目名)`);
      continue;
    }

    const key = `${category}::${name}`;
    if (seen.has(key)) { dropped.push(`${name}(重复)`); continue; }
    seen.add(key);

    let keys = asArray(w.keysRaw)
      .map(k => String(k || '').trim())
      .filter(k => k && !KEY_STOPWORDS.has(k))
      .filter((k, i, a) => a.indexOf(k) === i)
      .slice(0, 5);
    // keys 为空的条目永远触发不了，用条目名兜底
    if (!keys.length) keys = [name];

    out.push({
      category, name, keys, content,
      dynamicHint: String(w.dynamicHint || ''),
      constant: rawItem?.constant === true || category === 'map_world' || category === 'system_realm',
    });
  }
  out.dropped = dropped;   // 挂在数组上便于调用方打日志（不参与 JSON 序列化用途）
  return out;
}

/**
 * 世界观为空的兜底：用**已确认的数据**（时间线基准 + 阶段 + 事件脉络）拼一条
 * 真正有信息量的作品概览。
 *
 * 注意不能写成"（本文未抽到世界观设定…）"这种占位符 —— 那正是要避免的东西。
 * 这里输出的每一条都来自已经过校验的流水线产物，不是编的。
 * 数据不足以拼出任何实质内容时返回空数组（宁可没有，也不要占位符）。
 */
export function fallbackWorldbook(timeline, events, bookName, phases, sourceText) {
  const name = String(bookName || '').trim();

  const base = timeline?.base && timeline.base !== '相对纪元' ? timeline.base : '';
  const origin = timeline?.origin?.event || '';
  const chapterCount = new Set((events || []).map(e => e?.chapter).filter(Boolean)).size;
  const phaseNames = (phases || []).map(p => p?.name).filter(Boolean);
  const storyline = [...new Set((events || []).map(e => e?.storyline).filter(Boolean))];

  const out = [];

  // 保底 1：一条真正的 map_world —— 用原文开头的客观概括兜底。
  // 验收要求"世界书里至少有 1 条 [map_world]"，所以这一条必须有实质内容（截取原文而非编造）。
  const excerpt = String(sourceText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const worldBits = [];
  if (base) worldBits.push(`作品采用「${base}」纪年`);
  if (origin) worldBits.push(`叙事起点是「${origin}」`);
  if (chapterCount) worldBits.push(`已抽取 ${chapterCount} 章的内容`);
  if (worldBits.length || excerpt) {
    const content = [
      excerpt ? `【原文开头】${excerpt}…` : '',
      worldBits.length ? `【结构】${worldBits.join('；')}。` : '',
      '另外，本篇未抽到明确的地理与体系设定，以上为原文客观摘录，供扮演时保持文风与场景一致。',
    ].filter(Boolean).join('\n');
    if (content.length >= 40) {
      out.push({
        category: 'map_world',
        name: name ? `${name}·世界背景` : '世界背景',
        keys: name ? [name] : [],
        content,
        constant: true,
      });
    }
  }

  // 保底 2：作品结构概览（阶段/故事线/事件量），有内容才加
  const sentences = [];
  if (base) sentences.push(`作品采用「${base}」纪年。`);
  if (origin) sentences.push(`叙事起点是「${origin}」。`);
  if (chapterCount) sentences.push(`全书分为 ${chapterCount} 章，已抽取 ${(events || []).length} 个剧情事件。`);
  if (phaseNames.length) sentences.push(`剧情可划分为 ${phaseNames.length} 个阶段：${phaseNames.join('、')}。`);
  if (storyline.length) sentences.push(`主要故事线包括：${storyline.slice(0, 6).join('、')}。`);
  const overview = sentences.join('');
  if (sentences.length >= 2 && overview.length >= 40) {
    out.push({
      category: 'history',
      name: name ? `${name}·作品概览` : '作品概览',
      keys: name ? [name] : [],
      content: overview,
      constant: true,
    });
  }

  return out;
}

/**
 * 求解时间线。
 *
 * 三件事同时成立才算对：
 *   1. scope 分流 —— story 进主时间线，history（历史背景）单独一节，不淹没故事线
 *   2. 原点只能来自 story —— 否则会拿"百年前魔道东来"当年，整条轴错位
 *   3. 顺序 = 叙事顺序 —— 章节序优先，同章内让"锚点 → 由它推出的相对时间"有序
 *
 * @param {Array<{chapter:string, mentions:Array}>} mentions 各块的抽取结果
 * @param {object} origin 原点识别结果
 * @param {string[]} [chapterTitles] 按叙事顺序排列的块标题（来自 chunkText 的 index 顺序）。
 *   必须显式传入：chunkText 在 mergeShort 合并后会把合并块标成首块的标题，
 *   所以"标题"反推章节序是不可靠的。
 * @param {object[]|null} [displayEvents] 用来构成"事件时间线"的**剧情事件**（Step 2 产出）。
 *
 *   为什么要显式传进来：原来的时间线是拿「时间提及里的事件名」拼的
 *   （下面的 `m.type === 'absolute' && m.event`）。而抽取器把 `今天`／`第二天`／`四点了`
 *   这类**相对时间**标成 `relative`，全被那个条件过滤掉 —— 实测一篇小说 74 条提及里
 *   51 条是 relative、只有 1 条 absolute，于是时间线只剩 1 条、worldDate 变成「四点」，
 *   按天打包与阶段取文也跟着失去依据。
 *
 *   真正该进时间线的是**剧情事件**：它们本来就是叙事节点，且已由 `backfillEventTimes`
 *   对齐过时间与日期。传进来后，本函数仍负责排序、解析日期、挑 worldDate。
 */
export function solveTimeline(mentions, origin, chapterTitles = null, displayEvents = null) {
  // 分两类收集：scope=story 进主时间线，scope=history 单独放，不淹没故事线
  const storyTimes = new Map();   // 事件名 → 记录
  const historyTimes = new Map();
  const charBirths = new Map();
  let seq = 0;

  // 章节序：优先用 chunkText 给出的顺序表，退化为 mentions 的数组下标
  const chapIdx = new Map();
  if (Array.isArray(chapterTitles)) {
    chapterTitles.forEach((t, i) => { if (!chapIdx.has(t)) chapIdx.set(t, i); });
  }
  mentions.forEach((m, i) => { if (!chapIdx.has(m.chapter)) chapIdx.set(m.chapter, i); });
  const ci = (chapter) => chapIdx.get(chapter) ?? 999;

  const put = (map, rec) => {
    // 同名事件只留最早出现的那条（首见即定义）
    if (!map.has(rec.name)) map.set(rec.name, rec);
  };

  for (const { chapter, mentions: ms } of mentions) {
    for (const m of ms) {
      if (m.type !== 'absolute' || !m.event) continue;
      put(m.scope === 'history' ? historyTimes : storyTimes, {
        name: m.event, time: m.raw, precision: 'exact',
        chapter, quote: m.quote, seq: seq++, layer: 0,
      });
    }
  }

  // 相对时间：锚点若在 story 里，就按锚点推算；否则保持原样
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const { chapter, mentions: ms } of mentions) {
      for (const m of ms) {
        if (m.type !== 'relative' || !m.event || !m.anchor) continue;
        const map = m.scope === 'history' ? historyTimes : storyTimes;
        if (map.has(m.event)) continue;
        const anchor = storyTimes.get(m.anchor) || historyTimes.get(m.anchor);
        if (!anchor) continue;
        map.set(m.event, {
          name: m.event, time: `${anchor.time} + ${m.raw}`, precision: 'inferred',
          chapter, quote: m.quote, seq: seq++, layer: (anchor.layer || 0) + 1,
        });
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const { chapter, mentions: ms } of mentions) {
    for (const m of ms) {
      if (m.type !== 'age' || !m.subject) continue;
      // 描述性主语（"小女孩""中年女人"）与机构名不是人物，不能进人物时间线
      const subj = String(m.subject).trim();
      if (isDescriptorName(subj) || looksLikeNonPerson(subj)) continue;
      if (!charBirths.has(m.subject)) {
        charBirths.set(m.subject, {
          name: m.subject, birth: `（线索：${m.raw}）`,
          precision: 'inferred', source: 'age', chapter, quote: m.quote, seq: seq++, layer: 0,
        });
      }
    }
  }

  /**
   * 排序 = 叙事顺序。只用「首次被提到的位置」，规则简单且不会自相矛盾：
   *   先比章节序 —— 这是读者看到的顺序；
   *   同章节内，若一个是另一个的时间前缀（同一锚点链），短的在前，
   *     保证 药园立足(元和七年冬) → 夜访药园(+ 三日后) → 秘境试炼(+ 半月后)
   *     而不会出现「… → 元和八年春 → 元和七年冬 + 三日后」这种横跨章节的倒挂。
   *
   * 为什么绝对时间之间不按年份比大小：本作可能用「元和七年冬」这种自定义纪年，
   * 字典序不可靠；而像「1941年」这种来自历史叙述的年份，即使数字更小，
   * 它在叙事上也只是"顺带交代的背景"，不该跳到开场之前。
   */
  const posOf = (e) => String(e.time || '').split('+').map(s => s.trim()).filter(Boolean);
  const byNarrative = (a, b) => {
    const ca = ci(a.chapter);
    const cb = ci(b.chapter);
    if (ca !== cb) return ca - cb;

    const pa = posOf(a);
    const pb = posOf(b);
    const n = Math.min(pa.length, pb.length);
    let samePrefix = true;
    for (let i = 0; i < n; i++) {
      if (pa[i] !== pb[i]) { samePrefix = false; break; }
    }
    if (samePrefix && pa.length !== pb.length) return pa.length - pb.length;

    return a.seq - b.seq;
  };
  const sortByNarrative = (map) => [...map.values()].sort(byNarrative);

  /**
   * 事件时间线优先用**剧情事件**（displayEvents），退化为提及里的时间点。
   *
   * 用剧情事件时，章序仍按 `chapterTitles` 映射（`ci()`），排序交给下面的 byNarrative，
   * 日期解析照旧跑 —— 所以事件会带上真实日期，`worldDate` 也从它们里挑。
   */
  /**
   * 事件时间线优先用**剧情事件**（displayEvents），退化为提及里的时间点。
   *
   * ⚠️ 判据是 `Array.isArray` —— **空数组也算"调用方明确给了事件清单，只是它是空的"**。
   * 不能写成 `displayEvents.length > 0`：那样空数组会静默退回旧行为
   * （拿时间提及拼时间线），调用方以为传了空清单、实际拿到一堆时间短语。
   */
  const useDisplayEvents = Array.isArray(displayEvents);
  const events = useDisplayEvents
    ? displayEvents.map((e, i) => ({
      name: e?.name || `事件${i + 1}`,
      time: e?.dateText || e?.time || '',
      chapter: e?.chapter || '',
      quote: e?.quote || '',
      // dateKey 由 backfillEventTimes 算好，这里保留，供按天打包使用
      dateKey: e?.dateKey || null,
      pressure: e?.pressure || null,
      seq: i,
      layer: 0,
    }))
    : sortByNarrative(storyTimes);
  const history = sortByNarrative(historyTimes);

  /**
   * 被丢弃的相对时间提及：统计一下，供"时间线为空/稀疏"时给出可读原因。
   *
   * 这些提及（`今天`/`第二天`/`四点了`）**不适合直接进时间线** ——
   * 它们的锚点大多是 `当前叙事`／`章内叙述时点` 这类伪锚点，写进时间线只会是噪音。
   * 但它们的数量能说明"原文为什么给不出可定位的时间表"，比一句
   * 「原文未提供可定位的时间推进节点」有用得多。
   */
  const relStats = { relative: 0, vague: 0, periodic: 0 };
  let mentionTotal = 0;
  for (const { mentions: ms } of mentions) {
    for (const m of ms) {
      mentionTotal++;
      if (m?.type === 'relative') relStats.relative++;
      else if (m?.type === 'vague') relStats.vague++;
      else if (m?.type === 'periodic') relStats.periodic++;
    }
  }

  /**
   * 给每条事件补上**解析后的日期**（`date` 字段）。
   *
   * 为什么必须在这里做：`time` 是原文片段（`10月9日`、`现在是1961年`、`整个二月，甚至三月`），
   * 直接拿它当"当前时间"用会有两个毛病：
   *   · 状态栏显示不出年月日（或者显示成一句大白话）
   *   · 同一章内多个日期排不出先后
   *
   * `resolveDateYears` 按**叙事顺序**给缺年份的条目补年份（缺依据就留空），
   * 结果带 `inferred: true` 标记 —— 这是推断不是原文事实，必须可区分。
   */
  const partsByIndex = resolveDateYears(events);
  events.forEach((e, i) => {
    const p = partsByIndex.get(i);
    if (!p) return;
    e.date = {
      year: p.year, month: p.month, day: p.day,
      season: p.season, decade: p.decade,
      inferred: !!p.inferred,
      text: formatDate(p, { fallback: '' }),
    };
  });

  return {
    base: origin.base,
    origin: origin.origin,
    events,
    history,
    characters: sortByNarrative(charBirths),
    /**
     * 世界初始时间（给状态栏用）。
     *
     * 挑"最早且信息最全"的那条：优先有月日的，退而求其次要有年份的，
     * 都没有就用时间线首条的原文。
     *
     * 为什么要挑而不是直接取首条：首条常常只有年份（`1960年`），
     * 而真正能落进正文的日期（`1960年12月25日`）可能在它后面 ——
     * 直接取首条就是用户报的"状态栏时间没有几月几日"。
     */
    worldDate: pickWorldDate(events),
    /** 被丢弃的相对/模糊时间提及数：供日志与"时间线稀疏"的说明使用 */
    relativeStats: relStats,
    /** 时间提及总数（含进时间线的那条）：稀疏度诊断用 */
    _mentionTotal: mentionTotal,
    /** 时间线是否来自剧情事件（true）还是退化为提及时间点（false） */
    fromEvents: useDisplayEvents,
    unresolved: [],
    conflicts: [],
  };
}

/**
 * 状态栏的初始世界时间：从时间线里挑**最可信且最具体**的一条。
 *
 * 两条判据，**顺序是关键**：
 *
 * ① **明确年份能"纠正"推断年份，但只在两者真的不同、且明确的那个更早时**。
 *    实测踩过：`1960年10月9日`（年份是上下文推的）原本盖过了原文明确写的
 *    `1961年的4月8日` —— 显示一个错的年份会让 AI 在错误的年代里推进剧情，
 *    比"显示不出月日"严重得多。
 *    但反过来也要小心：如果推断出来的年份**与明确年份相同**（都是 1961），
 *    那"明确"这件事没有带来任何新信息，此时应当让**更精细**的那条赢
 *    （`1961年4月8日` 优于 `1961年`）—— 否则会为了一个没差别的标签丢掉月日。
 *
 * ② 年份不可比时，**精度高的优先**：有月日 > 有月 > 只有年。
 *    这一条直接对应用户反馈的"状态栏没有几月几日"。
 *
 * 都分不出时保留时间线里先出现的那条（＝叙事顺序，最不容易自相矛盾）。
 *
 * 补不出年份、也没有月日的（`天启三年春` 这类自定义纪年）会落到最后，
 * 直接用原文片段显示 —— 不硬凑成一个假日期。
 */
export function pickWorldDate(events) {
  const list = (Array.isArray(events) ? events : []).filter(e => e?.date);
  if (!list.length) return null;
  const precision = (d) => (d.day !== null ? 3 : d.month !== null ? 2 : d.year !== null ? 1 : 0);
  const yOf = (d) => (d.year === null || d.year === undefined ? null : d.year);

  let best = list[0];
  for (const e of list) {
    const ey = yOf(e.date);
    const by = yOf(best.date);
    const eKnown = ey !== null && !e.date.inferred;
    const bKnown = by !== null && !best.date.inferred;

    if (eKnown && !bKnown) {
      /**
       * 明确年份 vs 推断年份。
       * 推断值不同（或压根推不出来）→ 明确的接管，因为推断年份可能整个是错的。
       * 推断值**相同** → 不接管，继续比精度：此时"明确"没带来新信息，
       *   为它丢掉月日不值得（这正是 `1961年` 不该压过推断的 `1961年4月8日` 的原因）。
       */
      if (by === null || ey !== by) { best = e; continue; }
    } else if (!eKnown && bKnown) {
      // 反过来：除非推断值与已有的明确年份相同，否则不动
      if (ey === null || ey !== by) continue;
    } else if (ey !== null && by !== null && ey !== by) {
      if (ey < by) { best = e; continue; }
      continue;
    }

    if (precision(e.date) > precision(best.date)) { best = e; continue; }
    if (precision(e.date) < precision(best.date)) continue;
    if (compareDateParts(e.date, best.date) < 0) best = e;
  }

  const d = best.date;
  return {
    time: best.time,
    text: d.text || best.time,
    year: d.year ?? null,
    month: d.month ?? null,
    day: d.day ?? null,
    inferred: !!d.inferred,
    precision: d.day !== null ? 'day' : d.month !== null ? 'month' : d.year !== null ? 'year' : 'coarse',
    sourceEvent: best.name || null,
  };
}

/**
 * 条目正文的归一化：把 `content_yaml` / `content` / 中文键名都取成最终写入世界书的字符串。
 *
 * 为什么需要：Step 5 的 prompt 现在要求返回 `content_yaml`（结构化 YAML 文本），
 * 但模型有时仍按旧格式返回 `content`，也可能返回 `正文`/`内容`。
 * 只认一个键就会静默拿到 undefined —— 上一轮"人物条目全丢"就是这么来的。
 *
 * 返回值统一是**字符串**（YAML 文本或普通文本），最终直接写进世界书的 content 字段；
 * YAML 只是格式约定，不影响 ST 导入（对 ST 来说它就是一段长文本）。
 */
export function pickContent(item) {
  if (!item || typeof item !== 'object') return '';
  const raw = pickField(item, [
    'content_yaml', 'contentYaml', 'content', '正文', '内容', 'yaml', 'body', 'text',
  ]);
  if (raw === undefined || raw === null) return '';
  // 模型偶尔会把 YAML 当对象返回（而不是字符串），这里序列化回去
  if (typeof raw === 'object') {
    try { return YAML.stringify(raw).trim(); } catch { return ''; }
  }
  return String(raw).trim();
}

/**
 * 判断一段正文是否"只是占位符"。
 * YAML 形态下不能只看整段 —— 模板里允许单个字段是"未提及"，
 * 只有**整段就是一句未提及**才算占位符。
 */
export function isPlaceholderBody(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  if (s.length < 10) return true;
  const PLACEHOLDER_RE = /^(原文未(提及|说明|给出)|暂无(相关)?(信息|资料|内容)|待补充|此处(填写|省略)|略|无|n\/?a|todo|tbd|待定)[。.！!]?$/i;
  if (PLACEHOLDER_RE.test(s)) return true;

  // YAML 形态：把"key: 未提及"这类行去掉后，如果没剩任何实质内容，就是占位符
  const lines = s.split('\n');
  const hasStructure = lines.some(l => /^\s*[\w\u4e00-\u9fa5][^:]*:\s*\S/.test(l));
  if (hasStructure) {
    const UNMENTIONED = /^(未提及|未知|无|暂无|不详|n\/?a|none|unknown)$/i;
    /** 标识类字段：它们只是"条目名/类型"，不构成正文内容 */
    const IDENTITY_KEYS = new Set(['name', 'title', 'type', '类型', '条目名', '名称', '时间', '原著立场', '前置']);
    const meaningful = lines.filter(l => {
      // 缩进行是块标量的**内容**，字面量标记（| / >）已经在上面被剥掉了
      if (/^\s/.test(l)) return l.trim().length > 0 && !UNMENTIONED.test(l.trim());
      const m = /^\s*([^:]+):\s*(.*)$/.exec(l);
      if (!m) return false;
      // 标识类字段不算实质内容：只有条目名、没有任何描写，仍然是空壳条目
      if (IDENTITY_KEYS.has(m[1].trim())) return false;
      const v = m[2].trim();
      if (!v) return false;
      // ⚠️ `key: |` 的"值"是块标量标记，不是内容 ——
      // 不排除它的话，「全是未提及」的条目会被误判成有实质内容
      if (/^[|>][-+]?\d*$/.test(v)) return false;
      return !UNMENTIONED.test(v);
    });
    if (meaningful.length > 0) return false;
    // 全是"未提及" → 再看块标量里有没有实际文字
    const blockText = lines
      .filter(l => !/^\s*[^:]+:/.test(l))
      .join('')
      .replace(/[|\->#\s]/g, '');
    if (blockText.length >= 20 && !UNMENTIONED.test(blockText)) return false;
    return true;
  }
  return false;
}

/**
 * 校验一段 content_yaml 是否**结构完整**（模板字段是否都在）。
 * 只用于产出诊断信息，不作为丢弃依据 —— 缺字段比整条丢掉好。
 */
export function inspectContentYaml(text) {
  const s = String(text || '');
  const keys = [];
  for (const line of s.split('\n')) {
    const m = /^([^\s:#][^:]*):\s*(\||\S.*)?$/.exec(line);
    if (m) keys.push(m[1].trim());
  }
  // 计算"实质字数"：去掉纯"未提及"的字段值与 YAML 标点
  const chars = s.replace(/[\s|>#\-]/g, '').length;
  return { keys, keyCount: keys.length, chars };
}

/** 事件条目的字段名归一化（模型常用中文键名） */function normalizeEventItem(e) {
  if (!e || typeof e !== 'object') return null;
  const g = (names) => pickField(e, names);
  return {
    ...e,
    name: String(g(['name', '事件名', '名称', '事件', 'title']) ?? '').trim(),
    storyline: String(g(['storyline', '故事线', '线', '所属故事线']) ?? '主线').trim() || '主线',
    chapter: g(['chapter', '章节', '章节号']) ?? e.chapter,
    quote: g(['quote', '原文', '引文', '摘录']) ?? e.quote,
    canon: String(g(['canon', '原著', '正史', '描述', '说明']) ?? '').trim(),
    pressure: (() => {
      const raw = String(g(['pressure', '压力', '压力值']) ?? '').trim().toLowerCase();
      if (['core', 'buffer', 'flexible'].includes(raw)) return raw;
      // 中文压力值映射
      if (/^(核|核心|关键)$/.test(raw)) return 'core';
      if (/^(缓|缓冲)$/.test(raw)) return 'buffer';
      if (/^(弹|弹性|灵活)$/.test(raw)) return 'flexible';
      return 'buffer';
    })(),
    prerequisites: e.prerequisites || {},
    interventions: asArray(e.interventions),
  };
}

export function dedupeEvents(eventsInput) {
  const events = asArray(eventsInput).map(normalizeEventItem).filter(Boolean);
  const seen = new Map();
  const order = { core: 3, buffer: 2, flexible: 1 };
  for (const e of events) {
    if (!e.name) continue;
    if (!seen.has(e.name)) {
      seen.set(e.name, { ...e, interventions: e.interventions || [] });
    } else {
      const prev = seen.get(e.name);
      prev.interventions = [...prev.interventions, ...(e.interventions || [])];
      if ((order[e.pressure] || 0) > (order[prev.pressure] || 0)) prev.pressure = e.pressure;
      if (prev.storyline === '主线' && e.storyline && e.storyline !== '主线') {
        prev.storyline = e.storyline;
      }
    }
  }
  return [...seen.values()];
}

export function groupByStoryline(events) {
  const groups = {};
  for (const e of events) {
    const line = e.storyline || '主线';
    if (!groups[line]) groups[line] = { events: [], pressures: [] };
    groups[line].events.push(e.name);
    groups[line].pressures.push(e.pressure);
  }
  const result = {};
  for (const [line, d] of Object.entries(groups)) {
    const coreCount = d.pressures.filter(p => p === 'core').length;
    result[line] = {
      events: d.events,
      stage: '起点',
      deviation: 0,
      core: coreCount >= d.pressures.length / 2,
    };
  }
  return result;
}

export function extractPhaseText(phase, events, chunks) {
  const startIdx = events.findIndex(e => e.name === phase.startEvent);
  const endIdx = events.findIndex(e => e.name === phase.endEvent);
  if (startIdx < 0 || endIdx < 0) return '';
  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const chapters = new Set(events.slice(lo, hi + 1).map(e => e.chapter).filter(Boolean));
  return chunks.filter(c => chapters.has(c.title)).map(c => c.text).join('\n\n');
}

export function buildVariables(timeline, events, storylines, characters, phases) {
  // 键名统一走 varKey()：带 `.` 或空白的名字会把变量路径切错层（详见 varKey 注释）
  const eventsVar = {};
  for (const e of events) {
    eventsVar[varKey(e.name)] = { status: 'pending', deviation: 0, pressure: e.pressure || 'buffer' };
  }

  // 兜底 1：事件全空时至少放一个占位事件。
  // 空 events 会让「导演指令」永远显示"（无进行中事件）"、变量更新规则无事可做，
  // 整张卡的 EJS 全在空转 —— 与其空着，不如给一个 ongoing 的开场占位。
  if (Object.keys(eventsVar).length === 0) {
    eventsVar['开场'] = { status: 'ongoing', deviation: 0, pressure: 'buffer' };
  }

  // 兜底 2：故事线全空时至少放一条主线，指向实际存在的事件键
  /**
   * 故事线（`storylines` 参数）**不再写进变量树** —— 见下方注释，
   * 它改为世界书里的分段触发条目。这里只保留变量树真正需要的东西。
   */

  /**
   * 初始状态：让**第一个事件**处于 ongoing。
   *
   * 否则所有事件都是 pending，「导演指令」的 `find(status === 'ongoing')` 取不到东西，
   * 【正在发生】一开始就是空的 —— 卡刚导入时导演指令等于没内容，
   * 只能靠 AI 某轮自己把状态改成 ongoing 才恢复。
   * 故事总要有一个正在发生的开场事件，这里按叙事顺序取第一个。
   */
  if (Object.keys(eventsVar).length > 0 && !Object.values(eventsVar).some(v => v.status === 'ongoing')) {
    const firstKey = varKey((events || [])[0]?.name)
      || timeline?.origin?.event && varKey(timeline.origin.event)
      || Object.keys(eventsVar)[0];
    if (firstKey && eventsVar[firstKey]) eventsVar[firstKey].status = 'ongoing';
  }

  // 人物变量只给「会有互动」的角色：主角 + 主要NPC + 次要NPC。
  //
  // 之前这里用的是 timeline.characters（年龄提及的主语），于是变量树里会出现
  // 「小女孩」「女人」「人」这种键 —— 状态栏和 AI 更新规则全都建立在不存在的角色上。
  //
  // 分层之后（见 classifyByStoryShare）：路人NPC **不建变量**。
  // 理由是它们在原文里往往只被提一两次，给它们立好感度只会污染变量更新规则 ——
  // AI 每轮都要在这些"永远不会变化的字段"上做无用判断，还容易写错路径。
  // 条数上限仍然保留：次要NPC 可能有十几个，全建进去状态栏会变成一张花名册。
  const charsVar = {};
  const tracked = [...(characters || [])]
    .filter(c => c?.name)
    // 兼容两种输入：Step 5 产出的自带 tier；其它调用方只有 role（normalizeTier 会映射）
    .map(c => ({ ...c, tier: c.tier || normalizeTier(c.role, '次要NPC') }))
    .filter(c => c.tier !== '路人NPC')
    .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9)
      || (b.storyRatio ?? 0) - (a.storyRatio ?? 0))
    .slice(0, 12);
  for (const c of tracked) {
    charsVar[varKey(c.name)] = { affinity: 0, state: '正常' };
  }

  /**
   * 故事线**不再进变量树**，改为世界书里的分段触发条目（见 storylineEntries）。
   *
   * 为什么搬走：`custom.storylines` 原本每线存 `{events, stage, deviation, core}`，
   * 而 `stage` 是 `groupByStoryline` 里**硬编码的 `'起点'`** ——
   * 没有任何代码消费它，只有 B2 的更新规则让 AI 去写（写了也没人看）。
   * `deviation` 同理，事件的偏离度已经在 `events.<名>.deviation` 里了。
   * 等于每张卡都在变量树里供着一份没有人读的状态。
   *
   * 搬进世界书后：不占 B 包常驻预算，而且能按线触发 ——
   * 用户实际需要的是"这条线现在到哪了"，不是一份全量线表常驻。
   */

  // 主时间线的第一个时点作为世界时间的起点；没有 story 事件时退回 '开场'
  //
  // world.phase 必须落进「角色阶段」条目的人设增量表里，否则那条 EJS 的
  // `人设增量表[阶段]` 取不到值 → 什么都不输出（静默失效）。
  // 而增量表只收**有 characterDeltas 的阶段**，且恒含 '起始' 兜底键：
  //   - 首个阶段有增量 → 用它
  //   - 首个阶段没有增量 → 用 '起始'（对应"无变化，按世界书基线人设演绎"）
  const firstWithDeltas = phases.find(p => p?.characterDeltas?.length)?.name;
  const initialPhase = (phases[0]?.characterDeltas?.length && phases[0].name)
    ? phases[0].name
    : (firstWithDeltas || '起始');

  // 世界初始时间：优先用"最早且最具体"的那条（见 pickWorldDate）。
  // 直接取 events[0].time 时，首条常常只有年份（`1960年`），
  // 于是状态栏显示不出几月几日 —— 用户实际反馈的问题。
  const wd = timeline.worldDate || null;
  const worldTime = wd?.time || timeline.events?.[0]?.time || '开场';

  return {
    world: {
      time: worldTime,
      /**
       * 结构化日期 + 可读文本。
       *
       * `time` 保留原文片段（`现在是1961年` 这种也能原样显示），
       * `date.text` 是解析后的规范写法（`1961年4月8日`），状态栏用后者 ——
       * 这样"没有几月几日"和"显示成一句大白话"两个毛病同时解决。
       * `inferred: true` 表示年份是按上下文推的，不是原文写的。
       */
      date: {
        text: wd?.text || worldTime,
        year: wd?.year ?? null,
        month: wd?.month ?? null,
        day: wd?.day ?? null,
        precision: wd?.precision || 'coarse',
        inferred: !!wd?.inferred,
      },
      phase: initialPhase,
    },
    events: eventsVar,
    characters: charsVar,
    // 故事线已搬进世界书（见 storylineEntries），变量树里不再保留 custom.storylines
  };
}

/**
 * 故事线条目正文：一条线一段，供**分段触发**。
 *
 * 每条线给出：线名、事件顺序、核心/支线、压力分布。
 * 触发词 = 线名 + 该线事件名（提到线上任一事件就加载这条线的全貌）。
 *
 * 刻意**不再写 stage / deviation**（原来在变量里，是死字段）；
 * 线级的推进状态由 `events.<名>.status` 推导，不必重复存一份。
 */
export function formatStorylineEntry(name, line, allEvents = []) {
  const evNames = Array.isArray(line?.events) ? line.events : [];
  const byName = new Map((Array.isArray(allEvents) ? allEvents : []).map(e => [e.name, e]));
  const pressureLabel = { core: '核', buffer: '缓', flexible: '弹' };
  const lines = [
    `【故事线·${name}】`,
    `性质：${line?.core ? '主线' : '支线'}`,
    `事件顺序（${evNames.length} 个）：`,
  ];
  for (const [i, n] of evNames.entries()) {
    const e = byName.get(n);
    const when = e?.dateText || e?.time || '（未定）';
    const pressure = pressureLabel[e?.pressure] || '';
    lines.push(`  ${i + 1}. ${n}　${when}${pressure ? `　[${pressure}]` : ''}`);
  }
  if (!evNames.length) lines.push('  （该线暂无事件）');
  return lines.join('\n');
}

/** 故事线条目的触发词：线名 + 该线所有事件名 */
export function storylineKeys(name, line) {
  const keys = [];
  const seen = new Set();
  const push = (k) => {
    const s = String(k || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    keys.push(s);
  };
  push(name);
  for (const n of Array.isArray(line?.events) ? line.events : []) push(n);
  return keys;
}

/**
 * 校验 phase ↔ 人设增量表 的对齐（返回问题列表，空数组代表没问题）。
 * 增量表的键 = 各阶段名（只收有 characterDeltas 的） + '起始'。
 */
export function checkPhaseAlignment(variables, phases) {
  const problems = [];
  const table = new Set(['起始']);
  for (const p of phases || []) {
    if (p?.characterDeltas?.length && p.name) table.add(p.name);
  }
  const initial = variables?.world?.phase;
  if (initial === undefined || initial === null || initial === '') {
    problems.push('variables.world.phase 为空 —— 角色阶段条目会走 defaults(\'起始\')');
  } else if (!table.has(initial)) {
    problems.push(`初始阶段「${initial}」不在人设增量表里（表内：${[...table].join('、')}）`);
  }
  return problems;
}

export function initializeUserNamespace(variables, userMode) {
  if (userMode.mode === 'protagonist') {
    const name = userMode.protagonistName;
    // 变量树里的键是 varKey 之后的名字，查表也要用同一个形式
    const key = name ? varKey(name) : '';
    if (key && variables.characters[key]) {
      variables.user = { name: key, ...variables.characters[key] };
      delete variables.characters[key];
    } else {
      variables.user = { name: name || '{{user}}' };
    }
  } else if (userMode.mode === 'participant') {
    variables.user = {
      name: '{{user}}',
      position: '未知',
      identity: '外来者',
      skills: [],
    };
  } else {
    variables.user = { name: '{{user}}', watching: '主角' };
  }
}

/**
 * 按「天」组装剧情条目的正文。
 *
 * 用户诉求：「有些剧情在一天内是连续的话就直接将那一天的内发生的剧情打包，不要拆分」。
 *
 * 一天一条，条目标题用日期；条目里逐个事件列出，各自保留完整信息
 * （时间 / 原著 / 压力 / 在场 / 地点 / 干预分支），所以打包**不丢信息**。
 *
 * 触发词是组内所有事件触发词的并集 —— 提到当天任何一个人、地点或日期
 * 都能把这天的剧情整包加载，这正是"不要拆分"想要的效果。
 */
export function formatDayEntry(group, eventContents) {
  const evs = group.events || [];
  if (evs.length === 1) {
    // 单独一天的事件保持原格式，不必套一层"当天剧情"的壳
    const e = evs[0];
    return eventContents?.get?.(e.name) || formatEventEntry(e);
  }
  const head = `【${group.dateText || '同日'} · 当日剧情】`;
  const blocks = evs.map(e => {
    const rich = eventContents?.get?.(e.name);
    const body = rich || formatEventEntry(e);
    // 组内每条用 `·` 起头，避免与条目内的【】层级冲突
    return body.split('\n').map((l, i) => (i === 0 ? `· ${l}` : `  ${l}`)).join('\n');
  });
  return [head, ...blocks, '', '（以上为同一天内连续发生的剧情，按先后顺序排列）'].join('\n');
}

/** 按天的条目注释：`[event] 6月1日（2 个事件）` */
export function dayEntryComment(group) {
  const evs = group.events || [];
  if (evs.length === 1) return `[event] ${evs[0].name}`;
  return `[event] ${group.dateText || '同日'}（${evs.length} 个事件）`;
}

/** 按天的触发词：组内并集（保序去重），并把事件名放在最前 */
export function dayEntryKeys(group, { protagonist = '' } = {}) {
  const evs = group.events || [];
  if (evs.length === 1) return deriveEventKeys(evs[0], { protagonist });
  const keys = [];
  const seen = new Set();
  const push = (k) => {
    const s = String(k || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    keys.push(s);
  };
  // 事件名优先（用户按名字找事件时最先命中）
  for (const e of evs) push(e.name);
  // 组日期本身：原文很可能直接写「6月1日」而不带年份，那个形式也要能触发
  const token = dateTriggerToken(parseChainedTime(group.dateText || group.events[0]?.time));
  if (token) push(token);
  for (const e of evs) for (const k of deriveEventKeys(e, { protagonist, max: 6 })) push(k);
  return keys;
}

/**
 * 原著剧情简介的长度上限。
 *
 * 它是**常驻条目**（每轮都占上下文），prompt 里要求 600-1000 字；
 * 这里再兜一道硬上限，防止模型超写把正文预算挤掉。
 */
export const SYNOPSIS_MAX_CHARS = 1200;

export function assembleWorldbook(timeline, events, characters, worldbookItems, { title, eventContents, protagonist = '', storylines = {}, synopsis = '' } = {}) {
  const entries = [];

  entries.push({
    id: 0, keys: [], comment: '[timeline]',
    content: formatTimeline(timeline),
    constant: true, enabled: true,
    insertion_order: 1, position: 'after_char',
    selective: false, use_regex: false, secondary_keys: [],
    extensions: { position: 4, depth: 0, group: 'timeline' },
  });

  /**
   * 原著剧情简介（常驻）。
   *
   * 角色卡原有的条目都在讲"某一条信息"，没有一条讲"整部作品在讲什么"。
   * AI 只靠事件条目写对话，容易把人物动机与剧情走向带偏 ——
   * 用户要的正是这份可参考的梗概。
   *
   * 常驻 = 每轮都占上下文，所以 prompt 里限了 600-1000 字；
   * 这里再兜一道长度上限，防止模型超写把正文预算挤掉。
   */
  if (synopsis) {
    const body = String(synopsis).trim().slice(0, SYNOPSIS_MAX_CHARS);
    entries.push({
      id: entries.length, keys: [], comment: '[synopsis]',
      content: `【原著剧情简介】\n${body}`,
      constant: true, enabled: true,
      // insertion_order 2 = 紧跟 [timeline]，排在其它常驻条目之前
      insertion_order: 2, position: 'after_char',
      selective: false, use_regex: false, secondary_keys: [],
      extensions: { position: 4, depth: 0, group: 'synopsis', chars: body.length },
    });
  }

  const CAT_ORDER = {
    map_world: 5, system_realm: 6, map_region: 10, map_location: 11,
    system_item: 12, system_skill: 13, system_faction: 14, system_bloodline: 15,
    history: 30,
  };

  for (const w of worldbookItems) {
    entries.push({
      id: entries.length,
      keys: w.keys || [],
      comment: `[${w.category}] ${w.name}`,
      content: w.content,
      constant: w.category === 'map_world' || w.category === 'system_realm',
      enabled: true,
      insertion_order: CAT_ORDER[w.category] || 50,
      position: 'after_char',
      selective: true, use_regex: true, secondary_keys: [],
      extensions: { position: 4, depth: 0, group: w.category },
    });
  }

  // 故事线条目：一条线一条，按线触发（原来在变量树里，是死字段）
  for (const [name, line] of Object.entries(storylines || {})) {
    if (!name || !line) continue;
    entries.push({
      id: entries.length,
      keys: storylineKeys(name, line),
      comment: `[storyline] ${name}`,
      content: formatStorylineEntry(name, line, events),
      constant: false, enabled: true,
      insertion_order: 24, position: 'after_char',
      selective: true, use_regex: true, secondary_keys: [],
      extensions: {
        position: 4, depth: 0, group: 'storyline',
        events: Array.isArray(line.events) ? line.events : [],
        core: !!line.core,
      },
    });
  }

  // 剧情条目：**按天打包**（同一天内连续发生的剧情合成一条，不拆分）
  for (const group of groupEventsByDay(events)) {
    entries.push({
      id: entries.length,
      // 多组触发词：组内所有事件名 + 日期 + 在场人物 + 地点（见 deriveEventKeys）
      keys: dayEntryKeys(group, { protagonist }),
      comment: dayEntryComment(group),
      content: formatDayEntry(group, eventContents),
      constant: false, enabled: true,
      insertion_order: 25, position: 'after_char',
      selective: true, use_regex: true, secondary_keys: [],
      extensions: {
        position: 4, depth: 0, group: 'event',
        // 结构化字段：便于按天筛选，不必解析注释
        dateKey: group.dateKey || null,
        dateText: group.dateText || null,
        eventNames: group.events.map(e => e.name),
      },
    });
  }

  for (const c of characters) {
    // 分层写进注释：[character] 名 → [character·主要NPC] 名
    // 用户在 ST 的世界书面板里能一眼看出这张卡给谁写了多少戏份，
    // 也便于按层筛选/禁用（比如把路人NPC 整批关掉省 token）。
    const tier = c.tier || normalizeTier(c.role, '次要NPC');
    const tierTag = tier === '主角' ? '' : `·${tier}`;
    /**
     * ⚠️ 正文必须走 `pickContent`，不要直接读 `c.content`。
     *
     * 项目里人物档案的键名有两种：pipeline 内部用 `content`，
     * 而 `image_card.js` 与 augment 的抽取结果用 **`content_yaml`**。
     * 原来这里写的是 `content: c.content` —— 传 `content_yaml` 的调用方
     * 会得到**内容为空的人物条目**：keys 有（名字还在）、正文是空串，
     * 于是这个角色在卡里"存在但没有任何信息"。
     *
     * `pickContent` 同时认 content_yaml / content / 正文 / yaml 等写法，
     * 与 normalizeWorldbookItems 等处保持同一口径。
     */
    entries.push({
      id: entries.length, keys: c.keys || [c.name],
      comment: `[character${tierTag}] ${c.name}`,
      content: pickContent(c),
      constant: false, enabled: true,
      insertion_order: 20, position: 'after_char',
      selective: true, use_regex: true, secondary_keys: [],
      extensions: {
        position: 4, depth: 0, group: 'character',
        // 结构化字段：想让脚本按层筛选时不必去解析注释文本
        tier,
        storyChapters: c.storyChapters ?? null,
        storyRatio: c.storyRatio ?? null,
      },
    });
  }

  // 世界书名必须**每张卡唯一**：ST 会按 character_book.name 把内嵌世界书落盘成
  // data/<user>/worlds/<name>.json，并把 data.extensions.world 绑到这个名字上。
  // 如果所有卡都用同一个固定名，导入第二张卡会直接覆盖第一张卡的世界书，
  // 而第一张卡的 extensions.world 仍指向这个名字 —— 于是它开始加载第二部小说的
  // 时间线、变量与人物（ST 自己也会提示 "It will overwrite the World/Lorebook with the same name"）。
  // A 包的 worldbook.json 导出/导入用的也是同一个世界书名，同样会互相覆盖。
  const bookName = title ? `生成的世界设定集 · ${title}` : '生成的世界设定集';

  /**
   * 常驻条目预算裁剪。
   *
   * 为什么需要：常驻（`constant: true`）条目**每轮都注入**，是固定开销；
   * 而抽取是逐批做的，同一类会产出多条**语义重叠**的条目 ——
   * 实测《示例小说 A》产出 4 条 `system_realm`：
   *   「修仙境界体系」「修行境界与灵根体系」「灵根资质」「修仙境界与灵根资质」
   * 它们都被 `category === 'system_realm'` 判成常驻，合计 1803 tok，
   * 把 A 包顶到 3510 tok（上限 2000，超 75%）。
   * 而 `validate` 只发警告、不裁剪 —— 于是超支原样进了卡。
   *
   * 裁剪规则（按优先级，超出预算就降级为**按键触发**）：
   *   1. 世界概览（`map_world`）—— 世界观底座，必须常驻
   *   2. 每类 `system_realm` **只留第一条** —— 同类重复是超支主因
   *   3. 时间线与原著简介 —— 高频参考
   *   4. 其余常驻条目按原顺序留到预算用尽
   *
   * 降级**不丢内容**：条目仍在，只是改为按 keys 触发（keys 来自条目名，
   * 本来就能被正文命中），所以只是从"每轮都注入"变成"相关时才注入"。
   */
  {
    const budget = A_PACK_TOKEN_BUDGET;
    const est = (e) => estimateTokens(String(e.content || ''));
    const total = () => entries.filter(e => e.constant).reduce((s, e) => s + est(e), 0);

    /**
     * 第一步（**始终执行**）：同类只留第一条常驻。
     *
     * 这一步不依赖预算 —— 抽取是逐批做的，同一类产出多条语义重叠的条目是常态
     * （实测 4 条 `system_realm` 都叫"修仙境界体系/修行境界与灵根体系/灵根资质"…），
     * 让它们**全都**每轮注入本身就是错的，跟总预算够不够无关。
     */
    const demote = [];
    const seenGroup = new Set();
    for (const e of entries) {
      if (!e.constant) continue;
      const g = e.extensions?.group;
      // 只对这类"同一套体系会重复抽取"的分组去重；其余分组可以有多条常驻
      if (g !== 'system_realm') continue;
      if (seenGroup.has(g)) demote.push(e); else seenGroup.add(g);
    }

    /**
     * 第二步（仅超预算时）：从后往前继续降级，保住世界概览／时间线／简介。
     */
    const PROTECTED = new Set(['map_world', 'timeline', 'synopsis']);
    const remaining = () => total() - demote.reduce((s, e) => s + est(e), 0);
    if (remaining() > budget) {
      for (let i = entries.length - 1; i >= 0; i--) {
        if (remaining() <= budget) break;
        const e = entries[i];
        if (!e.constant || demote.includes(e)) continue;
        if (PROTECTED.has(e.extensions?.group)) continue;
        demote.push(e);
      }
    }

    if (demote.length) {
      const before = total();
      for (const e of demote) {
        e.constant = false;
        // 降级后必须有 keys，否则条目永远触发不了 —— 内容等于丢了
        if (!Array.isArray(e.keys) || !e.keys.length) {
          const nm = String(e.comment || '').replace(/^\[[^\]]*\]\s*/, '').trim();
          if (nm) e.keys = [nm];
        }
      }
      const after = total();
      entries.packNotice = before > budget
        ? `常驻超预算（${before} > ${budget} tok）：已把 ${demote.length} 条降级为按键触发`
          + `（内容不丢，现为 ${after} tok）`
        : `同类常驻去重：已把 ${demote.length} 条重复 system_realm 降级为按键触发`;
    }
  }

  return { entries, name: bookName };
}

function formatTimeline(tl) {
  const lines = [`【时间线 · 基准：${tl.base || '相对纪元'}】`];
  if (tl.origin?.event) lines.push(`原点：${tl.origin.event}`);

  /**
   * 时间线稀疏/为空时的说明。
   *
   * 不能只说"原文未提供" —— 那等于什么都没说。原文其实常常给了大量**相对时间**
   * （`今天`/`第二天`/`四点了`），只是它们没有可定位的绝对锚点，
   * 写进时间线只会是噪音。把真实原因与数量说出来，AI 才知道该怎么处理。
   */
  const relNote = (hasList) => {
    const s = tl.relativeStats;
    if (!s) return null;
    const parts = [];
    if (s.relative) parts.push(`${s.relative} 条相对时间（今天/第二天之类）`);
    if (s.vague) parts.push(`${s.vague} 条模糊时间`);
    if (s.periodic) parts.push(`${s.periodic} 条周期性时间`);
    if (!parts.length) return null;
    const tail = hasList
      ? '下面的顺序按叙事先后，不代表精确的日历间隔。'
      : '因此无法给出精确的日期对照。';
    return `原文的时间线索以${parts.join('、')}为主，缺少可定位的绝对纪年 —— ${tail}`;
  };

  if (!tl.events?.length) {
    lines.push('', '【说明】');
    const note = relNote(false);
    lines.push(note || '原文未提供可定位的时间推进节点，因此不给出事件时间表。');
    if (tl.origin?.raw) lines.push(`可参照的时间锚点：「${tl.origin.raw}」（${tl.origin.event || '故事开场'}）。`);
    lines.push('推进时按剧情自然节奏，不要假定发生过大幅时间跳跃。');
    // 历史背景仍然照常给出（它对设定理解有用）
    if (tl.history?.length) {
      lines.push('', '【历史背景】（故事开始之前的事，仅作设定参考，不作为情节节点）');
      for (const h of tl.history) lines.push(`${h.time}  ${h.name}`);
    }
    if (tl.characters?.length) {
      lines.push('', '【人物时间线】');
      for (const c of tl.characters) lines.push(`${c.name}  ${c.birth}`);
    }
    return lines.join('\n');
  }

  lines.push('', '【事件时间线】');
  for (const e of tl.events) {
    // 有解析出来的日期就优先用它（`1961年4月8日`），否则退回原文片段（`四点了`）
    const when = e.date?.text || e.time || '（未定）';
    lines.push(`${when}  ${e.name}`);
  }
  // 时间线够稀疏时补一句解释，避免 AI 以为"故事没有时间推进"
  if (tl.events.length <= 2) {
    const note = relNote(true);
    if (note) lines.push('', `【说明】${note}`);
  }

  // 历史背景单独一节：它是世界观参考资料，不是主角要经历的情节节点。
  // 之前混在主时间线里，一部长篇能塞进十几条历史年份，把真正的故事线淹没。
  if (tl.history?.length) {
    lines.push('', '【历史背景】（故事开始之前的事，仅作设定参考，不作为情节节点）');
    for (const h of tl.history) lines.push(`${h.time}  ${h.name}`);
  }

  if (tl.characters?.length) {
    lines.push('', '【人物时间线】');
    for (const c of tl.characters) lines.push(`${c.name}  ${c.birth}`);
  }
  return lines.join('\n');
}

function generateB2(variables) {
  const lines = [
    'task: 在每次回复末尾输出 <update> 标签，按以下规则更新变量',
    '',
    '变量:',
    '  stat_data.world.time:',
    '    规则: 剧情推进后更新',
    '  stat_data.world.phase:',
    '    规则: 关键事件完成后切换，取值为 B4 中定义的阶段名',
    '  stat_data.world.date:',
    '    规则: 一旦剧情中出现「几月几日」或明确日期，必须同步更新 date.text / date.month / date.day',
    '         （日期比 world.time 更具体，状态栏显示的是 date.text）',
    '  stat_data.events.<事件名>.status:',
    '    规则: pending → ongoing → done / diverged',
    '  stat_data.events.<事件名>.deviation:',
    '    规则: 用户每做出与原作不同的关键选择，+20~40',
    '  stat_data.characters.<人名>.affinity:',
    '    规则: 0-100，根据互动 ±(3~6)',
    '  stat_data.characters.<人名>.state:',
    '    规则: 剧情导致的状态变化',
    '',
    'format: |-',
    '  <update>',
    '  <update_analysis>',
    '  ${ 判断本轮推进了哪些事件；判断用户是否干预；逐一检查变量变化 }',
    '  </update_analysis>',
    '  _.set(stat_data.world.time, "${旧值}", "${新值}"); // ${理由}',
    '  _.set(stat_data.world.date.text, "${旧值}", "${新值}"); // ${理由}（有月日就写全，如「1961年4月8日」）',
    '  _.set(stat_data.events.${事件名}.status, "${旧值}", "${新值}"); // ${理由}',
    '  _.set(stat_data.events.${事件名}.deviation, ${旧值}, ${新值}); // ${理由}',
    '  _.set(stat_data.characters.${人名}.affinity, ${旧值}, ${新值}); // ${理由}',
    '  </update>',
  ];
  return lines.join('\n');
}

function validate(worldbook, preset, limits = DEFAULT_LIMITS, keyLimits = null) {
  const warnings = [];
  for (const e of worldbook.entries) {
    if (!e.enabled) warnings.push(`条目 ${e.id} 未启用`);
    if (!e.constant && (!e.keys || e.keys.length === 0)) warnings.push(`条目 ${e.id} keys 为空`);
  }
  const aTokens = estimateTokens(worldbook.entries.filter(e => e.constant).map(e => e.content).join(''));
  if (aTokens > limits.maxA) warnings.push(`A 包常驻 ${aTokens} token 超过上限 ${limits.maxA}`);
  const bTokens = estimateTokens(JSON.stringify(preset));
  if (bTokens > limits.maxB) warnings.push(`B 包常驻 ${bTokens} token 超过上限 ${limits.maxB}`);

  // key 触发条目的预算：条目本身可以很详细（不占常驻），但要盯住单条与单轮峰值
  const KL = keyLimits || KEY_ENTRY_LIMITS;
  const keyEntries = worldbook.entries.filter(e => !e.constant && e.enabled);
  let peakTokens = 0;
  for (const e of keyEntries) {
    const t = estimateTokens(e.content || '');
    peakTokens += t;
    if (t > KL.single) {
      warnings.push(`条目「${e.comment}」${t} token 超过单条上限 ${KL.single}（内容可能过长）`);
    }
  }
  // 峰值用"合计"近似最坏情况：用户可能一轮里触发全部 key 条目
  if (peakTokens > KL.peak) {
    warnings.push(`key 触发条目合计 ${peakTokens} token 超过单轮峰值上限 ${KL.peak}`
      + `（${keyEntries.length} 条；同场触发多条时可能挤压上下文）`);
  }

  if (!preset.b1_variables.includes('world:')) warnings.push('B1 缺少 world');
  if (!preset.b1_variables.includes('events:')) warnings.push('B1 缺少 events');
  if (!preset.b1_variables.includes('user:')) warnings.push('B1 缺少 user');
  if (!worldbook.entries.length) warnings.push('世界书为空');
  return warnings;
}

// ============================================================
// 完整角色卡（chara_card_v3）
// ============================================================

/** 把 LLM 返回的字段规整成可用的形态，缺什么补什么 */
function normalizeCardFields(raw, { title, protagonist, firstEvent } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const str = (v, fallback = '') => (typeof v === 'string' && v.trim() ? v.trim() : fallback);

  let greetings = Array.isArray(r.alternate_greetings) ? r.alternate_greetings : [];
  greetings = greetings.filter(g => typeof g === 'string' && g.trim()).map(g => g.trim()).slice(0, 5);

  let tags = Array.isArray(r.tags) ? r.tags : [];
  tags = tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim()).slice(0, 8);

  const name = str(r.name) || str(title) || '生成的角色卡';
  const who = protagonist || '你';
  const opening = firstEvent?.name ? `从「${firstEvent.name}」开始。` : '';
  const firstMes = str(r.first_mes, `${opening}故事即将开始，等待你的行动。`.trim());

  // LLM 失败时也要给出可用的备选开场，保证角色卡能直接用
  if (!greetings.length) {
    greetings = [
      firstMes,
      `${opening}你站在原地，四周的声音渐渐清晰起来。接下来怎么做，由你决定。`.trim(),
    ];
  }

  return {
    name,
    description: str(r.description, `本角色卡由小说文本生成，主角为${who}。${opening}`),
    personality: str(r.personality, `${who}的性格由世界书中的人物条目定义，按原著基线演绎。`),
    scenario: str(r.scenario, `${opening}世界按世界书中的时间线推进。`.trim()),
    first_mes: firstMes,
    alternate_greetings: greetings,
    mes_example: str(r.mes_example),
    tags: tags.length ? tags : ['小说改编'],
  };
}

/**
 * 把时间线条目解析成完整日期（年/月/日）。
 *
 * `resolveDateYears` 会按叙事顺序给缺年份的补年份（缺依据就留空），
 * 这里只负责把结果算成 `date` 对象 + `dateKey`。
 */
function resolveTimelineDates(tl) {
  const list = Array.isArray(tl) ? tl : [];
  // 章节内锚定：跨章借年份会编出错误日期（详见 resolveDateYears 的注释）
  const parts = resolveDateYears(list, {
    window: 'chapter',
    chapterOf: (e) => String(e?.chapter || ''),
  });
  return list.map((e, i) => {
    const p = parts.get(i) || {};
    const day = p.day ?? null;
    const month = p.month ?? null;
    const year = p.year ?? null;
    return {
      ...e,
      date: { year, month, day, season: p.season ?? null, decade: p.decade ?? null, inferred: !!p.inferred },
      /** 到"日"才有的键：按天分组只认可这个 */
      dateKey: (month !== null && day !== null)
        ? `${year !== null ? `${year}-` : ''}${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
        : null,
      dateText: formatDate({ year, month, day, season: p.season ?? null, decade: p.decade ?? null, inferred: !!p.inferred }, { fallback: e.time || '' }),
    };
  });
}

/**
 * 把事件对齐到时间线上的具体某一天。
 *
 * 原来的做法是「每章只取最早出现的那个时间点」，于是**同一章里的多个日期
 * 全被压成同一个** —— 实测一章里出现 `6月1日`（生日、发售）、`7月份`（上映）、
 * `1961年的4月8日`（拜访），结果四个事件全被标成 `6月1日`，
 * 一天里的事件看起来毫无区分，也没法按天打包。
 *
 * 现在的对齐策略（依次尝试，命中即停）：
 *   1. 事件名与时间线条目名相同 / 互相包含
 *   2. 同一章内，事件名出现在该条目的 quote 里
 *   3. 同一章内，事件名与该条目名有公共词（≥2 字）
 *   4. 同一章内，按**叙事顺序**把还没被占用过的条目依次分给各事件
 *      （「这一天发生了什么」通常原文就是按顺序写的）
 *   5. 都没有 → 用故事起点时间兜底（至少不是"未定"）
 *
 * 关键点：`dateKey` 只在**解析到具体某天**时才写。没有月日的事件
 * 不会被硬凑成某一天 —— 那会让"按天打包"把无关剧情错误地并到一起。
 */
export function backfillEventTimes(events, timeline) {
  const tl = resolveTimelineDates(timeline?.events || []);
  const byName = new Map(tl.map(e => [e.name, e]));
  const byChapter = new Map();
  for (const e of tl) {
    if (!e.chapter) continue;
    if (!byChapter.has(e.chapter)) byChapter.set(e.chapter, []);
    byChapter.get(e.chapter).push(e);
  }

  /**
   * 章节号的**模糊匹配**。
   *
   * 实测踩过：事件的 `chapter` 由模型写（`示例世界第三章`／`2/3`／`16`），
   * 而时间提及的 `chapter` 是块标题（`示例世界第三章，`／`【2/3】示例世界第三章，`）——
   * **两者形式不同**，精确查表必然落空，于是每个事件都拿到兜底时间（全变成「四点了」）。
   *
   * 归一化：去掉标点与方括号标记后，互相包含即视为同一章。
   */
  const normChapter = (s) => String(s || '')
    .replace(/[【】\[\]（）()，,。.、：:；;！!？?\s]/g, '')
    .toLowerCase();
  const chapterIndex = new Map();   // 归一化后的章名 → 该章的时间点
  for (const [ch, list] of byChapter) {
    const k = normChapter(ch);
    if (k && !chapterIndex.has(k)) chapterIndex.set(k, list);
  }
  const mentionsOfChapter = (ch) => {
    if (!ch) return [];
    if (byChapter.has(ch)) return byChapter.get(ch);
    const k = normChapter(ch);
    if (!k) return [];
    if (chapterIndex.has(k)) return chapterIndex.get(k);
    // 互为子串（事件写 `2/3`、提及写 `【2/3】示例世界第三章，`）
    for (const [ck, list] of chapterIndex) {
      if (ck && (ck.includes(k) || k.includes(ck))) return list;
    }
    return [];
  };
  const startTime = tl[0]?.time || timeline?.origin?.raw || '';
  const startDate = tl[0] || null;
  const claimed = new Set();

  /** 两个名字是否共享一个 ≥2 字的词（用于"夜访药园" vs "夜访旧宅"这类） */
  const shareWord = (a, b) => {
    const sa = String(a || ''), sb = String(b || '');
    for (let i = 0; i + 2 <= sa.length; i++) {
      if (sb.includes(sa.slice(i, i + 2))) return true;
    }
    return false;
  };

  let filled = 0;
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    // 已经有完整日期的不动，也**不计入 filled** ——
    // 这个计数表示"回填补上了几个"，不是"处理了几个"（测试按前者断言）
    if (ev.time && ev.dateKey) continue;

    /**
     * 记录一次回填。
     *
     * 语义分两层，计数只认第一层：
     *   · **`time` 从空变成有** → 这就是原来的 `filled`（"补上了几个事件的显示时间"）
     *   · `time` 已有、只补到 `dateKey` → 不算 filled（它本来就有时间，
     *     只是从"元和八年春"细化为可按天分组）
     *
     * ⚠️ **已有 time 绝不覆盖** —— 覆盖会把正确信息换成错误的
     * （实测：`初入秘境` 的 `元和八年春` 被故事起点盖掉）。
     */
    const assign = (src) => {
      if (!src) return;
      if (!ev.time && src.time) { ev.time = src.time; filled++; }
      if (!ev.dateKey && src.dateKey) {
        ev.date = { ...src.date };
        ev.dateKey = src.dateKey;
        ev.dateText = src.dateText;
      }
    };

    const chapterMentions = mentionsOfChapter(ev.chapter);
    const free = chapterMentions.filter(m => !claimed.has(m));

    let hit = byName.get(ev.name) || null;

    if (!hit) {
      hit = tl.find(e => e.name && (e.name.includes(ev.name) || ev.name.includes(e.name))) || null;
    }
    if (!hit) {
      hit = free.find(m => m.quote && String(m.quote).includes(ev.name)) || null;
    }
    if (!hit) {
      hit = free.find(m => shareWord(m.name, ev.name)) || null;
    }
    // 同章内按叙事顺序分配尚未占用的时间点
    if (!hit && free.length) hit = free[0];
    if (!hit && chapterMentions.length) hit = chapterMentions[0];

    /**
     * ⚠️ 章节号对不上时**不要乱兜底**。
     *
     * 实测踩过：事件的 `chapter`（`16`／`2/3`／`第17章`）与时间提及的 `chapter`
     * （块标题）**不是同一个字符串**，于是 `byChapter` 查不到，
     * 旧代码落到 `hit = tl[0]` 这条兜底 —— **17 个事件全被塞上第一条的时间**
     * （全变成「四点了」）。给错的时间比留空更糟：它会让 AI 以为整篇都发生在同一刻。
     *
     * 所以只在**确实只有一个候选**时才用它，否则宁可留空。
     */
    if (!hit && tl.length === 1 && !claimed.has(tl[0])) hit = tl[0];

    if (hit) {
      claimed.add(hit);
      assign(hit);
      continue;
    }

    /**
     * 最后兜底：用故事起点时间。
     *
     * ⚠️ **事件自己带了章节号、但该章一个时间点都没有**时**不要**兜底。
     * 那说明模型给的章节号对不上（`16` 这种），拿"故事起点"冒充会让所有这类事件
     * 看起来都发生在同一刻 —— 实测 17 个事件全变成「四点了」。
     * 宁可留空（序列化成 `时间：（未定）`），也不给一个确定但错误的时间。
     */
    const chapterUnresolved = !!ev.chapter && chapterMentions.length === 0;
    if (startTime && !ev.time && !chapterUnresolved) {
      // 直接赋值并计数：不要先赋值再调 assign ——
      // assign 里的判据是 `!ev.time`，先赋值就永远不成立，那一份计数会丢（测试抓到过）
      ev.time = startTime;
      filled++;
      if (startDate?.dateKey && !ev.dateKey) {
        ev.date = { ...startDate.date };
        ev.dateKey = startDate.dateKey;
        ev.dateText = startDate.dateText;
      }
    }
  }
  return { events, filled, total: list.length };
}

/**
 * 按**天**把事件分组。
 *
 * 用户诉求：「有些剧情在一天内是连续的话就直接将那一天的内发生的剧情打包，不要拆分」。
 *
 * 分组规则：
 *   · 有 `dateKey`（解析到具体年月日）的事件 → 同一天合成一组
 *   · 没有 `dateKey` 的 → **各自独立成组**，绝不硬凑到某一天
 *     （凑错会把无关剧情并到一起，比不分组更糟）
 *   · 组内保持原顺序，组间按日期先后排序
 *
 * @returns {Array<{dateKey:string|null, dateText:string|null, events:object[]}>}
 */
export function groupEventsByDay(events) {
  const list = Array.isArray(events) ? events : [];
  const buckets = new Map();
  const order = [];
  const undated = [];

  for (const e of list) {
    if (!e?.dateKey) { undated.push(e); continue; }
    if (!buckets.has(e.dateKey)) {
      buckets.set(e.dateKey, { dateKey: e.dateKey, dateText: e.dateText || e.time || '', events: [] });
      order.push(e.dateKey);
    }
    const b = buckets.get(e.dateKey);
    b.events.push(e);
    if (!b.dateText && (e.dateText || e.time)) b.dateText = e.dateText || e.time;
  }

  // 组间按日期排序（dateKey 形如 `1961-06-01` 或 `06-01`，可直接字典序比较）
  const dated = order.map(k => buckets.get(k)).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)));
  // 没有日期的事件保持原顺序追加在后面
  for (const e of undated) dated.push({ dateKey: null, dateText: e.time || null, events: [e] });
  return dated;
}

/** 事件条目正文（与 A 包 assembleWorldbook 保持一致的格式） */
export function formatEventEntry(e) {
  const pressureLabel = { core: '核', buffer: '缓', flexible: '弹' };
  const lines = [
    `【事件·${e.name}】`,
    `时间：${e.time || '（未定）'}`,
    `原著：${e.canon}`,
    `【压力】${pressureLabel[e.pressure] || '缓'}`,
  ];
  if (e.participants?.length) lines.push(`【在场】${e.participants.join('、')}`);
  if (e.location) lines.push(`【地点】${e.location}`);
  if (e.prerequisites?.behavioral) lines.push(`【前置·行】${e.prerequisites.behavioral}`);
  return lines.join('\n');
}

/**
 * 给一个事件派生**多组世界书触发词**。
 *
 * 为什么需要：原来每个事件只有一个 key —— 就是事件名本身（`邀莉莉拍电影`）。
 * 而这个名字是抽取器造的概括短语，**正文对话里几乎不会原样出现**
 * （实测 4 个事件全是单 key）。世界书是 key 触发，于是剧情基本靠"刻意引导"才会加载，
 * 不引导就大段错过 —— 用户反馈的正是这个。
 *
 * 派生来源（按可靠性排序）：
 *   1. 事件名本身（原样保留）
 *   2. **解析出的日期**（到日才用）—— 叙事里写到"12月25日"就该触发当天的事件。
 *      这是最能"自然触发"的一类：日期是客观的，AI 报时或旁白提日期都会命中。
 *   3. **事件里的其他人物名**（participants）—— 对话提到某人时加载相关事件。
 *   4. **地点**（location）—— 走进/提到某地时加载。
 *
 * ⚠️ 风险控制（宁可少触发，也不要误触发）：
 *   - **排除主角名**：主角几乎每轮都在场，拿它当 key 会让所有事件常驻，比不触发更糟
 *   - **日期必须到"日"**：只用月份（`6月`）会让整个月里每轮都触发
 *   - 名字太短（单字）不要，命中率太高且歧义大
 *   - 总数封顶，超出按上面的优先级截断
 *   - 全部去重
 *
 * @param {{name:string, participants?:string[], location?:string, time?:string}} ev
 * @param {{protagonist?:string, extraNames?:string[], max?:number}} [opts]
 * @returns {string[]} 触发词列表（第一个恒为事件名）
 */
export function deriveEventKeys(ev, { protagonist = '', extraNames = [], max = 6 } = {}) {
  const name = String(ev?.name || '').trim();
  const keys = [];
  const seen = new Set();
  const push = (k) => {
    const s = String(k || '').trim();
    if (!s || seen.has(s)) return;
    seen.add(s);
    keys.push(s);
  };

  // ① 事件名
  push(name);

  // 主角名不能当触发词（用 varKey 比较，容忍空白与点号差异）
  const protoKeys = new Set([varKey(protagonist), ...(extraNames || []).map(varKey)].filter(Boolean));

  // ② 日期（必须到日）
  const dp = parseChainedTime(ev?.time);
  const dateTok = dateTriggerToken(dp);
  if (dateTok) push(dateTok);

  // ③ 事件里的其他人物
  for (const p of Array.isArray(ev?.participants) ? ev.participants : []) {
    const s = String(p || '').trim();
    if (!s || s.length < 2) continue;          // 单字名歧义太大
    if (protoKeys.has(varKey(s))) continue;    // 主角/已排除的名字
    push(s);
  }

  // ④ 地点
  const loc = String(ev?.location || '').trim();
  if (loc && loc.length >= 2 && !/^(城里|街上|路上|屋里|屋内|外面|这里|那里|某地)$/.test(loc)) {
    push(loc);
  }

  // 封顶时按上面的优先级截断（事件名与日期优先保留）
  return keys.slice(0, Math.max(1, max));
}

/**
 * 组装完整的 chara_card_v3 角色卡。
 *
 * 结构与参考样本一致：
 *   data.character_book.entries   世界书（含 EJS 条目）
 *   data.extensions.regex_scripts 正则（隐藏 <update> 标签）
 *   data.extensions.tavern_helper 酒馆助手脚本与变量
 *
 * 注意：含 EJS 的条目内容必须原样保留 <%_ ... _%>，不要做任何转义 ——
 * JSON.stringify 本身不会转义 < 和 >，所以直接写字符串即可。
 *
 * @param {object} p 流水线上下文
 */
export function assembleCharacterCard(p) {
  const {
    timeline, events = [], characters = [], worldbook = [],
    variables = {}, phasesWithDeltas = [], userMode = {}, worldbookName = '生成的世界设定集',
    /** Step 5.5 写好的事件条目正文（按事件名索引），有就用它替换简洁格式 */
    eventContents = null,
    /** Step 7.5 的产出：{ regexScripts, placeholder, bodyWrapper, statusbar } */
    statusbar = null,
  } = p || {};

  /** 原著剧情简介（常驻参考条目）；由调用方通过 p.synopsis 传入 */
  const synopsis = String(p?.synopsis || '').trim();

  // 主角名：派生事件触发词时要排除它（主角几乎每轮在场，拿它当 key 会让所有事件常驻）
  const protagonistName = String(userMode?.protagonistName || '').trim();

  // 无论调用方传进来的是否已归一化，这里都再过一遍 —— 保证兜底字段一定存在
  const fields = normalizeCardFields(p?.cardFields, {
    title: p?.cardFields?.name || null,
    protagonist: userMode.protagonistName || null,
    firstEvent: timeline?.events?.[0] || null,
  });
  const cardName = fields.name || '生成的角色卡';
  const entries = [];

  /** 统一的条目工厂，减少重复字段 */
  const pushEntry = ({
    comment, content, constant, enabled = true, order,
    depth = 0, group = '', keys = [],
    position = 'after_char', selective = true, useRegex = true,
  }) => {
    entries.push({
      id: entries.length,
      comment,
      content,
      constant,
      enabled,
      insertion_order: order,
      keys,
      secondary_keys: [],
      selective,
      use_regex: useRegex,
      position,
      extensions: { position: 4, depth, group },
    });
  };

  // 1. 时间线常驻
  pushEntry({
    comment: '[timeline]',
    content: formatTimeline(timeline || { base: '相对纪元', events: [], characters: [] }),
    constant: true,
    order: 1,
    group: 'timeline',
    selective: false,
    useRegex: false,
  });

  // 2. 原著剧情简介（常驻）—— 只讲"整部作品在讲什么"，事件条目讲单个节点。
  //    与 A 包 assembleWorldbook 用同一份文本与上限，保证两条路径一致。
  if (synopsis) {
    pushEntry({
      comment: '[synopsis]',
      content: `【原著剧情简介】\n${synopsis.slice(0, SYNOPSIS_MAX_CHARS)}`,
      constant: true,
      order: 2,
      group: 'synopsis',
      selective: false,
      useRegex: false,
    });
  }

  // 2. initvar（必须关闭：只用于 MVU 初始化，不参与提示词）
  entries.push({
    id: entries.length,
    comment: '[initvar]勿启用',
    content: YAML.stringify(variables || {}),
    constant: true,
    enabled: false,                       // ← 关键：导入后是关闭状态
    insertion_order: 2,
    keys: [],
    secondary_keys: [],
    selective: true,
    use_regex: true,
    position: 'before_char',
    extensions: { position: 0, depth: 4, group: '', prevent_recursion: true },
  });

  // 3. 变量更新规则（原 B2）
  pushEntry({
    comment: '变量更新规则',
    content: T.buildVariableUpdateRule(variables),
    constant: true,
    order: 3,
    depth: 1,
  });

  // 4. 变量更新强调
  pushEntry({
    comment: '变量更新强调',
    content: T.buildUpdateEmphasis(),
    constant: true,
    order: 4,
  });

  // 5. 导演指令（原 B3，含 EJS）
  pushEntry({
    comment: '导演指令',
    content: T.buildDirectorEJS(userMode.mode, events),
    constant: true,
    order: 5,
    depth: 2,
  });

  // 6. 角色阶段（原 B4，含 EJS）
  pushEntry({
    comment: '角色阶段',
    content: T.buildPersonaPhaseEJS(phasesWithDeltas),
    constant: true,
    order: 6,
    depth: 2,
  });

  // 7. 围栏与隔离
  pushEntry({
    comment: '围栏与隔离',
    content: T.buildFenceRules(),
    constant: true,
    order: 7,
  });

  // 8. 输出纪律
  //    带上 Step 7.5 的占位符与正文包裹标签，否则 AI 不会输出 <StatusPlaceHolderImpl/>，
  //    状态栏正则没有替换目标 —— 面板永远不出现，且没有任何报错。
  pushEntry({
    comment: '输出纪律',
    content: T.buildOutputDiscipline(statusbar || {}),
    constant: true,
    order: 8,
  });

  // 9. 干预与偏离度（按 userMode）
  pushEntry({
    comment: '干预与偏离度',
    content: T.buildInterventionRules(userMode.mode),
    constant: true,
    order: 9,
  });

  // 10. 世界观常驻条目
  //     从 11 起逐条 +1：ST 对同 insertion_order 的条目没有稳定排序保证，
  //     整批同号会让"提示词超预算时先丢谁"变成随机的。
  let cardOrder = 11;
  for (const w of worldbook) {
    if (!w.constant) continue;
    pushEntry({
      comment: `[${w.category}] ${w.name}`,
      content: w.content,
      constant: true,
      order: cardOrder++,
      group: w.category,
    });
  }

  // 11. 人物条目（key 触发）
  //     人物抽取是按名字并发调用的，同名可能重复返回；世界书里出现两条同名条目
  //     会让用户困惑、也浪费 token，这里按名字去重（保留内容更长的那条）。
  const charByName = new Map();
  for (const c of characters) {
    if (!c?.name) continue;
    const prev = charByName.get(c.name);
    /**
     * ⚠️ 比较长度必须用 `pickContent`，不能读 `c.content`。
     * 传 `content_yaml` 的调用方（image_card / augment 的抽取结果）在 `c.content`
     * 上是 undefined —— 那样每次都会认为"新的更长"，去重结果取决于遍历顺序。
     */
    const len = pickContent(c).length;
    if (!prev || len > pickContent(prev).length) {
      charByName.set(c.name, c);
    }
  }
  for (const c of charByName.values()) {
    // 分层标注，与 assembleWorldbook 保持同一种写法
    const tier = c.tier || normalizeTier(c.role, '次要NPC');
    const tierTag = tier === '主角' ? '' : `·${tier}`;
    pushEntry({
      comment: `[character${tierTag}] ${c.name}`,
      /**
       * ⚠️ 正文必须走 `pickContent`，不要直接读 `c.content`。
       *
       * 项目里人物档案的键名有两种：pipeline 内部用 `content`，
       * 而 `image_card.js` 与 augment 的抽取结果用 **`content_yaml`**。
       * 原来这里写的是 `content: c.content` —— 传 `content_yaml` 的调用方
       * 会得到**内容为空的人物条目**：keys 有（名字还在）、正文是空串，
       * 这个角色在卡里"存在但没有任何信息"（实测图片路径正是这样）。
       *
       * `pickContent` 同时认 content_yaml / content / 正文 / yaml，
       * 与 assembleWorldbook、normalizeWorldbookItems 等处保持同一口径。
       */
      content: pickContent(c),
      constant: false,
      order: cardOrder++,
      group: 'character',
      keys: c.keys || [c.name],
    });
  }

  // 12. 事件条目（key 触发）—— **按天打包**
  //     pipeline 里已用 dedupeEvents 去重，这里再兜一层（本函数可被独立调用）
  const evByName = new Map();
  for (const e of events) {
    if (!e?.name || evByName.has(e.name)) continue;
    evByName.set(e.name, e);
  }
  // 12a. 故事线条目（一条线一条，按线触发；原来在变量树里是死字段）
  for (const [name, line] of Object.entries(p?.storylines || {})) {
    if (!name || !line) continue;
    pushEntry({
      comment: `[storyline] ${name}`,
      content: formatStorylineEntry(name, line, events),
      constant: false,
      order: cardOrder++,
      group: 'storyline',
      keys: storylineKeys(name, line),
    });
  }  for (const group of groupEventsByDay([...evByName.values()])) {
    pushEntry({
      comment: dayEntryComment(group),
      content: formatDayEntry(group, eventContents),
      constant: false,
      order: cardOrder++,
      group: 'event',
      // 与 A 包 assembleWorldbook 用同一套触发词派生，避免两条路径给出不同的 keys
      keys: dayEntryKeys(group, { protagonist: protagonistName }),
    });
  }

  // 13. 世界观 key 触发条目
  //     CATEGORY_ORDER 只决定这些分类之间的相对先后；这里整体平移到人物/事件之后，
  //     避免与内置条目（order 1~9）撞号。
  const categoryBase = Math.max(cardOrder, 100);
  for (const w of worldbook) {
    if (w.constant) continue;
    pushEntry({
      comment: `[${w.category}] ${w.name}`,
      content: w.content,
      constant: false,
      order: categoryBase + (T.CATEGORY_ORDER[w.category] || 15),
      group: w.category,
      keys: w.keys || [],
    });
  }

  // 顶层与 data.* 共享的字段。放在这里而不是只写进 data，是为了让两层**逐字一致** ——
  // ST 的 readFromV2 在两层值不同时会打 console.warn（"has Spec v2 data mismatch"），
  // 只有两边完全一致才是零噪音导入。
  //
  // 说明：v3 规范里顶层合法成员只有 spec / spec_version / data 三个，
  // 这 8 个字段是 v1 时代的字段，属于规范外冗余。这里保留是因为 ST 生态的历史惯例
  // （只认 v1 字段的老工具仍能读到名字），且 ST 明确以 data.* 为准。
  const shared = {
    name: cardName,
    description: fields.description || '',
    personality: fields.personality || '',
    scenario: fields.scenario || '',
    first_mes: fields.first_mes || '你来到了这个世界。',
    alternate_greetings: fields.alternate_greetings || [],
    mes_example: fields.mes_example || '',
    tags: fields.tags || [],
    // v3 规范里 group_only_greetings 是**必填**（"this field MUST be present…
    // MAY be empty array"）。本工具不生成群聊专属开场，所以恒为空数组。
    group_only_greetings: [],
  };

  return {
    ...shared,
    creatorcomment: '由小说 → 角色卡生成器生成',
    avatar: 'none',
    // ST 的类型契约是 number（char-data.js：@property {number} talkativeness），
    // 且它缺失时补的默认值也是数字 0.5 —— 所以这里必须写数字，不能写字符串 '0.5'。
    talkativeness: 0.5,
    fav: false,
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      ...shared,
      creator_notes: [
        '由「小说 → 角色卡生成器」自动生成。',
        '',
        '【使用前提】',
        '1. 需安装「酒馆助手」扩展（4.2.0+）：世界书条目里的 EJS 指令、以及卡片自带的',
        '   MVU 变量框架脚本都由它加载；未安装时卡片仍可用，但会看到 <%_ ... _%> 原文，',
        '   且变量树不会建立（状态栏里所有数值显示为 "—"）。',
        '2. 需安装「MVU」变量框架：状态栏、变量更新、导演指令的推进都依赖它。',
        '',
        '【导入后必须做的三件事 —— 漏掉任何一件都会"静默失效"（不报错，但明显不对劲）】',
        '',
        '① 导入内嵌世界书：打开本角色的角色面板时会弹窗',
        '   「This character has an embedded World/Lorebook. Would you like to import it now?」',
        '   —— 必须点「是」。',
        '   漏掉的后果：时间线、变量更新规则、导演指令、事件与人物条目**一条都不会进提示词**，',
        '   表现为"模型完全不理原著、自己乱编"。每个角色的这个提示只出现一次，',
        '   点过「否」就不会再弹；补救：角色面板 More… 菜单 →「Import Card Lore」。',
        '',
        '② 保持「[initvar]勿启用」条目为关闭状态。',
        '   它是 MVU 的变量初始化条目：MVU 按条目名匹配读取（不看启用开关），',
        '   开启反而会让它被当作普通世界书条目发给 AI。',
        '',
        '③ 放行卡内嵌的正则：首次加载本角色时会弹',
        '   「This character has embedded regex script(s). Would you like to allow using them?」',
        '   —— 必须点「是」。',
        '   漏掉的后果：AI 每轮输出的 <thinking>、<update>、<zhengwen> 与状态栏占位符',
        '   <StatusPlaceHolderImpl/> 都会原样留在聊天记录里，既占 token、又被模型当范例模仿，',
        '   状态栏也不会出现（正则没跑，占位符就只是个占位符）。',
        '   补救：扩展面板 → Regex → 打开该角色的 Scoped 开关。',
        '   注意群聊不执行角色自带的局部正则，请用单人聊天。',
        '',
        '【状态栏】',
        '本卡内嵌了 7 条正则与一块 HTML 状态面板：AI 每轮末尾输出占位符',
        '<StatusPlaceHolderImpl/>，正则把它替换成状态面板（读 MVU 变量树的实时数值）。',
        '其中「状态栏纯文本」这条是**默认关闭的降级方案**：',
        '  · 正常情况下不要开它 —— HTML 版已经是可用状态。',
        '  · 什么时候开：你的前端渲染不了 HTML（面板显示成一堆源码或空白）、',
        '    或正则替换后 HTML 被 Markdown 转义破坏了。',
        '  · 怎么开：扩展面板 → Regex → 点该角色的 Scoped 开关 → 找到「状态栏纯文本」',
        '    勾选启用，并**同时关闭「状态栏美化」**（两条正则匹配同一个占位符，',
        '    同时开启时实际生效的是数组里靠后的那条）。',
        '',
        '【常见的"装错扩展"】',
        'EJS 里的 getvar(\'stat_data.…\') 用的是 MVU 的变量命名空间，只有「酒馆助手」提供。',
        '若换成 Prompt Template 等其它 EJS 扩展，变量会全部读不到并静默走默认值',
        '（时间显示"未知"、阶段恒为"起始"、事件永不推进），且不会报错。',
        '同理：状态栏里的数值全部显示为 "—"，就说明 MVU 没跑起来（脚本没加载或变量树为空）。',
      ].join('\n'),
      system_prompt: '',
      post_history_instructions: '',
      creator: '生成器',
      character_version: '1.0',
      // CCv3 规范在 data 下定义了 creation_date / modification_date（可选，Unix 秒）。
      // 顶层那个 create_date 是 ISO 字符串，属于 SillyTavern 自己的惯例（不在规范内），
      // 两个都保留：前者给按规范读的客户端，后者给 ST。
      creation_date: Math.floor(Date.now() / 1000),
      extensions: {
        talkativeness: 0.5,
        fav: false,
        world: worldbookName,
        depth_prompt: { prompt: '', depth: 4, role: 'system' },
        // Step 7.5 生成的 7 条正则（思维链隐藏 / 变量更新隐藏 / 正文prompt隐藏 /
        // 状态栏prompt隐藏 / 正文美化 / 状态栏美化 / 状态栏纯文本）。
        // 顺序即 ST 的执行顺序，不要重排。没跑到 Step 7.5 时退回只隐藏 <update>。
        regex_scripts: statusbar?.regexScripts?.length
          ? statusbar.regexScripts
          : [
            {
              id: generateUUID(),
              scriptName: '[不发送][隐藏]变量更新',
              findRegex: '/<update(?:variable)?>(?:(?!.*<\\/update(?:variable)?>).*$|.*<\\/update(?:variable)?>)/gsi',
              replaceString: '',
              trimStrings: [],
              placement: [1, 2],
              substituteRegex: 0,
              minDepth: null,
              maxDepth: null,
              markdownOnly: true,
              promptOnly: true,
              disabled: false,
              runOnEdit: false,
            },
          ],
        // MVU 变量框架的注册。没有这条脚本，变量树永远不会被创建，
        // 状态栏里所有 {{get_message_variable::…}} 都取不到值（全显示 "—"），
        // <update> 也没人处理 —— 同样不报错。
        tavern_helper: {
          scripts: [{
            type: 'script',
            enabled: true,
            name: 'mvu',
            id: 'a86260a6-5f82-4c84-b9ad-564442540716',
            content: "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';",
            info: '',
            button: { enabled: true, buttons: [] },
            data: {},
            export_with: { data: true, button: true },
          }],
        },
      },
      character_book: {
        name: worldbookName,
        description: '由小说生成的设定集：时间线、变量、导演指令与世界观条目',
        // 下面三项是角色卡 V3 规范里 Lorebook 对象的字段，写出来是为了规范完整与导出往返一致。
        // ⚠️ SillyTavern **不读取**这三项：它用的是全局设置
        //    world_info_depth（默认 2）、world_info_budget（默认 25% 上下文）、world_info_recursive（默认 false）。
        //    想真正改扫描深度/预算，只能改全局设置，或走条目级 extensions.scan_depth。
        scan_depth: 4,
        token_budget: 2048,
        recursive_scanning: false,
        // 校验器要求 world book 同时具备 extensions 与 entries
        extensions: {},
        entries,
      },
    },
    create_date: new Date().toISOString(),
  };
}

function generateREADME(info) {
  const mode = info.outputMode || 'both';
  const hasCard = mode === 'card' || mode === 'both';
  const hasAb = mode === 'ab' || mode === 'both';

  const cardSection = `## 推荐方式（一次导入）

1. 打开 SillyTavern → 角色 → 导入
2. 选择 **character_card.json**
3. 完成

所有世界书、变量、更新规则、正则已内嵌在卡片中。
需要**酒馆助手扩展 + MVU 扩展**才能完整生效。`;

  const abSection = `## 分开导入（A 包 + B 包）

1. ST → 世界书 → 导入 → **worldbook.json**（A 包）
2. ST → 酒馆助手 → 预设管理 → 编辑 → 粘贴 **preset_fragment.json**（B 包）

preset_fragment.json 中 B1-B5 对应位置：
- b1_variables → 变量初始化
- b2_update_rules → 更新规则
- b3_director → 导演指令
- b4_persona_delta → 人设增量
- b5_rules.* → 五条常驻规则`;

  const modeLine = mode === 'card' ? '本次按「完整角色卡」模式生成，只产出 character_card.json。'
    : mode === 'ab' ? '本次按「A 包 + B 包」模式生成，只产出 worldbook.json 与 preset_fragment.json。'
    : '本次按「两者都要」模式生成，两套产物都在。';

  const main = hasCard && hasAb
    ? `${cardSection}\n\n---\n\n${abSection}`
    : hasCard ? cardSection : abSection;

  return `# 导入说明

${modeLine}

${main}

## 前置要求

- SillyTavern 最新版
- 酒馆助手扩展
- MVU 扩展

## 生成信息
- 章节数：${info.chapters}
- 事件数：${info.events}
- 阶段数：${info.phases}
- 人物条目：${info.characters}
- user 模式：${info.userMode}
- 输出模式：${mode}
- 源文本编码：${info.encoding || 'UTF-8'}

${info.warnings?.length ? `## 警告\n${info.warnings.map(w => `- ${w}`).join('\n')}\n` : ''}

## 故障排查

- 世界书条目不触发：检查 ST 是否装了酒馆助手
- 状态栏不更新：检查 MVU 是否启用
- EJS 显示为纯文本（能看到 \`<%_\`）：未装酒馆助手，但卡片仍可使用
- 事件不推进：检查「导演指令」条目是否取到了 stat_data.events
- 人设不变化：检查「角色阶段」条目里的阶段名与 variables.json 的 world.phase 是否一致
`;
}
