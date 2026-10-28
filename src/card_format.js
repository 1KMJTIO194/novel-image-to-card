/**
 * 角色卡格式：**普通卡（无美化、无变量）** / **完整卡（有美化、有变量）**。
 *
 * 用户要求（原话）：
 *   「生成角色卡功能增加一个没有美化和变量的普通角色卡
 *     以及有美化和变量的完整角色卡」
 *
 * 两个词在这里的定义（写清楚，免得歧义）：
 *   · **美化** = 状态栏（HTML 状态面板）+ 配套的 7 条内嵌正则
 *     （正文美化 / 状态栏美化 / 状态栏纯文本 / 思维链隐藏 / 变量更新隐藏 …）
 *   · **变量** = MVU 变量树：`[initvar]勿启用` 条目、`变量更新规则`、`变量更新强调`、
 *     `导演指令`、`角色阶段`，以及卡片里注册 MVU 的 tavern_helper 脚本
 *
 * 普通卡（plain）：
 *   只保留 **ST 原生就能用的东西** —— 角色字段（description / personality /
 *   scenario / first_mes / alternate_greetings / tags）+ 世界书
 *   （时间线、剧情简介、世界观、人物、事件、故事线）。
 *   不需要「酒馆助手」「MVU」扩展，导入即用；代价是没有状态面板、没有变量推进。
 *
 * 完整卡（enhanced）：保持原有行为。
 *
 * 默认 = **enhanced**（保持向后兼容：老用户不传值时拿到的还是原来那张卡）。
 */

export const CARD_FORMATS = ['plain', 'enhanced'];

/** 归一化：不传 / 传错一律按完整卡（与原行为一致，避免意外削弱现有产出） */
export function normalizeCardFormat(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'plain' || s === '普通' || s === '普通版' || s === 'simple') return 'plain';
  return 'enhanced';
}

export function isPlainCard(format) {
  return normalizeCardFormat(format) === 'plain';
}

/**
 * 普通卡要丢掉的**内置固定条目**（按 comment 精确匹配）。
 *
 * 覆盖：变量初始化、变量更新规则/强调、导演指令、角色阶段、围栏与隔离、
 * 输出纪律（状态栏占位符说明）、干预与偏离度。
 *
 * 刻意**不**丢：[timeline] / [synopsis] / 世界观 / 人物 / 事件 / 故事线 ——
 * 那些是"设定信息"，不是美化也不是变量。
 */
export const PLAIN_DROP_COMMENTS = [
  '[initvar]勿启用',
  '变量更新规则',
  '变量更新强调',
  '导演指令',
  '角色阶段',
  '围栏与隔离',
  '输出纪律',
  '干预与偏离度',
];

/** 普通卡的 creator_notes（导入说明要跟着换：不再需要那两个扩展） */
const PLAIN_CREATOR_NOTES = [
  '由「小说 → 角色卡生成器」自动生成的**普通卡**（无美化、无变量）。',
  '',
  '【这张卡里有什么】',
  '· 角色字段：description / personality / scenario / first_mes / 备选开场 / 标签',
  '· 内嵌世界书：时间线、原著剧情简介、世界观条目、人物条目、事件条目、故事线',
  '',
  '【这张卡里没有什么】',
  '· 没有状态栏（HTML 状态面板）与配套正则 —— 不需要「酒馆助手」扩展',
  '· 没有 MVU 变量树、变量更新规则、导演指令、角色阶段 —— 不需要「MVU」变量框架',
  '',
  '【导入后要做的一件事】',
  '打开本角色的角色面板时会弹窗',
  '「This character has an embedded World/Lorebook. Would you like to import it now?」，',
  '请点「是」。漏掉的后果：世界书条目一条都不会进提示词，模型会完全不理原著。',
  '（点过「否」也不会再弹：角色面板 More… →「Import Card Lore」可补救。）',
  '',
  '【想要美化与变量】',
  '用同一份原文再生成一次「完整卡」，那张卡带状态栏与变量树，',
  '代价是需要安装「酒馆助手」（4.2.0+）与「MVU」变量框架。',
].join('\n');

/**
 * 把一张完整卡改造成普通卡（纯函数，不改入参）。
 *
 * @param {{data: object}} card
 * @param {{keepTimeline?: boolean}} [opts]
 */
export function makePlainCard(card, opts = {}) {
  if (!card || typeof card !== 'object' || !card.data) return card;
  const drop = new Set(PLAIN_DROP_COMMENTS);
  if (opts.keepTimeline === false) drop.add('[timeline]');

  /** 深拷贝 + 过滤条目 + 删扩展 */
  const next = JSON.parse(JSON.stringify(card));
  const book = next.data.character_book;
  if (book && Array.isArray(book.entries)) {
    book.entries = book.entries
      .filter(e => !drop.has(String(e?.comment || '').trim()))
      // id 必须重排：ST 用 id 作为条目标识，删条目后留空洞没问题，
      // 但保持连续更利于别的工具读
      .map((e, i) => ({ ...e, id: i }));
  }

  /**
   * 去掉美化与变量的挂载：
   *   · regex_scripts —— 7 条内嵌正则（美化、隐藏、变量提取）
   *   · tavern_helper —— MVU 脚本注册
   * 其余 extensions（world / depth_prompt / talkativeness …）保留。
   */
  if (next.data.extensions && typeof next.data.extensions === 'object') {
    delete next.data.extensions.regex_scripts;
    delete next.data.extensions.tavern_helper;
  }

  next.data.creator_notes = PLAIN_CREATOR_NOTES;
  // 顶层也有一份 creatorcomment（ST 显示用），保持一致
  if (typeof next.creatorcomment === 'string') {
    next.creatorcomment = '由小说 → 角色卡生成器生成（普通卡：无美化、无变量）';
  }
  return next;
}

/** 给用户看的说明（日志 / UI 用） */
export function describeCardFormat(format) {
  return isPlainCard(format)
    ? '普通卡（无美化、无变量，导入即用）'
    : '完整卡（含状态栏美化与变量树）';
}
