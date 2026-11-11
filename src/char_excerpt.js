/**
 * 主要角色的**定向原文节选**：按角色出场章节取样。
 *
 * 为什么需要（用户提案 + 上轮 token 审计的结论）：
 *   原来所有角色共用一份 `sampleAcrossText(text, 10000)`（全书均匀随机抽样）。
 *   所以"每个角色单独生成"只是把**同一份随机抽样**多发几遍 —— 模型注意力集中了，
 *   但看到的原文并没有变得更相关，收益有限。
 *
 *   正确做法：对主要角色，按名字在章节里检索，取它**真正出场**的若干章
 *   （首章 + 尾章 + 均匀分布），这样每个角色的档案都能看到自己的关键戏份。
 *
 * 成本：与逐个生成本身相同（每角色一份 ~1 万字节选），不额外增加。
 */

/**
 * 找出角色出场的章节下标。
 *
 * @param {Array<{title:string,text:string}>} chunks 章节
 * @param {string[]|string} names 角色名 + 别名（少于 2 字的会被忽略，避免单字误命中）
 * @param {{maxChapters?:number}} [opts]
 * @returns {number[]} 升序下标（最多 maxChapters 个）
 */
export function findCharacterChapters(chunks, names, opts = {}) {
  const maxChapters = Math.max(1, Number(opts.maxChapters) || 6);
  const list = Array.isArray(chunks) ? chunks : [];
  const keys = (Array.isArray(names) ? names : [names])
    .map(n => String(n || '').trim())
    .filter(n => n.length >= 2);
  if (!keys.length || !list.length) return [];

  const hits = [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i]?.text || '');
    if (!text) continue;
    if (keys.some(k => text.includes(k))) hits.push(i);
  }
  if (hits.length <= maxChapters) return hits;

  /**
   * 出场章太多时不能只取前面几章 —— 长篇小说里角色的变化恰恰在后面。
   * 取首章、尾章 + 中间均匀分布，保证"出场早/中/晚"都被覆盖。
   */
  const picked = new Set([hits[0], hits[hits.length - 1]]);
  const step = (hits.length - 1) / (maxChapters - 1);
  for (let i = 0; i < maxChapters; i++) picked.add(hits[Math.round(i * step)]);
  return [...picked].sort((a, b) => a - b);
}

/**
 * 构造某角色的定向节选。
 *
 * 每个被选中的章节按预算切一段（不是把前几章整章塞进来），
 * 保证 maxChars 内覆盖首/中/尾。
 *
 * @param {Array} chunks
 * @param {string[]|string} names
 * @param {{maxChars?:number, maxChapters?:number}} [opts]
 * @returns {{text:string, chapters:string[], matched:boolean}}
 */
export function buildCharacterExcerpt(chunks, names, opts = {}) {
  const maxChars = Math.max(800, Number(opts.maxChars) || 10000);
  const maxChapters = Math.max(1, Number(opts.maxChapters) || 6);
  const hits = findCharacterChapters(chunks, names, { maxChapters });
  if (!hits.length) return { text: '', chapters: [], matched: false };

  const per = Math.max(400, Math.floor(maxChars / hits.length));
  const parts = hits.map((i) => {
    const c = chunks[i] || {};
    const text = String(c.text || '');
    const cut = text.length > per ? `${text.slice(0, per)}…` : text;
    return `【${String(c.title || `第${i + 1}章`)}】\n${cut}`;
  });
  return {
    text: parts.join('\n\n').slice(0, maxChars),
    chapters: hits.map(i => String(chunks[i]?.title || `#${i + 1}`)),
    matched: true,
  };
}
