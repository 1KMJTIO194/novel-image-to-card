/**
 * 抽取健壮性测试（事故回归）。
 *
 * 背景：完整 JSON 角色卡模式下出现过"事件 0 个 / 世界观 0 条 / 变量树全空"，
 * 而人物条目正常 —— 说明模型在工作，是 pipeline 侧静默失败。实测根因：
 *
 *   1. 抽取类步骤都写 `Array.isArray(x) ? x : []`，模型把数组包成
 *      `{"events":[...]}` / `{"worldbook":[...]}` 时**静默变成空数组**；
 *      人物档案是单对象、人物名单做过形态归一化，所以只有它们正常。
 *   2. `catch { return [] }` 把真实错误吞掉，日志里只有"0 事件"，看不出原因。
 *   3. 事件为空后，变量树 events/storylines 全空 → 导演指令永远"（无进行中事件）"、
 *      角色阶段永远不变、EJS 全部空转。
 *
 * 这个套件钉住：数组形态归一化、字段名归一化、以及三处兜底。
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

const U = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const { asArray, estimateTokens } = U;
const { dedupeEvents, normalizeWorldbookItems, buildVariables, fallbackWorldbook, assembleWorldbook } = P;

// ============================================================
console.log('【1】asArray：LLM 的任意容器形态都要能取到数组');
{
  const WB = { category: 'map_world', name: '云京', keys: ['云京'], content: '云京为王朝都城。' };
  const EV = { name: '开篇', storyline: '线', pressure: 'core' };

  ok('裸数组原样返回', eq(asArray([1, 2]), [1, 2]));
  ok('对象包数组（英文键）', eq(asArray({ events: [EV] }), [EV]));
  ok('对象包数组（中文键）', eq(asArray({ 世界观: [WB] }), [WB]));
  ok('自创键名 → 取第一个数组值', eq(asArray({ 随便什么: [WB] }), [WB]));
  ok('顶层是 list', eq(asArray({ list: [1] }), [1]));
  ok('顶层是 data', eq(asArray({ data: [1] }), [1]));

  // 关键回归：单条目对象不能被当成容器
  ok('单条目对象 → 包成单元素数组', eq(asArray(WB), [WB]),
    JSON.stringify(asArray(WB)));
  ok('单条目对象（事件）', eq(asArray(EV), [EV]), JSON.stringify(asArray(EV)));
  ok('单条目对象（中文键）', eq(asArray({ 名称: '云京', 正文: '都城' }).length, 1));

  ok('JSON 字符串数组', eq(asArray('[1,2]'), [1, 2]));
  ok('分隔符字符串', eq(asArray('甲、乙\n丙'), ['甲', '乙', '丙']));
  ok('null / undefined → []', eq(asArray(null), []) && eq(asArray(undefined), []));
  ok('数字 → []', eq(asArray(42), []));
  ok('空对象 → []', eq(asArray({}), []));
  ok('空字符串 → []', eq(asArray(''), []));
  ok('返回值永远是数组', [null, 0, 'x', {}, [], { a: 1 }].every(v => Array.isArray(asArray(v))));
}

// ============================================================
console.log('\n【2】世界观条目：容器形态 + 字段名归一化');
{
  const content = '云京为王朝都城，分内外两城，水系环绕。';
  const CASES = [
    ['裸数组', [{ category: 'map_world', name: '云京', keys: ['云京'], content }]],
    ['包在 worldbook 里', { worldbook: [{ category: 'map_world', name: '云京', keys: ['云京'], content }] }],
    ['包在中文键里', { 世界观: [{ category: 'map_world', name: '云京', keys: ['云京'], content }] }],
    ['中文键名', [{ 分类: 'map_world', 名称: '云京', 关键词: ['云京'], 正文: content }]],
    ['中文分类值', [{ category: '世界观', name: '云京', keys: ['云京'], content }]],
    ['单对象', { category: 'map_world', name: '云京', keys: ['云京'], content }],
    ['JSON 字符串', JSON.stringify([{ category: 'map_world', name: '云京', keys: ['云京'], content }])],
  ];
  for (const [label, input] of CASES) {
    const r = normalizeWorldbookItems(input);
    ok(`形态「${label}」能抽到 1 条`, r.length === 1 && r[0].category === 'map_world',
      `${r.length} 条 / dropped=${JSON.stringify(r.dropped)}`);
  }
  ok('keys 缺失时用条目名兜底',
    normalizeWorldbookItems([{ category: 'map_world', name: '云京', content }])[0].keys.length === 1);
  ok('中文分类值被映射成规范名',
    normalizeWorldbookItems([{ category: '势力', name: '清微宗', content: '青芜州三大宗门之一，以药理闻名。' }])[0]
      ?.category === 'system_faction');
  ok('分类非法时把实际键名带进剔除原因（便于诊断）', (() => {
    const r = normalizeWorldbookItems([{ 未知键: 1, 别的: 2 }]);
    return r.dropped.some(d => d.includes('键名'));
  })(), JSON.stringify(normalizeWorldbookItems([{ foo: 1 }]).dropped));
  ok('null 安全', normalizeWorldbookItems(null).length === 0);
}

// ============================================================
console.log('\n【3】事件条目：字段名与压力值归一化');
{
  ok('标准形态', dedupeEvents([{ name: '开篇', storyline: '线', pressure: 'core' }]).length === 1);
  ok('中文键名可识别', (() => {
    const r = dedupeEvents([{ 事件名: '开篇', 故事线: '线', 压力: '核', 原著: 'c' }]);
    return r.length === 1 && r[0].name === '开篇' && r[0].storyline === '线' && r[0].pressure === 'core';
  })(), JSON.stringify(dedupeEvents([{ 事件名: '开篇', 压力: '核' }])));
  ok('包在对象里可识别', dedupeEvents({ events: [{ name: '开篇' }] }).length === 1);
  ok('缺 name 的条目被丢弃', dedupeEvents([{ storyline: '线' }]).length === 0);
  ok('中文压力值映射', (() => {
    const r = dedupeEvents([{ name: 'A', 压力: '缓' }, { name: 'B', 压力: '弹' }, { name: 'C', 压力: '核心' }]);
    return eq(r.map(e => e.pressure), ['buffer', 'flexible', 'core']);
  })(), JSON.stringify(dedupeEvents([{ name: 'A', 压力: '缓' }]).map(e => e.pressure)));
  ok('缺 storyline 时归入主线', dedupeEvents([{ name: 'A' }])[0].storyline === '主线');
  ok('同名事件去重', dedupeEvents([{ name: 'A' }, { name: 'A' }]).length === 1);
  ok('interventions 是单值字符串时被规整成数组',
    eq(dedupeEvents([{ name: 'A', interventions: 'x' }])[0].interventions, ['x']),
    JSON.stringify(dedupeEvents([{ name: 'A', interventions: 'x' }])[0].interventions));
  ok('interventions 缺失时为 []', eq(dedupeEvents([{ name: 'A' }])[0].interventions, []));
}

// ============================================================
console.log('\n【4】变量树兜底：不允许空命名空间');
{
  const tl = { base: '相对纪元', origin: { event: '开场' }, events: [], characters: [] };
  const chars = [{ name: '林昭', role: '主角' }];

  const empty = buildVariables(tl, [], {}, chars, []);
  console.log('   事件全空时：', JSON.stringify(empty.events));
  ok('events 不为空（放占位事件）', Object.keys(empty.events).length >= 1, JSON.stringify(empty.events));
  ok('占位事件状态是 ongoing（让导演指令能推进）',
    Object.values(empty.events)[0].status === 'ongoing', JSON.stringify(empty.events));
  /**
   * 故事线**已搬出变量树**（改为世界书 `[storyline]` 条目）：
   * `stage` 是 groupByStoryline 里硬编码的 '起点'，没有任何代码消费它。
   * 所以这里断言"变量树里**没有** custom.storylines"，
   * 并另外验证同样的数据能生成世界书条目（防止搬丢了）。
   */
  ok('变量树里不再有 custom.storylines',
    !empty.custom || !('storylines' in empty.custom),
    JSON.stringify(Object.keys(empty.custom || {})));

  // 有数据时不引入占位
  const full = buildVariables(tl, [{ name: '开篇', pressure: 'core' }], { 线: { events: ['开篇'] } }, chars, []);
  ok('有事件时不插占位事件', !('开场' in full.events), JSON.stringify(Object.keys(full.events)));

  // 故事线搬进世界书后必须仍可生成条目（搬走 ≠ 丢掉）
  {
    const wb = assembleWorldbook(tl, [{ name: '开篇', pressure: 'core' }], chars, [], {
      title: 'T', storylines: { 线: { events: ['开篇'], core: true } },
    });
    const sl = wb.entries.filter(e => String(e.comment).startsWith('[storyline]'));
    ok('故事线生成世界书条目', sl.length === 1, JSON.stringify(wb.entries.map(e => e.comment)));
    ok('故事线条目按线触发', sl[0] && sl[0].keys.includes('线') && sl[0].keys.includes('开篇'),
      JSON.stringify(sl[0]?.keys));
    ok('故事线条目不常驻（省每轮预算）', sl[0] && sl[0].constant === false, String(sl[0]?.constant));
  }

  /**
   * A 包常驻预算必须**真的被裁剪**，不能只发警告。
   *
   * 实测：《示例小说 A》产出 4 条语义重叠的 `system_realm`
   * （「修仙境界体系」「修行境界与灵根体系」「灵根资质」「修仙境界与灵根资质」），
   * 而它们都被 `category === 'system_realm'` 判成常驻 ——
   * 合计 1803 tok，把 A 包顶到 3510 tok（上限 2000，超 75%）。
   * `validate()` 只 `warnings.push`，超支原样进了卡。
   */
  {
    const big = (label, n) => ({ category: 'system_realm', name: label, content: '境界说明。'.repeat(n), keys: [label] });
    const many = [
      { category: 'map_world', name: '大陆', content: '世界概览。'.repeat(60), keys: ['大陆'] },
      big('修仙境界体系', 80),
      big('修行境界与灵根体系', 80),
      big('灵根资质', 70),
      big('修仙境界与灵根资质', 70),
    ];
    const wb2 = assembleWorldbook(tl, [{ name: '开篇', pressure: 'core' }], chars, many, {
      title: 'T', synopsis: '简介内容。'.repeat(50),
    });
    const cons = wb2.entries.filter(e => e.constant);
    const aTok = estimateTokens(cons.map(e => e.content).join(''));
    ok('同类常驻只留一条（system_realm）',
      cons.filter(e => e.extensions?.group === 'system_realm').length === 1,
      JSON.stringify(cons.map(e => e.comment)));
    ok('常驻总量被裁到预算内（2000）', aTok <= 2000, `${aTok} tok`);
    ok('裁剪保留世界概览 / 时间线 / 简介',
      ['map_world', 'timeline', 'synopsis'].every(g => cons.some(e => e.extensions?.group === g)),
      JSON.stringify(cons.map(e => e.comment)));
    // 降级的条目必须有 keys，否则永远触发不了（内容等于丢了）
    const demoted = wb2.entries.filter(e => !e.constant && e.extensions?.group === 'system_realm');
    ok('降级的常驻条目仍带 keys（内容不丢）',
      demoted.length > 0 && demoted.every(e => Array.isArray(e.keys) && e.keys.length > 0),
      JSON.stringify(demoted.map(e => ({ c: e.comment, k: e.keys }))));
    ok('内容条数不因裁剪而减少',
      wb2.entries.filter(e => e.extensions?.group === 'system_realm').length === 4,
      String(wb2.entries.filter(e => e.extensions?.group === 'system_realm').length));
  }

  // 初始必须有一个 ongoing 事件：否则「导演指令」的 find(status==='ongoing')
  // 取不到东西，【正在发生】一开始就是空的，只能等 AI 某轮自己改状态
  const multi = buildVariables(tl,
    [{ name: '开篇入城', pressure: 'core' }, { name: '初见沈砚', pressure: 'buffer' }],
    { 入城立足: { events: ['开篇入城', '初见沈砚'] } }, chars, []);
  const ongoing = Object.entries(multi.events).filter(([, v]) => v.status === 'ongoing').map(([k]) => k);
  console.log('   ongoing 事件：', JSON.stringify(ongoing));
  ok('恰好一个事件是 ongoing', ongoing.length === 1, JSON.stringify(ongoing));
  ok('ongoing 的是叙事顺序上的第一个', ongoing[0] === '开篇入城', ongoing[0]);
  ok('其余事件是 pending', multi.events['初见沈砚'].status === 'pending');
  ok('占位事件也应是 ongoing（让导演指令能用）', empty.events['开场'].status === 'ongoing');

  // 变量树必须能序列化成合法 YAML（initvar 直接用它）
  let yerr = null;
  try { YAML.parse(YAML.stringify(empty)); } catch (e) { yerr = e; }
  ok('兜底后的变量树能序列化成合法 YAML', !yerr, yerr?.message);
  // custom 现在留空（故事线已搬进世界书）——允许缺省或空对象，但核心三段必须在
  ok('兜底后的变量树含核心段（world / events / characters）',
    ['world', 'events', 'characters'].every(k => k in empty),
    JSON.stringify(Object.keys(empty)));
}

// ============================================================
console.log('\n【5】时间线兜底：不输出无信息量的占位');
{
  // formatTimeline 没导出，通过 assembleCharacterCard 走端到端
  const { assembleCharacterCard } = P;
  const mk = (timeline) => assembleCharacterCard({
    timeline, events: [], characters: [], variables: {}, phasesWithDeltas: [],
    userMode: { mode: 'protagonist', protagonistName: '甲' },
    cardFields: { name: '测试' }, worldbook: [], worldbookName: '测试集',
  }).data.character_book.entries.find(e => e.comment === '[timeline]').content;

  const emptyTl = mk({ base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城' }, events: [], characters: [] });
  console.log('   事件为空时的 [timeline]：');
  console.log(emptyTl.split('\n').map(l => '     ' + l).join('\n'));
  ok('不含"按事件清单顺序推进"这种占位',
    !/按事件清单顺序推进/.test(emptyTl), emptyTl);
  ok('给出了实际可用的说明', /【说明】/.test(emptyTl), emptyTl);
  ok('保留了可参照的时间锚点', /天启三年春/.test(emptyTl), emptyTl);
  ok('给出了推进纪律（不要假定时间跳跃）', /时间跳跃/.test(emptyTl), emptyTl);

  // 有事件时走正常分支
  const fullTl = mk({
    base: '天启纪年', origin: { event: '开篇入城' },
    events: [{ name: '开篇入城', time: '天启三年春', chapter: '第一章' }], characters: [],
  });
  ok('有事件时正常输出事件时间线', /【事件时间线】/.test(fullTl) && /开篇入城/.test(fullTl), fullTl);
  ok('有事件时不输出【说明】分支', !/【说明】/.test(fullTl), fullTl);
}

// ============================================================
console.log('\n【6】世界观兜底：至少要有一条 map_world');
{
  const tl = { base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城' } };
  const events = [{ name: '开篇入城', chapter: '第一章', storyline: '入城立足' }];
  const text = '天启三年春，林昭独自一人来到云京。她握紧了袖中的半块玉佩，那是兄长留下的唯一信物。'
    + '街市两侧的灯笼刚刚点亮，卖汤饼的摊子冒着白气。'.repeat(4);

  const fb = fallbackWorldbook(tl, events, '云京旧案', [{ name: '入城立足' }], text);
  console.log('   兜底分类：', JSON.stringify(fb.map(f => f.category)));
  ok('至少有一条 map_world', fb.some(f => f.category === 'map_world'),
    JSON.stringify(fb.map(f => f.category)));
  const mw = fb.find(f => f.category === 'map_world');
  ok('map_world 有实质内容（不只是占位）', (mw?.content || '').length >= 40, String(mw?.content?.length));
  ok('map_world 取自原文摘录（不是编造）', (mw?.content || '').includes('天启三年春'), mw?.content?.slice(0, 60));
  ok('map_world 有 keys', (mw?.keys || []).length >= 1, JSON.stringify(mw?.keys));
  ok('map_world 是常驻条目', mw?.constant === true);
  // 兜底正文允许说明"未抽到明确设定"这一事实（它是给模型看的上下文），
  // 但不允许整条内容就是一句占位空话。判据：必须有实质信息且长度足够。
  const allContent = fb.map(f => f.content).join('\n');
  ok('兜底正文有实质信息（长度 + 原文摘录）',
    allContent.length >= 80 && allContent.includes('天启三年春'), String(allContent.length));
  ok('兜底正文不是纯占位空话',
    !/^(原文未(提及|说明)|暂无|待补充|未知)[。.]?$/.test(allContent.trim()), allContent.slice(0, 60));

  // 数据不足时不硬凑
  ok('无原文且无结构信息时返回空数组',
    fallbackWorldbook({ base: '相对纪元', origin: {} }, [], null, [], '').length === 0);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  抽取健壮性测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
