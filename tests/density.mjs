/**
 * 内容密度测试。
 *
 * 背景：用户反馈"描述信息太少不够详细" —— 角色条目 150-400 字光外貌+背景+性格就写满了、
 * 地点条目没有气候/人口/资源维度、事件条目只有时间+原著+压力。
 *
 * 改动：Step 5 的 prompt 改成输出结构化 YAML（content_yaml），四类条目各有模板；
 * 同时给 key 触发条目单独的预算（单条 2200 / 单轮峰值 6000 token）。
 *
 * 这个套件钉住 prompt 契约与正文解析契约 —— prompt 被改瘦了会立刻失败。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x ?? ''}`); } };

const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);
const P = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const { pickContent, isPlaceholderBody, inspectContentYaml, normalizeWorldbookItems, assembleCharacterCard } = P;

// ============================================================
console.log('【1】四类 Prompt 都要求 content_yaml 与各自模板字段');
{
  const CONTRACTS = [
    ['STEP_5_CHARACTER', [
      'content_yaml', 'appearance', 'clothing', 'background', 'personality',
      'preferences', 'special_notes', '言行举止', '不少于 100 字', '600-1500 字',
    ]],
    ['STEP_5_WORLDBOOK', [
      'content_yaml', '地理特征', '气候环境', '人口与阶层', '资源与产出',
      '文化与习俗', '重要地标', '控制势力', '当前局势', '层级或构成', '与主线关联',
    ]],
    ['STEP_5_EVENT', [
      'content_yaml', '起因', '经过', '结果', '影响', '原著立场', '前置', '干预可能', '不少于 100 字',
    ]],
    ['STEP_5_ITEM', [
      'content_yaml', '外观', '原理', '效果', '限制/代价', '来源', '持有者/掌握者', '等级/品质',
    ]],
  ];
  for (const [name, needles] of CONTRACTS) {
    const text = String(S[name] || '');
    ok(`${name} 存在`, text.length > 300, `${text.length} 字`);
    const missing = needles.filter(n => !text.includes(n));
    ok(`${name} 含全部模板字段`, missing.length === 0, `缺 ${JSON.stringify(missing)}`);
  }
  // 四类都要有"不要编造"的约束
  for (const name of ['STEP_5_CHARACTER', 'STEP_5_WORLDBOOK', 'STEP_5_EVENT', 'STEP_5_ITEM']) {
    ok(`${name} 含防编造约束`,
      /禁止瞎编|禁止编造|不要编造|来自原文|未提及/.test(String(S[name])),
      '缺少"内容必须来自原文"的约束');
  }
  ok('角色模板含 R18 字段占位（未提及）',
    S.STEP_5_CHARACTER.includes('erotic_abilities') && S.STEP_5_CHARACTER.includes('私处细节描写'));
  ok('世界观模板区分地图类与设定类',
    S.STEP_5_WORLDBOOK.includes('地图类') && S.STEP_5_WORLDBOOK.includes('设定类'));
}

// ============================================================
console.log('\n【2】正文键名兼容：content_yaml / content / 中文键都要能读');
{
  const YAML_BODY = 'name: 甲\nappearance: |\n  详细外貌描写，超过十个字的内容在这里。\nbackground: |\n  出身与经历，同样超过十个字。';
  ok('content_yaml 优先', pickContent({ content_yaml: YAML_BODY }) === YAML_BODY);
  ok('content 兼容（旧格式）', pickContent({ content: '一段普通正文' }) === '一段普通正文');
  ok('中文键 正文 兼容', pickContent({ 正文: '中文键正文' }) === '中文键正文');
  ok('中文键 内容 兼容', pickContent({ 内容: '中文键内容' }) === '中文键内容');
  ok('content_yaml 优先于 content',
    pickContent({ content_yaml: 'A', content: 'B' }) === 'A');
  ok('对象形态的 YAML 被序列化成字符串', (() => {
    const r = pickContent({ content_yaml: { name: '甲', appearance: '描述' } });
    return typeof r === 'string' && r.includes('name: 甲');
  })());
  ok('空对象返回空串', pickContent({}) === '' && pickContent(null) === '');
  ok('返回的永远是字符串',
    [pickContent({ content_yaml: YAML_BODY }), pickContent({ content: 'x' }), pickContent({})]
      .every(v => typeof v === 'string'));
}

// ============================================================
console.log('\n【3】占位符判定：整条空话要拦，单字段"未提及"要放行');
{
  const rich = [
    'name: 甲',
    'title: 乙',
    'appearance: |',
    '  这是一段足够长的外貌描写，用来表示确实有内容。',
    'erotic_abilities: |',
    '  未提及',
    '私处细节描写: |',
    '  未提及',
  ].join('\n');
  ok('含未提及字段但整体有内容 → 放行', !isPlaceholderBody(rich), '被误判为占位符');

  ok('整条就是一句未提及 → 拦', isPlaceholderBody('原文未提及'));
  ok('全文都是"未提及"字段 → 拦', isPlaceholderBody('name: 甲\nappearance: |\n  未提及\nbackground: |\n  未提及'));
  ok('空串 → 拦', isPlaceholderBody('') && isPlaceholderBody(null));
  ok('过短 → 拦', isPlaceholderBody('太短'));
  ok('普通长文本 → 放行', !isPlaceholderBody('【事件·开篇】\n时间：天启三年春\n原著：林昭入城，寻找失踪的兄长。'));
}

// ============================================================
console.log('\n【4】密度诊断：字段数与实质字数');
{
  const yaml = [
    'name: 苏青梧', 'title: 外门弟子', 'age: 十六岁',
    'appearance: |', '  乌黑长发以木簪束起，肤色是常年日晒后的浅麦色。',
    'background: |', '  出身青芜州乡野，父母早亡，由舅父抚养长大。',
    'erotic_abilities: |', '  未提及',
  ].join('\n');
  const r = inspectContentYaml(yaml);
  ok('统计到字段', r.keyCount >= 6, String(r.keyCount));
  ok('字段名被正确提取', r.keys.includes('appearance') && r.keys.includes('name'),
    JSON.stringify(r.keys));
  // 实质字数不该把 YAML 标点算进去：去掉标点后的字数应小于原文长度
  ok('实质字数排除 YAML 标点', r.chars > 30 && r.chars < yaml.length, `${r.chars} / ${yaml.length}`);
  ok('普通文本也能统计（不至于抛错）', inspectContentYaml('就是一段话').keyCount === 0);
}

// ============================================================
console.log('\n【5】世界观条目吃 content_yaml');
{
  const body = 'name: 云京\ntype: 世界\n地理特征: |\n  四面环山，中央是冲积平原，气候四季分明。\n当前局势: |\n  十年前一场大火烧毁半条长街，官方称走水。';
  const items = normalizeWorldbookItems([
    { category: 'map_world', name: '云京', keys: ['云京'], content_yaml: body },
  ]);
  ok('content_yaml 被读成 content', items.length === 1 && items[0].content === body,
    JSON.stringify(items[0]?.content?.slice(0, 40)));
  ok('包裹形态也能读', normalizeWorldbookItems({ worldbook: [{ category: 'map_world', name: '云京', content_yaml: body }] }).length === 1);
  ok('中文键名 + content_yaml 组合', normalizeWorldbookItems([
    { 分类: 'map_world', 名称: '云京', 关键词: ['云京'], content_yaml: body },
  ]).length === 1);
}

// ============================================================
console.log('\n【6】事件条目：完整正文优先，缺失时回退简洁格式');
{
  const base = {
    timeline: { base: '天启纪年', origin: { event: '开篇入城' }, events: [], characters: [] },
    events: [{ name: '开篇入城', time: '天启三年春', canon: '林昭入城。', pressure: 'core' }],
    characters: [], variables: {}, phasesWithDeltas: [],
    userMode: { mode: 'protagonist', protagonistName: '林昭' },
    cardFields: { name: '测试' }, worldbook: [], worldbookName: '测试集',
  };
  const RICH = 'name: 开篇入城\n起因: |\n  她在寻找失踪的兄长。\n经过: |\n  她进了城，先找落脚处。\n结果: |\n  住进客栈。';

  const withRich = assembleCharacterCard({ ...base, eventContents: new Map([['开篇入城', RICH]]) });
  const ev1 = withRich.data.character_book.entries.find(e => e.comment === '[event] 开篇入城');
  ok('有完整正文时用它', ev1.content === RICH, ev1.content.slice(0, 50));

  const noRich = assembleCharacterCard(base);
  const ev2 = noRich.data.character_book.entries.find(e => e.comment === '[event] 开篇入城');
  ok('没有完整正文时回退简洁格式', /【事件·开篇入城】/.test(ev2.content), ev2.content.slice(0, 40));
  ok('回退格式仍含时间与压力', ev2.content.includes('天启三年春') && ev2.content.includes('核'));

  // 完整正文必须是合法 YAML（前端按 YAML 展示）
  ok('完整正文可被 YAML 解析', (() => {
    try { return !!YAML.parse(ev1.content); } catch { return false; }
  })());
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  内容密度测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
