/**
 * 世界书条目正文的展示辅助。
 *
 * Step 5 的条目正文现在是**结构化 YAML**（角色/地点/事件/物品各有模板），
 * 直接用 <pre> 原样打印会有大量 `|`、缩进和键名，读起来很累。
 * 这里把它解析成 [{label, value}] 逐字段渲染；不是 YAML 的正文原样返回，走旧的 <pre> 展示。
 *
 * 为什么不引第三方 YAML 库：条目正文是我们自己 prompt 约定的**受控子集**
 *（两级 `key: value` 与 `key: |` 块标量），手写解析完全确定，
 * 比引一个几十 KB 的依赖更可控，也不需要处理完整 YAML 的锚点/多文档等边界。
 *
 * 安全：**只做解析，不生成 HTML**。调用方拿 label/value 建 DOM 节点，
 * 绝不 innerHTML —— 条目正文来自 LLM，必须当作不可信文本。
 */

/** 这几行是 YAML 的块标量标记，展示时要去掉 */
const BLOCK_MARKER_RE = /^[|>][-+]?\d*$/;

/**
 * 尝试把正文解析成字段列表。
 * @param {string} text
 * @returns {{fields: Array<{label: string, value: string}>, plain: string}|null}
 *   解析成功返回 {fields}；不是结构化 YAML 返回 null（调用方回退到纯文本展示）
 */
export function parseEntryYaml(text) {
  const src = String(text || '');
  if (!src.trim()) return null;
  const lines = src.split('\n');

  const fields = [];
  let cur = null;

  for (const raw of lines) {
    // 顶格 `键:` 或 `键: 值`（键可以含中文、斜杠、点）
    const m = /^([^\s#][^:]*?):\s*(.*)$/.exec(raw);
    if (m && !/^\s/.test(raw)) {
      const label = m[1].trim();
      const rest = m[2].trim();
      cur = { label, value: BLOCK_MARKER_RE.test(rest) ? '' : rest };
      fields.push(cur);
      continue;
    }
    // 缩进行 → 续到当前字段（块标量的内容）
    if (cur && /^\s+\S/.test(raw)) {
      const t = raw.replace(/^\s+/, '');
      cur.value = cur.value ? `${cur.value}\n${t}` : t;
      continue;
    }
    // 既不是键也不是缩进内容：保持原样拼进当前字段（YAML 里的列表项等）
    if (cur && raw.trim()) {
      cur.value = cur.value ? `${cur.value}\n${raw.trim()}` : raw.trim();
    }
  }

  // 判据：至少 3 个字段，且**至少一个字段有实质内容**，否则不算结构化
  if (fields.length < 3) return null;
  const hasReal = fields.some(f => f.value.trim() && f.value.trim() !== '未提及');
  if (!hasReal) return null;

  return { fields };
}

/** 该字段是否"原文没有"（模板允许填未提及） */
export function isUnmentioned(value) {
  return /^(未提及|未知|无|暂无|不详|n\/?a|none|unknown)$/i.test(String(value || '').trim());
}

/** 字段名 → 展示顺序（把最重要的放前面；未列出的排在其后） */
const FIELD_ORDER = [
  'name', 'title', '类型', 'type', 'age', 'height', 'weight', 'measurements',
  '等级/品质', '时间', '参与者', '原著立场', '前置',
  'appearance', 'clothing', '地理特征', '气候环境', '外观',
  'background', '人口与阶层', '资源与产出', '文化与习俗', '重要地标', '控制势力',
  '层级或构成', '运作原理', '获取或晋升', '原理',
  'personality', 'preferences', '效果', '限制/代价', '限制/代价',
  'special_notes', '来源', '持有者/掌握者', '代表人物或实例',
  '起因', '经过', '结果', '影响', '干预可能',
  '当前局势', '与主线关联',
  '言行举止', 'erotic_abilities', '私处细节描写',
];

export function sortFields(fields) {
  const rank = new Map(FIELD_ORDER.map((k, i) => [k, i]));
  return [...fields].sort((a, b) => {
    const ra = rank.has(a.label) ? rank.get(a.label) : 999;
    const rb = rank.has(b.label) ? rank.get(b.label) : 999;
    return ra - rb;
  });
}

/** 统计：字段数 + 实质字数（用于列表里的"密度"徽标） */
export function densityStats(text) {
  const parsed = parseEntryYaml(text);
  if (!parsed) return { structured: false, fields: 0, chars: String(text || '').length };
  const chars = parsed.fields
    .filter(f => !isUnmentioned(f.value))
    .reduce((s, f) => s + f.value.replace(/\s/g, '').length, 0);
  return { structured: true, fields: parsed.fields.length, chars };
}
