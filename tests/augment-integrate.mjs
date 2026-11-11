/**
 * 完善卡「人设整合」测试（P3）
 *
 * 背景：augment 原来的合并是**纯文本追加** —— 新剧情的人设变化以
 * 「【新增内容】」追加到条目末尾，于是"关系变了 / 身份变了"这种变化会前后矛盾地并存。
 *
 * 新行为：对"匹配到的已有人物条目"各跑一次整合调用（旧设定 + 新信息 → 更新后的完整设定），
 * 冲突以新剧情为准；默认开启，可用 integrateCharacters:false 关掉。
 *
 * 这里钉住：
 *   ① 默认开启：条目被整合（不再出现【新增内容】标记，含新信息）
 *   ② 关闭：保持原来的追加合并
 *   ③ 整合失败：不中断任务，保留追加结果
 *   ④ append 策略不动已有条目，也就不会整合
 *   ⑤ 报告里有 integrated / integrateSkipped
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const A = await import(pathToFileURL(path.join(ROOT, 'src/augment.js')).href);
const { assembleCharacterCard } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

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
      { name: '林昭', keys: ['林昭', '阿昭'], content: 'name: 林昭\nidentity: 学生\nrelations: 与李四是同学' },
    ],
    variables: { world: { time: '天启三年春' }, events: {}, characters: {}, custom: {} },
    phasesWithDeltas: [{
      name: '入城立足', startEvent: '开篇入城', endEvent: '开篇入城', coreChange: 'x',
      characterDeltas: [{ character: '林昭', change: '从学生变为官员' }],
    }],
    userMode: { mode: 'protagonist', protagonistName: '林昭' },
    cardFields: {
      name: '云京旧案', description: '描述', personality: '人设', scenario: '场景',
      first_mes: '开场白。', alternate_greetings: ['备选一。'], mes_example: '<START>\nx', tags: ['古风'],
    },
    worldbook: [{ category: 'map_world', name: '云京', keys: ['云京'], content: '云京为王朝都城。', constant: true }],
    worldbookName: '云京旧案设定集',
  });
}

/** 假 LLM：按 prompt 开头分派；`integrateMode` 控制整合调用的行为 */
function makeMockFetch({ integrateMode = 'ok' } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
    calls.push({ sys, kind: classify(sys) });

    let out = {};
    const k = classify(sys);
    if (k === 'events') out = [{ name: '入城任官', canon: '林昭入城后任官。', pressure: 'buffer' }];
    else if (k === 'phases') out = { phases: [{ name: '任官', coreChange: '身份变化' }] };
    else if (k === 'deltas') out = { deltas: [{ character: '林昭', change: '身份从学生变为官员' }] };
    else if (k === 'worldbook') out = { worldbook: [{ category: 'map_world', name: '云京', keys: ['云京'], content: '云京为王朝都城。' }] };
    else if (k === 'roster') out = { characters: [{ name: '林昭', aliases: ['阿昭'], role: '主角' }] };
    else if (k === 'character') out = { name: '林昭', content_yaml: 'name: 林昭\nidentity: 官员\nrelations: 与赵六结义' };
    else if (k === 'align') out = {
      matched: [{ type: 'character', existingName: '林昭', newName: '林昭', action: 'merge' }],
      added: [], conflicts: [],
    };
    else if (k === 'integrate') {
      if (integrateMode === 'throw') throw new Error('模拟整合失败');
      out = { content_yaml: 'name: 林昭\nidentity: 官员\nrelations: 与赵六结义\nbackground: 入城后任官，定居云京。' };
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function classify(sys) {
  if (/章节级多任务抽取器|事件抽取器/.test(sys)) return 'events';
  if (/阶段划分器/.test(sys)) return 'phases';
  if (/人设增量|增量表/.test(sys)) return 'deltas';
  if (/世界观抽取器/.test(sys)) return 'worldbook';
  if (/人物名单抽取器/.test(sys)) return 'roster';
  if (/人物档案抽取器/.test(sys)) return 'character';
  if (/实体对齐器/.test(sys)) return 'align';
  if (/角色设定整合器/.test(sys)) return 'integrate';
  return 'other';
}

async function runOnce(opts = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'n2c-integ-'));
  const cardPath = path.join(dir, 'card.json');
  await writeFile(cardPath, JSON.stringify(makeExistingCard(), null, 2), 'utf-8');
  const { fetchImpl, calls } = makeMockFetch(opts);
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await A.runAugment({
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
      cardPath,
      novelText: '第二章\n林昭入城后做了官。'.repeat(20),
      outputDir: dir,
      strategy: opts.strategy || 'merge',
      ...(opts.integrateCharacters === undefined ? {} : { integrateCharacters: opts.integrateCharacters }),
    }, () => {});
    const finalCard = JSON.parse(await readFile(path.join(result.outDir, 'character_card.json'), 'utf-8'));
    const entries = finalCard.data.character_book.entries || [];
    const linEntry = entries.find(e => /林昭/.test(e.comment || ''));
    return { result, calls, content: String(linEntry?.content || ''), entry: linEntry };
  } finally {
    globalThis.fetch = orig;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const integrateCalls = (calls) => calls.filter(c => c.kind === 'integrate');

// ============================================================
console.log('\n【1】默认开启：整合进已有条目');
{
  const { result, calls, content } = await runOnce();
  ok('确实发起了整合调用', integrateCalls(calls).length === 1, String(integrateCalls(calls).length));
  ok('条目内容含新信息（官员/赵六）', /官员/.test(content) && /赵六/.test(content), content.slice(0, 120));
  ok('条目内容保留旧信息（林昭）', /林昭/.test(content), '');
  ok('**不再出现追加标记「【新增内容】」**', !/【新增内容】/.test(content), content.slice(0, 120));
  ok('报告记录 integrated', Array.isArray(result.report.integrated) && result.report.integrated.includes('林昭'),
    JSON.stringify(result.report.integrated));
  ok('updated 里该角色标为 integrated',
    (result.report.updated || []).some(u => u.type === 'character' && u.how === 'integrated'),
    JSON.stringify(result.report.updated));
}

// ============================================================
console.log('\n【2】关闭整合：保持原来的追加合并');
{
  const { result, calls, content } = await runOnce({ integrateCharacters: false });
  ok('没有发起整合调用', integrateCalls(calls).length === 0, String(integrateCalls(calls).length));
  ok('内容仍是追加合并（有【新增内容】标记）', /【新增内容】/.test(content), content.slice(0, 120));
  ok('报告里 integrated 为空', Array.isArray(result.report.integrated) && result.report.integrated.length === 0,
    JSON.stringify(result.report.integrated));
}

// ============================================================
console.log('\n【3】整合失败：不中断，保留追加结果');
{
  let threw = null;
  let out = null;
  try { out = await runOnce({ integrateMode: 'throw' }); } catch (e) { threw = e; }
  ok('任务不因整合失败而中断', !threw, threw ? threw.message : '');
  ok('保留追加合并结果', out && /【新增内容】/.test(out.content), out?.content.slice(0, 120) || '');
  ok('失败记进 integrateSkipped',
    (out?.result?.report?.integrateSkipped || []).some(x => x.name === '林昭'),
    JSON.stringify(out?.result?.report?.integrateSkipped));
}

// ============================================================
console.log('\n【4】append 策略：不动已有条目，也不整合');
{
  const { result, calls, content } = await runOnce({ strategy: 'append' });
  ok('append 下没有整合调用', integrateCalls(calls).length === 0, String(integrateCalls(calls).length));
  ok('append 下已有条目原样保留',
    content.includes('identity: 学生') && !/【新增内容】/.test(content), content.slice(0, 120));
  ok('append 下报告 integrated 为空', (result.report.integrated || []).length === 0, '');
}

// ============================================================
console.log('\n【5】prompt 接线');
{
  const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);
  const p = S.STEP_AUGMENT_INTEGRATE;
  ok('存在整合 prompt', typeof p === 'string' && p.length > 200, String(p?.length));
  ok('要求保留旧信息', /保留已有设定/.test(p), '');
  ok('要求冲突以新剧情为准', /以新剧情为准/.test(p), '');
  ok('禁止元叙述（"新增""根据新剧情"）', /不要写"新增""根据新剧情"/.test(p), '');
  ok('输出 {content_yaml}', /"content_yaml"/.test(p), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  人设整合测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
