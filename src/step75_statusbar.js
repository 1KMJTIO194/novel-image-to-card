/**
 * Step 7.5 · 状态栏生成器 + 正则体系
 *
 * 位置：Pipeline 中 Step 7（图片处理）之后、Step 8（组装）之前。
 * 设计文档：docs/step75-statusbar.md
 *
 * 它解决的问题：AI 只要输出一个占位符 `<StatusPlaceHolderImpl/>`，
 * 卡内嵌正则就把它替换成一块 HTML 状态面板；`<update>` 等元信息被隐藏；
 * 正文被 `<zhengwen>...</zhengwen>` 包成卡片。用户导入即用、零配置。
 *
 * 两个刻意的设计约束：
 *   1. **不改变量树**。状态栏只展示变量树里**真实存在**的字段，
 *      不为了面板好看去凭空造"位置/天气"这类字段（那会连带要求变量更新规则也跟上）。
 *   2. **不引外部 CSS/JS 库**。HTML 里的样式与脚本全部内联，
 *      唯一的 `{{ }}` 是 ST 宏 `{{get_message_variable::…}}`（其它 `{{ }}` 会被 ST 误替换）。
 *
 * ⚠️ **所有 class 名都带 `custom-` 前缀，这是必需的，不是命名风格。**
 * SillyTavern 的 DOMPurify 钩子（`public/scripts/chats.js` 的 `uponSanitizeAttribute`）
 * 会把消息里每一个 class 改写成 `custom-<原名>`：
 *
 *     panel-container  →  custom-panel-container
 *
 * 而 `<style>` 里的选择器**不会**被改写。如果 HTML 用 `panel-container`
 * 而 CSS 写 `.panel-container`，选择器就全部失配 —— 背景、圆角、边框一概不生效，
 * 面板看起来是"透明"的（用户实际反馈过这个问题）。
 *
 * 所以这里的约定是：**HTML 的 class 与 CSS 的选择器都写 `custom-xxx`**。
 * 两种情况下都对：
 *   · ST 加了前缀 → `custom-panel-container` === `.custom-panel-container` ✓
 *   · ST 没加前缀 → 两边都是 `custom-panel-container` 自身 ✓
 * 改动 class 时必须两边同时改，否则就会静默丢样式。
 */

// ============================================================
// 字段识别
// ============================================================

/**
 * 元信息关键词：这些字段是给机器看的，不该出现在用户看的状态栏里。
 *
 * 不必再单列 `storylines` —— 它已搬进世界书（`[storyline]` 条目），
 * 变量树里没有这个键；而且 `custom` 整个命名空间在 INTERNAL_NAMESPACES 里已跳过。
 */
const META_KEYWORDS = ['deviation', 'pressure', 'status', 'core', 'events'];

/** 内部命名空间：整段跳过 */
const INTERNAL_NAMESPACES = new Set(['events', 'custom']);

/** 我们认为"数值可展示"的字段：真布尔也算，但对象/数组要看下一层 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 单个字段是否可展示。
 * @param {string} key
 * @param {unknown} value
 */
export function isDisplayable(key, value) {
  const k = String(key).toLowerCase();
  if (META_KEYWORDS.some(m => k.includes(m))) return false;
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

/** 变量键 → 展示用标签（英文键给一份中文对照，中文键原样） */
const LABEL_MAP = {
  time: '时间', phase: '阶段', name: '姓名', role: '身份',
  affinity: '好感度', state: '状态', position: '位置', identity: '身份',
  watching: '观测视角', skills: '技能', status: '状态', pressure: '压力',
};

export function toLabel(key) {
  return LABEL_MAP[key] || String(key);
}

/**
 * 分组映射。
 *
 * 设计文档 3.2 假设变量树是「角色信息 / 角色职业 / 物品栏 / 宠兽 / 人际关系」
 * 这类中文命名空间。本项目 `buildVariables` 实际产出的是
 * `world / characters / user / events / custom`（英文命名空间，且后两个被整段排除），
 * 所以这里做三层匹配，否则整块面板会只剩一个「其他」页：
 *
 *   1. 命名空间直配：characters → relations（文档的"人际关系"），world/user → profile
 *   2. 键名中英关键词
 *   3. 兜底 misc
 *
 * `characters` 下的值是 `{affinity, state}` 这种 record（不是数组），
 * 渲染时会变成"一张卡片一个人、姓名当标题"—— 正是因缘簿该有的样子。
 */
const NAMESPACE_GROUP = { characters: 'relations' };

/**
 * 分组规则，按数组顺序**先命中先返回**。
 *
 * 顺序上有两处刻意的安排，都是被中文分词的现实逼出来的：
 *
 *  1. `profile`（角色档案）排在最后。`角色信息` 是中文卡里最常见的**总括**命名空间，
 *     底下塞着行囊、宠兽、关系…… 把它排前面会把所有子分类一口吞掉。
 *  2. 规则按「窄 → 宽」组织：`characters` 这种命名空间正配放在 `NAMESPACE_GROUP`，
 *     而 `stat_data.world.time` 之所以落进角色档案，靠的是 key 里的 `time`。
 *
 * 另外刻意不收「位置」：`物品栏` 里正好含这两个字，中文没有词边界，
 * 收了会把整个行囊误判成角色档案。
 */
const GROUP_RULES = [
  { group: 'class', label: '职业/修炼', re: /角色职业|职业|修炼|境界|等级|class|realm|level|rank|天赋/i, order: 2 },
  { group: 'pets', label: '灵兽录', re: /宠兽|灵宠|宠物|pets?|beast|mount/i, order: 3 },
  { group: 'items', label: '行囊', re: /物品栏|背包|装备|道具|items?|inventory|bag/i, order: 4 },
  { group: 'relations', label: '因缘簿', re: /人际关系|关系|好感|relations?|affinity|bond/i, order: 5 },
  { group: 'skills', label: '技能', re: /技能|功法|忍术|skills?|abilities|spells?/i, order: 6 },
  { group: 'missions', label: '任务', re: /任务|missions?|quests?/i, order: 7 },
  // 命名空间只有明确叫"角色档案/资料"时才算角色档案
  { group: 'profile', label: '角色档案', re: /角色档案|角色资料|character_profile/i, order: 1 },
  // 具体字段名
  { group: 'profile', label: '角色档案', re: /角色信息|profile|world|user|姓名|时间|阶段|身份|name|time|date|location|place|position|phase|identity|观测/i, order: 1 },
];

export function mapToGroup(namespace, key = '') {
  // 命名空间整体归类：本项目的 `characters` 就是"人际关系"，正配优先
  if (NAMESPACE_GROUP[namespace]) return NAMESPACE_GROUP[namespace];
  // keys 是更具体的分类信号。只有在 key 认不出来时，才用命名空间兜底 ——
  // 反过来（命名空间先）会让 `角色信息` 这种总括命名空间吞掉行囊与宠兽。
  for (const r of GROUP_RULES) if (r.re.test(key)) return r.group;
  for (const r of GROUP_RULES) if (r.re.test(namespace)) return r.group;
  return 'misc';
}

export function groupLabel(group) {
  return GROUP_RULES.find(r => r.group === group)?.label || '其他';
}

function groupOrder(group) {
  return GROUP_RULES.find(r => r.group === group)?.order || 99;
}

/**
 * 从变量树里挑出"需要展示"的字段。
 *
 * 注意 second level：本项目 `characters.沈砚 = {affinity, state}` 是 **record 而非数组**，
 * 所以这里把"对象的值也是对象"的情况展平一层，渲染时按行/列表处理。
 */
export function selectDisplayFields(variables) {
  const fields = [];
  for (const [ns, content] of Object.entries(variables || {})) {
    if (INTERNAL_NAMESPACES.has(ns)) continue;
    if (!isPlainObject(content)) continue;

    for (const [key, value] of Object.entries(content)) {
      if (!isDisplayable(key, value)) continue;

      if (isPlainObject(value)) {
        // 嵌套对象：看成一张"子表"。例如 characters.沈砚.{affinity,state}
        fields.push({
          namespace: ns,
          key,
          path: `stat_data.${ns}.${key}`,
          // record 的键就是这张卡的标题（`characters` 下是人物名），
          // 不查 LABEL_MAP —— 否则人物名会被英文键对照表误改
          label: String(key),
          valueType: 'record',
          group: mapToGroup(ns, key),
          subKeys: Object.keys(value).filter(k => isDisplayable(k, value[k])),
        });
      } else if (Array.isArray(value)) {
        fields.push({
          namespace: ns, key, path: `stat_data.${ns}.${key}`,
          label: toLabel(key), valueType: 'list', group: mapToGroup(ns, key),
        });
      } else {
        fields.push({
          namespace: ns, key, path: `stat_data.${ns}.${key}`,
          label: toLabel(key), valueType: 'primitive', group: mapToGroup(ns, key),
        });
      }
    }
  }
  return fields;
}

// ============================================================
// 布局决策
// ============================================================

/** 把字段按 group 聚成标签页；组数 > 3 时把小组合并，最终控制在 3-5 页 */
export function decideLayout(fields) {
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  if (groups.size <= 1) {
    return {
      layout: 'single',
      tabCount: 1,
      tabs: [{ id: 'main', label: '状态', active: true, fields }],
    };
  }

  if (groups.size <= 3) {
    const tabs = [...groups.entries()].map(([g, list], i) => ({
      id: g, label: groupLabel(g), active: i === 0, fields: list,
    }));
    return { layout: 'tabs', tabCount: tabs.length, tabs };
  }

  // 超过 3 组：按文档要求合并小组，目标 3-5 页。
  //
  // 做法分两步，缺一不可：
  //   ① 先按顺序把小组合并成 3-5 个「合并块」；
  //   ② 再把这些块与主组**交错**铺开成页。
  // 直接"把小组合并进主组"是错的 —— 那样页数等于主组数，
  // 7 个组只有 2 个主组时会塌成 2 页（文档要求 3-5 页）。
  const sorted = [...groups.entries()]
    .map(([g, list]) => ({ group: g, list }))
    .sort((a, b) => groupOrder(a.group) - groupOrder(b.group));

  const target = Math.min(5, groups.size);
  const main = sorted.filter(x => x.list.length >= 2);
  const small = sorted.filter(x => x.list.length < 2);

  const blocks = main.map(x => ({ group: x.group, list: [...x.list], merged: [] }));
  if (!blocks.length) blocks.push({ group: sorted[0].group, list: [...sorted[0].list], merged: [] });

  // 小组尽量平摊到各块，保证每块字段数接近 —— 面板才不会一页挤爆、一页空着
  for (const x of small) {
    let t = blocks[0];
    for (const p of blocks) if (p.list.length < t.list.length) t = p;
    t.list.push(...x.list);
    t.merged.push(x.group);
  }

  // 块数不够目标页数时，把最大的合并块拆开。
  // 拆的时候**必须把该组的字段一起从原块里摘出去** —— 只 push 不删会让字段出现两次
  //（状态栏上看起来是"这个值怎么显示了两遍"）。
  while (blocks.length < target) {
    const donor = blocks.reduce((a, b) => (b.merged.length > a.merged.length ? b : a), blocks[0]);
    const g = donor?.merged?.shift();
    if (!g) break;
    donor.list = donor.list.filter(f => f.group !== g);
    blocks.push({ group: g, list: [...(groups.get(g) || [])], merged: [] });
  }
  blocks.sort((a, b) => groupOrder(a.group) - groupOrder(b.group));

  const tabs = blocks.slice(0, 5).map((p, i) => ({
    id: p.group,
    label: p.merged.length
      ? [groupLabel(p.group), ...p.merged.map(groupLabel)].join(' · ')
      : groupLabel(p.group),
    active: i === 0,
    fields: p.list,
  }));
  return { layout: 'tabs', tabCount: tabs.length, tabs };
}

// ============================================================
// 主题
// ============================================================

export const THEMES = {
  xianxia: {
    key: 'xianxia', bg: '#1e2a1f', bgStart: '#16211a', bgEnd: '#243226',
    accent: '#b7b06b', secondary: '#7c9a6e', text: '#f5f0e0', muted: '#a9b39a',
    border: 'rgba(183,176,107,0.35)', cardBg: 'rgba(30,42,31,0.85)',
    pattern: 'leaf', font: "'Segoe UI', '华文楷书', 'Microsoft YaHei', serif",
    title: '灵兽天工·御兽宝鉴',
  },
  urban: {
    key: 'urban', bg: '#0d1117', bgStart: '#0b0f14', bgEnd: '#141b23',
    accent: '#64ffda', secondary: '#7c4dff', text: '#c9d1d9', muted: '#8b949e',
    border: 'rgba(100,255,218,0.28)', cardBg: 'rgba(22,27,34,0.9)',
    pattern: 'grid', font: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    title: '状态面板',
  },
  campus: {
    key: 'campus', bg: '#f0f7ff', bgStart: '#eaf3ff', bgEnd: '#f7fbff',
    accent: '#4a90e2', secondary: '#7ed321', text: '#2c3e50', muted: '#6b7c93',
    border: 'rgba(74,144,226,0.3)', cardBg: 'rgba(255,255,255,0.9)',
    pattern: 'circle', font: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    title: '校园档案',
  },
  mystery: {
    key: 'mystery', bg: '#1a1a1a', bgStart: '#141414', bgEnd: '#232323',
    accent: '#c9302c', secondary: '#444444', text: '#e0e0e0', muted: '#9a9a9a',
    border: 'rgba(201,48,44,0.35)', cardBg: 'rgba(26,26,26,0.9)',
    pattern: 'noise', font: "'Courier New', 'SimSun', monospace",
    title: '调查档案',
  },
  scifi: {
    key: 'scifi', bg: '#0a0e27', bgStart: '#070a1c', bgEnd: '#111638',
    accent: '#00d4ff', secondary: '#a855f7', text: '#e2e8f0', muted: '#8ba3c7',
    border: 'rgba(0,212,255,0.3)', cardBg: 'rgba(12,17,45,0.9)',
    pattern: 'hexagon', font: "'Segoe UI', 'Roboto', sans-serif",
    title: '系统终端',
  },
  fantasy: {
    key: 'fantasy', bg: '#2a1f3d', bgStart: '#221933', bgEnd: '#33264a',
    accent: '#f6c453', secondary: '#9d4edd', text: '#f0e6d2', muted: '#b9a98c',
    border: 'rgba(246,196,83,0.32)', cardBg: 'rgba(42,31,61,0.88)',
    pattern: 'star', font: "'Georgia', 'SimSun', serif",
    title: '冒险者手册',
  },
};
// default 与 urban 配色相同（文档：默认 urban），但 key 必须是 'default' ——
// 否则测试与日志里分不清"识别出都市"和"没识别出来走了兜底"。
THEMES.default = { ...THEMES.urban, key: 'default' };

/** 按作品类型挑主题。本项目没有 genre 字段，调用方传的是 tags/标题拼出来的字符串。 */
export function pickTheme(genre) {
  const g = String(genre || '');
  if (/修仙|仙侠|武侠|御兽|灵兽|仙|宗门|修真/.test(g)) return THEMES.xianxia;
  if (/校园|青春|日常|恋爱|学园/.test(g)) return THEMES.campus;
  if (/悬疑|推理|恐怖|暗黑|惊悚|罪案/.test(g)) return THEMES.mystery;
  if (/科幻|未来|赛博|星际|机甲/.test(g)) return THEMES.scifi;
  if (/奇幻|西幻|魔法|异世界|史诗/.test(g)) return THEMES.fantasy;
  if (/都市|现代|职场|娱乐|商战/.test(g)) return THEMES.urban;
  return THEMES.default;
}

/** 主题底纹（内联 SVG，避免外链请求） */
function patternSvg(kind, color) {
  const c = encodeURIComponent(color);
  const shapes = {
    leaf: `<path d='M8 0C4 4 0 8 0 12c4 0 8-4 8-12z' fill='%23${c}' fill-opacity='0.5'/>`,
    grid: `<path d='M0 0h16v16H0z' fill='none' stroke='%23${c}' stroke-opacity='0.5' stroke-width='0.7'/>`,
    circle: `<circle cx='8' cy='8' r='4' fill='none' stroke='%23${c}' stroke-opacity='0.5' stroke-width='0.8'/>`,
    noise: `<circle cx='4' cy='4' r='1' fill='%23${c}' fill-opacity='0.45'/><circle cx='12' cy='11' r='1' fill='%23${c}' fill-opacity='0.35'/>`,
    hexagon: `<path d='M8 0l7 4v8l-7 4-7-4V4z' fill='none' stroke='%23${c}' stroke-opacity='0.5' stroke-width='0.7'/>`,
    star: `<path d='M8 1l1.8 5.2H15l-4.2 3.1 1.6 5.2L8 11.4 3.6 14.5l1.6-5.2L1 6.2h5.2z' fill='%23${c}' fill-opacity='0.45'/>`,
  };
  const body = shapes[kind] || shapes.grid;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'>${body}</svg>`;
  return `data:image/svg+xml;utf8,${svg}`;
}

// ============================================================
// HTML 生成
// ============================================================

/** HTML 文本转义（面板里要插入变量键名等文本时用） */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 只允许 `{{ }}` 里是 ST 宏。
 *
 * 校验清单第 8 条：HTML 里任何**非** ST 宏的 `{{ }}` 都会被 ST 优先替换掉，
 * 把面板弄坏。我们生成的 HTML 里 `{{ }}` 全部是 `get_message_variable` /
 * `format_message_variable`，生成后立刻自检，防止以后改模板时手滑写进 Vue 风格语法。
 */
export function checkMacros(html) {
  const bad = [];
  for (const m of String(html).matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const inner = m[1].trim();
    if (!/^(get_message_variable|format_message_variable|getvar|get_global_variable|get_chat_variable|get_character_variable)::/.test(inner)) {
      bad.push(m[0].slice(0, 60));
    }
  }
  return bad;
}

/** 字段 → 一行 data-row（值用 ST 宏在运行时取） */
function fieldRow(field) {
  const label = escapeHtml(field.label);
  // 宏里的路径也必须转义：键名来自变量树，正常情况是安全的中英文名，
  // 但独立调用时可能是任意串（如 `a<b>`）。不转义的话会提前闭合所在标签，
  // 把后面的面板结构整块吃掉。`{{` / `}}` 本身不受 escapeHtml 影响，ST 照样替换。
  const macro = `{{get_message_variable::${escapeHtml(field.path)}}}`;
  if (field.valueType === 'record') {
    const subs = (field.subKeys || []).map(k =>
      `<div class="custom-data-row"><span class="custom-data-label">${escapeHtml(toLabel(k))}</span>`
      + `<span class="custom-data-value" data-empty="—">`
      + `{{get_message_variable::${escapeHtml(`${field.path}.${k}`)}}}</span></div>`).join('');
    // 只挂 custom-info-card：早先还挂了一个 custom-record-card，
    // 但 CSS 里从来没有它的规则（纯无用 class）。class 配对校验会把它报出来 ——
    // 要么给它写规则，要么去掉。这里选择去掉。
    return `<div class="custom-info-card" data-field="${escapeHtml(field.key)}">`
      + `<div class="custom-card-header">${label}</div>${subs || '<div class="custom-placeholder-text">暂无</div>'}</div>`;
  }
  if (field.valueType === 'list') {
    return `<div class="custom-info-card"><div class="custom-card-header">${label}</div>`
      + `<div class="custom-data-value" data-empty="—" data-list="${escapeHtml(field.key)}">${macro}</div></div>`;
  }
  return `<div class="custom-data-row"><span class="custom-data-label">${label}</span>`
    + `<span class="custom-data-value" data-empty="—">${macro}</span></div>`;
}

/** 一个标签页的 HTML */
function tabPane(tab, index = 0) {
  const prim = tab.fields.filter(f => f.valueType === 'primitive');
  const rest = tab.fields.filter(f => f.valueType !== 'primitive');
  const rows = prim.map(fieldRow).join('');
  const cards = rest.map(fieldRow).join('');
  const inner = (rows ? `<div class="custom-info-card">${rows}</div>` : '')
    + (cards ? `<div class="custom-card-grid">${cards}</div>` : '')
    + (!rows && !cards ? '<div class="custom-placeholder-text">暂无</div>' : '');
  return `<div class="custom-tab-pane-content" data-pane="${index}">${inner}</div>`;
}

/**
 * 标签页的显隐规则。
 *
 * 每页固定生成一条 `#sb-tab-i:checked ~ .custom-tab-content-wrapper [data-pane="i"]{display:block}`。
 * 页数在生成时就是已知的，所以不需要 :nth-of-type 之类的技巧，
 * 也不会因为少写一条规则而出现"点了没反应"。
 */
function tabPaneCss(count) {
  if (count <= 1) return '.custom-tab-pane-content{display:block}';
  const rules = ['.custom-tab-pane-content{display:none}'];
  for (let i = 0; i < count; i++) {
    rules.push(`#sb-tab-${i}:checked ~ .custom-tab-content-wrapper [data-pane="${i}"]{display:block}`);
    rules.push(`#sb-tab-${i}:checked ~ .custom-tabs-navigation label[for="sb-tab-${i}"]`
      + '{background:var(--accent-primary);color:var(--bg-panel);border-color:var(--accent-primary)}');
  }
  return rules.join('\n');
}

/** 顶部信息栏取哪两个字段：优先"位置/时间"语义，否则取前两个原始字段 */
function headerFields(fields) {
  const flat = [];
  for (const f of fields) {
    if (f.valueType === 'primitive') flat.push(f);
    else if (f.valueType === 'record') {
      for (const k of f.subKeys || []) {
        flat.push({ ...f, key: `${f.key}.${k}`, path: `${f.path}.${k}`, label: toLabel(k), valueType: 'primitive' });
      }
    }
  }
  const pick = (re) => flat.find(f => re.test(`${f.key} ${f.label}`));
  const loc = pick(/位置|地点|location|place|position/i);
  const time = pick(/时间|time|date/i);
  return [loc, time].filter(Boolean);
}

/**
 * 生成状态栏。
 *
 * @param {{variables:object, genre?:string, worldName?:string, characterName?:string}} input
 */
export function buildStatusbar(input = {}) {
  const { variables = {}, genre = '', worldName = '', characterName = '' } = input;
  const fields = selectDisplayFields(variables);
  const layout = decideLayout(fields);
  const theme = pickTheme(genre);
  const title = worldName ? `${theme.title} · ${worldName}` : theme.title;

  const headers = headerFields(fields);
  const headerHtml = headers.length
    ? headers.map(f => `<span class="custom-header-item">${escapeHtml(f.label)} `
      + `{{get_message_variable::${escapeHtml(f.path)}}}</span>`).join('')
    : '<span class="custom-header-item">状态面板</span>';

  // 标签页用 CSS 单选按钮实现，**不依赖 JavaScript**。
  //
  // 原因：状态栏是 ST「正则替换」的产物。ST 会对替换后的 HTML 做消毒，
  // <script> 会被摘掉（即使不被摘掉，模块脚本也不会执行）—— 靠 JS 渲染内容的话
  // 在有 MVU、没有「酒馆助手」iframe 环境下会整块空白。所以取值全部交给
  // ST 宏 {{get_message_variable::…}}（发送/渲染时由酒馆助手在服务端替换），
  // 切换标签页交给 :checked 选择器。这样即使一个脚本都不跑，面板依然完整可用。
  const radioHtml = layout.tabs.map((t, i) =>
    `<input type="radio" name="sb-tab" id="sb-tab-${i}" class="custom-tab-radio"${t.active ? ' checked' : ''}>`,
  ).join('');
  const navHtml = layout.tabs.map((t, i) =>
    `<label for="sb-tab-${i}" class="custom-tab-button-nav">${escapeHtml(t.label)}</label>`,
  ).join('');
  const panesHtml = layout.tabs.map((tab, i) => tabPane(tab, i)).join('');
  const paneCss = tabPaneCss(layout.tabs.length);

  const css = `
/* ⚠️ CSS 变量定义在**容器**上，不用文档根选择器（那个写法会被 ST 前缀成
   .mes_text + 根选择器，而根元素不可能是 .mes_text 的后代，于是所有 var() 全部落空 ——
   颜色、边框、底纹一起失效）。挂到容器上之后，容器自己的规则与所有后代都能读到这些变量。 */
.custom-panel-container{
  --bg-panel:${theme.bg};
  --accent-primary:${theme.accent};
  --accent-secondary:${theme.secondary};
  --text-light:${theme.text};
  --text-muted:${theme.muted};
  --border-color:${theme.border};
  --card-bg:${theme.cardBg};
  --pattern:url('${patternSvg(theme.pattern, theme.accent.replace('#', ''))}');
}
*{margin:0;padding:0;box-sizing:border-box}
/* ⚠️ 背景同样必须挂在**容器**上，不能挂 body（理由见文件头注释）。 */
.custom-panel-container{position:relative;max-width:1200px;width:95%;margin:0 auto;
  background:linear-gradient(145deg,${theme.bgStart} 0%,${theme.bgEnd} 100%);
  color:var(--text-light);
  border-radius:32px;border:1px solid var(--accent-primary);
  box-shadow:0 8px 32px rgba(0,0,0,.45);padding:1.8rem;
  overflow:hidden}
/* 底纹：用容器的 ::before 而不是 body::before（理由同上） */
.custom-panel-container::before{content:'';position:absolute;inset:0;
  background-image:var(--pattern);background-repeat:repeat;opacity:.15;pointer-events:none;z-index:0}
.custom-panel-container > *{position:relative;z-index:1}
.custom-panel-main-title{font-size:1.5rem;font-weight:500;color:var(--accent-primary);
  text-align:center;margin-bottom:1.2rem;letter-spacing:.05em}
.custom-header-info-bar{display:flex;justify-content:space-between;flex-wrap:wrap;gap:12px;
  background:rgba(0,0,0,.3);padding:10px 20px;border-radius:60px;margin-bottom:1.5rem;
  font-size:.9rem;border:1px solid var(--border-color)}
.custom-header-item{color:var(--text-light)}
.custom-tab-radio{position:absolute;opacity:0;pointer-events:none;width:0;height:0}
.custom-tabs-navigation{display:flex;gap:10px;flex-wrap:wrap;justify-content:center;
  margin-bottom:1.8rem;border-bottom:1px solid var(--border-color);padding-bottom:.8rem}
.custom-tab-button-nav{background:transparent;border:1px solid var(--border-color);color:var(--text-muted);
  padding:8px 20px;border-radius:40px;cursor:pointer;font-size:.95rem;transition:all .2s;
  user-select:none;display:inline-block}
.custom-tab-button-nav:hover{border-color:var(--accent-primary);color:var(--accent-primary)}
.custom-tab-content-wrapper{max-height:70vh;overflow-y:auto;padding:5px}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.custom-card-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1.2rem}
.custom-info-card{background:rgba(0,0,0,.18);border-radius:28px;padding:1.2rem 1.5rem;
  border-left:6px solid var(--accent-primary);box-shadow:0 4px 12px rgba(0,0,0,.2);
  margin-bottom:1.2rem;animation:fadeIn .4s}
.custom-card-grid .custom-info-card{margin-bottom:0}
.custom-card-header{font-size:1.15rem;font-weight:500;color:var(--accent-primary);margin-bottom:.8rem;
  border-bottom:1px dashed var(--border-color);padding-bottom:.4rem}
.custom-data-row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;
  border-bottom:1px dotted var(--border-color);font-size:.9rem}
.custom-data-row:last-child{border-bottom:none}
.custom-data-label{color:var(--text-muted);flex:0 0 auto}
.custom-data-value{font-weight:500;text-align:right;word-break:break-word}
.custom-data-value.custom-is-empty{color:var(--text-muted);font-weight:400}
.custom-placeholder-text{color:var(--text-muted);font-style:italic;text-align:center;padding:30px}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg-panel)}
::-webkit-scrollbar-thumb{background:var(--accent-primary);border-radius:3px}
@media (max-width:680px){.custom-panel-container{padding:1rem}.custom-card-grid{grid-template-columns:1fr}}
${paneCss}
`.trim();

  // 面板脚本：真实 JS（文档 3.5 的 {#each} 是伪模板语法，这里由生成器展开成实际循环）。
  // 值由 ST 宏在渲染时填入，脚本只负责：① 标签页切换 ② 把宏没填上的空位
  // 统一兜底成"—"（宏取不到变量时 ST 会原样留下 `{{...}}` 或留空，很难看）。
  const js = [
    '(function(){',
    "  'use strict';",
    '  function escapeHtml(str){',
    "    if (str === undefined || str === null) return '';",
    '    return String(str).replace(/[&<>"\']/g, function(c){',
    "      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', \"'\":'&#39;' }[c];",
    '    });',
    '  }',
    '  // 唯一的职责：把 ST 宏没能替换掉的空位兜底成 "—"。',
    '  // 面板的内容与标签页切换都是纯 HTML + CSS，不依赖这段脚本 ——',
    '  // 就算它被 ST 的消毒流程摘掉、或酒馆助手没装，面板依旧完整可用。',
    '  //（此处刻意不写出尖括号形式的标签名：注释里出现标签字样会让上游的',
    '  //  HTML 校验正则误判成真的标签。）',
    '  function fill(){',
    "    var vals = document.querySelectorAll('.custom-data-value');",
    '    for (var i = 0; i < vals.length; i++){',
    '      var el = vals[i];',
    '      var t = (el.textContent || "").trim();',
    "      if (t === '' || t.indexOf('{{') === 0 || t === 'undefined' || t === 'null'){",
    '        el.textContent = el.dataset.empty || "—";',
    '        el.classList.add("custom-is-empty");',
    '      }',
    '    }',
    '  }',
    '  function init(){',
    '    try {',
    "      if (typeof waitGlobalInitialized === 'function'){",
    "        waitGlobalInitialized('Mvu').then(fill, fill);",
    '      } else { fill(); }',
    '    } catch (e) { fill(); }',
    '  }',
    "  if (typeof $ === 'function' && typeof errorCatched === 'function'){",
    '    $(errorCatched(init));',
    '  } else { init(); }',
    '})();',
  ].join('\n');

  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="UTF-8">',
    `<title>${escapeHtml(title)}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<style>',
    css,
    '</style>',
    '</head>',
    '<body>',
    '<div class="custom-panel-container">',
    `<h1 class="custom-panel-main-title">${escapeHtml(title)}</h1>`,
    `<div class="custom-header-info-bar">${headerHtml}</div>`,
    // radio 必须与 .custom-tabs-navigation / .custom-tab-content-wrapper **同级**且在最前，
    // CSS 的 `:checked ~ …` 兄弟选择器才选得到后面的标签页与内容。
    radioHtml,
    `<div class="custom-tabs-navigation">${navHtml}</div>`,
    `<div class="custom-tab-content-wrapper">${panesHtml}</div>`,
    '</div>',
    '<script type="module">',
    js,
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');

  const plainText = buildPlainText(fields, layout, { worldName, characterName, theme });

  return {
    html,
    plainText,
    theme: theme.key,
    themeTitle: theme.title,
    layout: layout.layout,
    tabCount: layout.tabCount,
    tabs: layout.tabs.map(t => ({ id: t.id, label: t.label, fieldCount: t.fields.length })),
    displayFields: fields,
  };
}

/** 纯文本降级版：同样用 ST 宏取值，只是排版成终端风格 */
export function buildPlainText(fields, layout, { worldName, characterName, theme } = {}) {
  const bar = '━'.repeat(22);
  const lines = [bar];
  if (worldName) lines.push(`【${worldName}】${characterName ? ` · ${characterName}` : ''}`);
  lines.push(bar);

  const byGroup = new Map();
  for (const f of fields) {
    if (!byGroup.has(f.group)) byGroup.set(f.group, []);
    byGroup.get(f.group).push(f);
  }
  for (const [g, list] of byGroup) {
    lines.push(`【${groupLabel(g)}】`);
    for (const f of list) {
      if (f.valueType === 'record') {
        lines.push(`${f.label}：`);
        for (const k of f.subKeys || []) {
          lines.push(`  ${toLabel(k)}：{{get_message_variable::${f.path}.${k}}}`);
        }
      } else {
        lines.push(`${f.label}：{{get_message_variable::${f.path}}}`);
      }
    }
    lines.push(bar);
  }
  if (!fields.length) lines.push('（变量树里暂无可展示的字段）', bar);
  return lines.join('\n');
}

// ============================================================
// 正文美化（正则 6 的替换内容）
// ============================================================
//
// 注意：这里的 HTML 是**正则的 replaceString**，不是消息正文。
// 里面的 `<zhengwen>` 是 ST 正则替换语法，$1 会被替换成捕获组 1 的内容
// （ST 先做 `replaceString.replace(/\$(\d+)/g, …)` 取出捕获组，再当普通文本用），
// 所以 $1 必须原样保留，不能转义、不能被当成模板变量。
//
// 背景图：文档说"用户上传了场景图就用该图 URL"。本项目在上传小说/图片后，
// 头像会落到 `avatars/`；真正可用的场景图 URL 要等 ST 侧，所以这里用
// 主题色渐变兜底（无外链请求，离线也能看）。
//
// ⚠️ class 同样必须带 `custom-` 前缀（原因见文件头注释）。

export function buildBodyBeautify(theme) {
  const t = theme || THEMES.default;
  /**
   * ⚠️ 样式全部挂在 `.custom-pm-card-container` 上，**不挂 body**。
   *
   * ST 的 decodeStyleTags 会给每条规则的选择器加 `.mes_text ` 前缀，
   * 于是 `body{...}` 变成 `.mes_text body{...}` —— .mes_text 里没有 body，
   * 这条规则永不匹配（背景与字体一起丢，用户看到的就是"透明"）。
   * 容器是 .mes_text 的后代，前缀化后正常匹配。
   */
  return '```\n<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<style>\n'
    + '*{margin:0;padding:0;box-sizing:border-box}\n'
    + '.custom-pm-card-container{max-width:860px;margin:0 auto;border-radius:18px;overflow:hidden;'
    + `border:1px solid ${t.border};background:linear-gradient(150deg,${t.bgStart} 0%,${t.bgEnd} 100%);`
    + `color:${t.text};font-family:${t.font};`
    + 'box-shadow:0 6px 24px rgba(0,0,0,.35)}\n'
    + '.custom-pm-card-header{display:flex;align-items:center;gap:10px;padding:10px 18px;'
    + `background:${t.accent};color:${t.bg};font-size:.95rem;letter-spacing:.08em}\n`
    + '.custom-pm-card-header .custom-pm-card-dot{width:8px;height:8px;border-radius:50%;'
    + `background:${t.bg};opacity:.7}\n`
    + '.custom-pm-card-content{padding:20px 24px;line-height:1.85;font-size:1rem;'
    + `color:${t.text};white-space:pre-wrap;word-break:break-word}\n`
    + '.custom-pm-card-content p{margin:0 0 .9em}\n'
    + `.custom-pm-card-content blockquote{border-left:3px solid ${t.secondary};margin:.8em 0;`
    + `padding:.2em 0 .2em 1em;color:${t.muted}}\n`
    + `.custom-pm-card-content hr{border:none;border-top:1px dashed ${t.border};margin:1.2em 0}\n`
    + '</style>\n</head>\n<body>\n'
    + '<div class="custom-pm-card-container">\n'
    + '<div class="custom-pm-card-header"><span class="custom-pm-card-dot"></span><span>正文</span></div>\n'
    + '<div class="custom-pm-card-content">$1</div>\n'
    + '</div>\n</body>\n</html>\n```';
}

// ============================================================
// 正则体系（共 7 条）
// ============================================================

/** 占位符：AI 每轮末尾输出它，正则 3/4/5 都作用在它上面 */
export const PLACEHOLDER = '<StatusPlaceHolderImpl/>';

/** 正文包裹标签 */
export const BODY_WRAPPER = { open: '<zhengwen>', close: '</zhengwen>' };

/** 变量更新标签的隐藏正则（原「变量更新」正则的正则体，两条正则共用同一模式） */
const UPDATE_REGEX = '/<update(?:variable)?>(?:(?!.*<\\/update(?:variable)?>).*$|.*<\\/update(?:variable)?>)/gsi';

/**
 * 生成 7 条正则，顺序即 ST 的执行顺序（见设计文档 4.3）。
 *
 * 顺序上有个刻意的安排：**先隐藏 prompt、后美化**。
 * 正文美化 `replaceString` 里含 `<div>` 等 HTML，如果它先跑，
 * prompt 里就会带上整块 HTML；而 prompt 隐藏规则（正则 7）靠 `minDepth: 8`
 * 只清深层历史，两者叠加才是"显示要卡片、发送要干净"。
 *
 * @param {{html:string, plainText:string, theme:object}} p
 */
export function buildRegexScripts({ html, plainText, theme } = {}) {
  const t = theme || THEMES.default;
  return [
    // 1. 思维链隐藏：分析标签整段不显示、不进 prompt
    //
    //    文档写的模式是 `/<disclaimer>…<\/disclaimer>/gsi`，但**本项目从来没有声明过
    //    <disclaimer> 标签** —— B5_5 让 AI 每轮先输出 `<thinking>`。照文档原样写，
    //    这条正则会匹配不到任何东西（静默失效：面板上会看到大段内心独白）。
    //    这里把两种标签都吃进来，条数仍是 7 条、id 与 scriptName 不变。
    {
      id: 'regex_thinking_hide',
      scriptName: '思维链隐藏',
      findRegex: '/<(?:disclaimer|thinking)>([\\s\\S]*?)<\\/(?:disclaimer|thinking)>/gsi',
      replaceString: '',
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: true,
      promptOnly: true,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
    // 2. 变量更新隐藏：<update>…</update>（含未闭合的残缺标签）
    {
      id: 'regex_update_hide',
      scriptName: '变量更新隐藏',
      findRegex: UPDATE_REGEX,
      replaceString: '',
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: true,
      promptOnly: true,
      // 编辑消息时不重跑：用户手动编辑时，正则是基于原文匹配的，
      // 已替换过的内容再跑一次会把用户新写的 <update> 也吃掉
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
    // 3. 正文 prompt 隐藏：深层历史里去掉 <zhengwen> 标签，只留文本
    {
      id: 'regex_body_prompt_hide',
      scriptName: '正文prompt隐藏',
      findRegex: '/<zhengwen>([\\s\\S]*?)<\\/zhengwen>/gsi',
      replaceString: '$1',
      trimStrings: [],
      placement: [1, 2],
      disabled: false,
      markdownOnly: true,
      promptOnly: true,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: 8,
      maxDepth: null,
    },
    // 4. 状态栏 prompt 隐藏：占位符替换成空格，避免 AI 把它当范例照抄
    {
      id: 'regex_statusbar_prompt_hide',
      scriptName: '状态栏prompt隐藏',
      findRegex: PLACEHOLDER,
      replaceString: ' ',
      trimStrings: [],
      placement: [2],
      disabled: false,
      markdownOnly: false,
      promptOnly: true,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
    },
    // 5. 正文美化：浅层楼层把 <zhengwen> 换成卡片 HTML
    {
      id: 'regex_body_beautify',
      scriptName: '正文美化',
      findRegex: '/<zhengwen>([\\s\\S]*?)<\\/zhengwen>/gsi',
      replaceString: buildBodyBeautify(t),
      trimStrings: [],
      placement: [1, 2],
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: 8,
    },
    // 6. 状态栏美化：占位符 → 状态栏 HTML。
    //    `replaceString` 必须用 ``` 围栏包住，否则 ST 会把 HTML 当 Markdown 文本渲染出来。
    {
      id: 'regex_statusbar_html',
      scriptName: '状态栏美化',
      findRegex: PLACEHOLDER,
      replaceString: '```\n' + String(html || '') + '\n```',
      trimStrings: [],
      placement: [1, 2],
      disabled: false,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: 3,
    },
    // 7. 状态栏纯文本（降级）：默认关闭，用户想用纯文本版时手动开启
    {
      id: 'regex_statusbar_text',
      scriptName: '状态栏纯文本',
      findRegex: PLACEHOLDER,
      replaceString: String(plainText || ''),
      trimStrings: [],
      placement: [2],
      disabled: true,
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: 3,
    },
  ];
}

// ============================================================
// 校验清单（设计文档第七节）
// ============================================================

/** 极简 HTML 标签配对检查：只看标签名配对，不解析属性语义 */
export function checkHtmlSyntax(html) {
  const errs = [];
  const src = String(html || '');
  if (!/^<!DOCTYPE html>/i.test(src.trim())) errs.push('缺少 <!DOCTYPE html>');
  if (!/<html[\s>]/i.test(src)) errs.push('缺少 <html>');
  if (!/<\/html>\s*$/i.test(src.trim())) errs.push('缺少 </html>');

  // <script> / <style> 的内容不是 HTML，必须整段剔除再配对。
  // 否则脚本里的 `'<':'&lt;'` 这类字符串会被当成"没闭合的开始标签"，
  // 把后面所有标签的配对全部错位 —— 报出一堆假错误。
  const noRaw = src
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>');

  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr', '!doctype']);
  const stack = [];
  const re = /<(\/?)([a-zA-Z!][a-zA-Z0-9-]*)\b([^>]*)>/g;
  let m;
  while ((m = re.exec(noRaw))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (VOID.has(tag)) continue;
    if (m[3].trim().endsWith('/')) continue;
    if (!closing) { stack.push({ tag, at: m.index }); continue; }
    const top = stack.pop();
    if (!top) { errs.push(`多余的结束标签 </${tag}>`); continue; }
    if (top.tag !== tag) errs.push(`标签未正确闭合：<${top.tag}> 被 </${tag}> 关闭`);
  }
  for (const s of stack) errs.push(`标签未闭合：<${s.tag}>`);
  return errs.slice(0, 10);
}

/** HTML 里引用的 `stat_data.*` 路径是否真实存在于变量树 */
export function checkPaths(html, variables) {
  const bad = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/\{\{get_message_variable::([^}]+)\}\}/g)) {
    const p = m[1].trim();
    if (seen.has(p)) continue;
    seen.add(p);
    if (!p.startsWith('stat_data.')) { bad.push(`${p}（不是 stat_data 命名空间）`); continue; }
    // 只用点号切第一层之后的路径：变量键里不允许有点号（varKey 保证），
    // 但用户手改过的变量树可能有，所以逐段贪心匹配。
    const rest = p.slice('stat_data.'.length);
    const segs = rest.split('.');
    let node = variables?.[segs[0]];
    if (node === undefined) { bad.push(p); continue; }
    for (const seg of segs.slice(1)) {
      if (node === null || typeof node !== 'object') { node = undefined; break; }
      node = node[seg];
      if (node === undefined) break;
    }
    if (node === undefined) bad.push(p);
  }
  return bad;
}

/**
 * 走一遍校验清单。
 * @returns {{errors:string[], warnings:string[]}}
 */
export function validateStatusbar(result, variables) {
  const errors = [];
  const warnings = [];
  const html = result?.html || '';
  const scripts = result?.regexScripts || [];

  // 1. HTML 语法
  for (const e of checkHtmlSyntax(html)) errors.push(`状态栏 HTML：${e}`);

  // 2. stat_data 路径存在性
  for (const p of checkPaths(html, variables)) errors.push(`状态栏引用了不存在的变量路径：${p}`);
  for (const p of checkPaths(result?.plainText || '', variables)) {
    errors.push(`状态栏纯文本引用了不存在的变量路径：${p}`);
  }

  // 3/4. 正则的 id / scriptName / placement
  if (scripts.length !== 7) errors.push(`正则条数应为 7，实际 ${scripts.length}`);
  for (const s of scripts) {
    if (!s.id) errors.push(`正则缺少 id：${s.scriptName || '(无名)'}`);
    if (!s.scriptName) errors.push(`正则缺少 scriptName：${s.id || '(无 id)'}`);
    const pl = JSON.stringify(s.placement);
    if (!['[1]', '[2]', '[1,2]'].includes(pl)) {
      errors.push(`正则「${s.scriptName}」的 placement 非法：${pl}`);
    }
  }

  // 5. 状态栏美化正则用 ``` 包裹
  const beauty = scripts.find(s => s.id === 'regex_statusbar_html');
  if (beauty) {
    const rs = String(beauty.replaceString || '');
    if (!(rs.startsWith('```') && rs.trimEnd().endsWith('```'))) {
      warnings.push('「状态栏美化」的 replaceString 没有用 ``` 围栏包裹 —— ST 会把 HTML 当 Markdown 文本显示');
    }
  } else {
    errors.push('缺少「状态栏美化」正则（regex_statusbar_html）');
  }

  // 6. 纯文本正则默认关闭
  const text = scripts.find(s => s.id === 'regex_statusbar_text');
  if (text && text.disabled !== true) warnings.push('「状态栏纯文本」正则建议保持 disabled: true');

  // 8. 非 ST 宏的 {{ }}
  for (const bad of checkMacros(html)) errors.push(`状态栏 HTML 里有非 ST 宏的 {{ }}：${bad}`);

  // 9. script type="module"
  //
  //    直接从**原始** HTML 里抽取所有 `<script ...>` 开始标签，再丢掉含 `</script>`
  //    的那一段 —— 它必然来自脚本体或注释（真正的开始标签里不可能有结束标签）。
  //
  //    这里踩过两个坑，都写下来免得再犯：
  //      · 用否定前瞻 `(?![^>]*type=module)` 判断会把 `<script></script>` 骗过去；
  //      · 想"先剥 script 内容再查"，剥掉后留下的任何占位符只要含 `<script` 字样
  //        （包括 `<!--script-->`、`\u0000SCRIPT\u0000`）就会被自己的正则抓到。
  //    所以干脆不做剥离，只做一次抽取 + 一次过滤。
  const scriptTags = (html.match(/<script\b[^>]*>/gi) || [])
    .filter(tag => !/<\/script\s*>/i.test(tag));
  for (const tag of scriptTags) {
    if (!/\btype\s*=\s*["']module["']/i.test(tag)) {
      warnings.push(`状态栏 HTML 里的 <script> 建议用 type="module"：${tag}`);
    }
  }

  // 10. escapeHtml 已定义
  //
  //     注意这条的真实含义变了：面板内容与标签页切换现在都是纯 HTML + CSS，
  //     值由 ST 宏填充，**不依赖**这段脚本。所以 escapeHtml 缺失不会让面板坏掉，
  //     它现在是"生成器自己的脚本没写坏"的自检，因此降级为警告。
  //     （清单原文要求"错误"级，这里刻意偏离，理由见设计文档附录。）
  if (!/function\s+escapeHtml\s*\(/.test(html)) {
    warnings.push('状态栏 HTML 里没有定义 escapeHtml 函数（面板不依赖它，但脚本可能被改坏了）');
  }

  // 11. class 前缀一致性：HTML 用的 class 必须在 CSS 里有对应选择器（都带 custom-）
  //
  //     这是"面板看起来透明"那个事故的直接防线：ST 会给 class 加 custom- 前缀，
  //     只要 HTML 与 CSS 两边都写 custom-xxx 就永远匹配。可如果改模板时
  //     只在一边加/漏了前缀，就会静默失配（样式全丢、不报错）。
  for (const bad of checkClassPairing(html)) errors.push(`状态栏 class 选择器失配：${bad}`);

  // 12. 前缀化后永不匹配的选择器（body / :root）—— 背景"透明"的字面原因
  for (const s of checkPrefixedSelectors(html)) {
    errors.push(`状态栏 CSS 里有「${s}」选择器：ST 会把它前缀成 .mes_text ${s}，永不匹配（样式静默失效）`);
  }

  // 额外：占位符与正文包裹标签必须和正则一致，否则整条链路静默失效
  if (!html && !result?.plainText) warnings.push('状态栏内容为空：面板会显示空白');
  return { errors, warnings };
}

/**
 * 找出"前缀化后永远不会匹配"的选择器。
 *
 * ST 的 `decodeStyleTags` 会给消息里 `<custom-style>` 的每条规则选择器加上
 * `.mes_text ` 前缀（`public/scripts/chats.js`）。所以：
 *
 *   `body{…}`  →  `.mes_text body{…}`    ← .mes_text 里没有 body，永不匹配
 *   `:root{…}` →  `.mes_text :root{…}`   ← :root 是文档根，不可能是后代，永不匹配
 *
 * 这类规则**不报错、只是静默失效**（背景没了、CSS 变量全落空 → 看起来"透明"），
 * 排查起来很费劲。所以在这里主动拦下来。
 *
 * 只检查规则开头的选择器（逗号分隔的每一段），不深究复杂组合器。
 */
export function checkPrefixedSelectors(html) {
  const src = String(html || '');
  const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(src);
  if (!styleMatch) return [];
  // 去掉 at-rule 块的内容（@media 内部的规则另算，这里只切最外层）
  const css = styleMatch[1].replace(/@[a-z-]+[^{]*\{/gi, '');

  const DEAD = /^(body|html|:root|html\s+body)\b/i;
  const bad = [];
  for (const m of css.matchAll(/(^|[}])\s*([^{}]+)\{/g)) {
    const selector = m[2].trim();
    if (!selector || selector.startsWith('@')) continue;
    for (const part of selector.split(',')) {
      const s = part.trim();
      if (!s) continue;
      // 伪元素/伪类开头的规则（::-webkit-scrollbar）会被前缀成
      // `.mes_text ::-webkit-scrollbar`，这仍然能匹配到后代的滚动条，不算死规则
      if (DEAD.test(s)) bad.push(s);
    }
  }
  return [...new Set(bad)];
}

/**
 * 检查 HTML 里用到的每个 class 是否都能在 `<style>` 里找到对应选择器。
 *
 * 只报"HTML 有、CSS 没有"的方向 —— 反过来（CSS 有多余规则）是预留，不算错。
 * 同时校验前缀一致性：两边的 class 名必须**逐字相同**（含 `custom-`）。
 */
export function checkClassPairing(html) {
  const src = String(html || '');
  const styleMatch = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(src);
  const css = styleMatch ? styleMatch[1] : '';
  // 去掉脚本再抽 class，避免脚本里的 classList 字符串被当成 HTML class
  const noScript = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  const htmlClasses = new Set();
  for (const m of noScript.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) htmlClasses.add(c);
  }
  const cssClasses = new Set();
  for (const m of css.matchAll(/\.([A-Za-z][\w-]*)/g)) cssClasses.add(m[1]);

  const bad = [];
  for (const c of htmlClasses) {
    if (!cssClasses.has(c)) bad.push(`${c}（HTML 用了但 CSS 里没有 .${c}）`);
  }
  return bad;
}

// ============================================================
// 入口
// ============================================================

/**
 * Step 7.5 · 生成状态栏 + 正则体系。
 *
 * @param {object} input
 * @param {object} input.variables      Step 6 的变量树
 * @param {string} [input.genre]        作品类型（本项目没有 genre 字段，传 tags/标题拼出的串）
 * @param {string} [input.worldName]    作品名
 * @param {string} [input.characterName] 主角名（可选）
 * @returns {Promise<object>} { statusbar, regexScripts, placeholder, bodyWrapper, validation }
 */
export async function generateStatusbar(input = {}) {
  const { variables = {}, genre = '', worldName = '', characterName = '' } = input;
  const built = buildStatusbar({ variables, genre, worldName, characterName });
  const theme = THEMES[built.theme] || THEMES.default;

  const regexScripts = buildRegexScripts(built);

  const result = {
    statusbar: {
      html: built.html,
      plainText: built.plainText,
      theme: built.theme,
      themeTitle: built.themeTitle,
      layout: built.layout,
      tabCount: built.tabCount,
      tabs: built.tabs,
      fieldCount: built.displayFields.length,
      // 被选中展示的字段清单（含 path / group / valueType），
      // 供 pipeline 落盘 statusbar.json、预览页替换示例值使用。
      fields: built.displayFields,
    },
    regexScripts,
    placeholder: PLACEHOLDER,
    bodyWrapper: { ...BODY_WRAPPER },
    theme,
  };
  result.validation = validateStatusbar({ ...result, html: built.html }, variables);
  return result;
}
