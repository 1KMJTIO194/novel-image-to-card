/**
 * 角色卡版本：**普通版（不含成人内容） / 成人版（完整包含成人内容）**。
 *
 * 用户要求（原话）：
 *   「角色卡增加一个生成普通角色卡（不含成人内容的角色卡）
 *     生成成人版角色卡（完整的包含成人内容的角色卡）的功能」
 *
 * 设计原则：
 *   ① **普通版是默认**。不传 / 传错时一律按普通版 —— 宁可少写，不能让用户
 *      在不知情的情况下生成成人内容。
 *   ② 普通版不能只靠 prompt：模型经常无视"不要写"的指令，所以**代码里再删一道**
 *      （`stripAdultFieldsFromYaml`）。成人字段（`erotic_abilities`、
 *      `私处细节描写`）直接移除，不留空行占位。
 *   ③ 成人版要求**出场角色均为成年（18+）**。资料显示/暗示未成年时，
 *      即使选了成人版也不写成人内容 —— 这条写进 prompt，并在成人版说明里告知用户。
 *   ④ 图片路径特殊：画面能提供的是**可见事实**（体型、衣着、裸露程度），
 *      无法提供"私处细节"这类设定。所以图片路径的成人字段只在**转录文字明确写了**
 *      的时候才写，否则写「未提及」——不编造。
 */

/** 合法版本 */
export const CONTENT_MODES = ['general', 'adult'];

/**
 * 归一化。默认普通版；`adult` / `成人版` / `r18` 认作成人版。
 */
export function normalizeContentMode(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'adult' || s === 'r18' || s === '18+' || s === '成人版' || s === 'nsfw') return 'adult';
  return 'general';
}

export function isAdultMode(mode) {
  return normalizeContentMode(mode) === 'adult';
}

/** 成人字段名（普通版要移除的键） */
export const ADULT_FIELD_KEYS = ['erotic_abilities', '私处细节描写'];

/**
 * 两档都要遵守的底线：出场角色须成年。
 *
 * 放在两档共用的规则里：普通版本来就不写成人内容，这条只是把"不写"的理由说清；
 * 成人版靠它兜住"资料里出现未成年角色"的情况。
 */
export const ADULT_BASELINE_RULE = [
  '',
  '【年龄底线】',
  '本卡涉及的角色必须全部为**成年人（18 岁及以上）**。',
  '如果资料显示或暗示某角色未成年，则**不要**为该角色写任何性/露骨内容；',
  '成人字段一律写「不适用」。',
].join('\n');

/** 普通版：明确不写成人内容 */
export const GENERAL_MODE_RULE = [
  '',
  '【本卡为普通版（不含成人内容）】',
  '- 不要写任何性描写、性行为、性器官描写或性暗示内容。',
  '- `erotic_abilities` 与 `私处细节描写` 这两个字段**整段省略**，不要写、也不要留空行占位。',
  '- `preferences` 只写日常喜好与厌恶（食物、场所、事物、人），不要写性偏好。',
  '- 性格、关系、经历照常写细，只是不涉及成人内容。',
].join('\n');

/** 成人版：把成人字段写具体（但仍受事实与年龄底线约束） */
export const ADULT_MODE_RULE = [
  '',
  '【本卡为成人版（完整包含成人内容）】',
  '- `erotic_abilities`：写清性方面的特殊设定、敏感点、癖好与边界，写具体，不要用含糊词。',
  '- `私处细节描写`：按「乳房 / 小穴 / 肛门」三项分别描写；只写资料能支持的，',
  '  资料没写到的部位写「未提及」，**不要凭空编造**。',
  '- `preferences` 可以包含性偏好，与日常喜好分开写。',
  '- 描写要具体、有细节，但不要写与角色设定冲突的内容。',
  '- 仍然遵守上面的年龄底线：未成年角色不写成人内容。',
].join('\n');

/**
 * 给 prompt 追加版本规则。
 *
 * @param {string} prompt 原 prompt
 * @param {'general'|'adult'} mode
 * @param {'character'|'summary'|'none'} [kind]
 *    character —— 小说路径的人物档案（含成人字段模板）
 *    summary   —— 图片路径的信息总结（人物字段里没有成人键，但可能写进 appearance 等）
 *    none      —— 只加年龄底线
 */
export function withContentRules(prompt, mode, kind = 'none') {
  const adult = isAdultMode(mode);
  let out = String(prompt || '');
  if (kind === 'character' || kind === 'summary') {
    out += adult ? ADULT_MODE_RULE : GENERAL_MODE_RULE;
  }
  out += ADULT_BASELINE_RULE;
  return out;
}

/**
 * 从一段 **content_yaml 文本**里删掉成人字段（连同它们的缩进子块）。
 *
 * 为什么是文本级而不是解析 YAML 再序列化：
 *   这一段最终是**原样塞进世界书**的文本，用户/其他工具按 YAML 读它。
 *   解析再 dump 会改变缩进与 `|` 块风格（甚至丢掉注释），风险比删几行更大。
 *   这里只做"按行删块"，其余一个字不动。
 *
 * @param {string} text content_yaml 文本
 * @returns {string}
 */
export function stripAdultFieldsFromYaml(text) {
  const s = String(text || '');
  if (!s.trim()) return s;

  const keep = [];
  let skipping = false;
  for (const line of s.split('\n')) {
    /** 顶层键行（不缩进、`key:` 形式） */
    const topKey = /^([A-Za-z_\u4e00-\u9fa5][\w\u4e00-\u9fa5]*)\s*:/.exec(line);
    if (topKey) {
      const key = topKey[1];
      // 成人字段本身 → 开始跳过
      if (ADULT_FIELD_KEYS.includes(key)) { skipping = true; continue; }
      // 其它顶层键 → 结束跳过
      skipping = false;
      keep.push(line);
      continue;
    }
    // 缩进行：跳过字段内 / 空行：正常保留（空行不影响块识别）
    if (skipping && /^\s+\S/.test(line)) continue;
    if (skipping && line.trim() === '') continue;
    keep.push(line);
  }

  // 收拾连续空行（删掉字段后可能留下两个空行）
  return keep.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/**
 * 按版本处理一条人物条目（小说路径的产出）。
 *
 * @param {object} item 人物条目（含 content / content_yaml）
 * @param {string} mode
 * @returns {object} 新对象（不修改入参）
 */
export function applyContentModeToCharItem(item, mode) {
  if (!item || typeof item !== 'object') return item;
  if (isAdultMode(mode)) return item;          // 成人版原样
  const next = { ...item };
  if (typeof next.content === 'string') next.content = stripAdultFieldsFromYaml(next.content);
  if (typeof next.content_yaml === 'string') next.content_yaml = stripAdultFieldsFromYaml(next.content_yaml);
  return next;
}

/** 给用户看的档位说明（UI / 日志用） */
export function describeContentMode(mode) {
  return isAdultMode(mode)
    ? '成人版（完整包含成人内容；出场角色须全员成年）'
    : '普通版（不含成人内容）';
}
