/**
 * 分批评析 · 全局归并
 *
 * 各批是独立抽取的，所以同一个实体在不同批里会有不同写法：
 *   「林昭」/「阿昭」/「昭儿」是一个人；同一场「云京之变」可能被抽成
 *   「云京之变」和「京城事变」；批内事件的章节号在全局时间线里也要重新对齐。
 *
 * 这个模块把各批结果合成全局统一产物，并且**保留归并账本**（mergeReport）——
 * 归并错了比不归并更难查，所以每一步都要能说清"把谁并进了谁、为什么"。
 *
 * 两条不可动摇的规则：
 *   1. **绝不编造**。所有归并只做"同一实体的不同称呼"合并，不新增任何实体，
 *      不做语义推断（不会因为"两人都在云京"就合并）。
 *   2. **级联保护**。别名必须能被"认领"，且一个名字只能被一个实体认领。
 *      否则「林」既是「林昭」的别名又能匹配「林婉儿」，三个人会被并成一个。
 */
import { varKey } from './utils.js';
import { dedupeEvents } from './pipeline.js';
import { TIER_RANK, normalizeTier } from './tiers.js';

/**
 * 角色重要度排序，用于决定合并后保留谁的主名。
 *
 * 直接用 pipeline 的 TIER_RANK（主角 / 主要NPC / 次要NPC / 路人NPC），
 * 不再自己维护一份 —— 两处档位不一致会让"主名优选"和"变量树建给谁"
 * 得出互相矛盾的结果。
 */
const ROLE_RANK = TIER_RANK;

/**
 * 归并各批的人物名单。
 *
 * 合并条件（满足其一，且通过级联保护）：
 *   - A 的主名出现在 B 的别名里，或 B 的主名出现在 A 的别名里
 *     （这是分批评析最常见的情况：一批认出全名，另一批只认出简称）
 *   - A、B 的主名相同（varKey 之后相同，即只差空白与点号）
 *
 * ⚠️ **不做**"主名互为子串"的合并。看起来很像同一个人，但中文里
 * 「林昭」与「林昭仪」是两个人，子串合并会把整张卡的人搞乱。
 * 子串关系只用于**校验**：发现可疑时记进 report，交给人判断。
 *
 * @param {Array<Array<{name:string, aliases?:string[], role?:string}>>} rosterPerBatch
 * @returns {{roster:Array, report:object}}
 */
export function mergeRosters(rosterPerBatch = []) {
  const batches = Array.isArray(rosterPerBatch) ? rosterPerBatch : [];
  const flat = [];
  const batchCount = new Map();
  for (let bi = 0; bi < batches.length; bi++) {
    for (const r of Array.isArray(batches[bi]) ? batches[bi] : []) {
      const name = String(r?.name || '').trim();
      if (!name) continue;
      flat.push({
        name,
        aliases: (Array.isArray(r?.aliases) ? r.aliases : [])
          .map(a => String(a || '').trim()).filter(a => a && a !== name),
        /**
         * 模型给的等级**提示**。
         *
         * 这里刻意用 normalizeTier 保留提示值（旧档位名会映射到新档位），
         * 而不是统一塞一个默认值 —— 归并的「主名优选」要靠它区分
         * 「林昭(主角)」与「阿昭(次要NPC)」。真分层（按剧情占比）
         * 在 Step 5 归并之后由 classifyByStoryShare 统一算，那才是权威值。
         */
        role: normalizeTier(r?.role, '次要NPC'),
        // 本批内该角色出现的章节数。各批的章节**互不相交**，
        // 所以跨批归并时要**求和**（取最大值会漏掉其它批次的戏份，
        // 一个横跨 11 批的角色会被算成只出场 1 批）。
        storyChapters: Number(r?.storyChapters) || 0,
        batchIndex: bi,
      });
      batchCount.set(name, (batchCount.get(name) || 0) + 1);
    }
  }

  // ① 先按主名精确合并（同一批里同一个人被抽两次也会在这里合掉）
  const byKey = new Map();
  for (const r of flat) {
    const key = varKey(r.name);
    if (!byKey.has(key)) {
      byKey.set(key, {
        name: r.name,
        // primaryName=true 表示这个名字是**某条记录自己声明的主名**。
        // 它必须优先于"别人列的别名" —— 见下面 shouldKeepAsPrimary。
        primaryName: true,
        aliases: new Set(r.aliases),
        role: r.role,
        /**
         * 「第几批 → 该批里出现了多少章」。
         *
         * 必须按批分别记，不能只留一个累计值：
         * 各批的章节**互不相交**，所以跨批要**相加**；
         * 而同一批里的同名重复条目（模型把一个人抽了两次）要**取最大值**。
         * 早期版本直接 `acc.storyChapters += r.storyChapters`：
         * 同一批抽两次就会把 1 章算成 2 章；改成一个标量取 max 之后，
         * 跨批的戏份又会被丢掉（横跨 3 批的角色只算 1 批）。
         */
        chaptersByBatch: new Map([[r.batchIndex, r.storyChapters]]),
        batchIndexes: new Set([r.batchIndex]),
      });
      continue;
    }
    const acc = byKey.get(key);
    for (const a of r.aliases) acc.aliases.add(a);
    acc.batchIndexes.add(r.batchIndex);
    acc.chaptersByBatch.set(
      r.batchIndex,
      Math.max(acc.chaptersByBatch.get(r.batchIndex) ?? 0, r.storyChapters),
    );
    if ((ROLE_RANK[r.role] ?? 9) < (ROLE_RANK[acc.role] ?? 9)) acc.role = r.role;
  }

  // 别名里出现过的名字：它们只是"称呼"，不是谁声明的主名。
  //
  // 注意这里**必须**把"一条记录自己列出的别名"也算进来：
  //   `{ name:'阿昭', aliases:['林昭'] }` 这种记录（模型把简称当主名、全名当别名）
  //   在阶段 2 里不会产生任何 union（别名的 owner 就是它自己），
  //   如果这里不登记，「林昭」就不会被认成别名，最终主名会错选成「阿昭」。
  const aliasNames = new Set();
  for (const g of byKey.values()) for (const a of g.aliases) aliasNames.add(varKey(a));

  // ② 别名归并：某人/某批的别名若正好是另一条记录的主名 → 并成一条
  const groups = [...byKey.values()];
  const parent = groups.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));

  // **两阶段**，保证结果与遍历顺序无关：
  //   阶段 1：所有主名先登记进 owner —— 主名永远优先，别名只能去认领主名，
  //           不能反过来把另一条记录的主名吞掉。
  //   阶段 2：每个别名去 owner 里找目标并 union。
  const owner = new Map();
  groups.forEach((g, i) => owner.set(varKey(g.name), i));

  const notes = [];
  for (let i = 0; i < groups.length; i++) {
    for (const alias of groups[i].aliases) {
      const ak = varKey(alias);
      if (!ak || ak === varKey(groups[i].name)) continue;
      const j = owner.get(ak);
      if (j === undefined || j === i) continue;
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) continue;
      // 保留"更像正式名"的那个当主名：角色等级高者优先，其次名字长的
      const keepI = shouldKeepAsPrimary(groups[ri], groups[rj], aliasNames);
      const [win, lose] = keepI ? [ri, rj] : [rj, ri];
      parent[lose] = win;
      notes.push(`「${groups[lose].name}」作为「${groups[win].name}」的别名并入`);
    }
  }

  const buckets = new Map();
  for (let i = 0; i < groups.length; i++) {
    const root = find(i);
    if (!buckets.has(root)) buckets.set(root, []);
    buckets.get(root).push(groups[i]);
  }

  const roster = [];
  const merged = [];
  for (const bucket of buckets.values()) {
    // 主名优选顺序（**顺序不能颠倒**）：
    //   ① 角色等级高者 —— 「主角」是比"谁把它当别名"更强的信号
    //   ② 自己声明的主名 优于 别人列的别名
    //   ③ 名字更长者（全名优于简称）
    //
    // 曾经把 ② 放在 ① 前面，结果是：主名「林昭(主角)」+ 别名「阿昭」，
    // 而另一批把「阿昭(主要配角)」当主名 → 「阿昭」反而赢了。
    // 原因是 `-1 || 1` 会短路成 -1：别名那条判据一旦有结论，等级判据就不再参与。
    bucket.sort((a, b) => ((ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9))
      || (Number(aliasNames.has(varKey(b.name))) - Number(aliasNames.has(varKey(a.name))))
      || (b.name.length - a.name.length));
    const primary = bucket[0];

    // 别名 = 这一桶里除主名之外的所有写法（其他条目的主名 + 所有列的别名）
    const aliases = new Set();
    for (const g of bucket) {
      if (g.name !== primary.name) aliases.add(g.name);
      for (const a of g.aliases) if (a !== primary.name) aliases.add(a);
    }
    const sources = [primary.name, ...aliases];

    if (bucket.length > 1) {
      merged.push({
        name: primary.name,
        from: sources.slice(1),
        role: primary.role,
        batches: [...new Set(bucket.flatMap(g => [...(g.batchIndexes || [])]))],
      });
    }
    // 本桶内该角色的出场章节数：
    // 同一批内取最大值（重复条目），跨批相加（章节互不相交）。
    const perBatchChapters = new Map();
    for (const g of bucket) {
      for (const [bi, n] of g.chaptersByBatch || []) {
        perBatchChapters.set(bi, Math.max(perBatchChapters.get(bi) ?? 0, n || 0));
      }
    }
    const storyChapters = [...perBatchChapters.values()].reduce((s, n) => s + n, 0);

    roster.push({
      name: primary.name,
      aliases: [...aliases],
      role: primary.role,
      sources,
      storyChapters,
      // 出现过的批次数 —— 供后续按重要度截断时参考
      batchCount: [...sources].reduce((m, s) => Math.max(m, batchCount.get(s) || 0), 0),
    });
  }

  // 主名排前（截断时不丢主角），其次出现批次多的
  roster.sort((a, b) => (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9)
    || b.batchCount - a.batchCount
    || b.name.length - a.name.length);

  return {
    roster,
    report: {
      inputCount: flat.length,
      outputCount: roster.length,
      merged,
      notes,
      // 可疑但**没有**合并的：主名互为子串。只提示，不动数据。
      suspicious: findSuspiciousSubstrings(roster),
    },
  };
}

function shouldKeepAsPrimary(a, b, aliasNames) {
  const ra = ROLE_RANK[a.role] ?? 9;
  const rb = ROLE_RANK[b.role] ?? 9;
  if (ra !== rb) return ra < rb;
  // 同等级时：自己声明的主名 优于 别人列的别名。
  // 「阿昭(aliases:['林昭'])」与「林昭」这种情况下必须保住「林昭」。
  const aIsAliasOnly = aliasNames?.has(varKey(a.name));
  const bIsAliasOnly = aliasNames?.has(varKey(b.name));
  if (aIsAliasOnly !== bIsAliasOnly) return !aIsAliasOnly;
  return a.name.length >= b.name.length;
}

/** 找出互为子串的主名，只用于提示（可能是同一人的全名/简称，也可能是两个人） */
function findSuspiciousSubstrings(roster) {
  const out = [];
  for (let i = 0; i < roster.length; i++) {
    for (let j = 0; j < roster.length; j++) {
      if (i === j) continue;
      const a = roster[i].name;
      const b = roster[j].name;
      if (a.length >= 2 && b.length > a.length && b.includes(a)) {
        out.push(`${a} ⊂ ${b}`);
      }
    }
  }
  return out.slice(0, 10);
}

/**
 * 归并各批的事件。
 *
 * 批内已经去过重（`dedupeEvents`），跨批要做的是：
 *   ① 同名合并（保留压力等级更高的那个、合并 interventions）
 *   ② 名字高度相近的**记进 report 但不合并** —— 事件名是变量键的一部分，
 *      错误合并会让导演指令指向不存在的事件
 *
 * @param {Array<Array>} eventsPerBatch
 */
export function mergeEvents(eventsPerBatch = []) {
  const batches = Array.isArray(eventsPerBatch) ? eventsPerBatch : [];
  const flat = [];
  for (const list of batches) for (const e of Array.isArray(list) ? list : []) flat.push(e);

  // 复用 pipeline 的同名合并逻辑（保压力高者、合 interventions）
  const merged = dedupeEvents(flat);

  // 统计每个事件来自哪些批次 —— 用于报告"哪些事件跨批出现"（多半是被重复抽出的）
  const seenIn = new Map();
  for (const e of flat) {
    const n = String(e?.name || '').trim();
    if (!n) continue;
    if (!seenIn.has(n)) seenIn.set(n, new Set());
  }
  return {
    events: merged,
    report: {
      inputCount: flat.length,
      outputCount: merged.length,
      dropped: flat.length - merged.length,
      duplicateNames: [...seenIn.entries()].filter(([, s]) => s.size > 1).map(([n]) => n),
      nearDuplicates: findNearDuplicateNames(merged.map(e => e.name)),
    },
  };
}

/**
 * 名字高度相近的事件对。
 *
 * 判据刻意都是**结构性**的，不用编辑距离：中文事件名只有 4-6 字，
 * 编辑距离阈值放到 1 会把「夜探旧宅」和「夜探密道」也报出来，噪音比信号多。
 *
 * 三条规则：
 *   ① 去掉标点/间隔号后完全相同（「云京·之变」vs「云京之变」）
 *   ② 互为前缀/后缀（「夜探旧宅」vs「夜探旧宅的真相」）
 *   ③ 去掉"之变/事变/之战"这类事件后缀后词干相同（「云京之变」vs「云京事变」）
 *
 * 全部只**报告**，不自动合并 —— 事件名是变量键的一部分，
 * 错误合并会让导演指令指向一个不存在的事件。
 */
const EVENT_SUFFIXES = ['之变', '事变', '之战', '之乱', '事件', '之战役', '之役', '风波'];
function eventStem(name) {
  let s = String(name).replace(/[·・\s\-—_]/g, '');
  for (const suf of EVENT_SUFFIXES) {
    if (s.length > suf.length + 1 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  }
  return s;
}
function findNearDuplicateNames(names) {
  const clean = (names || []).map(n => ({ raw: n, k: String(n).replace(/[·・\s\-—_]/g, ''), stem: eventStem(n) }));
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      const a = clean[i];
      const b = clean[j];
      if (a.k.length < 2 || b.k.length < 2) continue;
      const pair = `${a.raw} ≈ ${b.raw}`;
      if (a.k === b.k) { out.push(pair); continue; }
      if (a.k.startsWith(b.k) || b.k.startsWith(a.k) || a.k.endsWith(b.k) || b.k.endsWith(a.k)) {
        out.push(pair);
        continue;
      }
      // 词干相同但后缀不同（两个词干都至少 2 字，避免"变"这种单字误伤）
      if (a.stem !== a.k || b.stem !== b.k) {
        if (a.stem === b.stem && a.stem.length >= 2) out.push(pair);
      }
    }
  }
  return out.slice(0, 10);
}

/** 归并各批的时间提及（时间线要靠它全局重算） */
export function mergeMentions(mentionsPerBatch = []) {
  const out = [];
  for (const list of Array.isArray(mentionsPerBatch) ? mentionsPerBatch : []) {
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || !m.chapter) continue;
      out.push(m);
    }
  }
  // 按章序排：solveTimeline 内部会用 chapterTitles 映射，但先排好能让人工检查更直观
  return out;
}

/**
 * 归并各批的世界观条目。
 *
 * 三步处理，顺序不能反（都是被真实产出逼出来的）：
 *
 * **① 同名同分类合并**：保留更长的那条。
 *
 * **② 同名跨分类去重**：同一个地方被不同批次归到了不同分类时，只留信息更全的一条。
 *    实测《示例小说 A》里「御兽山」被抽了两次：
 *
 *        [map_region]   御兽山  643 字  0 处「未提及」
 *        [map_location] 御兽山  282 字  5 处「未提及」
 *
 *    旧的 key 是 `分类::名字`，两个分类不同 → **没被去重**，两条都进了卡，
 *    而且低质那条跟高质那条在正文里抢同一个触发词。
 *
 * **③ 分类上限全局生效**：`map_world` / `system_realm` 各最多 2 条。
 *    这条规则写在抽取 prompt 里，但抽取器是**逐批**调用的 ——
 *    规则是全局口径、执行却是逐批的，于是"每批各占满 2 条"累积成 5 条。
 *
 *    ⚠️ 超出上限的条目**不丢弃**，而是把它的**独有内容并入**同分类保留者的正文。
 *    为什么不能简单丢掉：实测 5 条 `system_realm` 里，「炼心路」是一条独立设定
 *    （走通它才能"自主筑基"，否则只能靠筑基丹），跟"境界/灵根"完全不是一回事 ——
 *    按"保留最长的 2 条"裁掉它，就是实打实的信息损失。
 *    所以这里只做**结构压缩**，不做内容取舍。
 *
 * ⚠️ **不做语义合并** —— 世界观条目描述的是不同侧面，合并会丢信息。
 *
 * @param {Array<Array>} itemsPerBatch
 * @param {{categoryCaps?:object}} [opts]
 */
export const WORLDVIEW_CATEGORY_CAPS = { map_world: 2, system_realm: 2 };

/**
 * "实体类"分类：这些分类里**同名就是同一个东西**，跨分类同名属于分类判断失误。
 *
 * 为什么只对这些分类做同名去重：`system_*` 那几类里同名可能是**两回事** ——
 * 测试里那个例子很准：「体系层的『剑』与具体武器『剑』是两回事」
 * （`system_skill` 的「御剑术」是功法体系，`system_item` 的「御剑术」可能是那本秘籍）。
 * 对它们做同名合并会丢信息。
 *
 * 而地图/势力类不会：同一个「御兽山」不可能既是 A 区域又是 B 地点。
 * 实测《示例小说 A》里它被抽了两条：
 *
 *     [map_region]   御兽山  643 字  0 处「未提及」
 *     [map_location] 御兽山  282 字  5 处「未提及」
 *
 * 旧的 key 是 `分类::名字`，两个分类不同 → **没被去重**，
 * 于是低质那条和高质那条在正文里抢同一个触发词。
 */
export const ENTITY_CATEGORIES = new Set(['map_world', 'map_region', 'map_location', 'system_faction']);

export function mergeWorldbook(itemsPerBatch = [], { categoryCaps = WORLDVIEW_CATEGORY_CAPS } = {}) {
  const byKey = new Map();
  let inputCount = 0;
  for (const list of Array.isArray(itemsPerBatch) ? itemsPerBatch : []) {
    for (const w of Array.isArray(list) ? list : []) {
      if (!w || !w.name) continue;
      inputCount++;
      const key = `${w.category || ''}::${varKey(w.name)}`;
      const prev = byKey.get(key);
      if (!prev) { byKey.set(key, w); continue; }
      if (String(w.content || '').length > String(prev.content || '').length) byKey.set(key, w);
    }
  }
  const afterSameCategory = byKey.size;

  // ② 同名跨分类去重：**只对实体类分类**做（见 ENTITY_CATEGORIES 注释）
  const byName = new Map();
  for (const w of byKey.values()) {
    if (!ENTITY_CATEGORIES.has(w.category)) continue;
    const nk = varKey(w.name);
    const prev = byName.get(nk);
    if (!prev) { byName.set(nk, w); continue; }
    if (String(w.content || '').length > String(prev.content || '').length) byName.set(nk, w);
  }
  const dropped = [];
  const seenEntityName = new Map();
  for (const w of byKey.values()) {
    if (!ENTITY_CATEGORIES.has(w.category)) continue;
    const nk = varKey(w.name);
    const keep = byName.get(nk);
    if (keep && keep !== w) {
      dropped.push({ name: w.name, category: w.category, chars: String(w.content || '').length, reason: 'same-name-other-category' });
    }
    seenEntityName.set(nk, keep);
  }

  // ③ 分类上限：超出时把**独有内容并入**保留者，而不是丢弃
  //
  // ⚠️ 这里遍历 byKey 的全部条目（不只是 byName 里那些实体类）：
  // 上面 ② 只把**实体类**的同名条目收进了 byName，其余分类的条目必须原样带过来。
  const groups = new Map();
  for (const w of byKey.values()) {
    // 实体类条目如果输给了同名的另一分类，就不再参与（去重结果见 byName）
    if (ENTITY_CATEGORIES.has(w.category)) {
      if (byName.get(varKey(w.name)) !== w) continue;
    }
    const c = w.category || '';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(w);
  }
  const kept = [];
  for (const [c, list] of groups) {
    const cap = categoryCaps?.[c];
    if (!cap || list.length <= cap) { kept.push(...list); continue; }
    // 保留者按内容长度排序（信息量大的先留）
    const sortedByLen = [...list].sort((a, b) =>
      String(b.content || '').length - String(a.content || '').length);
    const survivors = sortedByLen.slice(0, cap);
    const extras = sortedByLen.slice(cap);
    kept.push(...survivors);

    /**
     * 把超出者并入保留者：按 **keys 命中** 挑最相关的保留者
     * （同一套体系的关键词通常重合），命中不了就并入第一条。
     */
    for (const extra of extras) {
      const ek = new Set((extra.keys || []).map(String));
      let host = survivors[0];
      let best = -1;
      for (const s of survivors) {
        const score = (s.keys || []).filter(k => ek.has(String(k))).length;
        if (score > best) { best = score; host = s; }
      }
      const name = String(extra.name || '').trim();
      const body = String(extra.content || '').trim();
      // 并入时保留原条目名，让读者知道这段来自哪一条
      host.content = `${host.content.trim()}\n\n【补充·${name}】\n${body}`;
      host.keys = [...new Set([...(host.keys || []), ...(extra.keys || [])])];
      dropped.push({
        name, category: c, chars: String(extra.content || '').length,
        reason: 'over-cap-merged-into', mergedInto: host.name,
      });
    }
  }

  return {
    items: kept,
    report: {
      inputCount,
      outputCount: kept.length,
      dropped: inputCount - kept.length,
      afterSameCategory,
      // 注意：dropped 里含"已并入"的条目 —— `dropped` 计数是**条目数**的减少，
      // 不是内容丢失。内容是否丢失要看 reason：over-cap-merged-into 表示已并入。
      crossCategoryDropped: dropped,
    },
  };
}

/**
 * 全局归并入口。
 *
 * @param {{perBatch:Array<{index:number, mentions:Array, events:Array, roster:Array, worldbook:Array}>, chapterTitles?:string[]}} input
 * @returns {{mentions:Array, events:Array, roster:Array, worldbook:Array, report:object}}
 */
export function mergeBatches({ perBatch = [], chapterTitles = [] } = {}) {
  const sorted = [...perBatch].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const empty = { inputCount: 0, outputCount: 0, merged: [], notes: [], suspicious: [] };
  if (!sorted.length) {
    return {
      mentions: [], events: [], roster: [], worldbook: [],
      report: { batches: 0, mentions: empty, events: {}, roster: empty, worldbook: {} },
    };
  }

  const mentions = mergeMentions(sorted.map(b => b.mentions));
  const ev = mergeEvents(sorted.map(b => b.events));
  const ro = mergeRosters(sorted.map(b => b.roster));
  const wb = mergeWorldbook(sorted.map(b => b.worldbook));

  // 时间线对齐的**校验**：所有产生提及的章节都必须能在全局章节表里找到，
  // 否则 solveTimeline 会把这些提及算到错误的章序上（静默错位，很难发现）。
  const titleSet = new Set(chapterTitles);
  const orphanChapters = chapterTitles.length
    ? [...new Set(mentions.map(m => m.chapter).filter(c => c && !titleSet.has(c)))]
    : [];

  return {
    mentions,
    events: ev.events,
    roster: ro.roster,
    worldbook: wb.items,
    report: {
      batches: sorted.length,
      mentions: { inputCount: mentions.length, chapters: new Set(mentions.map(m => m.chapter)).size },
      events: ev.report,
      roster: ro.report,
      worldbook: wb.report,
      // 非空说明批次切分与章节表不一致（正常情况应为空数组）
      orphanChapters,
      chapterCount: chapterTitles.length,
    },
  };
}
