/**
 * 角色卡体检与优化测试
 *
 * 全是确定性逻辑，不调模型。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const D = await import(pathToFileURL(path.join(ROOT, 'src/card_doctor.js')).href);
const { assembleCharacterCard } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

/** 造一张最小可用的卡 */
function makeCard(entries) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: '测试卡',
      description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
      tags: [], creator: '', character_version: '1.0', alternate_greetings: [],
      extensions: {},
      character_book: { name: '测试世界书', entries },
    },
  };
}
const E = (id, comment, content, opts = {}) => ({
  id, comment, content,
  keys: opts.keys || [],
  constant: opts.constant || false,
  enabled: opts.enabled !== false,
  insertion_order: opts.order ?? 100,
  position: 'before_char',
  extensions: opts.group ? { group: opts.group } : {},
});

// ============================================================
console.log('\n【1】体检：空壳、同名、key 冲突、预算');
{
  const card = makeCard([
    E(0, '正常条目', '这是一段正常内容。'.repeat(10), { keys: ['正常'] }),
    E(1, '空壳A', '', { keys: [] }),
    E(2, '空壳B', '   \n  ', { keys: [] }),
    E(3, '香织', '第一版香织的内容。'.repeat(20), { keys: ['香织', '莉乃'] }),
    E(4, '香织', '第二版香织的内容。'.repeat(25), { keys: ['香织', '莉乃'] }),
    E(5, '常驻大条目', '常驻内容。'.repeat(100), { constant: true }),
    E(6, '城', '城市条目。'.repeat(30), { keys: ['主城'] }),
    E(7, '城二', '另一个城市条目。'.repeat(30), { keys: ['主城'] }),
  ]);
  const a = D.auditCard(card, { commonKeys: ['主城'] });

  ok('体检成功', a.ok === true, JSON.stringify(a.error));
  ok('条目总数正确', a.counts.entries === 8, String(a.counts.entries));
  ok('常驻数正确', a.counts.constant === 1, String(a.counts.constant));
  ok('识别出 2 条空壳', a.empty.length === 2, JSON.stringify(a.empty.map(e => e.comment)));
  ok('空壳都标记为无 keys', a.empty.every(e => e.hasKeys === false), JSON.stringify(a.empty));
  ok('空白内容也算空壳', a.empty.some(e => e.comment === '空壳B'), JSON.stringify(a.empty.map(e => e.comment)));
  ok('识别出 1 组同名', a.duplicates.length === 1, String(a.duplicates.length));
  ok('同名组统计条数与 token', a.duplicates[0].count === 2 && a.duplicates[0].tokens > 0,
    JSON.stringify(a.duplicates[0]));
  ok('识别出 key 冲突', a.keyConflicts.some(c => c.key === '主城' && c.entries === 2),
    JSON.stringify(a.keyConflicts.map(c => c.key)));
  ok('标记出常见词', a.keyConflicts.find(c => c.key === '主城')?.common === true);
  ok('常驻 token 统计正确', a.tokens.constant > 0, String(a.tokens.constant));
  ok('总 token = 常驻 + 按键', a.tokens.total === a.tokens.constant + a.tokens.keyed);
  ok('给出最坏单轮提示', !!a.tokens.worstSingleTurn, JSON.stringify(a.tokens.worstSingleTurn));
  ok('notes 提到空壳', a.notes.some(n => /空壳/.test(n)), JSON.stringify(a.notes));
  ok('notes 提到同名', a.notes.some(n => /同名/.test(n)));

  // 不是卡时要优雅失败，不能崩
  ok('非卡片输入不崩', D.auditCard({}).ok === false);
  ok('null 输入不崩', D.auditCard(null).ok === false);
}

// ============================================================
console.log('\n【2】优化：删空壳 + 合并同名，且内容无损');
{
  const card = makeCard([
    E(0, '空壳A', ''),
    E(1, '香织', 'AAA 第一版', { keys: ['香织'] }),
    E(2, '香织', 'BBB 第二版', { keys: ['莉乃'], constant: true }),
    E(3, '正常', '正常内容'),
    E(4, '-----', '   '),
  ]);
  const { card: out, report } = D.optimizeCard(card);
  const entries = out.data.character_book.entries;

  ok('优化成功', report.ok === true);
  ok('删掉 2 条空壳', report.changes.droppedEmpty.length === 2,
    JSON.stringify(report.changes.droppedEmpty.map(d => d.comment)));
  // 5 条：空壳A / 香织×2 / 正常 / -----
  // 删 2 条空壳、香织 2 → 1，剩「香织」「正常」= 2 条
  ok('条目数 5 → 2', report.before === 5 && report.after === 2, `${report.before} → ${report.after}`);

  const host = entries.find(e => e.comment === '香织');
  ok('同名合并成一条', entries.filter(e => e.comment === '香织').length === 1);
  ok('第一版内容保留', host.content.includes('AAA 第一版'), host.content);
  ok('第二版内容保留（无损）', host.content.includes('BBB 第二版'), host.content);
  ok('带来源标记', host.content.includes('【同名条目·合并】'));
  ok('keys 合并', host.keys.includes('香织') && host.keys.includes('莉乃'), JSON.stringify(host.keys));
  // 任一为非常驻 → 合并后也非常驻（否则会把按需内容变成每轮注入）
  ok('合并后不升级为常驻', host.constant === false, String(host.constant));

  ok('id 重排为连续下标', entries.every((e, i) => e.id === i), JSON.stringify(entries.map(e => e.id)));
  ok('不改动原卡（返回新对象）',
    card.data.character_book.entries.length === 5, String(card.data.character_book.entries.length));

  // 幂等：再优化一次不应再有变化
  const again = D.optimizeCard(out);
  ok('幂等（第二次没有可优化项）',
    again.report.changes.droppedEmpty.length === 0
    && again.report.changes.mergedDuplicates.length === 0,
    JSON.stringify(again.report.changes));
}

// ============================================================
console.log('\n【3】优化只做无损处理：key 冲突与预算**不自动改**');
{
  const card = makeCard([
    E(0, 'A', 'A 内容', { keys: ['主城'] }),
    E(1, 'B', 'B 内容', { keys: ['主城'] }),
    E(2, '常驻', '常驻内容', { constant: true }),
  ]);
  const { card: out, report } = D.optimizeCard(card);
  const entries = out.data.character_book.entries;

  ok('key 冲突不被自动修改（削 key 会改变触发行为）',
    entries.filter(e => (e.keys || []).includes('主城')).length === 2,
    JSON.stringify(entries.map(e => e.keys)));
  ok('常驻标记不被自动改动',
    entries.find(e => e.comment === '常驻')?.constant === true);
  ok('没有同名/空壳时条目数不变', report.before === 3 && report.after === 3,
    `${report.before} → ${report.after}`);
}

// ============================================================
console.log('\n【4】与真实生成的卡兼容（字段口径一致）');
{
  // 用 pipeline 真造一张卡，确认体检器认它的字段结构
  const card = assembleCharacterCard({
    timeline: { base: '相对纪元', origin: { event: '开场' }, events: [{ name: '开场', time: '' }], characters: [] },
    events: [{ name: '开场', pressure: 'core', chapter: '第1章' }],
    // 给一份**有内容**的档案 —— 空档案是另一个话题（见下面那条断言）
    characters: [{ name: '甲', content_yaml: 'name: 甲\nappearance: 黑色短发，深色瞳孔，身形瘦高' }],
    variables: { world: { time: '晨' }, events: { 开场: { status: 'ongoing', deviation: 0, pressure: 'core' } }, characters: { 甲: { affinity: 0, state: '正常' } } },
    phasesWithDeltas: [],
    userMode: { mode: 'participant', protagonistName: '' },
    cardFields: { name: '真实卡', first_mes: 'x' },
    worldbook: [{ category: 'map_world', name: '世界', keys: ['世界'], content: '世界内容', constant: true }],
    worldbookName: '设定集',
  });
  const a = D.auditCard(card);
  ok('能体检 pipeline 真实产出的卡', a.ok === true, JSON.stringify(a.error));
  ok('正常卡没有空壳条目', a.empty.length === 0, JSON.stringify(a.empty.map(e => e.comment)));
  ok('正常卡能统计常驻 token', a.tokens.constant > 0, String(a.tokens.constant));

  const { report } = D.optimizeCard(card);
  ok('正常卡优化不误删条目', report.changes.droppedEmpty.length === 0,
    JSON.stringify(report.changes.droppedEmpty.map(d => d.comment)));
  ok('正常卡优化后条目数不变', report.before === report.after,
    `${report.before} → ${report.after}`);

  /**
   * 这张卡的人物条目必须**有正文**。
   *
   * 这是一个真 bug 的回归：`assembleCharacterCard` 原来直接读 `c.content`，
   * 而 `content_yaml` 形状的档案（image_card / augment 的抽取结果）在 `c.content`
   * 上是 undefined —— 于是产出**内容为空的人物条目**：
   * keys 有（名字还在）、正文是空串，角色"存在但没有任何信息"。
   * 修法是改走 `pickContent`（认 content_yaml / content / 正文 / yaml）。
   */
  const charEntry = card.data.character_book.entries.find(e => /^\[character/.test(e.comment));
  ok('人物条目有正文（content_yaml 也被读到）',
    !!charEntry && String(charEntry.content).includes('黑色短发'),
    JSON.stringify({ c: charEntry?.comment, len: String(charEntry?.content || '').length }));
  ok('体检没把有正文的人物条目当空壳',
    a.empty.every(e => !/^\[character/.test(String(e.comment))),
    JSON.stringify(a.empty.map(e => e.comment)));

  /**
   * 空档案的角色条目 → **有 keys 但内容为空**。
   *
   * 这种条目**只报告、不删**：它可能是归并失败留下的壳，
   * 也可能是用户故意留的触发挂点。自动删掉会静默改变触发行为。
   */
  const withEmptyChar = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
      name: '有壳的卡', description: '', personality: '', scenario: '',
      first_mes: '', mes_example: '', tags: [], creator: '', character_version: '1.0',
      alternate_greetings: [], extensions: {},
      character_book: {
        name: 'S',
        entries: [E(0, '[character·次要NPC] 乙', '', { keys: ['乙'], group: 'character' })],
      },
    },
  };
  const a2 = D.auditCard(withEmptyChar);
  const shell = a2.empty.find(e => String(e.comment).includes('乙'));
  ok('体检能发现「有 keys 但内容为空」的条目', !!shell && shell.hasKeys === true,
    JSON.stringify(a2.empty));
  ok('notes 提醒人工确认而不是建议直接删',
    a2.notes.some(n => /有触发词但内容为空/.test(n) && /人工确认/.test(n)),
    JSON.stringify(a2.notes));

  const opt2 = D.optimizeCard(withEmptyChar);
  ok('这种条目不自动删除', opt2.report.changes.droppedEmpty.length === 0,
    JSON.stringify(opt2.report.changes.droppedEmpty));
  ok('但会记进 keptEmptyKeyed 供人工处理',
    opt2.report.changes.keptEmptyKeyed.length === 1,
    JSON.stringify(opt2.report.changes.keptEmptyKeyed));
}

// ============================================================
console.log('\n【5】边界：空世界书、无 entries、超大卡');
{
  ok('空数组条目不崩', D.auditCard(makeCard([])).counts.entries === 0);
  ok('空数组优化不崩', D.optimizeCard(makeCard([])).report.after === 0);

  const noBook = { data: {} };
  ok('缺 character_book 时体检报错不崩', D.auditCard(noBook).ok === false);
  ok('缺 character_book 时优化报错不崩', D.optimizeCard(noBook).report.ok === false);

  // 只有空壳的卡：优化后条目为 0
  const allEmpty = makeCard([E(0, 'a', ''), E(1, 'b', '  ')]);
  ok('全是空壳时优化后为 0 条', D.optimizeCard(allEmpty).report.after === 0);

  // 同名但有分组前缀不同的，按去前缀后的名字判定
  const withGroup = makeCard([
    E(0, '[map_region] 御兽山', '区域版内容'),
    E(1, '[map_location] 御兽山', '地点版内容'),
  ]);
  const dup = D.auditCard(withGroup).duplicates;
  ok('去分组前缀后判同名', dup.length === 1 && dup[0].count === 2, JSON.stringify(dup.map(d => d.name)));
  const merged = D.optimizeCard(withGroup).card.data.character_book.entries;
  ok('跨分组同名也合并', merged.length === 1, String(merged.length));
  ok('跨分组合并后两边内容都在',
    merged[0].content.includes('区域版内容') && merged[0].content.includes('地点版内容'),
    merged[0].content);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  卡片体检测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
