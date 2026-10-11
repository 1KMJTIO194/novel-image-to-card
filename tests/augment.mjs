/**
 * 完善角色卡测试（需求第十四节）。
 *
 * 纯逻辑测试：不调 LLM、不依赖服务器。
 * 对齐（alignEntities）单独用桩 LLM 覆盖，因为它是整个功能的关键路径。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const A = await import(pathToFileURL(path.join(ROOT, 'src/augment.js')).href);
const { assembleCharacterCard } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

// ============================================================
// 造一张真实的"已有角色卡"（用流水线自己的组装函数，保证结构真实）
// ============================================================
function makeExistingCard() {
  return assembleCharacterCard({
    timeline: {
      base: '天启纪年',
      origin: { event: '开篇入城' },
      events: [{ name: '开篇入城', time: '天启三年春', chapter: '第一章' }],
      characters: [],
    },
    events: [{ name: '开篇入城', canon: '林昭入城。', pressure: 'core', prerequisites: {} }],
    characters: [
      { name: '林昭', keys: ['林昭', '阿昭'], content: '林昭，十七岁，为寻兄长入京。' },
      { name: '卡卡西', keys: ['卡卡西'], content: '卡卡西，银发，戴面罩。' },
    ],
    variables: {
      world: { time: '天启三年春', phase: '起始' },
      events: { 开篇入城: { status: 'done', deviation: 0, pressure: 'core' } },
      characters: { 卡卡西: { affinity: 10, state: '正常' } },
      custom: { storylines: { 入城立足: { events: ['开篇入城'], stage: '起点' } } },
    },
    phasesWithDeltas: [
      { name: '入城立足', startEvent: '开篇入城', endEvent: '开篇入城', coreChange: 'x',
        characterDeltas: [{ character: '林昭', change: '从谨慎观望变为主动出击' }] },
    ],
    userMode: { mode: 'protagonist', protagonistName: '林昭' },
    cardFields: {
      name: '云京旧案', description: '描述', personality: '人设', scenario: '场景',
      first_mes: '开场白。', alternate_greetings: ['备选一。', '备选二。'],
      mes_example: '<START>\nx', tags: ['古风'],
    },
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: '云京为王朝都城，分内外两城。', constant: true },
    ],
    worldbookName: '云京旧案设定集',
  });
}

// ============================================================
console.log('【1】载入 character_card.json 解析成功');
const existingCard = makeExistingCard();
{
  ok('validateCard 通过', A.validateCard(existingCard) === true);
  const s = A.extractCardStructure(existingCard);
  console.log(`   已有：${s.entries.length} 条目 / 人物 ${s.characters.length} / 世界观 ${s.worldbook.length}`);
  ok('条目被解析', s.entries.length > 0, String(s.entries.length));
  ok('人物条目被识别', s.characters.length === 2, JSON.stringify(s.characters.map(c => c.name)));
  ok('人物 keys 带出', eq(s.characters.find(c => c.name === '林昭')?.keys, ['林昭', '阿昭']));
  ok('世界观条目被识别', s.worldbook.length === 1 && s.worldbook[0].category === 'map_world',
    JSON.stringify(s.worldbook));
  ok('extractName 正确', A.extractName('[character] 林昭') === '林昭');
  ok('extractCategory 正确', A.extractCategory('[map_world] 云京') === 'map_world');
  ok('找到角色阶段条目', !!s.phaseEntry);
}

// ============================================================
console.log('\n【2】initvar 解析成变量树');
{
  const s = A.extractCardStructure(existingCard);
  ok('变量树被解析', !!s.variables && typeof s.variables === 'object');
  ok('world 段存在', s.variables.world?.time === '天启三年春', JSON.stringify(s.variables.world));
  ok('characters 段存在', !!s.variables.characters?.['卡卡西']);
  ok('custom.storylines 存在', !!s.variables.custom?.storylines);
  ok('initvar 条目只有一条', s.entries.filter(e => String(e.comment).includes('[initvar]')).length === 1);

  // 坏 YAML 不能让它炸
  const broken = JSON.parse(JSON.stringify(existingCard));
  broken.data.character_book.entries.find(e => String(e.comment).includes('[initvar]')).content = '{{[bad';
  let err = null;
  try { A.extractCardStructure(broken); } catch (e) { err = e; }
  ok('initvar 是坏 YAML 时不抛错（退化为空变量树）', !err, err?.message);
}

// ============================================================
console.log('\n【3】卡片结构校验');
{
  for (const [label, card, expect] of [
    ['null', null, '不是合法的 JSON 对象'],
    ['缺 data', {}, '缺少 data 字段'],
    ['缺 name', { data: { character_book: { entries: [] } } }, '缺少 data.name'],
    ['缺 character_book', { data: { name: 'x' } }, '缺少 data.character_book'],
    ['entries 不是数组', { data: { name: 'x', character_book: { entries: {} } } }, 'entries 不是数组'],
  ]) {
    let err = null;
    try { A.validateCard(card); } catch (e) { err = e; }
    ok(`拒绝非法卡「${label}」`, !!err && err.message.includes(expect), err?.message || '没有抛错');
  }
}

// ============================================================
console.log('\n【4】实体对齐（关键路径）');
{
  // 桩 LLM：返回一段包含别名匹配、新实体、冲突的对齐结果
  const stubLLM = {
    async chatJSON(_sys, user) {
      const payload = JSON.parse(user);
      const names = new Set((payload.new.characters || []).map(c => c.name));
      const matched = [];
      const added = [];
      // 卡卡西 vs 旗木卡卡西 → 同一实体
      if (names.has('旗木卡卡西')) {
        matched.push({
          type: 'character', existingName: '卡卡西', newName: '旗木卡卡西',
          confidence: 0.95, reason: '同一角色的全名与简称', action: 'merge',
        });
      }
      if (names.has('沈砚')) added.push({ type: 'character', name: '沈砚' });
      return {
        matched,
        added,
        conflicts: [{
          type: 'character', existingName: '卡卡西', newName: '旗木卡卡西',
          field: '性格', existing: '散漫、迟到', new: '严肃、守时', severity: 'high',
        }],
      };
    },
  };

  const newItems = {
    characters: [{ name: '旗木卡卡西', keys: ['旗木卡卡西'] }, { name: '沈砚', keys: ['沈砚'] }],
    events: [{ name: '初见沈砚' }],
    worldbook: [{ name: '茶楼', category: 'map_location' }],
  };
  const s = A.extractCardStructure(existingCard);
  const aligned = await A.alignEntities({ existing: s, newItems, llm: stubLLM });

  ok('别名对齐命中（卡卡西 ↔ 旗木卡卡西）',
    aligned.matched.some(m => m.existingName === '卡卡西' && m.newName === '旗木卡卡西'),
    JSON.stringify(aligned.matched));
  ok('新人物被标为 added', aligned.added.some(a => a.name === '沈砚'), JSON.stringify(aligned.added));
  ok('冲突被记录且带 severity',
    aligned.conflicts.length === 1 && aligned.conflicts[0].severity === 'high',
    JSON.stringify(aligned.conflicts));
  ok('未降级', aligned.degraded === false);

  // LLM 失败 → 退化为全部新增，而不是整次失败
  const badLLM = { async chatJSON() { throw new Error('boom'); } };
  const logs = [];
  const degraded = await A.alignEntities({ existing: s, newItems, llm: badLLM, log: (a, b) => logs.push(b) });
  ok('对齐失败时降级而非抛错', degraded.degraded === true);
  ok('降级后新实体全部进 added', degraded.added.length === 4, JSON.stringify(degraded.added));
  ok('降级有日志', logs.some(l => /对齐失败/.test(l)), JSON.stringify(logs));

  // 已有卡为空 → 不必调 LLM
  const emptyExisting = { characters: [], events: [], worldbook: [] };
  let called = false;
  const spy = { async chatJSON() { called = true; return {}; } };
  const r2 = await A.alignEntities({ existing: emptyExisting, newItems, llm: spy });
  ok('已有卡为空时不调 LLM', !called);
  ok('已有卡为空时全部新增', r2.added.length === 4, String(r2.added.length));
}

// ============================================================
console.log('\n【5】append / merge / overwrite 三种策略');
{
  const s = A.extractCardStructure(existingCard);
  const mkNew = () => ([
    {
      id: 999, comment: '[character] 卡卡西', keys: ['旗木卡卡西'],
      content: '旗木卡卡西，木叶上忍，写轮眼。', constant: false, enabled: true,
      insertion_order: 999, position: 'after_char', extensions: {},
    },
    {
      id: 998, comment: '[character] 沈砚', keys: ['沈砚'],
      content: '沈砚，茶楼常客。', constant: false, enabled: true,
      insertion_order: 998, position: 'after_char', extensions: {},
    },
  ]);
  const aligned = {
    matched: [{ type: 'character', existingName: '卡卡西', newName: '卡卡西', action: 'merge' }],
    added: [{ type: 'character', name: '沈砚' }],
    newEntries: mkNew(),
  };

  const before = JSON.parse(JSON.stringify(s.entries));
  // 人物条目注释可能带剧情分层后缀（`[character·主要NPC] 名`），
  // 所以按**名字**查而不是按注释全等查 —— 否则查不到新生成的条目。
  const findChar = (entries, name) =>
    entries.find(e => /^\[character(\u00b7[^\]]+)?\]/.test(e.comment || '') && A.extractName(e.comment) === name);
  const beforeKakashi = findChar(before, '卡卡西').content;

  // append：已有条目一字不改，但仍然新增
  const ap = A.mergeEntries(s.entries, aligned, 'append');
  ok('append：已有条目 content 未变',
    findChar(ap.entries, '卡卡西').content === beforeKakashi);
  ok('append：新增条目被加入', !!findChar(ap.entries, '沈砚'));
  ok('append：条目数 = 原 + 1', ap.entries.length === before.length + 1, String(ap.entries.length));

  // merge：content 合并，keys 取并集
  const mg = A.mergeEntries(s.entries, aligned, 'merge');
  const merged = findChar(mg.entries, '卡卡西');
  ok('merge：content 含原内容', merged.content.includes('银发'));
  ok('merge：content 含新内容', merged.content.includes('写轮眼'));
  ok('merge：用【新增内容】分隔', merged.content.includes('【新增内容】'), merged.content.slice(0, 80));
  ok('merge：keys 取并集',
    merged.keys.includes('卡卡西') && merged.keys.includes('旗木卡卡西'), JSON.stringify(merged.keys));
  ok('merge：原文一字未删', merged.content.includes(beforeKakashi), '原内容丢失');
  ok('merge：有 updated 记录', mg.updated.some(u => u.name === '卡卡西' && u.how === 'merge'));

  // overwrite：替换正文
  const ow = A.mergeEntries(s.entries, aligned, 'overwrite');
  const replaced = findChar(ow.entries, '卡卡西');
  ok('overwrite：正文被替换', replaced.content.includes('写轮眼') && !replaced.content.includes('面罩'),
    replaced.content);
  ok('overwrite：keys 变成新的', eq(replaced.keys, ['旗木卡卡西']), JSON.stringify(replaced.keys));
  ok('overwrite：保留原有 insertion_order',
    replaced.insertion_order === findChar(before, '卡卡西').insertion_order);
  ok('overwrite：有 updated 记录', ow.updated.some(u => u.how === 'replace'));

  // id 唯一且连续（验收标准）
  for (const [label, r] of [['append', ap], ['merge', mg], ['overwrite', ow]]) {
    const ids = r.entries.map(e => e.id);
    ok(`${label}：id 唯一且连续 0..n-1`,
      ids.every((v, i) => v === i), JSON.stringify(ids.slice(0, 8)));
  }

  // 原对象不被改写（合并必须无副作用）
  ok('mergeEntries 不改动传入的 entries',
    findChar(s.entries, '卡卡西').content === beforeKakashi, '原对象被改了');
}

// ============================================================
console.log('\n【5b】matched 指向不存在的已有条目时，必须退化为新增（不能静默丢数据）');
{
  // 实测踩过的坑：对齐器说「卡卡西」与「旗木卡卡西」是同一实体，
  // 但原卡里根本没有卡卡西条目 → 既没东西可合并、又不能什么都不做，
  // 旧实现会把这个新实体**静默丢掉**。
  const existing = [{
    id: 0, comment: '[character] 林昭', keys: ['林昭'], content: '林昭的原有档案。',
    insertion_order: 11, position: 'after_char', extensions: {},
  }];
  const newEntries = [{
    id: 99, comment: '[character] 旗木卡卡西', keys: ['旗木卡卡西', '卡卡西'],
    content: '旗木卡卡西，木叶上忍。', insertion_order: 120, position: 'after_char', extensions: {},
  }];
  const aligned = {
    matched: [{ type: 'character', existingName: '卡卡西', newName: '旗木卡卡西', confidence: 0.95, action: 'merge' }],
    added: [],
    newEntries,
  };
  for (const s of ['append', 'merge', 'overwrite']) {
    const r = A.mergeEntries(existing, aligned, s);
    ok(`${s}：匹配落空的新实体被保留`,
      r.entries.some(e => e.comment === '[character] 旗木卡卡西'),
      JSON.stringify(r.entries.map(e => e.comment)));
    ok(`${s}：计入 added 而不是 updated`,
      r.added.some(a => a.name === '旗木卡卡西') && r.updated.length === 0,
      JSON.stringify({ added: r.added, updated: r.updated }));
    ok(`${s}：id 仍连续`, r.entries.every((e, i) => e.id === i));
  }
}

// （人物条目查询辅助：注释可能带剧情分层后缀，统一按名字查）
const findCharIn = (entries, name) =>
  entries.find(e => /^\[character(\u00b7[^\]]+)?\]/.test(e.comment || '') && A.extractName(e.comment) === name);

// ============================================================
console.log('\n【5c】keep_both 与重复 added 的处理');
{
  const s = A.extractCardStructure(existingCard);
  const newEntries = [{
    id: 90, comment: '[character] 卡卡西', keys: ['卡卡西'],
    content: '另一条卡卡西。', insertion_order: 90, position: 'after_char', extensions: {},
  }];
  // keep_both：不动已有条目，但也**不**把它塞进 added（它就在 matched 里）
  const r = A.mergeEntries(s.entries, {
    matched: [{ type: 'character', existingName: '卡卡西', newName: '卡卡西', action: 'keep_both' }],
    added: [], newEntries,
  }, 'merge');
  ok('keep_both：已有条目未被改动',
    findCharIn(r.entries, '卡卡西').content.includes('银发'));
  ok('keep_both：也没有重复新增',
    r.entries.filter(e => A.extractName(e.comment) === '卡卡西' && /^\[character/.test(e.comment)).length === 1);

  // added 里同一个名字出现两次 → 只加一条
  const r2 = A.mergeEntries(s.entries, {
    matched: [], added: [{ type: 'character', name: '沈砚' }, { type: 'character', name: '沈砚' }], newEntries: [{
      id: 91, comment: '[character] 沈砚', keys: ['沈砚'], content: '沈砚。',
      insertion_order: 91, position: 'after_char', extensions: {},
    }],
  }, 'merge');
  ok('added 重复名字只加一条',
    r2.entries.filter(e => /^\[character/.test(e.comment || '') && A.extractName(e.comment) === '沈砚').length === 1,
    String(r2.entries.filter(e => /^\[character/.test(e.comment || '') && A.extractName(e.comment) === '沈砚').length));

  // added 指向一个不存在于 newEntries 的名字 → 跳过，不抛错
  const r3 = A.mergeEntries(s.entries, {
    matched: [], added: [{ type: 'character', name: '查无此条' }], newEntries: [],
  }, 'merge');
  ok('added 指向不存在的条目时安全跳过', r3.entries.length === s.entries.length);
}

// ============================================================
console.log('\n【6】变量树合并：新字段加入，旧字段保留');
{
  const existingVars = {
    world: { time: '天启三年春', phase: '起始' },
    events: { 开篇入城: { status: 'done', deviation: 0, pressure: 'core' } },
    characters: { 卡卡西: { affinity: 10, state: '正常' } },
    custom: { storylines: { 入城立足: { stage: '起点' } } },
    user: { name: '林昭' },
  };
  const newVars = {
    world: { time: '天启三年冬', phase: '旧案浮现' },        // 冲突：应保留旧值
    events: { 初见沈砚: { status: 'pending', deviation: 0, pressure: 'buffer' } },
    characters: {
      卡卡西: { affinity: 0, rank: '上忍' },                  // affinity 已有 → 保留 10；rank 是新字段 → 加入
      沈砚: { affinity: 0, state: '正常' },
    },
    custom: { storylines: { 旧案真相: { stage: '起点' } } },
    user: { name: '不该覆盖' },
  };
  const m = A.mergeVariables(existingVars, newVars);

  ok('world 冲突保留旧值', m.world.time === '天启三年春', m.world.time);
  ok('world 新字段补入', m.world.phase === '起始' && !!m.world);
  ok('events 新事件加入', !!m.events['初见沈砚'] && !!m.events['开篇入城']);
  ok('旧事件未被删', m.events['开篇入城'].status === 'done');
  ok('characters 新人物加入', !!m.characters['沈砚']);
  ok('已有角色缺的字段被补', m.characters['卡卡西'].rank === '上忍');
  ok('已有角色已有字段不被覆盖', m.characters['卡卡西'].affinity === 10, String(m.characters['卡卡西'].affinity));
  ok('custom 合并保留旧线', !!m.custom.storylines['入城立足'] && !!m.custom.storylines['旧案真相']);
  ok('user 命名空间不被覆盖', m.user.name === '林昭', m.user.name);
  ok('原变量树无副作用', existingVars.world.time === '天启三年春' && !existingVars.characters['沈砚']);
  ok('空新变量安全', eq(A.mergeVariables(existingVars, null).world, existingVars.world));
}

// ============================================================
console.log('\n【7】角色阶段表合并：新阶段追加，去重');
{
  const s = A.extractCardStructure(existingCard);
  const before = s.phaseEntry.content;
  const newPhases = [
    { name: '旧案浮现', characterDeltas: [{ character: '林昭', change: '从被动到主动追查' }] },
    { name: '入城立足', characterDeltas: [{ character: '林昭', change: '重复阶段应被去重' }] },
    { name: '无增量阶段', characterDeltas: [] },
  ];
  const merged = A.mergePhaseEJS(before, newPhases);
  ok('新阶段被追加', merged.includes('旧案浮现'), merged.slice(0, 200));
  ok('内容带增量正文', merged.includes('从被动到主动追查'));
  ok('已存在的阶段被去重', !merged.includes('重复阶段应被去重'));
  ok('无增量的阶段不写入', !merged.includes('无增量阶段'));

  // 关键：合并后仍是**单个** EJS 标签（跨标签会变成非法 JS）
  const tags = merged.match(/<%_[\s\S]*?_%>/g) || [];
  const defTag = tags.find(t => t.includes('人设增量表'));
  ok('表定义仍在单个 EJS 标签内', !!defTag && !defTag.includes('_%>') === false);
  ok('表定义标签只有一对定界符',
    defTag && (defTag.match(/<%_/g) || []).length === 1 && (defTag.match(/_%>/g) || []).length === 1,
    defTag?.slice(0, 80));

  // 表必须是合法 JSON（前端/引擎要能解析）
  const m = /<%_\s*const\s+人设增量表\s*=\s*(\{[\s\S]*?\})\s*;\s*_%>/.exec(merged);
  let parsed = null, err = null;
  try { parsed = JSON.parse(m[1]); } catch (e) { err = e; }
  ok('表体是合法 JSON', !err, err?.message);
  ok('表里含起始兜底键', parsed?.['起始'] !== undefined);
  ok('表里含新阶段', parsed?.['旧案浮现'] !== undefined);
  ok('表里保留原阶段', parsed?.['入城立足'] !== undefined);

  // 无新增时原样返回
  ok('没有新阶段时原样返回', A.mergePhaseEJS(before, []) === before);
  ok('EJS 为空时安全', A.mergePhaseEJS('', newPhases) === '');
  ok('形态不匹配时原样返回（不做危险改写）',
    A.mergePhaseEJS('<%_ const 别的 = 1; _%>', newPhases) === '<%_ const 别的 = 1; _%>');
}

// ============================================================
console.log('\n【8】组装最终卡片：保留扩展、initvar 唯一、版本递增');
{
  const s = A.extractCardStructure(existingCard);
  const merged = A.mergeVariables(s.variables, {
    events: { 初见沈砚: { status: 'pending', deviation: 0, pressure: 'buffer' } },
  });
  // 故意塞两条 initvar，验证"只保留一条"
  const entries = [
    ...s.entries,
    {
      id: 900, comment: '[initvar]重复的', content: 'bad: 1', constant: true, enabled: false,
      insertion_order: 900, keys: [], position: 'before_char', extensions: {},
    },
  ];
  const finalCard = A.assembleAugmentedCard({ existingCard, entries, variables: merged });

  const ivs = finalCard.data.character_book.entries.filter(e => String(e.comment).includes('[initvar]'));
  ok('initvar 只保留一条', ivs.length === 1, String(ivs.length));
  ok('initvar 内容是合并后的变量树',
    ivs[0].content.includes('初见沈砚') && ivs[0].content.includes('开篇入城'),
    ivs[0].content.slice(0, 100));
  ok('initvar 内容可被 YAML 解析', (() => {
    try { return !!YAML.parse(ivs[0].content); } catch { return false; }
  })());

  ok('id 唯一且连续',
    finalCard.data.character_book.entries.every((e, i) => e.id === i));

  // 原卡结构必须原样保留
  ok('regex_scripts 原样保留',
    eq(finalCard.data.extensions.regex_scripts, existingCard.data.extensions.regex_scripts)
    && finalCard.data.extensions.regex_scripts.length === 1,
    JSON.stringify(finalCard.data.extensions.regex_scripts?.length));
  ok('tavern_helper 原样保留',
    eq(finalCard.data.extensions.tavern_helper, existingCard.data.extensions.tavern_helper));
  ok('depth_prompt 原样保留',
    eq(finalCard.data.extensions.depth_prompt, existingCard.data.extensions.depth_prompt));
  ok('alternate_greetings 未被删',
    eq(finalCard.data.alternate_greetings, existingCard.data.alternate_greetings)
    && finalCard.data.alternate_greetings.length === 2,
    JSON.stringify(finalCard.data.alternate_greetings));
  ok('name 未被改动', finalCard.data.name === existingCard.data.name);
  ok('description/personality/scenario 未改',
    finalCard.data.description === existingCard.data.description
    && finalCard.data.personality === existingCard.data.personality);
  ok('spec/spec_version 未改',
    finalCard.spec === 'chara_card_v3' && finalCard.spec_version === '3.0');

  // 版本递增
  ok('版本号递增 1.0 → 1.1', finalCard.data.character_version === '1.1', finalCard.data.character_version);
  ok('bumpVersion 各种输入',
    A.bumpVersion('1.0') === '1.1' && A.bumpVersion('2.3') === '2.4'
    && A.bumpVersion('') === '1.1' && A.bumpVersion('x') === '1.1',
    [A.bumpVersion('1.0'), A.bumpVersion('2.3'), A.bumpVersion(''), A.bumpVersion('x')].join(','));
  ok('bumpVersion 到 9 进位成 10 而不是 1.10',
    A.bumpVersion('1.9') === '1.10', A.bumpVersion('1.9'));

  // 顶层与 data.* 一致（ST 两层不一致会打警告）
  ok('顶层 name 与 data.name 一致', finalCard.name === finalCard.data.name);
  ok('顶层 alternate_greetings 与 data 一致',
    eq(finalCard.alternate_greetings, finalCard.data.alternate_greetings));
  ok('顶层 tags 与 data 一致', eq(finalCard.tags, finalCard.data.tags));
  ok('顶层 talkativeness 与 extensions 一致',
    finalCard.talkativeness === finalCard.data.extensions.talkativeness);

  // 序列化往返
  ok('JSON 往返无损', eq(JSON.parse(JSON.stringify(finalCard)), finalCard));
  ok('JSON 里没有 \\u003c 转义', !JSON.stringify(finalCard).includes('\\u003c'));
}

// ============================================================
console.log('\n【9】mergeContentText 的边界');
{
  ok('原为空 → 返回新内容', A.mergeContentText('', '新') === '新');
  ok('新为空 → 返回原内容', A.mergeContentText('原', '') === '原');
  ok('已包含则不再追加', A.mergeContentText('abc', 'abc') === 'abc');
  ok('正常追加带分隔',
    A.mergeContentText('原', '新') === '原\n\n---\n【新增内容】\n新',
    JSON.stringify(A.mergeContentText('原', '新')));
  ok('null 安全', A.mergeContentText(null, null) === '');
}

// ============================================================
console.log('\n【9】三个「静默丢失」bug 的回归（都曾让完善功能看起来"没效果"）');
{
  /**
   * Bug ①：事件返回被包在对象里 → 全部静默丢失。
   *
   * 实测模型返回 {"type":"json_object","events":[{…}]}，
   * 而旧代码写的是 `Array.isArray(r) ? r : []` → 0 个事件，
   * 日志只说"新事件 0 个"，看起来像是模型没抽到。
   */
  {
    const wrapped = { type: 'json_object', events: [{ name: '真法一重圆满' }, { name: '张元留玉简' }] };
    const out = A.parseEventsResponse(wrapped);
    ok('事件包在对象里也能取出来', out.length === 2, JSON.stringify(out.length));
    ok('取出的还是原事件对象', out[0]?.name === '真法一重圆满', JSON.stringify(out[0]));

    // 各种真实可能出现的外壳
    ok('裸数组照常', A.parseEventsResponse([{ name: 'A' }]).length === 1);
    ok('items 键也认', A.parseEventsResponse({ items: [{ name: 'B' }] }).length === 1);
    ok('data 键也认', A.parseEventsResponse({ data: [{ name: 'C' }] }).length === 1);
    ok('空对象 → 空数组', A.parseEventsResponse({}).length === 0);
    ok('null → 空数组', A.parseEventsResponse(null).length === 0);
    ok('字符串 → 空数组（不崩）', A.parseEventsResponse('nonsense').length === 0);
    // 关键：只要模型给了事件，就绝不能变成 0
    ok('模型给了 1 个事件就不会丢',
      A.parseEventsResponse({ events: [{ name: 'X' }] }).length === 1);
  }

  /**
   * Bug ②：人物档案字段名是 `content_yaml`，不是 `content`。
   * 旧判据 `if (!item?.content) return null` → 新人物档案恒为 0 份。
   */
  {
    const real = {
      name: '张元',
      keys: ['张元', '哥哥'],
      content_yaml: 'name: 张元\ntitle: 太一宗本宗修行者\nage: 未提及',
    };
    const p = A.parseCharacterProfile(real, { name: '张元', aliases: ['哥哥'] });
    ok('content_yaml 能被读到（字段名没写错）', !!p && p.content.includes('name: 张元'),
      JSON.stringify(p?.content?.slice(0, 40)));
    ok('name 用传入的名字', p?.name === '张元', p?.name);
    ok('keys 合并了别名', p?.keys.includes('张元') && p?.keys.includes('哥哥'), JSON.stringify(p?.keys));

    // 兼容旧写法
    ok('content 写法也认', A.parseCharacterProfile({ content: 'x' }, { name: 'A' })?.content === 'x');
    ok('text 写法也认', A.parseCharacterProfile({ text: 'y' }, { name: 'A' })?.content === 'y');
    // 真空档案要返回 null（不能塞空条目进卡）
    ok('正文为空 → null', A.parseCharacterProfile({ name: 'X' }, { name: 'X' }) === null);
    ok('空对象 → null', A.parseCharacterProfile({}, { name: 'X' }) === null);
    ok('null → null（不崩）', A.parseCharacterProfile(null, { name: 'X' }) === null);
    ok('只有空白的 content_yaml → null',
      A.parseCharacterProfile({ content_yaml: '   \n  ' }, { name: 'X' }) === null);
  }

  /**
   * Bug ③：`assembleWorldbook(timeline, [], …)` 把事件列表传成了空数组，
   * 于是抽到的事件**一条都不会变成卡片条目**（added.event 恒为 0）。
   *
   * 这里直接验证"传事件 → 产生 [event] 条目"这条契约。
   */
  {
    const { assembleWorldbook } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
    const events = [
      { name: '张元留玉简', pressure: 'core', chapter: '第1章' },
      { name: '获准炼心路', pressure: 'buffer', chapter: '第3章' },
    ];
    const timeline = {
      base: '相对纪元', origin: { event: events[0].name },
      events: events.map(e => ({ name: e.name, time: '', chapter: e.chapter })),
      characters: [],
    };
    const wb = assembleWorldbook(timeline, events, [], [], { title: 'T' });
    const evEntries = wb.entries.filter(e => String(e.comment).startsWith('[event]'));
    ok('传事件 → 生成 [event] 条目', evEntries.length === 2, JSON.stringify(wb.entries.map(e => e.comment)));
    ok('条目名与事件名对应',
      evEntries.some(e => e.comment.includes('张元留玉简'))
      && evEntries.some(e => e.comment.includes('获准炼心路')),
      JSON.stringify(evEntries.map(e => e.comment)));

    // 反证：传空数组就是旧行为（一条都没有）—— 这正是 bug 的样子
    const empty = assembleWorldbook(timeline, [], [], [], { title: 'T' });
    ok('传空数组确实一条 [event] 都没有（旧 bug 的形态）',
      empty.entries.filter(e => String(e.comment).startsWith('[event]')).length === 0,
      JSON.stringify(empty.entries.map(e => e.comment)));
  }
}

// ============================================================
console.log('\n【10】对齐必须看得见「不用标准前缀」的卡（否则新内容全部变成新条目）');
{
  /**
   * 真实故障（用户报的"小说内容没并进卡里，而是新建条目存设定"）：
   *
   * `extractCardStructure` 靠 comment 前缀（[character]/[event]/[map_*]）分类，
   * 而用户那张 100 条目的卡**完全不用这套约定**（条目就叫「香织」「精灵森林」「地下城」）。
   * 于是报告里 before = {characters:0, events:0, worldbook:0}：
   *   · hasExisting 判为"已有卡是空的"
   *   · 对齐器收到空 existing → matched 0
   *   · 21 条新抽取**全部堆成新条目**，一条都没并进已有条目
   */
  const bareCard = A ? null : null;   // 占位，避免未使用告警

  // 一张不用前缀的卡
  const plainEntries = [
    { id: 0, comment: '香织', content: '莉乃的母亲，优雅而严厉。', keys: ['香织'], enabled: true, extensions: {} },
    { id: 1, comment: '地下城', content: '随机生成的地城，层数越深越危险。', keys: ['地下城'], enabled: true, extensions: {} },
    { id: 2, comment: '升级和技能', content: '击杀怪物获得经验，升级后可选技能。', keys: ['等级', '技能'], enabled: true, extensions: {} },
    { id: 3, comment: '已禁用的条目', content: '这条被禁用了。', keys: ['x'], enabled: false, extensions: {} },
  ];

  const structure = A.extractCardStructure({ data: { character_book: { entries: plainEntries } } });
  ok('不用前缀的卡：结构分类结果为空（这就是 bug 的来源）',
    structure.characters.length === 0 && structure.events.length === 0 && structure.worldbook.length === 0,
    JSON.stringify({ c: structure.characters.length, e: structure.events.length, w: structure.worldbook.length }));

  const pick = A.pickAlignEntries(plainEntries, structure);
  ok('退回用全部条目参与对齐', pick.useFallback === true, String(pick.useFallback));
  ok('索引包含所有启用的条目（3 条，跳过禁用的）', pick.entries.length === 3,
    JSON.stringify(pick.entries.map(e => e.name)));
  ok('索引里名字已去掉前缀', pick.entries.every(e => !e.name.startsWith('[')),
    JSON.stringify(pick.entries.map(e => e.name)));
  ok('索引带内容摘要（供对齐器判断同一性）',
    pick.entries.every(e => typeof e.hint === 'string' && e.hint.length > 0),
    JSON.stringify(pick.entries.map(e => e.hint.slice(0, 20))));
  ok('禁用的条目不进索引', !pick.entries.some(e => e.name === '已禁用的条目'));

  // 用标准前缀的卡：行为必须**完全不变**
  const prefixed = [
    { id: 0, comment: '[character·主角] 林昭', content: 'x', keys: ['林昭'], enabled: true, extensions: {} },
    { id: 1, comment: '[map_world] 云京', content: 'y', keys: ['云京'], enabled: true, extensions: {} },
  ];
  const s2 = A.extractCardStructure({ data: { character_book: { entries: prefixed } } });
  const pick2 = A.pickAlignEntries(prefixed, s2);
  ok('用标准前缀的卡不退回（保持原行为）', pick2.useFallback === false, String(pick2.useFallback));
  ok('标准前缀卡传的还是分类后的条目', pick2.entries.length === 2, String(pick2.entries.length));

  // 对齐器现在能匹配到「地下城」
  const stubLLM = {
    async chatJSON(_sys, user) {
      const payload = JSON.parse(user);
      const names = payload.existing.map(e => e.name);
      return {
        matched: names.includes('地下城')
          ? [{ type: 'worldbook', existingName: '地下城', newName: '地下城', confidence: 0.9, reason: '同名', action: 'merge' }]
          : [],
        added: [{ type: 'worldbook', name: '新地点' }],
        conflicts: [],
      };
    },
  };
  const aligned = await A.alignEntities({
    existing: structure, newItems: { worldbook: [{ name: '地下城', category: 'map_location' }], events: [], characters: [] },
    llm: stubLLM, alignEntries: pick.entries,
  });
  ok('对齐器能看到已有条目并匹配上', aligned.matched.length === 1,
    JSON.stringify(aligned.matched));
  ok('匹配到的是「地下城」', aligned.matched[0]?.existingName === '地下城');

  // 合并：内容要并进**已有条目**，而不是新建
  const newEntries = [{
    id: 99, comment: '[map_location] 地下城', content: '新增：地下城有陷阱与宝箱。',
    keys: ['地下城', '陷阱'], constant: false, enabled: true, insertion_order: 50, extensions: { group: 'map_location' },
  }];
  const merged = A.mergeEntries(plainEntries, { ...aligned, newEntries });
  ok('合并后没有新增重复的「地下城」条目',
    merged.entries.filter(e => A.extractName(e.comment) === '地下城').length === 1,
    JSON.stringify(merged.entries.map(e => e.comment)));
  ok('新内容并进了已有条目', merged.entries.find(e => e.comment === '地下城').content.includes('陷阱与宝箱'),
    merged.entries.find(e => e.comment === '地下城').content);
  ok('已有内容没丢', merged.entries.find(e => e.comment === '地下城').content.includes('层数越深越危险'));
  ok('记为 updated（并进已有条目）而不是新增',
    merged.updated.length === 1 && merged.updated[0].name === '地下城',
    JSON.stringify({ updated: merged.updated, added: merged.added }));
  // stub 的 added 里那个「新地点」并不在 newEntries 里，所以找不到、不会真加进来
  ok('找不到正文的新增不会凭空插入', merged.added.length === 0,
    JSON.stringify(merged.added));
  ok('keys 合并了', merged.entries.find(e => e.comment === '地下城').keys.includes('陷阱'),
    JSON.stringify(merged.entries.find(e => e.comment === '地下城').keys));

  /**
   * ⚠️ **真实端到端抓到的 bug**：`hasExisting` 读的是旧的分类结果。
   *
   * 只测 `alignEntities({ alignEntries })` 是不够的 —— 真实调用时
   * `existing` 是 `extractCardStructure` 的输出，对不用前缀的卡
   * 三项**全是空数组**。如果 `hasExisting` 判的是那三项的长度，
   * 就会直接返回 `nothingMatches()`、**`alignEntries` 根本没被用上**，
   * 对齐永远降级为"全部新增"（日志会出现「对齐结果已降级为「全部新增」」）。
   *
   * 所以这里**必须传一个分类为空的 `existing`**，模拟真实调用形态。
   */
  const emptyStructure = { characters: [], events: [], worldbook: [], entries: plainEntries };
  let called = 0;
  const countingLLM = {
    async chatJSON(_sys, user) {
      called++;
      const payload = JSON.parse(user);
      return {
        matched: payload.existing.some(e => e.name === '地下城')
          ? [{ type: 'worldbook', existingName: '地下城', newName: '地下城', confidence: 0.9, reason: '同名', action: 'merge' }]
          : [],
        added: [],
        conflicts: [],
      };
    },
  };
  const aligned2 = await A.alignEntities({
    existing: emptyStructure,           // ← 分类全空（真实形态）
    newItems: { worldbook: [{ name: '地下城', category: 'map_location' }], events: [], characters: [] },
    llm: countingLLM,
    alignEntries: pick.entries,
  });
  ok('分类为空时**仍然调用对齐器**（而不是直接降级）', called === 1,
    `chatJSON 调用次数=${called}（0 就说明又走了 nothingMatches 早退）`);
  ok('分类为空时不会误判为 degraded', aligned2.degraded === false, String(aligned2.degraded));
  ok('分类为空时依然能匹配上已有条目', aligned2.matched.length === 1,
    JSON.stringify({ matched: aligned2.matched, degraded: aligned2.degraded }));

  // 真的没有已有条目时才该降级
  const aligned3 = await A.alignEntities({
    existing: { characters: [], events: [], worldbook: [] },
    newItems: { worldbook: [{ name: 'X' }], events: [], characters: [] },
    llm: countingLLM,
    alignEntries: [],                   // ← 索引也是空的
  });
  ok('确实没有已有条目时才降级为全部新增',
    aligned3.degraded === true && aligned3.added.length === 1,
    JSON.stringify({ degraded: aligned3.degraded, added: aligned3.added }));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  完善角色卡测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
