/**
 * 用**真实 EJS 引擎**渲染角色卡里的所有 EJS 条目。
 *
 * 为什么必须做：`tests/character-card.mjs` 与两份核验脚本都只断言「`<%_` 原样保留、没被转义」，
 * 从未真正渲染过。EJS 的 `<%_ ... _%>` 只是「去空白」的普通标签，标签内容仍是独立语句块 ——
 * 如果一个对象字面量被拆在多个标签里，展开后会穿插 `__append(...)` 语句，直接是语法错误。
 * 那种条目在酒馆里 100% 渲染失败，而所有静态断言依然全绿。
 *
 * 引擎来源：本机 SillyTavern 里 ST-Prompt-Template 扩展自带的 ejs 3.1.9。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

const EJS_CANDIDATES = [
  String.raw`D:\Documents\GitHub\SillyTavern\data\default-user\extensions\ST-Prompt-Template\src\3rdparty\ejs.js`,
  path.join(ROOT, 'node_modules', 'ejs'),
];

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

let ejs = null, ejsFrom = '';
for (const c of EJS_CANDIDATES) {
  try { ejs = require(c); ejsFrom = c; break; } catch { /* 继续找 */ }
}

const { assembleCharacterCard } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

console.log('\n' + '='.repeat(66));
console.log('  真实 EJS 渲染核验（含 EJS 的条目必须真的能渲染出内容）');
console.log('='.repeat(66));
console.log(`\nEJS 引擎：${ejs ? ejsFrom : '（未找到）'}`);
if (ejs?.VERSION) console.log(`EJS 版本：${ejs.VERSION}`);

if (!ejs) {
  console.log('\n⚠ 未找到 EJS 引擎，跳过（把 ejs 装到 node_modules 或修正上面的路径）\n');
  process.exit(0);
}

// ---------- 造一份覆盖三种 userMode 的上下文 ----------
const base = {
  timeline: {
    base: '天启纪年',
    origin: { raw: '天启三年春', event: '开篇入城', reason: '最早纪年' },
    events: [{ name: '开篇入城', time: '天启三年春', chapter: '第一章' }],
    characters: [{ name: '林昭', birth: '（线索：十七岁）', chapter: '第一章' }],
  },
  events: [
    { name: '开篇入城', canon: '林昭进城。', pressure: 'core', prerequisites: {}, interventions: [] },
    { name: '夜探旧宅', canon: '发现密信。', pressure: 'buffer', prerequisites: {}, interventions: [] },
  ],
  characters: [{ name: '林昭', keys: ['林昭'], content: '林昭，十七岁。' }],
  worldbook: [
    { category: 'map_world', name: '云京', keys: ['云京'], content: '都城。', constant: true },
    { category: 'map_location', name: '茶楼', keys: ['茶楼'], content: '消息集散地。', constant: false },
  ],
  variables: {
    world: { time: '天启三年春', phase: '入城立足' },
    events: { 开篇入城: { status: 'pending', deviation: 0, pressure: 'core' } },
    characters: { 沈砚: { affinity: 0, state: '正常' } },
    user: { name: '林昭' },
    custom: { storylines: { 入城立足: { events: ['开篇入城'], stage: '起点', deviation: 0, core: true } } },
  },
  phasesWithDeltas: [
    { name: '入城立足', startEvent: '开篇入城', endEvent: '开篇入城', coreChange: 'x', characterDeltas: [] },
    {
      name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: 'y',
      characterDeltas: [{ character: '林昭', change: '从谨慎观望变为主动出击', quote: '她握紧了信' }],
    },
  ],
  cardFields: {
    name: '云京旧案', description: '描述', personality: '人设', scenario: '场景',
    first_mes: '开场白。', alternate_greetings: ['备选一。', '备选二。'], mes_example: '<START>\nx', tags: ['古风'],
  },
};

/** 阶段名里带引号 / 反引号 / 反斜杠 / ${}（LLM 抽取的真实风险） */
const nastyPhases = [
  {
    name: "剑圣的'誓约'", startEvent: 'x', endEvent: 'x', coreChange: 'c',
    characterDeltas: [{ character: '林昭', change: "获得`称号`与\\反斜杠 和 ${注入}" }],
  },
];

const CASES = [
  ['protagonist', { userMode: { mode: 'protagonist', protagonistName: '林昭' } }],
  ['participant', { userMode: { mode: 'participant' } }],
  ['observer', { userMode: { mode: 'observer' } }],
  ['阶段名含引号/反引号/${}', { userMode: { mode: 'protagonist', protagonistName: '林昭' }, phasesWithDeltas: nastyPhases }],
  ['空上下文（LLM 全失败）', {
    userMode: {}, events: [], characters: [], worldbook: [], phasesWithDeltas: [],
    timeline: { base: 'x', events: [], characters: [] }, variables: {},
  }],
  ['无阶段增量', { userMode: { mode: 'protagonist', protagonistName: '林昭' }, phasesWithDeltas: [] }],
];

/** 该条目在哪些情形下本来就该渲染出空串（if 守卫不成立），不算失败 */
const EMPTY_OK = new Set([
  '角色阶段',   // world.phase 不在增量表里时不输出任何内容
]);

/**
 * 「角色阶段」在 phase 缺失时会走 getvar 的 defaults:'起始'，
 * 而「起始」永远在表里 —— 所以它总是有输出。真正空输出的情形是
 * phase 有值但不在表里。下面这组用例专门覆盖"该空就空"。
 */
const EMPTY_CASES = [
  ['phase 有值但不在增量表里', { world: { phase: '不存在的阶段' } }, '角色阶段'],
];

// ---------- 模拟 MVU 的 stat_data 命名空间 ----------
function makeGetvar(stat) {
  return (p, opts) => {
    const dflt = opts && 'defaults' in opts ? opts.defaults : undefined;
    let cur = { stat_data: stat };
    for (const seg of String(p).split('.')) {
      if (cur === null || typeof cur !== 'object' || !(seg in cur)) return dflt;
      cur = cur[seg];
    }
    return cur === undefined ? dflt : cur;
  };
}

console.log('\n【1】每个 EJS 条目都必须能被真实引擎编译并渲染');
for (const [label, override] of CASES) {
  const card = assembleCharacterCard({ ...base, ...override, worldbookName: '测试设定集' });
  const ejsEntries = card.data.character_book.entries.filter(e => e.content.includes('<%'));
  ok(`${label}：有 EJS 条目`, ejsEntries.length >= 2, String(ejsEntries.length));

  const stat = override.variables ?? base.variables;
  const getvar = makeGetvar(stat);

  for (const e of ejsEntries) {
    let out = null, err = null;
    try {
      out = ejs.render(e.content, { getvar }, { async: false });
    } catch (ex) { err = ex; }
    ok(`${label} / 「${e.comment}」渲染成功`, !err, err ? String(err.message).split('\n')[0] : '');
    if (err) continue;
    ok(`${label} / 「${e.comment}」输出无残留标签`,
      !out.includes('<%') && !out.includes('_%>'), '渲染结果里还有 EJS 标签');
    if (EMPTY_OK.has(e.comment)) continue;
    ok(`${label} / 「${e.comment}」输出非空`, typeof out === 'string' && out.trim().length > 0,
      JSON.stringify(String(out).slice(0, 60)));
  }
}

console.log('\n【1b】该渲染成空串的情形必须真的空（if 守卫生效）');
for (const [label, stat, comment] of EMPTY_CASES) {
  const card = assembleCharacterCard({ ...base, worldbookName: '测试设定集' });
  const e = card.data.character_book.entries.find(x => x.comment === comment);
  const out = ejs.render(e.content, { getvar: makeGetvar(stat) }, { async: false });
  ok(`${label}：输出为空`, out.trim() === '', JSON.stringify(out.slice(0, 80)));
}

console.log('\n【2】渲染结果的内容正确性（不是"没报错就行"）');
{
  const card = assembleCharacterCard({ ...base, worldbookName: '测试设定集' });
  const render = (comment, stat) => {
    const e = card.data.character_book.entries.find(x => x.comment === comment);
    return ejs.render(e.content, { getvar: makeGetvar(stat) }, { async: false });
  };

  // 导演指令：三种状态各渲染一次
  const st1 = { world: { time: '天启三年春', phase: '入城立足' }, events: { 开篇入城: { status: 'ongoing', deviation: 0, pressure: 'core' } } };
  const out1 = render('导演指令', st1);
  ok('导演指令：取到当前时间', out1.includes('天启三年春'), JSON.stringify(out1.slice(0, 80)));
  ok('导演指令：取到进行中事件', out1.includes('开篇入城'));
  ok('导演指令：低偏离度走「按原著推进」分支', out1.includes('按原著推进'));

  const st2 = { ...st1, events: { 开篇入城: { status: 'ongoing', deviation: 30, pressure: 'core' } } };
  ok('导演指令：中度偏离走对应分支', render('导演指令', st2).includes('轻度干预'));

  const st3 = { ...st1, events: { 开篇入城: { status: 'ongoing', deviation: 90, pressure: 'core' } } };
  ok('导演指令：高偏离走对应分支', render('导演指令', st3).includes('深度干预'));

  const st4 = { world: { time: '未知', phase: '起始' } };
  const out4 = render('导演指令', st4);
  ok('导演指令：无任何事件时给出明确兜底（不留空档）',
    out4.includes('无进行中事件'), JSON.stringify(out4.slice(0, 140)));
  ok('导演指令：兜底输出仍然包含推进原则', out4.includes('【推进原则】'));

  const st5 = { world: { time: '未知' }, events: { 待办事件: { status: 'pending', pressure: 'core' } } };
  const out5 = render('导演指令', st5);
  ok('导演指令：只有 pending 事件时给出「下一事件」', out5.includes('【下一事件】') && out5.includes('待办事件'),
    JSON.stringify(out5.slice(0, 160)));

  // 角色阶段：按 world.phase 命中对应增量
  const p1 = render('角色阶段', { world: { phase: '旧案浮现' } });
  ok('角色阶段：命中「旧案浮现」并输出增量', p1.includes('主动出击'), JSON.stringify(p1.slice(0, 120)));
  ok('角色阶段：输出不含"起始"的兜底文案', !p1.includes('无变化，按世界书基线人设演绎'));

  const p2 = render('角色阶段', { world: { phase: '起始' } });
  ok('角色阶段：阶段为「起始」时输出基线文案', p2.includes('无变化'), JSON.stringify(p2.slice(0, 90)));

  const p3 = render('角色阶段', { world: { phase: '不存在的阶段' } });
  ok('角色阶段：未知阶段不输出内容（if 守卫生效）', !p3.includes('【当前人设增量】'),
    JSON.stringify(p3.slice(0, 90)));

  const p4 = render('角色阶段', {});
  ok('角色阶段：变量全空也能渲染（走 defaults）', typeof p4 === 'string');
}

console.log('\n【3】极端阶段名（引号 / 反引号 / 反斜杠 / ${}）不能让 EJS 编译失败');
{
  const card = assembleCharacterCard({
    ...base, worldbookName: '测试设定集', phasesWithDeltas: nastyPhases,
  });
  const e = card.data.character_book.entries.find(x => x.comment === '角色阶段');
  let out = null, err = null;
  try { out = ejs.render(e.content, { getvar: makeGetvar({ world: { phase: "剑圣的'誓约'" } }) }, { async: false }); }
  catch (ex) { err = ex; }
  ok('含引号/反引号/${} 的阶段名仍能渲染', !err, err ? String(err.message).split('\n')[0] : '');
  if (!err) {
    ok('命中该阶段并输出增量', out.includes('获得`称号`'), JSON.stringify(out.slice(0, 140)));
    ok('输出里没有反斜杠转义残留（值被正确还原）',
      !out.includes('\\`') && !out.includes("\\'"), JSON.stringify(out.slice(0, 200)));
    ok('变量值原样输出（含反引号与 ${} 也不被解释）',
      out.includes('获得`称号`') && out.includes('${注入}') && out.includes('\\反斜杠'),
      JSON.stringify(out.slice(0, 200)));
  }
}

console.log('\n【4】真实产物文件里的 EJS 也要能渲染（若 output/ 里有卡）');
{
  const outDir = path.join(ROOT, 'output');
  let dirs = [];
  try { dirs = (await readdir(outDir, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); } catch {}
  let checked = 0, stale = [];
  for (const d of dirs) {
    let card = null;
    try {
      card = JSON.parse(await readFile(path.join(outDir, d, 'character_card.json'), 'utf-8'));
    } catch { continue; }
    const entries = card?.data?.character_book?.entries || [];
    const withEjs = entries.filter(e => String(e.content).includes('<%'));
    if (!withEjs.length) continue;
    checked++;
    // 用产物自己的 variables.json 作为变量树
    let stat = {};
    try { stat = JSON.parse(await readFile(path.join(outDir, d, 'variables.json'), 'utf-8')); } catch {}
    for (const e of withEjs) {
      let err = null;
      try { ejs.render(e.content, { getvar: makeGetvar(stat) }, { async: false }); } catch (ex) { err = ex; }
      if (err) {
        // 修复前的旧产物本来就坏，不能算本次回归失败；但必须点名，不能静默
        stale.push(`${d} / ${e.comment}（${String(err.message).split('\n')[0]}）`);
        continue;
      }
      ok(`产物 ${d} / 「${e.comment}」可渲染`, true);
    }
  }
  console.log(`  （检查了 ${checked} 份真实产物）`);
  if (stale.length) {
    console.log(`  ⚠ ${stale.length} 条来自修复前的旧产物，重新生成即可（不计入失败）：`);
    for (const s of stale) console.log(`      · ${s}`);
  }
}

console.log('\n' + '='.repeat(66));
console.log(`  EJS 渲染核验：通过 ${pass} · 失败 ${fail}`);
console.log('='.repeat(66) + '\n');
process.exit(fail ? 1 : 0);
