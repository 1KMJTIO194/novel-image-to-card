/**
 * 人物分层（按剧情占比）
 *
 * 为什么单独一个模块：这些常量与纯函数被 `pipeline.js`（分层、变量树）、
 * `merge_batches.js`（归并时的主名优选）和测试同时使用。
 * 放在 pipeline 里会让 merge_batches 在模块顶层读到一个还没求值完的绑定
 * （循环依赖 → `Cannot access 'TIER_RANK' before initialization`），
 * 放在这里两边都只依赖它，没有环。
 *
 * 分层为什么需要：
 * 原来只有「主角 / 主要配角 / 次要配角 / 提及」四档，而这四档**完全是模型自己说的**，
 * 没有任何客观依据 —— 同一本书换个模型可能给出完全不同的分层，而「配角」这个词
 * 既指"戏份很多的二号人物"也指"只出现一次的路人"。后果直接落在三处：
 * 变量树给谁建好感度、状态栏显示谁、人物条目写多详细。
 *
 * 现在的做法：**占比由原文算，模型只给提示**。
 *   - 量：`storyRatio` = 角色出现在多少比例的**章节**里（按章去重，不是提及次数）
 *   - 层：按阈值切档（主要 ≥30% / 次要 ≥10% / 其余路人）
 *   - 模型给的 `role` 只在"没有章节可统计"时兜底，不覆盖实测结果
 *
 * 为什么用章节占比而不是提及次数：提及次数会被一段集中对话灌爆 ——
 * 某个路人只要在茶楼里跟主角聊上 30 句，次数就能压过贯穿全书的二号人物。
 * 章节覆盖率天然抗这个：戏份分散在多章才算重要。
 */

/** 四档分层。主角由 userMode 判定，其余三档由剧情占比算出。 */
export const NPC_TIERS = ['主角', '主要NPC', '次要NPC', '路人NPC'];

/** 分层阈值：占全部章节的比例 */
export const TIER_THRESHOLDS = {
  /** ≥ 30% 的章节出现 → 主要NPC */
  major: 0.3,
  /** ≥ 10% 的章节出现 → 次要NPC；不到就是路人NPC */
  minor: 0.1,
};

/**
 * 分层排序权重（越小越靠前）。主角固定 0。
 * 同时接受**历史档位名**：老卡、老预设、老批次文件里出现的「主要配角」等，
 * 一律映射到对应档位，而不是被当成"未知"排到最后。
 */
export const TIER_RANK = {
  主角: 0, 主要NPC: 1, 次要NPC: 2, 路人NPC: 3,
  主要配角: 1, 次要配角: 2, 提及: 3,
};

/** 旧档位名 → 新档位名 */
export const LEGACY_ROLE_MAP = {
  主角: '主角',
  主要配角: '主要NPC',
  次要配角: '次要NPC',
  提及: '路人NPC',
};

/**
 * 把任意来源的 role/tier 值收敛成 NPC_TIERS 里的一档。
 * @param {string} role
 * @param {string} fallback 认不出来时用哪一档
 */
export function normalizeTier(role, fallback = '次要NPC') {
  const s = String(role || '').trim();
  if (NPC_TIERS.includes(s)) return s;
  if (LEGACY_ROLE_MAP[s]) return LEGACY_ROLE_MAP[s];
  return fallback;
}

/** 该档位是否值得为它建变量（好感度/状态） */
export function tierGetsVariables(tier) {
  return tier !== '路人NPC';
}

/**
 * 世界书条目的注释前缀。
 *
 * 主角写 `[character]`，其余写 `[character·主要NPC]` 这种带分层的形式。
 * 读取侧**不能**用 `startsWith('[character]')` 或 `comment === '[character] 名'` 精确匹配 ——
 * 那样带分层的条目会被当成"不存在"（实测：augment 的 extractCardStructure
 * 因此把新生成的人物条目全部漏掉）。
 */
export function characterComment(name, tier) {
  const t = normalizeTier(tier, '次要NPC');
  return t === '主角' ? `[character] ${name}` : `[character·${t}] ${name}`;
}

/** 这条注释是不是人物条目（兼容带分层后缀与不带后缀两种） */
export function isCharacterComment(comment) {
  return /^\[character(\u00b7[^\]]+)?\]/.test(String(comment || ''));
}

/** 从人物条目注释里读出分层；读不出时返回 fallback */
export function tierFromComment(comment, fallback = '次要NPC') {
  const m = /^\[character\u00b7([^\]]+)\]/.exec(String(comment || ''));
  return normalizeTier(m ? m[1] : null, fallback);
}

/**
 * 该档位的人物条目该写多详细。给 prompt 与实际裁剪共用，
 * 避免出现"prompt 说要写详细、代码却按路人截断"这种前后矛盾。
 */
export const TIER_DETAIL = {
  主角: { label: '主角', fields: '全部字段，尽量写满，外貌/性格/关系/秘密都要有', minChars: 600 },
  主要NPC: { label: '主要NPC', fields: '全部字段，重点写性格、与主角的关系、关键经历', minChars: 400 },
  次要NPC: { label: '次要NPC', fields: '身份、性格、外貌、与主角的关系；不确定的字段填"未提及"', minChars: 150 },
  路人NPC: { label: '路人NPC', fields: '只写身份与出现在哪里；其余填"未提及"，不要展开', minChars: 0 },
};

/**
 * 完整版的分层要求：在基础版之上加字与字段，但**路人仍然不展开**。
 *
 * 为什么路人不变：完整版的意义是"把主要人物写透"，不是"给路人灌水"。
 * 一条 800 字的路人档案既多花 token，又会在世界书里抢主要角色的注意力。
 */
export const TIER_DETAIL_FULL = {
  主角: {
    label: '主角（完整版）',
    fields: '模板字段全部写满；额外写 relations / speechStyle / voiceSample / 言行举止；'
      + 'appearance 与 clothing 按分层写足；不确定的写"未提及"',
    minChars: 1000,
  },
  主要NPC: {
    label: '主要NPC（完整版）',
    fields: '模板字段尽量写满；补 relations / speechStyle / voiceSample / 言行举止；'
      + '重点写性格、与主角的关系、关键经历',
    minChars: 700,
  },
  次要NPC: {
    label: '次要NPC（完整版）',
    fields: '身份、性格、外貌、与主角的关系；能写的模板字段都补上，不确定的写"未提及"',
    minChars: 260,
  },
  路人NPC: { label: '路人NPC', fields: '只写身份与出现在哪里；其余填"未提及"，不要展开', minChars: 0 },
};

/**
 * 按档位取分层要求。
 *
 * @param {string} tier 分层名
 * @param {'basic'|'full'} [level]
 */
export function tierDetail(tier, level = 'basic') {
  const table = level === 'full' ? TIER_DETAIL_FULL : TIER_DETAIL;
  return table[tier] || table['次要NPC'];
}
