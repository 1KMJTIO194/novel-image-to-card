/**
 * 角色卡体检与优化（`card_doctor`）
 *
 * 用途：对**已经生成好的卡**做确定性检查与安全修复。
 * 与 pipeline / augment 的区别：这里**不调用模型、不改写设定内容**，
 * 只做客观、可复核的结构处理。
 *
 * 为什么需要它：完善流程只负责"把新内容合并进去"，不负责复查合并结果。
 * 实测一张真实卡上出现的问题，都是**归并之后**才看得见的：
 *   · 4 条 `content=""` + `keys=[]` 的空壳条目（永远触发不了，纯占位）
 *   · 「香织」有两条（同一人的两个版本，一次触发注入两份 1422 + 1577 字）
 *   · 51 个 key 被多个条目共用，`主城` 一个词同时触发 7 条 / 7092 tok
 *   · 常驻 13,837 tok，某轮命中常见词时单轮注入 28,546 tok
 *
 * 设计原则：**所有"修复"都必须是无损或可复核的**。
 *   · 删空壳：内容本来就是空的，无损失
 *   · 合并同名：两边正文都保留（标出来源），不挑一份丢一份
 *   · key 冲突 / 预算风险：**只报告，不自动改** —— 削 key 会改变触发行为，
 *     必须由人决定
 */

import { varKey } from './utils.js';

/** 与 pipeline 一致的口径：中文约 1 字 ≈ 0.7 token */
export function estimateTokens(text) {
  return Math.round(String(text || '').length / 1.6);
}

/** 去掉 `[分组] ` 前缀后的条目名 */
export function entryName(entry) {
  return String(entry?.comment || '').replace(/^\[[^\]]*\]\s*/, '').trim();
}

/** 条目内容是否为空（空白也算） */
export function isEmptyEntry(entry) {
  return !String(entry?.content || '').trim();
}

/**
 * 体检：只读，不改任何东西。
 *
 * @param {object} card character_card（v2/v3）
 * @param {{commonKeys?:string[]}} [opts] commonKeys = 你认为"太常见、不该当触发词"的词
 * @returns {object} 报告
 */
export function auditCard(card, { commonKeys = [] } = {}) {
  const entries = card?.data?.character_book?.entries;
  if (!Array.isArray(entries)) {
    return { ok: false, error: '不是有效的角色卡：缺少 data.character_book.entries' };
  }

  const empty = entries.filter(isEmptyEntry);
  const emptyNoKeys = empty.filter(e => !(e.keys || []).length);

  // 常驻预算
  const constEntries = entries.filter(e => e.constant);
  const constTokens = constEntries.reduce((s, e) => s + estimateTokens(e.content), 0);
  const totalTokens = entries.reduce((s, e) => s + estimateTokens(e.content), 0);

  // 同名条目（跨分类也算 —— 同一名字出现两次通常是分类判断不一致）
  const byName = new Map();
  for (const e of entries) {
    const nm = entryName(e);
    if (!nm) continue;
    const k = varKey(nm);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(e);
  }
  const duplicates = [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([k, list]) => ({
      key: k,
      name: entryName(list[0]),
      count: list.length,
      tokens: list.reduce((s, e) => s + estimateTokens(e.content), 0),
      entries: list,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // key 冲突：一个词触发多条
  const keyOwner = new Map();
  for (const e of entries) {
    for (const raw of e.keys || []) {
      const k = String(raw).trim();
      if (!k) continue;
      if (!keyOwner.has(k)) keyOwner.set(k, []);
      keyOwner.get(k).push(e);
    }
  }
  const keyConflicts = [...keyOwner.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([key, list]) => ({
      key,
      entries: list.length,
      tokens: list.reduce((s, e) => s + estimateTokens(e.content), 0),
      names: list.map(entryName),
      common: commonKeys.includes(key),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // 单轮最坏情况：命中冲突最多的那个 key，会注入多少
  const worst = keyConflicts[0]
    ? { key: keyConflicts[0].key, entries: keyConflicts[0].entries, tokens: keyConflicts[0].tokens }
    : null;

  return {
    ok: true,
    counts: {
      entries: entries.length,
      constant: constEntries.length,
      enabled: entries.filter(e => e.enabled !== false).length,
      withKeys: entries.filter(e => (e.keys || []).length).length,
    },
    tokens: {
      total: totalTokens,
      constant: constTokens,
      keyed: totalTokens - constTokens,
      worstSingleTurn: worst,
    },
    empty: empty.map(e => ({ id: e.id, comment: e.comment, hasKeys: !!(e.keys || []).length })),
    emptyNoKeysCount: emptyNoKeys.length,
    duplicates,
    keyConflicts,
    /** 常驻超预算的提示（用什么阈值由调用方决定） */
    notes: buildNotes({
      constTokens,
      duplicates,
      keyConflicts,
      /**
       * ⚠️ 这里过滤的是**原始卡条目**，判据必须是 `(e.keys||[]).length`。
       *
       * 踩过两次：
       *   ① 调用处只传了 `empty`，而 buildNotes 读 `emptyNoKeys`/`emptyKeyed`
       *      —— 两个键都 undefined，提示完全反了（把无 keys 的报成"需人工确认"）。
       *   ② 改成传 `empty.filter(e => !e.hasKeys)` 后仍然错：
       *      `empty` 是原始条目、**没有 `hasKeys` 字段**，filter 结果恒为空数组。
       *      （`hasKeys` 只存在于下面 `empty:` 返回值的映射结果里。）
       *   所以判据与上面 `emptyNoKeys` 的定义保持一致，直接算 keys 长度。
       */
      emptyNoKeys: empty.filter(e => !(e.keys || []).length),
      emptyKeyed: empty.filter(e => (e.keys || []).length),
      worst,
    }),
  };
}

function buildNotes({ constTokens, duplicates, keyConflicts, emptyNoKeys = [], emptyKeyed = [], worst }) {
  const notes = [];
  if (emptyNoKeys.length) {
    notes.push(`${emptyNoKeys.length} 条空壳条目（内容为空、也没有触发词，永远不产生效果）——建议删除`);
  }
  if (emptyKeyed.length) {
    notes.push(`${emptyKeyed.length} 条条目有触发词但内容为空（${emptyKeyed.slice(0, 3).map(e => e.comment).join('、')}）`
      + ' —— 可能是归并失败留下的壳，需要人工确认后再删');
  }
  if (duplicates.length) {
    notes.push(`${duplicates.length} 组同名条目，重复注入同一角色/地点 —— 建议合并`);
  }
  if (constTokens > 8000) {
    notes.push(`常驻 ${constTokens} tok 偏高（每轮固定开销）——建议把非必需的常驻条目改为按键触发`);
  }
  const badConflicts = keyConflicts.filter(c => c.entries >= 4);
  if (badConflicts.length) {
    notes.push(`${badConflicts.length} 个触发词会一次拉起 ≥4 条条目`
      + `（最严重：${badConflicts[0].key} → ${badConflicts[0].entries} 条 / ${badConflicts[0].tokens} tok）`
      + ' —— 建议给条目补 secondary_keys，或收窄触发词');
  }
  if (worst && worst.tokens > 15000) {
    notes.push(`单轮最坏情况会注入 ${worst.tokens} tok（命中「${worst.key}」）—— 可能吃掉大半上下文`);
  }
  return notes;
}

/**
 * 优化：只做**无损**修改，返回新卡 + 变更清单。
 *
 * 两个动作：
 *   ① 删除**无 keys 的空壳**条目（内容为空且没有触发词 —— 删掉不可能有任何影响）
 *   ② 合并同名条目：**两边正文都保留**，后一条以「【同名条目·合并】」标注追加
 *      （不挑一份丢一份 —— 哪份更好需要人来判断）
 *
 * ⚠️ **有 keys 的空条目不删，只报告**。
 * 它有两种可能：归并失败留下的壳，或用户故意留的触发挂点。
 * 自动删掉会静默改变触发行为 —— 那不该由工具替人决定。
 *
 * @param {object} card
 * @param {{mergeDuplicates?:boolean, dropEmpty?:boolean}} [opts]
 * @returns {{card:object, report:object}}
 */
export function optimizeCard(card, { mergeDuplicates = true, dropEmpty = true } = {}) {
  const cloned = JSON.parse(JSON.stringify(card));
  const entries = cloned?.data?.character_book?.entries;
  if (!Array.isArray(entries)) {
    return { card: cloned, report: { ok: false, error: '不是有效的角色卡' } };
  }

  const changes = { droppedEmpty: [], keptEmptyKeyed: [], mergedDuplicates: [], reindexed: 0 };
  let out = entries;

  // ① 删空壳（**仅限无 keys 的**）
  if (dropEmpty) {
    const keep = [];
    for (const e of out) {
      if (isEmptyEntry(e)) {
        const hasKeys = !!(e.keys || []).length;
        if (hasKeys) {
          // 有触发词却没有内容 → 保留但报告（见上面注释）
          changes.keptEmptyKeyed.push({ id: e.id, comment: e.comment, keys: e.keys });
          keep.push(e);
          continue;
        }
        changes.droppedEmpty.push({ id: e.id, comment: e.comment, hadKeys: false });
        continue;
      }
      keep.push(e);
    }
    out = keep;
  }

  // ② 合并同名（保留两边正文）
  if (mergeDuplicates) {
    const byName = new Map();
    const order = [];
    for (const e of out) {
      const nm = entryName(e);
      const k = nm ? varKey(nm) : null;
      if (!k) { order.push(e); continue; }
      if (!byName.has(k)) { byName.set(k, []); order.push(k); }
      byName.get(k).push(e);
    }
    const merged = [];
    for (const item of order) {
      if (typeof item !== 'string') { merged.push(item); continue; }
      const list = byName.get(item);
      if (list.length === 1) { merged.push(list[0]); continue; }

      // 保留第一条为宿主；其余正文并进去（**不丢内容**）
      const host = { ...list[0] };
      const parts = [String(host.content || '').trim()];
      const keys = new Set((host.keys || []).map(String));
      for (const extra of list.slice(1)) {
        const body = String(extra.content || '').trim();
        if (body) parts.push(`【同名条目·合并】\n${body}`);
        for (const k of extra.keys || []) keys.add(String(k));
        // 任一为非常驻 → 合并后也非常驻（避免把按需内容变成每轮注入）
        if (extra.constant === false) host.constant = false;
      }
      host.content = parts.join('\n\n');
      host.keys = [...keys];
      merged.push(host);
      changes.mergedDuplicates.push({
        name: entryName(list[0]),
        count: list.length,
        ids: list.map(e => e.id),
        tokens: estimateTokens(host.content),
      });
    }
    out = merged;
  }

  // ③ 重排 id / insertion_order 里的 id 序号（ST 依赖 id 连续且与下标一致）
  out.forEach((e, i) => {
    if (e.id !== i) changes.reindexed++;
    e.id = i;
  });
  cloned.data.character_book.entries = out;

  return {
    card: cloned,
    report: {
      ok: true,
      before: entries.length,
      after: out.length,
      changes,
      tokensBefore: entries.reduce((s, e) => s + estimateTokens(e.content), 0),
      tokensAfter: out.reduce((s, e) => s + estimateTokens(e.content), 0),
    },
  };
}
