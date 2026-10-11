/**
 * 完善已有角色卡：导入一张 character_card.json + 一段新剧情 → 输出合并后的卡。
 *
 * 与 runPipeline 的关系：
 *   - **共用**同一套章节切分（chunkText + chapterRange）与 SSE 事件格式
 *   - 差异只在"最后怎么处理"：这里是对齐 + 合并，不是全量生成
 *
 * 设计取舍（刻意保守）：
 *   - 合并 content 用**纯文本追加**，不请 LLM 重写 —— 不会丢原文、不会改写设定
 *   - 实体对齐交给 LLM，但结果落进 augment_report.json，冲突不静默
 *   - 原有 extensions / regex_scripts / tavern_helper / alternate_greetings
 *     一律原样保留，只动 character_book.entries
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { makeLLM } from './llm.js';
import { chunkText, pMap, asArray } from './utils.js';
import { readNovelText } from './encoding.js';
import {
  assembleWorldbook, dedupeEvents, groupByStoryline, extractPhaseText,
  buildVariables,
  sanitizeRoster, sampleAcrossText, normalizeWorldbookItems,
} from './pipeline.js';
import { isCharacterComment, tierFromComment, TIER_RANK } from './tiers.js';
import { summarizeAugment, renderSummaryMarkdown } from './summary.js';
import * as S from './steps.js';

// ============================================================
// 实体对齐 prompt
// ============================================================
export const ALIGN_PROMPT = `你是实体对齐器。给定"已有角色卡的条目"和"新剧情抽取出的实体"，
判断哪些是同一实体、哪些是新实体、哪些存在冲突。

输入：
{
  "existing": [
    { "index": 0, "name": "条目名（已去掉 [分类] 前缀）", "keys": [...], "hint": "内容前若干字" }
  ],
  "new": {
    "characters": [{"name": "...", "keys": [...]}],
    "events": [{"name": "..."}],
    "worldbook": [{"name": "...", "category": "..."}]
  }
}

【最重要的一条】existing 里**可能包含任意语言的任意命名条目**，
它们的名字不带 [character] 这类前缀，也可能不叫「某某百科」。
判断同一性要**看名字与 hint（内容摘要）**，不要依赖命名约定的分类：
- 新剧情里的地点「地下城」与已有条目「地下城」是同一条 → matched
- 新剧情里的设定「等级体系」与已有条目「升级和技能」讲的是同一件事 → matched
- hint 显示已有条目讲的是另一个东西 → 才放进 added

**宁可匹配也不要重复建条目**：把新信息并进已有条目是首选；
只有确实是新实体时才 added。重复条目会让同一内容被注入两次。

输出 JSON：
{
  "matched": [
    {
      "type": "character | event | worldbook",
      "existingName": "已有条目名（必须与 existing[].name 逐字一致）",
      "newName": "新抽取名",
      "confidence": 0.0-1.0,
      "reason": "判断理由",
      "action": "merge | keep_both | replace"
    }
  ],
  "added": [
    { "type": "...", "name": "新实体名" }
  ],
  "conflicts": [
    {
      "type": "...",
      "existingName": "...",
      "newName": "...",
      "field": "冲突字段，如'性格'/'状态'",
      "existing": "已有摘要",
      "new": "新摘要",
      "severity": "high | medium | low"
    }
  ]
}

规则：
- 别名、称呼、称号视为同一实体（如"卡卡西"和"旗木卡卡西"）
- 同一地点/体系的**不同说法**也算同一实体（如"主城"与"王都"若指同一处）
- 同名不同人标注为 added 且不匹配
- 冲突 severity：
  - high：核心设定矛盾（性格反转、生死状态）
  - medium：细节差异（年龄、外貌）
  - low：表述方式不同
- 无法判断倾向 keep_both
- existingName / newName 必须逐字使用输入里给出的名字，不要改写`;

// ============================================================
// 卡片解析与结构提取
// ============================================================

/** 卡片结构校验：明显不是角色卡就早失败，别等跑完 LLM 才发现 */
export function validateCard(card) {
  const problems = [];
  if (!card || typeof card !== 'object') problems.push('不是合法的 JSON 对象');
  else {
    const data = card.data;
    if (!data || typeof data !== 'object') problems.push('缺少 data 字段（不是 chara_card_v2/v3 结构）');
    if (!data?.name) problems.push('缺少 data.name');
    if (!data?.character_book) problems.push('缺少 data.character_book（这张卡没有内嵌世界书，无法增补）');
    else if (!Array.isArray(data.character_book.entries)) problems.push('data.character_book.entries 不是数组');
  }
  if (problems.length) {
    const err = new Error(`角色卡无法解析：${problems.join('；')}`);
    err.code = 'INVALID_CARD';
    throw err;
  }
  return true;
}

/** 从条目注释里抽出实体名：[character] 林昭 → 林昭 */
export function extractName(comment) {
  return String(comment || '').replace(/^\[[^\]]+\]\s*/, '').trim();
}

/** 从条目注释里抽出分类：[map_world] 云京 → map_world */
export function extractCategory(comment) {
  const m = /^\[([^\]]+)\]/.exec(String(comment || ''));
  return m ? m[1] : '';
}

/**
 * 这条注释是不是人物条目。
 *
 * 用共享的 isCharacterComment 而不是 `startsWith('[character]')`：
 * 人物条目现在会带剧情分层后缀（`[character·主要NPC] 沈砚`），
 * 精确匹配前缀会把它们全部漏掉 —— 症状是"增补时新人物一条都识别不出来"。
 */
const isCharEntry = (e) => isCharacterComment(e?.comment);
const isEventEntry = (e) => String(e?.comment || '').startsWith('[event]');
const isWorldEntry = (e) => /^\[(map_|system_|history)/.test(String(e?.comment || ''));
const isInitvar = (e) => String(e?.comment || '').includes('[initvar]');

/**
 * 把已有卡片拆成可对齐的结构。
 * 注意：entries 一律**深拷贝**，避免后续合并改到调用方手里的原对象。
 */
export function extractCardStructure(card) {
  const entries = (card?.data?.character_book?.entries || []).map(e => JSON.parse(JSON.stringify(e)));

  const initvarEntry = entries.find(isInitvar);
  let variables = {};
  if (initvarEntry?.content) {
    try { variables = YAML.parse(initvarEntry.content) || {}; } catch { variables = {}; }
  }

  const characters = entries.filter(isCharEntry).map(e => ({ name: extractName(e.comment), keys: e.keys || [] }));
  const events = entries.filter(isEventEntry).map(e => ({ name: extractName(e.comment) }));
  const worldbook = entries.filter(isWorldEntry).map(e => ({ name: extractName(e.comment), category: extractCategory(e.comment) }));

  return {
    entries,
    variables,
    name: card?.data?.name || '',
    characterVersion: card?.data?.character_version || '1.0',
    characters,
    events,
    worldbook,
    /**
     * 这张卡是否使用本工具的标准前缀约定。
     *
     * 三项都为空而条目不为空 → 说明它不用 `[character]`/`[event]`/`[map_*]` 那套命名
     * （用户自己的卡基本都是这样）。此时：
     *   · 分类计数**不可信**，报告与总结里不该按类型显示 0
     *   · 对齐要退回"全部条目"（见 pickAlignEntries）
     */
    usesStandardPrefix: !(characters.length === 0 && events.length === 0
      && worldbook.length === 0 && entries.length > 0),
    phaseEntry: entries.find(e => e.comment === '角色阶段') || null,
  };
}

// ============================================================
// 已有条目的索引
// ============================================================

/**
 * 给"已有卡的全部条目"建索引，供**实体对齐**使用。
 *
 * ⚠️ 为什么必须单独有这个函数（而不是只用 `extractCardStructure`）：
 *
 * `extractCardStructure` 靠 `comment` 的**前缀约定**分类
 * （`[character]` / `[event]` / `[map_*]`），那是本工具生成卡的写法。
 * 而用户手上很多卡完全不用这套约定 —— 条目就叫「香织」「精灵森林」「地下城」。
 * 那种卡经过 `extractCardStructure` 会得到 `{characters:0, events:0, worldbook:0}`，
 * 于是：
 *   · `hasExisting` 判为"已有卡是空的"
 *   · 对齐器收到的 `existing` 是空的 → **匹配 0 条**
 *   · 结果**新剧情的内容全部新建成独立条目**，一条都并不进已有条目
 *
 * 实测就是这么发生的：一张 79 条目的卡，报告的 before 是
 * `{entries:79, characters:0, events:0, worldbook:0}`，matched 0 / updated 0，
 * 21 条新抽取全部堆成新条目。
 *
 * 所以对齐必须看得见**所有**已有条目，而不是只看带前缀的那部分。
 * 名字用 `extractName` 去掉前缀，这样对齐器报回来的名字能直接对上。
 *
 * @param {Array} entries 卡里的全部条目
 * @param {{onlyEnabled?:boolean, contentHint?:number}} [opts]
 */
export function buildExistingIndex(entries = [], { onlyEnabled = true, contentHint = 80 } = {}) {
  const out = [];
  for (const [i, e] of (Array.isArray(entries) ? entries : []).entries()) {
    if (!e) continue;
    if (onlyEnabled && e.enabled === false) continue;
    const name = extractName(e.comment);
    if (!name) continue;
    out.push({
      index: i,
      id: e.id,
      name,
      keys: e.keys || [],
      constant: !!e.constant,
      hasContent: !!String(e.content || '').trim(),
      hint: String(e.content || '').replace(/\s+/g, ' ').slice(0, contentHint),
    });
  }
  return out;
}

/**
 * 统一入口：`extractCardStructure` 的 `worldbook` 参数**为空**时（说明这张卡不用标准前缀），
 * 就退回全部条目一起对齐。
 *
 * 用标准前缀的卡（本工具自己生成的）行为完全不变 —— 这是刻意的保守取舍：
 * 不改变已验证的路径，只补上原来完全失效的那一类卡。
 */
export function pickAlignEntries(entries = [], structure = {}) {
  const prefixed = [
    ...(structure.characters || []),
    ...(structure.events || []),
    ...(structure.worldbook || []),
  ];
  const useFallback = prefixed.length === 0;
  return {
    useFallback,
    entries: useFallback ? buildExistingIndex(entries) : prefixed,
  };
}

// ============================================================
// 合并
// ============================================================

/** 纯文本追加合并 —— 刻意不请 LLM 重写，避免丢失原文与改写设定 */
export function mergeContentText(oldText, newText) {
  const a = String(oldText || '').trim();
  const b = String(newText || '').trim();
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;              // 已经包含，不重复追加
  return `${a}\n\n---\n【新增内容】\n${b}`;
}

/**
 * 合并世界书条目。
 * @param {Array} existingEntries 已有条目（会被拷贝）
 * @param {{matched, added, newEntries}} aligned
 * @param {'append'|'merge'|'overwrite'} strategy
 */
export function mergeEntries(existingEntries, aligned, strategy = 'merge') {
  const result = existingEntries.map(e => JSON.parse(JSON.stringify(e)));
  const byName = new Map();
  for (const e of result) byName.set(`${extractCategory(e.comment)}::${extractName(e.comment)}`, e);

  const newEntries = aligned?.newEntries || [];
  const findNew = (type, name) => newEntries.find(e =>
    (!type || typeOf(e) === type) && extractName(e.comment) === name);
  const typeOf = (e) => isCharEntry(e) ? 'character' : isEventEntry(e) ? 'event' : 'worldbook';

  const updated = [];
  const promoted = [];     // matched 但已有条目不存在 → 退化为新增
  for (const m of aligned?.matched || []) {
    /**
     * 找"要并进去的那条已有条目"。
     *
     * 三条查询路径，**顺序很重要**：
     *   ① 分类::名字（本工具生成卡的标准路径，行为不变）
     *   ② 按类型 + 名字
     *   ③ **按名字在整个卡里找** —— 这是为"不用标准前缀的卡"补的：
     *      那种卡在 extractCardStructure 里类型全为空，前两条都命中不了，
     *      于是新内容一条都并不进去、全部变成新条目（实测就是这样）。
     *      名字才是真正稳定的对应关系，类型不该成为合并的前提。
     */
    const existing = byName.get(`${categoryOfType(m.type, result)}::${m.existingName}`)
      || result.find(e => typeOf(e) === m.type && extractName(e.comment) === m.existingName)
      || result.find(e => extractName(e.comment) === String(m.existingName || '').trim());
    const fresh = findNew(m.type, m.newName);
    if (!fresh) continue;

    // ⚠️ 对齐器有时会把"新实体"匹配到一个**原卡里并不存在**的名字上
    // （实测：它说「卡卡西」与「旗木卡卡西」是同一实体，但原卡里根本没有卡卡西条目）。
    // 这时既没有东西可合并、也不能什么都不做 —— 否则新实体被静默丢弃。
    // 正确做法是退化为新增。
    if (!existing) { promoted.push(fresh); continue; }

    if (strategy === 'append') continue;      // 仅新增，不改已有
    if (strategy === 'overwrite' || m.action === 'replace') {
      const idx = result.indexOf(existing);
      // 保留原有插入顺序与 id，只换正文与 keys
      fresh.id = existing.id;
      fresh.insertion_order = existing.insertion_order;
      result[idx] = fresh;
      updated.push({ type: m.type, name: m.existingName, how: 'replace' });
      continue;
    }
    // merge
    existing.content = mergeContentText(existing.content, fresh.content);
    existing.keys = [...new Set([...(existing.keys || []), ...(fresh.keys || [])])];
    updated.push({ type: m.type, name: m.existingName, how: 'merge' });
  }

  const added = [];
  const pushNew = (fresh) => {
    if (!fresh) return;
    if (result.some(e => typeOf(e) === typeOf(fresh) && extractName(e.comment) === extractName(fresh.comment))) return;
    if (added.some(x => x.name === extractName(fresh.comment))) return;
    result.push(fresh);
    added.push({ type: typeOf(fresh), name: extractName(fresh.comment) });
  };

  // 先加"匹配落空"降级来的，再加对齐器明确标的 added
  for (const fresh of promoted) pushNew(fresh);
  for (const a of aligned?.added || []) pushNew(findNew(a.type, a.name));

  // 重排 id：唯一且连续（验收标准之一）
  result.forEach((e, i) => { e.id = i; });
  return { entries: result, updated, added };
}

function categoryOfType() { return null; }   // 占位：按 type 查找用 find 兜底

/**
 * 合并变量树：新字段补入，冲突保留旧值（已有卡是"权威版本"）。
 *
 * `user` 命名空间**永不从新数据注入** —— 它由原卡决定，
 * 增补侧凭空塞一个 user 会让主角模式的卡多出一个错误的 user 段。
 */
export function mergeVariables(existing, newVars) {
  const merged = JSON.parse(JSON.stringify(existing || {}));
  const incoming = newVars || {};

  if (incoming.world) merged.world = { ...incoming.world, ...(merged.world || {}) };

  if (incoming.events) {
    merged.events = { ...(merged.events || {}) };
    for (const [k, v] of Object.entries(incoming.events)) if (!merged.events[k]) merged.events[k] = v;
  }

  if (incoming.characters) {
    merged.characters = { ...(merged.characters || {}) };
    for (const [k, v] of Object.entries(incoming.characters)) {
      if (!merged.characters[k]) {
        merged.characters[k] = v;
      } else {
        for (const [f, val] of Object.entries(v || {})) {
          if (merged.characters[k][f] === undefined) merged.characters[k][f] = val;
        }
      }
    }
  }

  if (incoming.custom) {
    merged.custom = { ...(merged.custom || {}) };
    for (const [k, v] of Object.entries(incoming.custom)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        merged.custom[k] = { ...(merged.custom?.[k] || {}), ...v };
      } else {
        merged.custom[k] = v;
      }
    }
  }

  // user 只保留原卡已有的；incoming.user 一律忽略
  return merged;
}

/**
 * 把人设增量表并进「角色阶段」条目。
 *
 * ⚠️ 只做**文本层面**插入，不解析 EJS 语义（见需求「不要做的」）。
 * 实测过的坑：`<%_ ... _%>` 是独立语句块，把对象字面量拆在多个标签里会产生非法 JS。
 * 所以这里沿用 generateB4 的做法：找到现有的单标签表定义行，把新键**插入同一个标签内**。
 */
export function mergePhaseEJS(existingEJS, newPhases) {
  const src = String(existingEJS || '');
  if (!src) return src;

  // 现有表定义行：`<%_ const 人设增量表 = {...}; _%>`
  const defRe = /<%_\s*const\s+人设增量表\s*=\s*(\{[\s\S]*?\})\s*;\s*_%>/;
  const m = defRe.exec(src);
  if (!m) return src;   // 不是我们生成的形态 → 原样返回，不做危险改写

  let table;
  try { table = JSON.parse(m[1]); } catch { return src; }
  if (!table || typeof table !== 'object') return src;

  let changed = 0;
  for (const p of newPhases || []) {
    if (!p?.characterDeltas?.length || !p.name) continue;
    if (table[p.name] !== undefined) continue;        // 去重
    table[p.name] = p.characterDeltas.map(d => `${d.character}：${d.change}`).join('\n');
    changed++;
  }
  if (!changed) return src;

  const literal = JSON.stringify(table).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return src.replace(defRe, `<%_ const 人设增量表 = ${literal}; _%>`);
}

/** 拼装最终卡片：只动 character_book.entries / 版本号 / 时间，其余原样保留 */
export function assembleAugmentedCard({ existingCard, entries, variables, now = new Date() }) {
  const card = JSON.parse(JSON.stringify(existingCard));
  card.data.character_book.entries = entries;
  card.data.character_version = bumpVersion(card.data.character_version);

  // initvar 只保留一条，且内容 = 合并后的变量树
  const initvars = entries.filter(isInitvar);
  if (initvars.length > 1) {
    // 留第一条，其余从 entries 里摘掉
    const keep = initvars[0];
    card.data.character_book.entries = entries.filter(e => !isInitvar(e) || e === keep);
  }
  const iv = card.data.character_book.entries.find(isInitvar);
  if (iv) iv.content = YAML.stringify(variables || {});
  card.data.character_book.entries.forEach((e, i) => { e.id = i; });

  const iso = now.toISOString();
  card.create_date = iso;
  // 顶层与 data.* 的共享字段保持一致（ST 两层不一致会打 mismatch 警告）
  for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) {
    if (card.data[k] !== undefined) card[k] = card.data[k];
  }
  if (card.data.alternate_greetings) card.alternate_greetings = card.data.alternate_greetings;
  if (card.data.tags) card.tags = card.data.tags;
  if (card.data.extensions?.talkativeness !== undefined) card.talkativeness = card.data.extensions.talkativeness;
  return card;
}

export function bumpVersion(v) {
  const parts = String(v || '1.0').split('.');
  const major = parseInt(parts[0], 10);
  const minor = parseInt(parts[1], 10);
  return `${Number.isNaN(major) ? 1 : major}.${(Number.isNaN(minor) ? 0 : minor) + 1}`;
}

/**
 * 实体对齐。LLM 失败时**退化为"全部当新增"**，而不是让整次增补失败。
 */
export async function alignEntities({ existing, newItems, llm, log = () => {}, alignEntries = null }) {
  /**
   * 送进对齐器的"已有条目"。
   *
   * `alignEntries` 是 `pickAlignEntries()` 的产出 —— 对**不用标准前缀**的卡，
   * 它包含全部条目（见该函数的注释：否则对齐器看不到任何已有内容，
   * 于是所有新内容都会变成新条目）。
   */
  const existingList = Array.isArray(alignEntries)
    ? alignEntries
    : [
      ...(existing.characters || []),
      ...(existing.events || []),
      ...(existing.worldbook || []),
    ];

  const payload = {
    existing: existingList,
    new: {
      characters: (newItems.characters || []).map(c => ({ name: c.name, keys: c.keys || [] })),
      events: (newItems.events || []).map(e => ({ name: e.name })),
      worldbook: (newItems.worldbook || []).map(w => ({ name: w.name, category: w.category })),
    },
  };

  const nothingMatches = () => ({
    matched: [],
    added: [
      ...(newItems.characters || []).map(c => ({ type: 'character', name: c.name })),
      ...(newItems.events || []).map(e => ({ type: 'event', name: e.name })),
      ...(newItems.worldbook || []).map(w => ({ type: 'worldbook', name: w.name })),
    ],
    conflicts: [],
    degraded: true,
  });

  /**
   * 已有卡是空的 → 没什么可对齐的，全部新增。
   *
   * ⚠️ 判据必须是 **`existingList`**，不能是 `existing.characters/events/worldbook`。
   *
   * 踩过的坑：这里原来写的是三个分类数组的长度之和。而对**不用标准前缀**的卡
   * （条目就叫「香织」「地下城」），那三项恒为 0 → 这里直接返回 `nothingMatches()`
   * → **`existingList` 根本没机会被用上**，对齐永远降级为"全部新增"。
   *
   * 真实端到端抓到的：日志出现「对齐结果已降级为「全部新增」」，
   * matched 0 / updated 0，改好的索引形同虚设。
   * 单元测试没抓到是因为它们直接调 `alignEntities({ alignEntries })` 并断言了 matched，
   * 没有覆盖"分类为空"这条真实路径 —— 所以这次加了日志与端到端。
   */
  const hasExisting = existingList.length > 0;
  if (!hasExisting) return nothingMatches();

  try {
    const r = await llm.chatJSON(ALIGN_PROMPT, JSON.stringify(payload, null, 2), 'augment-align');
    if (!r || typeof r !== 'object') return nothingMatches();
    return {
      matched: Array.isArray(r.matched) ? r.matched : [],
      added: Array.isArray(r.added) ? r.added : [],
      conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
      degraded: false,
    };
  } catch (e) {
    log('WARN', `实体对齐失败（${e.message}），本次全部按新增处理`);
    return nothingMatches();
  }
}

// ============================================================
// 解析辅助（抽成独立函数，便于被测试钉住）
// ============================================================

/**
 * 解析「事件抽取」的返回。
 *
 * ⚠️ 存在这个函数是因为它踩过一次**静默丢失全部事件**的坑：
 * 原来是 `Array.isArray(r) ? r : []`，而模型实际返回
 *   {"type":"json_object","events":[{…}]}
 * —— 事件包在对象里，`Array.isArray` 为假、静默变成 0 个事件，
 * 而日志只说"新事件 0 个"。用户看到的就是"完善了但没效果"。
 *
 * 统一走 `asArray`（与 /api/generate 同一条路径），再兜一层常见容器键名。
 * 抽成独立函数是为了**可以被测试覆盖** —— 埋在 runAugment 里就只能靠真实调用才发现。
 */
export function parseEventsResponse(raw) {
  // 裸数组直接用
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined) return [];

  /**
   * ⚠️ **先查容器键，再交给 `asArray`**。顺序不能反。
   *
   * 实测返回是 `{"type":"json_object","events":[…]}` —— 外层对象带 `type` 字段，
   * 而 `asArray` 的规则是"含 name/type/content 等键的对象视为**单条**条目"，
   * 于是它会把整个外层对象当成一条事件返回（长度 1），真正的 events 数组反而取不到。
   * （测试抓到的：期望 2 条、实际 1 条。）
   */
  for (const k of ['events', 'items', 'data', 'list', '事件']) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  // 没有容器键 → 可能是"单条事件对象"，交给 asArray 判断。
  // 但字符串/数字**不是事件**，`asArray('x')` 会给出 ['x']，那是脏数据，直接丢。
  if (typeof raw !== 'object') return [];
  return asArray(raw);
}

/**
 * 解析单个人物档案的返回，取出 YAML 正文。
 *
 * ⚠️ 字段名是 **`content_yaml`**，不是 `content`。
 * 原来判据是 `if (!item?.content) return null`，于是每一份都命中 return null、
 * **新人物档案恒为 0 份** —— 完善角色卡时一个人物都加不进去。
 * 兼容 content_yaml / content / text / yaml 四种写法。
 *
 * @returns {{name:string, keys:string[], content:string}|null} 正文为空时返回 null
 */
export function parseCharacterProfile(raw, { name = '', aliases = [] } = {}) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const body = String(item.content_yaml || item.content || item.text || item.yaml || '').trim();
  if (!body) return null;
  return { name, keys: [name, ...(aliases || [])].filter(Boolean), content: body };
}

// ============================================================
// 主流程
// ============================================================

export async function runAugment(config, send) {
  const log = (step, msg) => {
    console.log(`[${step}] ${msg}`);
    send('progress', { step, msg, ts: Date.now() });
  };
  const checkAbort = () => {
    if (config.signal?.aborted) {
      const err = new Error('任务已被用户取消');
      err.name = 'AbortError';
      throw err;
    }
  };

  const llm = makeLLM(config, config.preset || null);
  const taskId = `task_${Date.now()}`;
  const outDir = path.join(config.outputDir || 'output', taskId);
  await mkdir(outDir, { recursive: true });
  send('start', { taskId, startedAt: new Date().toISOString() });

  // ---------- 1. 解析已有角色卡 ----------
  let card;
  try {
    card = JSON.parse(await readFile(config.cardPath, 'utf-8'));
  } catch (e) {
    throw new Error(`角色卡读取失败：${e.message}`);
  }
  validateCard(card);
  const existing = extractCardStructure(card);
  log('Augment', `已载入卡片《${card.data.name}》：${existing.entries.length} 条目`
    + `（人物 ${existing.characters.length} / 事件 ${existing.events.length} / 世界观 ${existing.worldbook.length}）`);

  // ---------- 2. 切分新剧情（与 /api/generate 共用同一套 chapterRange 语义）----------
  let novelText = config.novelText;
  if (!novelText && config.novelPath) {
    // 复用 readNovelText：与 runPipeline 走完全相同的编码检测/转码路径
    const decoded = await readNovelText(config.novelPath);
    novelText = decoded.text;
    log('Augment', `新剧情编码：${decoded.originalEncoding}`
      + (decoded.transcoded ? '（已转码）' : ''));
  }
  if (!novelText || !String(novelText).trim()) throw new Error('新剧情内容为空');

  const chunks = chunkText(String(novelText), {
    maxLen: Number(config.chunkMaxLen) || 6000,
    chapterRange: config.chapterRange,
  });
  const processedChars = chunks.reduce((s, c) => s + c.text.length, 0);
  log('Augment', `本次处理 ${chunks.length} 章，共 ${processedChars} 字`
    + (config.chapterRange && config.chapterRange !== 'all' ? `（范围：${config.chapterRange}）` : ''));

  const joined = chunks.map(c => c.text).join('\n\n');
  const concurrency = Math.max(1, Number(config.concurrency) || 3);
  const charProbeChars = Number(config.charProbeChars) || 10000;

  // ---------- 3. 抽取新剧情的事件 / 阶段 / 人物 / 世界观 ----------
  //     复用与 runPipeline 相同的步骤 prompt，保证两边的抽取口径一致
  checkAbort();
  log('Augment', '抽取新事件');
  const eventsRaw = await pMap(chunks, async (c) => {
    try {
      // 用抽出来的解析函数（见 parseEventsResponse 注释：这里曾静默丢光全部事件）
      const raw = await llm.chatJSON(S.STEP_2_EVENTS, `章节：${c.title}\n\n${c.text}`, 'step2');
      return parseEventsResponse(raw);
    } catch (e) {
      log('WARN', `章节事件抽取失败（${c.title}）：${e.message}`);
      return [];
    }
  }, concurrency);
  const events = dedupeEvents(eventsRaw.flat());
  const storylines = groupByStoryline(events);
  log('Augment', `新事件 ${events.length} 个 / ${Object.keys(storylines).length} 条线`);
  // 抽取到 0 个事件时要说清楚后果 —— 否则用户只看到"没效果"，不知道后面全在空转
  if (!events.length) {
    log('WARN', '新剧情里没有抽到事件：阶段划分、变量树事件、导演指令都不会更新');
  }

  checkAbort();
  log('Augment', '划分阶段');
  let phases = [];
  try {
    const r = await llm.chatJSON(S.STEP_3_PHASES, JSON.stringify(events, null, 2), 'step3');
    phases = Array.isArray(r?.phases) ? r.phases : [];
  } catch (e) { log('WARN', `阶段划分失败：${e.message}`); }
  log('Augment', `新阶段 ${phases.length} 个`);

  checkAbort();
  const phasesWithDeltas = await pMap(phases, async (phase) => {
    try {
      const text = extractPhaseText(phase, events, chunks);
      const r = await llm.chatJSON(
        S.STEP_4_DELTAS,
        `阶段名：${phase.name}\n核心变化：${phase.coreChange}\n原文：\n${text.slice(0, 8000)}`,
        'step4',
      );
      return { ...phase, characterDeltas: Array.isArray(r?.deltas) ? r.deltas : [] };
    } catch { return { ...phase, characterDeltas: [] }; }
  }, Math.max(1, Math.min(concurrency, 2)));

  checkAbort();
  log('Augment', '抽取世界观');
  let worldbookItems = [];
  try {
    const r = await llm.chatJSON(S.STEP_5_WORLDBOOK, sampleAcrossText(joined, Number(config.worldProbeChars) || 15000), 'step5');
    worldbookItems = normalizeWorldbookItems(r);
  } catch (e) { log('WARN', `世界观抽取失败：${e.message}`); }

  checkAbort();
  log('Augment', '抽取人物');
  let roster = [];
  try {
    const raw = await llm.chatJSON(S.STEP_5_CHARACTER_LIST, `原文：\n${sampleAcrossText(joined, charProbeChars)}`, 'step5');
    roster = sanitizeRoster(raw, joined, { max: Number(config.maxCharacters) || 15 }).roster;
    log('Augment', `新人物名单 ${roster.length} 人`);
  } catch (e) { log('WARN', `人物名单抽取失败：${e.message}`); }

  const characters = (await pMap(roster, async (r) => {
    try {
      const item = await llm.chatJSON(
        S.STEP_5_CHARACTER,
        `角色名：${r.name}\n已知称呼：${[r.name, ...r.aliases].join('、')}\n\n原文节选：\n${sampleAcrossText(joined, charProbeChars)}`,
        'step5',
      );
      // 用抽出来的解析函数（见 parseCharacterProfile 注释：字段名曾写错，档案恒为 0 份）
      const prof = parseCharacterProfile(item, { name: r.name, aliases: r.aliases });
      if (!prof) {
        log('WARN', `人物「${r.name}」的档案为空（返回键：${Object.keys(item || {}).join('/') || '无'}）`);
      }
      return prof;
    } catch (e) {
      log('WARN', `人物「${r.name}」档案抽取失败：${e.message}`);
      return null;
    }
  }, concurrency)).filter(Boolean);
  log('Augment', `新人物档案 ${characters.length} 份 / 世界观 ${worldbookItems.length} 条`);

  // ---------- 4. 实体对齐 ----------
  checkAbort();
  log('Augment', '实体对齐');
  /**
   * 决定"让对齐器看见哪些已有条目"。
   *
   * 用标准前缀的卡 → 传分类后的条目（原行为）；
   * 不用前缀的卡 → 传**全部条目**。
   * 不这么做的话后者会得到空 existing、matched 恒为 0，
   * 新剧情就会全部堆成新条目（这正是用户报的问题）。
   */
  const alignPick = pickAlignEntries(existing.entries, existing);
  if (alignPick.useFallback) {
    log('Augment', `已有卡不使用标准前缀（[character]/[event]/[map_*]）——`
      + `本次用全部 ${alignPick.entries.length} 条已有条目参与对齐，避免新内容全部变成新条目`);
  }
  const aligned = await alignEntities({
    existing,
    newItems: { events, worldbook: worldbookItems, characters },
    llm,
    log,
    alignEntries: alignPick.entries,
  });
  if (aligned.degraded) log('WARN', '对齐结果已降级为「全部新增」');
  log('Augment', `匹配 ${aligned.matched.length} / 新增 ${aligned.added.length} / 冲突 ${aligned.conflicts.length}`);
  if (aligned.conflicts.length) send('conflicts', { conflicts: aligned.conflicts });

  // ---------- 5. 构造新条目 ----------
  const timeline = {
    base: '相对纪元',
    origin: { event: events[0]?.name || '' },
    events: events.map(e => ({ name: e.name, time: e.time || '', chapter: e.chapter || '' })),
    characters: [],
  };
  /**
   * ⚠️ 第二个参数必须传**抽取到的事件**，不能传 `[]`。
   *
   * 踩过的坑：这里原来写的是 `assembleWorldbook(timeline, [], characters, …)`，
   * 于是新剧情里的剧情事件**一条都不会变成卡片条目**：
   * 卡里 `[event]` 系列始终是原卡那几条，`added.event` 恒为 0 —— 而日志里
   * 「新事件 N 个」看着一切正常。用户感受到的就是"完善了但剧情没推进"。
   *
   * 同时要把 `storylines` 传进去：故事线是按线触发的分段条目，
   * 新剧情抽出的线也要能进卡（否则只有事件、没有线）。
   */
  const wb = assembleWorldbook(timeline, events, characters, worldbookItems, {
    title: card.data.name || null,
    storylines,
  });
  // assembleWorldbook 会把内置顺序算进 insertion_order；这里只需要它的条目内容形态，
  // 顺序统一由 mergeEntries 之后的 id 重排与既有条目决定
  const newEntries = wb.entries.map(e => {
    const c = JSON.parse(JSON.stringify(e));
    if (c.insertion_order >= 100) c.insertion_order = c.insertion_order;   // 保留相对次序
    return c;
  });

  const { entries: mergedEntries, updated, added } = mergeEntries(
    existing.entries, { ...aligned, newEntries }, config.strategy || 'merge',
  );

  // ---------- 6. 合并变量树 + 人设增量表 ----------
  const newVariables = buildVariables(timeline, events, storylines, characters, phasesWithDeltas);
  // ⚠️ 增补**不碰** user 命名空间：它由原卡决定（主角模式可能是 user，参与者模式是另一套）。
  // 这里连同 buildVariables 可能带出的 user 一起清掉，避免给原卡凭空塞一个 `user:` 段
  //（实测踩过：原卡是主角模式、initvar 里没有 user，合并后却多出 user.name: {{user}}）。
  delete newVariables.user;
  const mergedVariables = mergeVariables(existing.variables, newVariables);

  const phaseMerged = mergePhaseEJS(existing.phaseEntry?.content || '', phasesWithDeltas);

  const finalCard = assembleAugmentedCard({
    existingCard: card,
    entries: mergedEntries,
    variables: mergedVariables,
  });
  // 角色阶段条目：用文本层面合并后的内容
  const pe = finalCard.data.character_book.entries.find(e => e.comment === '角色阶段');
  if (pe && phaseMerged) pe.content = phaseMerged;

  // ---------- 7. 输出 ----------
  await writeFile(path.join(outDir, 'character_card.json'), JSON.stringify(finalCard, null, 2), 'utf-8');

  /**
   * `after` 统计：**必须有**，否则总结算不出"改了多少"。
   *
   * 原来报告里只有 `before`，于是「生成后总结增加了什么」只能靠 `added.length`
   * 间接猜 —— 而合并策略下有些内容是**改写**而不是新增，那些变化就看不见了。
   * 这里直接数一遍最终卡，前后差值才是可信的。
   *
   * 分类口径与 `before` 保持一致（都走 extractCardStructure），否则差值没有意义。
   */
  const finalStruct = extractCardStructure(finalCard);
  /**
   * ⚠️ `before` / `after` 的分类计数**只有在这张卡使用标准前缀时才有意义**
   * （见 `extractCardStructure`：它靠 `[character]`/`[event]`/`[map_*]` 分类）。
   *
   * 对不用前缀的卡（条目就叫「香织」「地下城」），那三项恒为 0 —— 报告里会出现
   * `{characters:0, events:0, worldbook:0}`，总结里显示"人物 0 → 0"，
   * 让人以为一个人物都没有。**那是统计口径失效，不是事实。**
   *
   * 所以口径必须**前后统一**：卡不用标准前缀时，before 与 after **都只报总数**。
   *
   * 踩过的坑：一开始按"每一次数出来为空就省掉键"来写，
   * 结果 before 是 `{entries:79}`（省了），after 却成了
   * `{entries:86, characters:0, events:4, worldbook:3}` ——
   * 因为这次新增的事件带了 `[event]` 前缀，让 after 的分类"部分可信"了。
   * 同一张对照表里两个口径，差值就没有意义。
   */
  const prefixOK = existing.usesStandardPrefix !== false;
  const counted = (struct) => (
    prefixOK
      ? {
        entries: struct.entries.length,
        characters: struct.characters.length,
        events: struct.events.length,
        worldbook: struct.worldbook.length,
      }
      : { entries: struct.entries.length }   // 口径不可信 → 只报可靠的总数
  );

  const report = {
    sourceCard: card.data.name,
    sourceCardFile: config.cardFileName || null,
    chapterRange: config.chapterRange || 'all',
    processedChapters: chunks.length,
    processedChapterTitles: chunks.map(c => c.title),
    processedChars,
    strategy: config.strategy || 'merge',
    /** 这张卡有没有用本工具的标准前缀约定（决定分类计数是否可信） */
    usesStandardPrefix: prefixOK,
    before: counted(existing),
    after: counted(finalStruct),
    extracted: { events: events.length, characters: characters.length, worldbook: worldbookItems.length, phases: phases.length },
    matched: aligned.matched,
    added: added.length ? added : aligned.added,
    updated,
    conflicts: aligned.conflicts,
    skipped: [],
    alignDegraded: !!aligned.degraded,
    version: { from: existing.characterVersion, to: finalCard.data.character_version },
  };
  await writeFile(path.join(outDir, 'augment_report.json'), JSON.stringify(report, null, 2), 'utf-8');

  // ---------- 变更总结（用户要看"改了什么"）----------
  const summary = summarizeAugment(report);
  await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  await writeFile(path.join(outDir, 'SUMMARY.md'), renderSummaryMarkdown(summary), 'utf-8');

  await writeFile(path.join(outDir, 'README.md'), generateAugmentREADME(report, finalCard), 'utf-8');
  await writeFile(path.join(outDir, 'project.json'), JSON.stringify({
    taskId,
    mode: 'augment',
    sourceCard: card.data.name,
    chapterRange: report.chapterRange,
    strategy: report.strategy,
    createdAt: new Date().toISOString(),
  }, null, 2), 'utf-8');

  const kb = (JSON.stringify(finalCard).length / 1024).toFixed(1);
  log('Done', `角色卡已更新（${kb}KB）：新增 ${added.length || aligned.added.length} 条，合并 ${updated.length} 条，处理 ${chunks.length} 章`);
  log('Done', `变更总结：${summary.highlights.join(' · ') || '本次没有新增或修改条目'}`);

  send('files', {
    taskId,
    taskDir: outDir,
    files: ['character_card.json', 'summary.json', 'SUMMARY.md', 'augment_report.json', 'README.md'],
    // 直接带上结构化总结，前端不必再请求一次
    summary,
  });
  return { taskId, outDir, card: finalCard, report, summary };
}

// ---------- 全部复用 pipeline 的既有实现，这里不再有第二套 ----------
// 章节切分 / 抽样 / 人物名单清洗 / 世界观条目清洗 / 并发映射，
// 一律用 utils.js 与 pipeline.js 导出的那套，保证两个模式口径完全一致。
function generateAugmentREADME(report, card) {
  return `# 增补说明

本次为**完善已有角色卡**：以《${report.sourceCard}》为基础，合并新剧情。

## 处理范围
- 章节范围：${report.chapterRange}
- 实际处理：${report.processedChapters} 章 / ${report.processedChars} 字
- 增补策略：${report.strategy}
- 版本：${report.version.from} → ${report.version.to}

## 合并结果
- 已有条目：${report.before.entries}（人物 ${report.before.characters} / 事件 ${report.before.events} / 世界观 ${report.before.worldbook}）
- 新抽取：事件 ${report.extracted.events} / 人物 ${report.extracted.characters} / 世界观 ${report.extracted.worldbook} / 阶段 ${report.extracted.phases}
- 实体匹配：${report.matched.length} 条
- 新增条目：${report.added.length} 条
- 合并/替换：${report.updated.length} 条
- 冲突：${report.conflicts.length} 处

${report.conflicts.length ? `## ⚠️ 需要人工确认的冲突\n\n`
    + report.conflicts.map(c => `- [${c.severity || '?'}] **${c.existingName}** 的「${c.field || '设定'}」：\n`
      + `  - 原卡：${c.existing}\n  - 新剧情：${c.new}`).join('\n') + '\n' : ''}

## 导入方式
SillyTavern → 角色 → 更多 → 替换/更新 → 选择 **character_card.json**。
原有正则、脚本、扩展、备选开场全部原样保留。

## 注意
- 精确认领的冲突只记录、**不自动改写**你的原设定，请人工确认后再决定是否调整。
- 合并的条目正文用「【新增内容】」分隔，原文一字未删。
`;
}
