/**
 * 把事件按「剧情段落」（批次）分组 —— 用于**按段撰写事件条目正文**。
 *
 * 为什么需要（用户提案 + 实测缺陷）：
 *   原来事件条目正文是**一次调用写全书所有事件**，而喂给模型的原文节选是
 *   `chunks.slice(0, 4)` —— 只有前 4 章。
 *   一本 25 章的书，第 5~25 章的事件条目正文，模型**根本没看到对应原文**，
 *   只能靠事件清单里的一行 canon 去编"起因/经过/结果/影响"。
 *
 * 用户的原话：剧情条目、地理条目根据剧情段落生成。
 * 地理条目已经是按批抽取了；剧情条目这里补上"按段写正文"。
 *
 * 设计：
 *   · 事件在抽取时就被打上 `chapter`（stampChapter），这里靠章节标题归到批次；
 *   · 一批 = 一个剧情段落，每段一次调用，只喂该段原文；
 *   · 归不进任何批次的事件（模型把章节名写错/省略）退回 fallback 批次，
 *     最后用全文章节摘要兜底，**不丢事件**。
 */

/** 归一化章节标题：去空白、全角括号统一 */
function normTitle(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .toLowerCase();
}

/** 从章节名里取数字（"第3章" → 3；"第三章" 中文数字也尽力映射） */
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function chapterNumber(s) {
  const t = String(s || '');
  const m = /(\d+)/.exec(t);
  if (m) return Number(m[1]);
  // 简单中文数字：第三章 / 第十二章（只处理 1-99 的常见写法）
  const cn = /第([一二三四五六七八九十]{1,2})章/.exec(t);
  if (cn) {
    const w = cn[1];
    if (w.length === 1) return CN_DIGITS[w] || null;
    const [a, b] = w;
    if (a === '十') return 10 + (CN_DIGITS[b] || 0);
    if (b === '十') return (CN_DIGITS[a] || 0) * 10;
    return (CN_DIGITS[a] || 0) * 10 + (CN_DIGITS[b] || 0);
  }
  return null;
}

/**
 * 给事件打上章节标记（抽取时调用）。
 *
 * 模型返回的事件里通常**没有** chapter 字段 —— 章节信息在调用上下文里。
 * 不打这个标记，后续就无法把事件归到具体段落。
 *
 * @param {Array} events
 * @param {string} chapterTitle
 * @returns {Array} 新数组（不修改传入对象）
 */
export function stampChapter(events, chapterTitle) {
  const list = Array.isArray(events) ? events : [];
  return list.map((e) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
    const hasOwn = String(e.chapter || '').trim();
    return hasOwn ? e : { ...e, chapter: chapterTitle };
  });
}

/**
 * 事件按批次分组。
 *
 * @param {Array} events 已打章节标记的事件
 * @param {Array<{chapters:Array<{title:string,text:string}>}>} batches 批次（splitIntoBatches 的产出）
 * @param {{maxChars?:number, fallbackText?:string}} [opts]
 * @returns {{segments:Array, unmatched:Array, stats:object}}
 *   segments: [{ batchIndex, label, chapterTitles, events, text }]
 *   unmatched: 没归入任何批次的事件
 */
export function groupEventsBySegment(events, batches = [], opts = {}) {
  const maxChars = Math.max(500, Number(opts.maxChars) || 15000);
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  const bs = Array.isArray(batches) ? batches.filter(b => b && Array.isArray(b.chapters)) : [];

  /** 章节标题 → 批次下标（精确 + 归一化） */
  const byTitle = new Map();
  const byNumber = new Map();
  bs.forEach((b, bi) => {
    for (const c of b.chapters) {
      const t = String(c?.title || '').trim();
      if (!t) continue;
      if (!byTitle.has(t)) byTitle.set(t, bi);
      const nt = normTitle(t);
      if (nt && !byTitle.has(nt)) byTitle.set(nt, bi);
      const n = chapterNumber(t);
      if (n != null && !byNumber.has(n)) byNumber.set(n, bi);
    }
  });

  /** 事件 → 批次 */
  const buckets = new Map(bs.map((_, bi) => [bi, []]));
  const unmatched = [];
  for (const e of list) {
    const raw = String(e?.chapter || '').trim();
    let bi = null;
    if (raw) {
      bi = byTitle.get(raw) ?? byTitle.get(normTitle(raw)) ?? null;
      if (bi == null) {
        const n = chapterNumber(raw);
        if (n != null) bi = byNumber.get(n) ?? null;
      }
      // 标题包含关系兜底（模型可能写成「第一章 雪原」vs 原文「第1章 雪原」）
      if (bi == null) {
        const nt = normTitle(raw);
        for (const [t2, b2] of byTitle.entries()) {
          if (t2.length >= 3 && (t2.includes(nt) || nt.includes(t2))) { bi = b2; break; }
        }
      }
    }
    if (bi == null) unmatched.push(e);
    else buckets.get(bi).push(e);
  }

  const segments = [];
  for (const [bi, evs] of buckets.entries()) {
    if (!evs.length) continue;
    const b = bs[bi];
    const chapterTitles = b.chapters.map(c => String(c?.title || '').trim()).filter(Boolean);
    const text = b.chapters.map(c => `${c?.title || ''}\n${c?.text || ''}`).join('\n\n').slice(0, maxChars);
    segments.push({
      batchIndex: bi,
      label: `第 ${bi + 1} 段（${chapterTitles[0] || '?'}…${chapterTitles[chapterTitles.length - 1] || '?'}）`,
      chapterTitles,
      events: evs,
      text,
    });
  }
  segments.sort((a, b) => a.batchIndex - b.batchIndex);

  return {
    segments,
    unmatched,
    stats: {
      inputEvents: list.length,
      batchCount: bs.length,
      usedSegments: segments.length,
      matchedEvents: list.length - unmatched.length,
      unmatchedEvents: unmatched.length,
      budgetChars: segments.reduce((a, s) => a + s.text.length, 0),
    },
  };
}

/**
 * 未归段事件的兜底原文：按章节标题取前若干段（尽量别只给前 4 章）。
 * 没有可用章节时返回空串。
 */
export function fallbackExcerpt(chunks = [], chapters = [], maxChars = 15000) {
  const titles = new Set((chapters || []).map(t => normTitle(t)));
  const picked = (chunks || []).filter(c => titles.size === 0 || titles.has(normTitle(c?.title)));
  const source = picked.length ? picked : (chunks || []);
  return source.map(c => `${c?.title || ''}\n${c?.text || ''}`).join('\n\n').slice(0, maxChars);
}
