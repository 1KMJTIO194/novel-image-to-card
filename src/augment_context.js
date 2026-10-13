/**
 * 完善角色卡时的「用户指令」与「已有卡世界观」上下文。
 *
 * 用户诉求（原话）：
 *   「让小说中的角色合并到角色卡里并且角色设定要符合角色卡世界观」
 *   「小说中的地图势力等内容合并到角色卡里并且要符合角色卡世界观」
 *
 * 也就是两类需求：
 *   ① **指令**：用户想怎么完善（挑哪些角色、地图要不要、要不要贴合原卡）
 *   ② **一致性**：新抽出来的角色/地图/势力必须**符合原卡世界观**，不能自造设定
 *
 * ①靠把指令文本拼进各步骤的 user 消息；②靠把**已有卡的世界观摘要**一起喂进去 ——
 * 光说"要符合世界观"而没有给出世界观内容，模型只能猜。
 *
 * 抽成独立模块是为了可测：这段逻辑决定"给模型看了什么"，
 * 而它出错的方式很隐蔽（喂了空摘要、截断成没有信息量的片段），
 * 光看日志看不出来。
 */

/** 单条摘要的默认长度上限（字符） */
const DEFAULT_ITEM_CHARS = 60;

/**
 * 把已有卡拼成一段紧凑的「世界观摘要」。
 *
 * 为什么不全塞进去：一张卡的条目正文可能有 8 万字，全部塞进去会
 * 挤爆上下文、并且让新剧情文本被淹没。这里只取**条目名 + 正文首句**，
 * 够模型判断"这个世界叫什么、有哪些势力/地点/体系"即可。
 *
 * @param {object} structure `extractCardStructure` 的产出
 * @param {{maxItems?:number, itemChars?:number}} [opts]
 * @returns {string} 空卡时返回空串
 */
export function buildCardWorldviewDigest(structure, { maxItems = 60, itemChars = DEFAULT_ITEM_CHARS } = {}) {
  const entries = Array.isArray(structure?.entries) ? structure.entries : [];
  if (!entries.length) return '';

  /**
   * 取一条正文里**最有信息量**的一句话。
   *
   * 踩过的坑：一开始只取「第一个有值字段」，而档案类条目的第一个字段几乎总是
   * `name: 林昭` —— 与条目名重复，摘要就成了「林昭：林昭」，等于没给模型任何信息。
   *
   * 所以这里分两步：
   *   ① 优先取「描述性字段」的值（appearance / 外貌 / 地理概况 / 运作原理…）
   *   ② 退而取「与条目名不同的」第一个有值字段或第一句话
   */
  const DESC_KEYS = /(appearance|外貌|外观|地理|运作|原理|描述|介绍|内容|类型|简介|效果|说明|特征|个性|性格)/i;
  const firstLine = (text, itemName = '') => {
    const raw = String(text || '');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    const nameKey = String(itemName || '').trim();

    /** 把 `key: value` 拆开；不是键值行则返回 null */
    const asKV = (l) => {
      const m = /^([^:：]{1,24})[:：]\s*(.*)$/.exec(l);
      if (!m) return null;
      return { key: m[1].trim(), value: m[2].trim() };
    };

    /** 值是不是"没有内容"（键名占位 / 空 / 流水线标记） */
    const emptyish = (v) => !v || v === '|' || v === '>' || v === '未提及' || v === '无' || v === 'None';

    const clean = (s) => s.replace(/[*_`>#]/g, '').replace(/\s+/g, ' ').trim();

    // ① 优先描述性字段
    for (const l of lines) {
      const kv = asKV(l);
      if (!kv || emptyish(kv.value)) continue;
      if (DESC_KEYS.test(kv.key)) {
        const v = clean(kv.value);
        if (v) return v.length > itemChars ? v.slice(0, itemChars) + '…' : v;
      }
    }
    // ② 退而取与条目名不同的第一个有值字段
    for (const l of lines) {
      const kv = asKV(l);
      if (!kv || emptyish(kv.value)) continue;
      if (nameKey && clean(kv.value) === clean(nameKey)) continue;   // 与条目名重复 → 跳过
      const v = clean(kv.value);
      if (v) return v.length > itemChars ? v.slice(0, itemChars) + '…' : v;
    }
    // ③ 最后退回第一句非键值内容
    for (const l of lines) {
      if (asKV(l)) continue;
      const v = clean(l);
      if (v) return v.length > itemChars ? v.slice(0, itemChars) + '…' : v;
    }
    return '';
  };

  /** 去掉 `[分组] ` 前缀 */
  const nameOf = (e) => String(e?.comment || '').replace(/^\[[^\]]*\]\s*/, '').trim();

  /** 按分组归类，顺序固定，便于阅读 */
  const groups = [
    ['人物', []],
    ['世界观 / 地点 / 势力 / 体系', []],
    ['剧情事件', []],
    ['其它', []],
  ];
  const bucket = (e) => {
    const g = e?.extensions?.group;
    if (g === 'character' || /^\[character/.test(String(e?.comment || ''))) return 0;
    if (g && /^(map_|system_|history)/.test(String(g))) return 1;
    if (g === 'event' || /^\[event/.test(String(e?.comment || ''))) return 2;
    return 3;
  };

  for (const e of entries) {
    const nm = nameOf(e);
    if (!nm) continue;
    const line = firstLine(e.content, nm);
    groups[bucket(e)][1].push(line ? `${nm}：${line}` : nm);
  }

  const out = [];
  let used = 0;
  for (const [label, items] of groups) {
    if (!items.length) continue;
    const room = Math.max(0, maxItems - used);
    if (!room) break;
    const shown = items.slice(0, room);
    out.push(`【${label}】\n${shown.map(s => `- ${s}`).join('\n')}`);
    used += shown.length;
  }
  if (used && entries.length > used) {
    out.push(`（另有 ${entries.length - used} 条未列出）`);
  }
  return out.join('\n\n');
}

/**
 * 拼「用户指令」段。
 *
 * @param {string} instruction 用户输入
 * @param {string} [label] 段的标题，默认「用户对本次完善的额外要求」
 */
export function buildInstructionBlock(instruction, label = '用户对本次完善的额外要求') {
  const t = String(instruction || '').trim();
  if (!t) return '';
  return `\n\n【${label}（优先级高于下面的通用规则，但不得违反事实）】\n${t}`;
}

/**
 * 拼「已有卡世界观」段 —— 让新内容向原卡看齐。
 *
 * 措辞刻意强调「符合」与「不要自造」：用户明确要的是
 * "角色设定要符合角色卡世界观"，而不是"各写各的"。
 */
export function buildWorldviewBlock(digest) {
  const t = String(digest || '').trim();
  if (!t) return '';
  return `\n\n【已有角色卡的世界观（新抽取的内容必须与之**一致**）】\n${t}\n\n`
    + '一致性要求：\n'
    + '- 名词沿用已有卡的说法（同一个地点/势力/体系不要另起名字）\n'
    + '- 新角色的身份、能力、立场要能放进这个世界观，不要引入与它矛盾的新体系\n'
    + '- 已有卡没提到的、且原文也没写的设定，不要凭空补全';
}

/**
 * 一次性拼出「指令 + 世界观」两段，供各步骤的 user 消息复用。
 *
 * @param {{instruction?:string, digest?:string}} opts
 * @returns {string} 无内容时返回空串（便于直接拼）
 */
export function buildAugmentContext({ instruction, digest } = {}) {
  return buildWorldviewBlock(digest) + buildInstructionBlock(instruction);
}
