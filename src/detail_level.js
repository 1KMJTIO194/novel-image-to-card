/**
 * 生成档位：**基础版 / 完整版**。
 *
 * 用户要求（原话）：
 *   「当前生成角色卡为基础版 Token 消耗较少，
 *     增加一个完整版 Token 消耗更多但是角色卡更细致完善」
 *
 * 所以这里只放**两档之间的差异**，两条生成路径（小说 / 图片）共用：
 *   · 基础版：保持原有调用次数与字数要求（token 省）
 *   · 完整版：人物档案字段写全 + 字数下限 + 世界观更细 + 概要更长
 *
 * 另外有一条**两档都加**的硬约束（用户指定）：
 *   反转 / 伏笔 / 阴谋论 —— 不搞术语黑名单，只加一条
 *   「禁止推测未揭示的真相」。
 *   原因：黑名单能绕开（"实际上"、"原来"），而"只写已明确说出的"是可判定的。
 */

/** 合法档位 */
export const DETAIL_LEVELS = ['basic', 'full'];

/**
 * 归一化档位。非法值一律按基础版处理 —— 宁可少花 token，
 * 也不要因为前端传了个奇怪的值导致整轮成本翻倍。
 */
export function normalizeDetailLevel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'full' || s === '完整版' || s === 'complete') return 'full';
  return 'basic';
}

export function isFull(level) {
  return normalizeDetailLevel(level) === 'full';
}

/**
 * 两档都适用的反剧透约束。
 *
 * 用户明确说：不要反转、伏笔、阴谋论 —— 但**只加这一条就够**，
 * 不要堆一堆术语黑名单。
 */
export const NO_SPOILER_RULE = [
  '',
  '【禁止推测未揭示的真相】',
  '只写原文/资料里**已经明确说出**的内容。',
  '不要推测、补完或暗示尚未揭示的真相、隐藏身份、幕后主使、后续转折；',
  '不要用「其实……」「真正的……」「幕后……」这类说法给出结论。',
  '信息不足就写「未提及」，不要用推断去填。',
].join('\n');

/** 完整版：人物档案追加要求 */
export const FULL_CHARACTER_RULE = [
  '',
  '【完整版：档案要写得更细】',
  '- 人物卡模板里的字段尽量写全；确实没有信息的字段写「未提及」，但**不要整段省略**。',
  '- 字数下限：appearance ≥150 字、clothing ≥120 字、background ≥200 字、',
  '  personality ≥120 字、言行举止 ≥120 字。',
  '- 额外补写：identity（身份一句话）、relations（与主要人物的关系与互相称呼）、',
  '  speechStyle（语气/口癖/称呼习惯）、voiceSample（1-2 句台词示例，用来定口吻）。',
  '- appearance 按「发型 → 面部 → 肤色体态 → 特殊标记」分层；',
  '  clothing 按「上装 → 下装 → 外搭 → 鞋袜 → 配饰」分层。',
  '- 以上都只能写原文/画面能支持的内容，不要编造。',
].join('\n');

/** 完整版：世界观追加要求 */
export const FULL_WORLDBOOK_RULE = [
  '',
  '【完整版：世界观要写得更细】',
  '- 地理要能看出从属关系：每个具体地点写明它属于哪个区域、哪个世界。',
  '- 条目可以更多（一条只说一件事），每条正文 ≥120 字。',
  '- 势力 / 体系 / 历史要写清：它是什么、怎么运作、与其它条目的关系、对普通人的影响。',
].join('\n');

/** 完整版：剧情概要追加要求 */
export const FULL_SYNOPSIS_RULE = [
  '',
  '【完整版：概要要写完整】',
  '- 按时间顺序覆盖主要事件，写到当前结局/最新进展为止。',
  '- 写清人物关系的变化脉络（谁与谁、从什么关系变成什么关系）。',
  '- 只写已经发生的事；不要写预测、悬念或未揭示的内容。',
].join('\n');

/**
 * 完整版：**图片的信息总结**追加要求。
 *
 * 图片路径的总结要同时产出人物 / 世界观 / 舞台，所以这里把
 * 人物与世界观两套要求都要过来，并额外要求舞台写得能直接开演。
 */
export const FULL_SUMMARY_RULE = [
  '',
  '【完整版：总结要更细】',
  '- 人物：尽量写全字段（identity / appearance / clothing / personality /',
  '  speechStyle / relations / background / preferences / 言行举止），',
  '  其中 appearance ≥150 字（按 发型→面部→肤色体态→特殊标记 分层），',
  '  clothing ≥120 字（按 上装→下装→外搭→鞋袜→配饰 分层）；',
  '  另外给每个人 1-2 句 voiceSample（台词示例），用来定口吻。',
  '- 世界观：地理要能看出从属（地点属于哪个区域/世界），每条正文 ≥120 字；',
  '  势力与体系要写清「是什么 / 怎么运作 / 对普通人的影响」。',
  '- 舞台（scenario）要写得更具体：在哪、在场有谁、当前处境、正在发生什么。',
  '- 以上都只能写资料与画面能支持的内容，不要编造。',
].join('\n');

/**
 * 给一个 prompt 追加档位规则。
 *
 * @param {string} prompt 原 prompt
 * @param {'basic'|'full'} level
 * @param {'character'|'worldbook'|'synopsis'|'summary'|'none'} kind
 * @param {{noSpoiler?:boolean}} [opts] 默认 true（两档都加）
 */
export function withDetailRules(prompt, level, kind = 'none', { noSpoiler = true } = {}) {
  let out = String(prompt || '');
  if (kind === 'character' && isFull(level)) out += FULL_CHARACTER_RULE;
  if (kind === 'worldbook' && isFull(level)) out += FULL_WORLDBOOK_RULE;
  if (kind === 'synopsis' && isFull(level)) out += FULL_SYNOPSIS_RULE;
  if (kind === 'summary' && isFull(level)) out += FULL_SUMMARY_RULE;
  if (noSpoiler) out += NO_SPOILER_RULE;
  return out;
}

/**
 * 两条路径共用的数字参数。
 *
 * `basic` 就是**原来那一套**（不改动 token 消耗）；
 * `full` 只把"多花的钱"用在最影响可用性的地方：
 * 更多主要角色做外观精修、每个角色多看几张图。
 */
export const DETAIL_PRESETS = {
  basic: {
    /** 图片路径：最多精修几个主要角色 */
    refineMax: 3,
    /** 图片路径：每个角色看几张图 */
    imagesPerChar: 6,
    /** 剧情概要字数上限 */
    synopsisMaxChars: 1200,
    /** 图片路径：总结里每个角色外貌的目标下限（只作为 prompt 要求） */
    appearanceTarget: 80,
  },
  full: {
    refineMax: 6,
    imagesPerChar: 8,
    synopsisMaxChars: 2400,
    appearanceTarget: 150,
  },
};

/** 取档位对应的数字参数 */
export function detailPreset(level) {
  return isFull(level) ? DETAIL_PRESETS.full : DETAIL_PRESETS.basic;
}
