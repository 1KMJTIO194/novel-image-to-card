/**
 * 生成 / 完善的**变更总结**。
 *
 * 用户诉求：「生成角色卡后总结增加了什么内容，修改了哪些地方」。
 *
 * 两条路径共用一个渲染器：
 *   · 完善已有角色卡 → 有"改动前"的基线，能做真正的 **before → after 差异**
 *   · 从零生成       → 没有基线（原本就是空），所以总结的是**本次产出了什么**
 *
 * 设计上刻意与产物文件解耦：本模块只吃普通对象、吐普通对象/字符串，
 * 所以可以在测试里用构造数据完整覆盖，不需要跑 LLM。
 */

/** 分类显示名（总结里给人看的，不是内部 category） */
const GROUP_LABEL = {
  character: '人物',
  event: '剧情事件',
  worldbook: '世界观',
  storyline: '故事线',
  phase: '角色阶段',
  variable: '变量树',
  regex: '正则脚本',
  card: '角色卡字段',
};

const label = (t) => GROUP_LABEL[t] || t || '其它';

/** 把 [{type,name}] 按类型分组计数 */
function countByType(items = []) {
  const out = {};
  for (const it of items) {
    const t = it?.type || 'other';
    out[t] = (out[t] || 0) + 1;
  }
  return out;
}

/** 按类型分组列出名字（每类最多列 max 个，其余折叠成"等 N 项"） */
function listByType(items = [], max = 12) {
  const groups = new Map();
  for (const it of items) {
    const t = it?.type || 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(String(it?.name || '(无名)'));
  }
  const lines = [];
  for (const [t, names] of groups) {
    const shown = names.slice(0, max);
    const rest = names.length - shown.length;
    lines.push({
      type: t,
      label: label(t),
      names: shown,
      total: names.length,
      suffix: rest > 0 ? `等 ${names.length} 项` : '',
    });
  }
  return lines;
}

/**
 * 完善路径：由 `augment_report.json` 生成结构化总结。
 *
 * @param {object} report augment_report.json 的内容
 * @returns {object} 结构化总结（可直接渲染，也可落盘）
 */
export function summarizeAugment(report = {}) {
  const before = report.before || {};
  const after = report.after || {};
  const extracted = report.extracted || {};
  const added = Array.isArray(report.added) ? report.added : [];
  const updated = Array.isArray(report.updated) ? report.updated : [];
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  const conflicts = Array.isArray(report.conflicts) ? report.conflicts : [];
  const matched = Array.isArray(report.matched) ? report.matched : [];

  const delta = {
    entries: (after.entries ?? 0) - (before.entries ?? 0),
    characters: (after.characters ?? 0) - (before.characters ?? 0),
    events: (after.events ?? 0) - (before.events ?? 0),
    worldbook: (after.worldbook ?? 0) - (before.worldbook ?? 0),
  };

  /**
   * ⚠️ 分类计数可能是**不可信**的。
   *
   * 卡如果不用本工具的标准前缀（条目就叫「香织」「地下城」），
   * `extractCardStructure` 数不出类型，report 里只有 `entries` 一个键。
   * 这时如果照常显示"人物 0 → 0"，会让人以为一个人物都没有 —— 那是口径失效。
   * 所以缺的分类显示"—"、也不进"一句话变化"。
   */
  const typed = (k) => before[k] !== undefined || after[k] !== undefined;

  const highlights = [];
  if (typed('characters') && delta.characters) highlights.push(`人物 ${delta.characters > 0 ? '+' : ''}${delta.characters} 人`);
  if (typed('events') && delta.events) highlights.push(`事件 ${delta.events > 0 ? '+' : ''}${delta.events} 个`);
  if (typed('worldbook') && delta.worldbook) highlights.push(`世界观 ${delta.worldbook > 0 ? '+' : ''}${delta.worldbook} 条`);
  if (delta.entries) highlights.push(`总条目 ${delta.entries > 0 ? '+' : ''}${delta.entries} 条`);

  // 没产出任何变化的常见原因，直接说出来（否则用户看到的是一份空总结）
  const notes = [];
  if (!added.length && !updated.length) {
    if (!extracted.events && !extracted.characters && !extracted.worldbook) {
      notes.push('新剧情里没有抽到任何可入库的内容 —— 检查是否传了正文，'
        + '或换更强的模型（抽取为空时日志会另有 WARN）');
    } else {
      notes.push('抽到了内容但全部与已有条目重复，因此没有新增（策略为 merge 时会这样）');
    }
  }
  if (report.alignDegraded) {
    notes.push('实体对齐降级为「全部新增」——本次未做同名匹配，可能出现重复条目');
  }
  if (conflicts.length) {
    notes.push(`有 ${conflicts.length} 处冲突需要你决定保留哪一版`);
  }
  if (!after.entries) {
    notes.push('「改动后」的统计缺失（报告里没有 after 字段），无法给出条目差值');
  }
  // 分类计数不可信时说明一下，否则读者会以为"人物 0 个"
  if (report.usesStandardPrefix === false || !typed('characters')) {
    if (report.usesStandardPrefix === false) {
      notes.push('这张卡不使用本工具的标准条目前缀（[character]/[event]/[map_*]），'
        + '因此按类型的计数不可用，只看总条目数');
    }
  }

  return {
    kind: 'augment',
    title: report.sourceCard || report.sourceCardFile || '已有角色卡',
    baseline: `策略 ${report.strategy || 'merge'} / 处理 ${report.processedChapters ?? 0} 章`
      + `（${report.processedChars ?? 0} 字）`,
    before,
    after,
    delta,
    extracted,
    added,
    updated,
    skipped,
    conflicts,
    matchedCount: matched.length,
    chapters: report.processedChapterTitles || [],
    version: report.version || null,
    highlights,
    notes,
  };
}

/** 从零生成路径：没有基线，总结"这次产出了什么" */
export function summarizeGenerate(meta = {}, counts = {}) {
  const c = { ...(counts || {}), ...(meta?.counts || {}) };
  const highlights = [];
  if (c.chapters) highlights.push(`${c.chapters} 章`);
  if (c.chars) highlights.push(`${c.chars} 字`);
  if (c.characters) highlights.push(`人物 ${c.characters} 人`);
  if (c.events) highlights.push(`事件 ${c.events} 个`);
  if (c.worldbookEntries) highlights.push(`世界观 ${c.worldbookEntries} 条`);
  if (c.storylines) highlights.push(`故事线 ${c.storylines} 条`);
  if (c.phases) highlights.push(`阶段 ${c.phases} 个`);

  const tiers = c.tiers || {};
  const tierText = Object.entries(tiers).map(([k, v]) => `${k} ${v} 人`).join('、');

  /**
   * 成品规格（条目数 / 正则数 / 体积）。
   * ⚠️ 从第二参数读，不是 `meta.kit` —— 调用方把它跟着 counts 一起传
   * （pipeline 传 `{…, kit: {...}}`，server 的旧任务回退分支也传在第二参数）。
   * 一开始写成 `meta?.kit` 导致规格那行**恒为空**，测试抓到的。
   */
  const kit = counts?.kit || meta?.kit || null;
  const kitText = kit
    ? `世界书条目 ${kit.entries ?? '?'} 条 / 正则 ${kit.regex ?? '?'} 条 / 约 `
      + `${kit.cardBytes ? Math.round(kit.cardBytes / 1024) + 'KB' : '?'}`
    : '';

  const notes = [];
  if (!c.characters) notes.push('没有产出人物条目 —— 检查小说是否含人物描写，或换更强的模型');
  if (!c.events) notes.push('没有产出剧情事件 —— 阶段划分与导演指令会空转');

  return {
    kind: 'generate',
    title: meta?.title || '新生成的角色卡',
    baseline: '从零生成',
    before: {},
    after: c,
    delta: {},
    // ⚠️ 只放**有中文映射**的四个数值。直接整份塞进来会把内部键名
    // （worldbookEntries / chapters / storylines）原样漏到"抽取统计"里，
    // 渲染出来是一串英文键，很难看也不像给人读的。
    extracted: {
      events: c.events || 0,
      characters: c.characters || 0,
      worldbook: c.worldbookEntries || 0,
      phases: c.phases || 0,
    },
    added: [],
    updated: [],
    skipped: [],
    conflicts: [],
    highlights,
    tierText,
    kitText,
    tokens: meta?.tokens || null,
    model: meta?.model || '',
    notes,
  };
}

/**
 * 把结构化总结渲染成 Markdown（落盘 / 复制 / 展示共用一份）。
 *
 * @param {object} s summarizeAugment 或 summarizeGenerate 的结果
 */
export function renderSummaryMarkdown(s = {}) {
  const L = [];
  const isAug = s.kind === 'augment';
  L.push(isAug ? `# 完善总结：${s.title}` : `# 生成总结：${s.title}`);
  L.push('');
  L.push(`- ${s.baseline}`);
  // 来源说明：图片路径的 baseline 是"从零生成"，而 "由 N 张图片生成" 只在 source 里
  if (s.source) L.push(`- ${s.source}`);
  if (s.model) L.push(`- 模型：${s.model}`);
  L.push('');

  // 改动前后对照
  if (isAug && (Object.keys(s.before).length || Object.keys(s.after).length)) {
    L.push('## 改动前后');
    L.push('');
    L.push('| 项目 | 改动前 | 改动后 | 变化 |');
    L.push('| --- | --- | --- | --- |');
    for (const [k, cn] of [
      ['entries', '总条目'], ['characters', '人物'],
      ['events', '事件'], ['worldbook', '世界观'],
    ]) {
      const b = s.before[k];
      const a = s.after[k];
      // 分类计数不可用时**不显示 0**（那会被读成"一个人物都没有"），整行跳过
      if (b === undefined && a === undefined) continue;
      const d = s.delta[k];
      const sign = d > 0 ? `+${d}` : d === 0 ? '±0' : String(d);
      L.push(`| ${cn} | ${b ?? '—'} | ${a ?? '—'} | ${d === undefined ? '—' : sign} |`);
    }
    L.push('');
  }

  if (s.highlights?.length) {
    L.push(isAug ? '## 一句话变化' : '## 本次产出');
    L.push('');
    L.push(s.highlights.join(' · '));
    L.push('');
  }
  if (s.tierText) { L.push(`人物分层：${s.tierText}`); L.push(''); }
  if (s.kitText) { L.push(s.kitText); L.push(''); }

  // 新增
  if (s.added?.length) {
    L.push(`## 新增内容（${s.added.length} 项）`);
    L.push('');
    for (const g of listByType(s.added)) {
      L.push(`- **${g.label}（${g.total}）**：${g.names.join('、')}${g.suffix ? ' ' + g.suffix : ''}`);
    }
    L.push('');
  }

  // 修改
  if (s.updated?.length) {
    L.push(`## 修改内容（${s.updated.length} 项）`);
    L.push('');
    for (const g of listByType(s.updated)) {
      L.push(`- **${g.label}（${g.total}）**：${g.names.join('、')}${g.suffix ? ' ' + g.suffix : ''}`);
    }
    L.push('');
  }

  if (s.matchedCount) {
    L.push(`## 与已有条目对齐（${s.matchedCount} 项）`);
    L.push('');
    L.push('这些内容与卡里已有条目匹配上，按策略合并而不是重复新增。');
    L.push('');
  }

  if (s.skipped?.length) {
    L.push(`## 跳过（${s.skipped.length} 项）`);
    L.push('');
    for (const g of listByType(s.skipped)) {
      L.push(`- **${g.label}**：${g.names.join('、')}${g.suffix ? ' ' + g.suffix : ''}`);
    }
    L.push('');
  }

  if (s.conflicts?.length) {
    L.push(`## 冲突（${s.conflicts.length} 处，需人工确认）`);
    L.push('');
    for (const c of s.conflicts.slice(0, 20)) {
      const nm = c?.name || c?.target || '(无名)';
      L.push(`- ${nm}${c?.reason ? `：${c.reason}` : ''}`);
    }
    L.push('');
  }

  if (s.chapters?.length) {
    L.push(`## 处理范围（${s.chapters.length} 章）`);
    L.push('');
    for (const c of s.chapters.slice(0, 30)) L.push(`- ${c}`);
    if (s.chapters.length > 30) L.push(`- …等 ${s.chapters.length} 章`);
    L.push('');
  }

  if (s.extracted && Object.keys(s.extracted).length) {
    L.push('## 抽取统计');
    L.push('');
    const map = { events: '事件', characters: '人物', worldbook: '世界观', phases: '阶段' };
    for (const [k, v] of Object.entries(s.extracted)) {
      if (typeof v === 'number') L.push(`- ${map[k] || k}：${v}`);
    }
    L.push('');
  }

  if (s.notes?.length) {
    L.push('## 需要注意');
    L.push('');
    for (const n of s.notes) L.push(`- ${n}`);
    L.push('');
  }

  if (s.version) {
    L.push(`> 卡片版本 ${s.version.from ?? '?'} → ${s.version.to ?? '?'}`);
  }
  return L.join('\n').trimEnd() + '\n';
}
