/**
 * 分批评析 · 全局归并测试
 *
 * 覆盖：别名归并、级联保护、事件去重、时间线对齐、归并账本。
 * 重点是**归并不能出错**：把两个人并成一个比不归并更糟，所以这里大量测试"不该合并"的情况。
 *
 * 运行：node tests/merge_batches.mjs
 */
import {
  mergeRosters, mergeEvents, mergeMentions, mergeWorldbook, mergeBatches,
} from '../src/merge_batches.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}
const names = (roster) => roster.map(r => r.name).join(',');
const aliasesOf = (roster, name) => roster.find(r => r.name === name)?.aliases || [];

// ============================================================
console.log('\n【1】别名归并');
{
  // 最典型的场景：一批认出全名+简称，另一批只认出简称并当成独立人物
  const r = mergeRosters([
    [{ name: '林昭', aliases: ['阿昭'], role: '主角' }],
    [{ name: '阿昭', aliases: [], role: '主要配角' }, { name: '沈砚', aliases: [], role: '主要配角' }],
  ]);
  ok('合并成 2 人', r.roster.length === 2, names(r.roster));
  ok('保留「林昭」为主名', r.roster.some(x => x.name === '林昭'), names(r.roster));
  ok('没有遗留独立的「阿昭」', !r.roster.some(x => x.name === '阿昭'), names(r.roster));
  ok('「阿昭」进别名', aliasesOf(r.roster, '林昭').includes('阿昭'), JSON.stringify(aliasesOf(r.roster, '林昭')));
  ok('主名取角色等级高者（主角优先）', r.roster[0].name === '林昭', names(r.roster));
  ok('账本记录了这次合并',
    r.report.merged.some(m => m.name === '林昭' && m.from.includes('阿昭')),
    JSON.stringify(r.report.merged));
  ok('账本记录了来源批次',
    r.report.merged[0].batches.join(',') === '0,1', JSON.stringify(r.report.merged[0].batches));
}

// ============================================================
console.log('\n【2】不该合并的情况（级联保护）');
{
  // 「林」是「林昭」的别名，但「林」同时是另一条记录的主名
  const r = mergeRosters([
    [{ name: '林昭', aliases: ['林'], role: '主角' }],
    [{ name: '林', aliases: [], role: '主要配角' }, { name: '林婉儿', aliases: [], role: '次要配角' }],
  ]);
  ok('三个名字仍保持独立（主名不可被别名吞掉）',
    new Set([...r.roster.map(x => x.name)]).size >= 2, names(r.roster));
  ok('「林婉儿」没有被并进「林昭」',
    r.roster.some(x => x.name === '林婉儿') || r.roster.some(x => x.name === '林'),
    names(r.roster));

  // 互为子串绝不自动合并
  const sub = mergeRosters([
    [{ name: '林昭', aliases: [], role: '主角' }],
    [{ name: '林昭仪', aliases: [], role: '次要配角' }],
  ]);
  ok('子串关系不自动合并', sub.roster.length === 2, names(sub.roster));
  ok('子串关系被记为可疑（只提示）',
    sub.report.suspicious.some(s => s.includes('林昭') && s.includes('林昭仪')),
    JSON.stringify(sub.report.suspicious));
}

// ============================================================
console.log('\n【3】主名优选');
{
  // 关键区分：「声明的主名」永远优于「别人列的别名」，哪怕别名更长。
  // {name:'阿昭', aliases:['林昭']} 这一条**单独**存在时，主名就该是「阿昭」——
  // 没有任何证据说「林昭」才是正式名（模型可能是对的）。
  const single = mergeRosters([[{ name: '阿昭', aliases: ['林昭'], role: '主要配角' }]]);
  ok('单条记录时保留它自己声明的主名', single.roster[0].name === '阿昭', names(single.roster));
  ok('它的别名仍在别名表里', aliasesOf(single.roster, '阿昭').includes('林昭'));

  // 一旦另一批把「林昭」也当主名报出来，就该优选「林昭」（它被两处认作名字，
  // 而「阿昭」只被一处当名字、另一处当别名）
  const merged2 = mergeRosters([
    [{ name: '阿昭', aliases: ['林昭'], role: '主要配角' }],
    [{ name: '林昭', aliases: [], role: '主要配角' }],
  ]);
  ok('另一批也报出林昭时优选林昭', merged2.roster[0].name === '林昭', names(merged2.roster));
  ok('阿昭进别名', aliasesOf(merged2.roster, '林昭').includes('阿昭'));

  // 等级不同 → 主角优先，与长短无关
  const r2 = mergeRosters([
    [{ name: '小昭', aliases: ['林昭'], role: '主角' }],
    [{ name: '林昭', aliases: [], role: '主要配角' }],
  ]);
  ok('主角等级优先于名字长度', r2.roster[0].name === '小昭', names(r2.roster));

  // 同名跨批
  const r3 = mergeRosters([
    [{ name: '沈砚', aliases: ['沈公子'], role: '主要配角' }],
    [{ name: '沈砚', aliases: ['沈兄'], role: '主要配角' }],
  ]);
  ok('同名只保留一条', r3.roster.length === 1, names(r3.roster));
  ok('两批的别名都并进来',
    aliasesOf(r3.roster, '沈砚').includes('沈公子') && aliasesOf(r3.roster, '沈砚').includes('沈兄'),
    JSON.stringify(aliasesOf(r3.roster, '沈砚')));
  ok('批次计数为 2', r3.roster[0].batchCount === 2, String(r3.roster[0].batchCount));
}

// ============================================================
console.log('\n【4】人物归并的边界');
{
  ok('空输入 → 空名单', mergeRosters([]).roster.length === 0);
  ok('null 不崩', mergeRosters(null).roster.length === 0);
  ok('空批不崩', mergeRosters([[], []]).roster.length === 0);
  ok('缺 name 的条目被跳过', mergeRosters([[{ aliases: ['x'] }, { name: '  ' }]]).roster.length === 0);
  ok('别名去重', mergeRosters([[{ name: 'A', aliases: ['a', 'a', 'b'] }]])
    .roster[0].aliases.length === 2, JSON.stringify(mergeRosters([[{ name: 'A', aliases: ['a', 'a', 'b'] }]]).roster[0].aliases));
  ok('别名等于主名时丢弃',
    mergeRosters([[{ name: 'A', aliases: ['A'] }]]).roster[0].aliases.length === 0);
  // 主角排最前
  const order = mergeRosters([
    [{ name: '配角甲', aliases: [], role: '次要配角' }, { name: '主角乙', aliases: [], role: '主角' }],
  ]);
  ok('主角排在最前', order.roster[0].name === '主角乙', names(order.roster));
  ok('账本记录输入输出条数',
    order.report.inputCount === 2 && order.report.outputCount === 2,
    JSON.stringify(order.report));
}

// ============================================================
console.log('\n【5】事件去重');
{
  const r = mergeEvents([
    [{ name: '云京之变', pressure: 'buffer', interventions: ['a'] }],
    [{ name: '云京之变', pressure: 'core', interventions: ['b'] }],
  ]);
  ok('同名合成一条', r.events.length === 1, String(r.events.length));
  ok('保留更高的压力等级', r.events[0].pressure === 'core', r.events[0].pressure);
  ok('interventions 合并', r.events[0].interventions.length === 2, JSON.stringify(r.events[0].interventions));
  ok('账本记录去重数', r.report.dropped === 1, String(r.report.dropped));

  const multi = mergeEvents([
    [{ name: 'E1' }, { name: 'E2' }],
    [{ name: 'E2' }, { name: 'E3' }],
  ]);
  ok('跨批事件合并后 3 条', multi.events.length === 3, multi.events.map(e => e.name).join(','));

  // 相近但不合并
  const near = mergeEvents([[{ name: '云京之变' }], [{ name: '云京事变' }]]);
  ok('名字相近不自动合并', near.events.length === 2, near.events.map(e => e.name).join(','));
  ok('去后缀后同词干 → 记进账本', near.report.nearDuplicates.length >= 1,
    JSON.stringify(near.report.nearDuplicates));

  const prefix = mergeEvents([[{ name: '夜探旧宅' }], [{ name: '夜探旧宅的真相' }]]);
  ok('前缀关系也算相近', prefix.report.nearDuplicates.length === 1, JSON.stringify(prefix.report.nearDuplicates));

  const punct = mergeEvents([[{ name: '云京·之变' }], [{ name: '云京之变' }]]);
  ok('只差间隔号也算相近', punct.report.nearDuplicates.length === 1, JSON.stringify(punct.report.nearDuplicates));

  // 不该误报：字面上有共同词但结构不同
  const distinct = mergeEvents([[{ name: '夜探旧宅' }], [{ name: '夜探密道' }]]);
  ok('结构不同不误报', distinct.report.nearDuplicates.length === 0, JSON.stringify(distinct.report.nearDuplicates));

  ok('空输入不崩', mergeEvents([]).events.length === 0);
  ok('null 不崩', mergeEvents(null).events.length === 0);
  ok('缺 name 的条目被丢掉', mergeEvents([[{ canon: 'x' }]]).events.length === 0);
}

// ============================================================
console.log('\n【6】时间提及归并');
{
  const r = mergeMentions([
    [{ chapter: '第一章', mentions: [{ raw: 'a' }] }],
    [{ chapter: '第二章', mentions: [{ raw: 'b' }] }],
  ]);
  ok('两批提及都在', r.length === 2, String(r.length));
  ok('保持批次顺序', r[0].chapter === '第一章' && r[1].chapter === '第二章');
  ok('缺 chapter 的被丢掉', mergeMentions([[{ mentions: [] }]]).length === 0);
  ok('null 不崩', mergeMentions(null).length === 0);
}

// ============================================================
console.log('\n【7】世界观归并');
{
  const r = mergeWorldbook([
    [{ category: 'map_world', name: '云京', content: '短' }],
    [{ category: 'map_world', name: '云京', content: '这是更长的描述内容' }],
  ]);
  ok('同名同分类合并', r.items.length === 1, String(r.items.length));
  ok('保留更长的内容', r.items[0].content === '这是更长的描述内容', r.items[0].content);
  ok('账本记录去重', r.report.dropped === 1);

  // 同名不同分类不合并（体系层的"剑"与具体武器"剑"是两回事）
  const diff = mergeWorldbook([
    [{ category: 'system_skill', name: '御剑术', content: 'a' }],
    [{ category: 'system_item', name: '御剑术', content: 'b' }],
  ]);
  ok('同名不同分类不合并', diff.items.length === 2, String(diff.items.length));

  /**
   * P0 修复之一：**实体类**分类的同名跨分类条目要去重。
   *
   * 实测《示例小说 A》里「御兽山」被抽了两条：
   *   [map_region]   御兽山  643 字  0 处「未提及」
   *   [map_location] 御兽山  282 字  5 处「未提及」
   * 旧 key 是 `分类::名字`，分类不同 → 没被去重，低质那条跟高质那条抢同一个触发词。
   *
   * 只对地图/势力类做（ENTITY_CATEGORIES）—— 上面那条 `system_skill` vs
   * `system_item` 的断言就是"不能一刀切"的证明。
   */
  {
    const ent = mergeWorldbook([
      [{ category: 'map_location', name: '御兽山', content: '短且空' }],
      [{ category: 'map_region', name: '御兽山', content: '这是信息更全的那条' }],
    ]);
    ok('实体类同名跨分类去重', ent.items.length === 1, String(ent.items.length));
    ok('实体类保留信息更全的那条',
      ent.items[0].category === 'map_region' && ent.items[0].content === '这是信息更全的那条',
      JSON.stringify({ c: ent.items[0].category, t: ent.items[0].content }));
    ok('跨分类去重有账本',
      (ent.report.crossCategoryDropped || []).some(d => d.reason === 'same-name-other-category'),
      JSON.stringify(ent.report.crossCategoryDropped));
  }

  /**
   * P0 修复之二：分类上限**全局**生效。
   *
   * 上限写在抽取 prompt 里，但抽取器是逐批调用的 —— 全局口径、逐批执行，
   * 于是"每批各占满 2 条"累积成 5 条（实测批次 1 抽 1、批次 2 抽 2、批次 3 抽 2）。
   *
   * 超出上限的条目**并入**保留者，不丢弃内容 ——
   * 实测 5 条 system_realm 里「炼心路」是独立设定，简单裁掉就是信息损失。
   */
  {
    const cap = mergeWorldbook([
      [{ category: 'system_realm', name: '境界体系', content: '境界内容' }],
      [
        { category: 'system_realm', name: '灵根体系', content: '灵根内容' },
        { category: 'system_realm', name: '炼心路', content: '自主筑基的历练路径', keys: ['炼心路'] },
      ],
      [{ category: 'system_realm', name: '真元机制', content: '真元消耗规则' }],
    ]);
    const realms = cap.items.filter(w => w.category === 'system_realm');
    ok('分类上限全局生效（system_realm ≤ 2）', realms.length === 2, String(realms.length));

    // 内容不能丢：超限的条目名要出现在保留者的正文里
    const all = realms.map(w => w.content).join('\n');
    ok('超限条目的独有内容被并入（不丢弃）',
      all.includes('自主筑基的历练路径') && all.includes('真元消耗规则') && all.includes('灵根内容'),
      all.slice(0, 120));
    ok('并入时带来源标记', /【补充·/.test(all), all.match(/【补充·[^】]*】/g)?.join(','));
    ok('并入的账本标明 mergedInto',
      (cap.report.crossCategoryDropped || []).filter(d => d.reason === 'over-cap-merged-into')
        .every(d => d.mergedInto),
      JSON.stringify(cap.report.crossCategoryDropped));
    ok('并入后 keys 也合并', realms.some(w => (w.keys || []).includes('炼心路')),
      JSON.stringify(realms.map(w => w.keys)));
  }
  ok('空输入不崩', mergeWorldbook([]).items.length === 0);
}

// ============================================================
console.log('\n【8】mergeBatches 总入口');
{
  const r = mergeBatches({
    perBatch: [
      {
        index: 0,
        mentions: [{ chapter: '第一章', mentions: [{ raw: 'a' }] }],
        events: [{ name: 'E1' }],
        roster: [{ name: '林昭', aliases: ['阿昭'], role: '主角' }],
        worldbook: [{ category: 'map_world', name: '云京', content: 'c' }],
      },
      {
        index: 1,
        mentions: [{ chapter: '第二章', mentions: [{ raw: 'b' }] }],
        events: [{ name: 'E1' }, { name: 'E2' }],
        roster: [{ name: '阿昭', aliases: [], role: '主要配角' }],
        worldbook: [{ category: 'map_world', name: '云京', content: 'cc' }],
      },
    ],
    chapterTitles: ['第一章', '第二章'],
  });
  ok('提及合并 2 条', r.mentions.length === 2);
  ok('事件去重后 2 条', r.events.length === 2, r.events.map(e => e.name).join(','));
  ok('人物归并后 1 人', r.roster.length === 1, names(r.roster));
  ok('世界观去重后 1 条', r.worldbook.length === 1);
  ok('账本记录批数', r.report.batches === 2);
  ok('没有孤立章节', r.report.orphanChapters.length === 0, JSON.stringify(r.report.orphanChapters));

  // 乱序传入也要按 index 排序
  const shuffled = mergeBatches({
    perBatch: [
      { index: 2, mentions: [{ chapter: 'C', mentions: [] }], events: [], roster: [], worldbook: [] },
      { index: 0, mentions: [{ chapter: 'A', mentions: [] }], events: [], roster: [], worldbook: [] },
      { index: 1, mentions: [{ chapter: 'B', mentions: [] }], events: [], roster: [], worldbook: [] },
    ],
    chapterTitles: ['A', 'B', 'C'],
  });
  ok('按批次号排序', shuffled.mentions.map(m => m.chapter).join('') === 'ABC',
    shuffled.mentions.map(m => m.chapter).join(''));

  // 章节错位检测（时间线对齐的守卫）
  const orphan = mergeBatches({
    perBatch: [{ index: 0, mentions: [{ chapter: '不存在的章', mentions: [] }], events: [], roster: [], worldbook: [] }],
    chapterTitles: ['第一章'],
  });
  ok('章节号对不上会被报出', orphan.report.orphanChapters.length === 1,
    JSON.stringify(orphan.report.orphanChapters));

  // 空输入
  const empty = mergeBatches({});
  ok('空输入各字段为空数组',
    empty.mentions.length === 0 && empty.events.length === 0
    && empty.roster.length === 0 && empty.worldbook.length === 0);
  ok('空输入账本可读', empty.report.batches === 0);
  ok('null 不崩', mergeBatches().report.batches === 0);
}

// ============================================================
console.log('\n==============================================');
console.log(`  归并测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
