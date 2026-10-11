/**
 * 输出模式测试
 *
 * 「生成流程」页有两种产物，对应的两个按钮必须**真的**改变产出：
 *   card  → 只产出 character_card.json
 *   ab    → 只产出 worldbook.json + preset_fragment.json
 *   both  → 两者都产出
 * 另外验证：README 内容随模式变化、meta/project 记录模式、公共中间产物始终存在。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3120;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const NOVEL = [
  '第一章 入城', '林昭年方十七，独自来到云京寻找失踪的兄长。'.repeat(14),
  '第二章 茶楼', '林昭在茶楼遇见沈砚，得知玉佩的来历。'.repeat(14),
  '第三章 旧宅', '林昭夜探旧宅，发现一封密信。'.repeat(14),
].join('\n\n');

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const s = String(p.messages?.find(m => m.role === 'system')?.content || '');
    let content;
    if (s.includes('叙事结构')) content = JSON.stringify({ hasSingleProtagonist: true, protagonistName: '林昭' });
    else if (s.includes('时间线抽取器')) content = JSON.stringify([
      { type: 'absolute', raw: '天启三年春', quote: '天启三年春', event: '开篇入城' },
      { type: 'age', raw: '十七岁', quote: '十七岁', subject: '林昭' },
    ]);
    else if (s.includes('时间线锚点识别器')) content = JSON.stringify({ base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城', reason: 'r' } });
    else if (s.includes('小说事件抽取器')) content = JSON.stringify([
      { name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭年方十七', canon: '林昭入京。', pressure: 'core', prerequisites: { temporal: [], behavioral: '' }, interventions: [] },
      { name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '发现一封密信', canon: '林昭发现密信。', pressure: 'buffer', prerequisites: { temporal: ['开篇入城'], behavioral: '' }, interventions: [] },
    ]);
    else if (s.includes('阶段划分器')) content = JSON.stringify({ phases: [{ name: '入城立足', startEvent: '开篇入城', endEvent: '夜探旧宅', coreChange: '从寻亲到追查' }] });
    else if (s.includes('人设变化抽取器')) content = JSON.stringify({ deltas: [{ character: '林昭', change: '从谨慎到主动' }] });
    else if (s.includes('热门作品')) content = JSON.stringify({ wellKnown: false, reason: '原创' });
    else if (s.includes('世界观抽取器')) content = JSON.stringify([
      { category: 'map_world', name: '云京', keys: ['云京'], content: '云京为都城。' },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: '掌查密案。' },
    ]);
    else if (s.includes('人物档案抽取器')) content = JSON.stringify({ name: '林昭', keys: ['林昭'], content: '林昭，十七岁。' });
    else if (s.includes('角色卡的基础字段')) content = JSON.stringify({
      description: '天启三年，云京。林昭为寻兄长入京。',
      personality: '林昭沉静果决。',
      scenario: '你站在云京城门下。',
      first_mes: '城门在身后合拢，你抬起头。',
      alternate_greetings: ['你在茶楼坐下。', '夜里的旧宅门虚掩着。'],
      tags: ['古风', '悬疑'],
    });
    else content = JSON.stringify({ ok: true });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

async function generate(outputMode) {
  const fd = new FormData();
  fd.append('novel', new Blob([Buffer.from(NOVEL, 'utf-8')], { type: 'text/plain' }), `模式-${outputMode}.txt`);
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'k');
  fd.append('model', 'mock');
  fd.append('userMode', 'auto');
  if (outputMode !== undefined) fd.append('outputMode', outputMode);
  fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 2 }));

  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: fd });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', evt = null, data = [];
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (l.startsWith('event:')) evt = l.slice(6).trim();
      else if (l.startsWith('data:')) data.push(l.slice(5).trim());
      else if (l.trim() === '' && evt) {
        let parsed = null; try { parsed = JSON.parse(data.join('\n')); } catch {}
        events.push({ event: evt, data: parsed }); evt = null; data = [];
      }
    }
  }
  return events;
}

async function collect(mode) {
  const events = await generate(mode);
  const err = events.find(e => e.event === 'error');
  const filesEvt = events.find(e => e.event === 'files');
  const dir = filesEvt ? path.join(ROOT, 'output', filesEvt.data.taskId) : null;
  const files = dir ? (await readdir(dir)).filter(f => f !== 'log.jsonl') : [];
  return { events, err, filesEvt, dir, files };
}

/**
 * 各模式下的产物预期。
 *
 * 注意 `mustNot` 里**没有** worldbook.json / preset_fragment.json：
 * 这两份是 A 包与 B 包的检视副本，现在**始终写出**（pipeline 里它们本来就已构建好）。
 * 省略它们会让「预设规则」页的「↓ 下载 JSON」和「角色卡内容」页的世界书标签页
 * 在卡模式任务上直接 404 —— 那是用户实际报过的故障。
 * outputMode 仍然决定**主产物**：卡模式不生成"导入用"的 worldbook/preset 之外的差异，
 * 但两者作为检视副本一直在。
 */
const INSPECT = ['worldbook.json', 'preset_fragment.json'];
const EXPECT = {
  card: { must: ['character_card.json', ...INSPECT], mustNot: [] },
  ab: { must: [...INSPECT], mustNot: ['character_card.json'] },
  both: { must: ['character_card.json', ...INSPECT], mustNot: [] },
};

/** 两种模式都一定有的中间产物 */
const ALWAYS = [
  'variables.json', 'timeline.json', 'events.json', 'storylines.json',
  'phases.json', 'user_mode.json', 'card_fields.json', 'meta.json', 'README.md',
];

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const cleanup = [];

  for (const mode of ['card', 'ab', 'both']) {
    console.log(`\n【模式 ${mode}】`);
    const { err, filesEvt, dir, files, events } = await collect(mode);
    ok('生成无错误', !err, JSON.stringify(err?.data));
    if (!filesEvt) { ok('收到产物事件', false, JSON.stringify(events.map(e => e.event))); continue; }
    cleanup.push(dir);

    const expect = EXPECT[mode];
    for (const f of expect.must) ok(`产出 ${f}`, files.includes(f), files.join(','));
    for (const f of expect.mustNot) ok(`不产出 ${f}`, !files.includes(f), files.join(','));
    for (const f of ALWAYS) ok(`始终产出 ${f}`, files.includes(f), files.join(','));

    // files 事件里的清单要和磁盘一致
    const listed = filesEvt.data.files;
    for (const f of expect.must) ok(`files 事件包含 ${f}`, listed.includes(f), listed.join(','));
    for (const f of expect.mustNot) ok(`files 事件不含 ${f}`, !listed.includes(f), listed.join(','));

    /**
     * 回归：卡模式必须也产出 worldbook.json 与 preset_fragment.json。
     *
     * 这两个文件是 A 包与 B 包的**检视副本**，UI 有三处直接依赖它们：
     *   · 「预设规则」页读 preset_fragment.json → 点「↓ 下载 JSON」会 404
     *   · 「角色卡内容」页首个标签读 worldbook.json → 报"该任务没有 worldbook.json"，整页打不开
     *   · 「打包下载」的产物清单里也应当有它们（用户要能一次拿到全部内容）
     * 曾经它们只在 ab/both 模式产出，于是选「🎴 完整 JSON 角色卡」的任务上
     * 这三个功能全都不可用（用户实际报过的故障）。
     */
    for (const f of INSPECT) {
      ok(`检视副本始终可下载 ${f}`, listed.includes(f) && files.includes(f), listed.join(','));
    }

    // 日志说明当前模式
    const modeLog = events.filter(e => e.event === 'progress')
      .map(e => e.data?.msg || '').find(m => /输出模式/.test(m));
    ok('日志说明了输出模式', !!modeLog, modeLog || '（未找到）');
    if (mode === 'ab') {
      ok('ab 模式日志提到跳过角色卡',
        events.some(e => /按输出模式跳过完整角色卡/.test(e.data?.msg || '')),
        JSON.stringify(events.filter(e => /跳过/.test(e.data?.msg || '')).map(e => e.data.msg)));
    }

    // meta / project 记录模式
    const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
    ok('meta.json 记录 outputMode', meta.outputMode === mode, String(meta.outputMode));
    ok('meta.json 记录 hasCharacterCard',
      meta.hasCharacterCard === (mode !== 'ab'), String(meta.hasCharacterCard));
    const project = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8'));
    ok('project.json 记录 outputMode', project.outputMode === mode, String(project.outputMode));

    // README 随模式变化
    const readme = await readFile(path.join(dir, 'README.md'), 'utf-8');
    if (mode === 'card') {
      ok('README 只讲一次导入', /推荐方式（一次导入）/.test(readme) && !/分开导入（A 包 \+ B 包）/.test(readme));
      ok('README 说明本次只产出角色卡', /只产出 character_card\.json/.test(readme), readme.slice(0, 200));
    } else if (mode === 'ab') {
      ok('README 只讲分开导入', /分开导入（A 包 \+ B 包）/.test(readme) && !/推荐方式（一次导入）/.test(readme));
      ok('README 说明本次只产出 A/B 包', /只产出 worldbook\.json/.test(readme), readme.slice(0, 200));
    } else {
      ok('README 两种方式都讲',
        /推荐方式（一次导入）/.test(readme) && /分开导入（A 包 \+ B 包）/.test(readme));
      ok('README 说明两套产物都在', /两套产物都在/.test(readme), readme.slice(0, 200));
    }

    // 产物本身必须仍然合法
    if (expect.must.includes('character_card.json')) {
      const cc = JSON.parse(await readFile(path.join(dir, 'character_card.json'), 'utf-8'));
      ok('角色卡结构合法', cc.spec === 'chara_card_v3' && Array.isArray(cc.data.character_book.entries));
      ok('角色卡 initvar 关闭',
        cc.data.character_book.entries.find(e => e.comment?.includes('initvar'))?.enabled === false);
      ok('角色卡 EJS 未转义',
        cc.data.character_book.entries.some(e => e.content?.includes('<%_')));
    }
    if (expect.must.includes('worldbook.json')) {
      const wb = JSON.parse(await readFile(path.join(dir, 'worldbook.json'), 'utf-8'));
      ok('A 包结构未变', Array.isArray(wb.entries) && wb.entries.length > 0);
      const pf = JSON.parse(await readFile(path.join(dir, 'preset_fragment.json'), 'utf-8'));
      ok('B 包结构未变',
        ['b1_variables', 'b2_update_rules', 'b3_director', 'b4_persona_delta', 'b5_rules'].every(k => k in pf));
    }

    console.log(`     产出 ${files.length} 个文件：${files.sort().join(' ')}`);
  }

  // ============================================================
  console.log('\n【默认行为】');
  {
    const { err, filesEvt, dir, files } = await collect(undefined);   // 不带 outputMode
    ok('未传 outputMode 不报错', !err, JSON.stringify(err?.data));
    if (filesEvt) {
      cleanup.push(dir);
      const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
      ok('默认回退为 both', meta.outputMode === 'both', String(meta.outputMode));
      ok('默认两套产物都有',
        files.includes('character_card.json') && files.includes('worldbook.json'));
    }

    // 非法值同样回退到 both
    const bad = await collect('nonsense');
    ok('非法 outputMode 不报错', !bad.err, JSON.stringify(bad.err?.data));
    if (bad.filesEvt) {
      cleanup.push(bad.dir);
      const meta = JSON.parse(await readFile(path.join(bad.dir, 'meta.json'), 'utf-8'));
      ok('非法值回退为 both', meta.outputMode === 'both', String(meta.outputMode));
    }
  }

  for (const d of cleanup) await rm(d, { recursive: true, force: true });
  console.log(`\n（已清理 ${cleanup.length} 个测试产物）`);

  await new Promise((resolve) => {
    mock.closeAllConnections?.();
    mock.close(() => resolve());
    setTimeout(resolve, 1200);
  });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  输出模式：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(async e => {
  console.error('\n测试异常：', e);
  try { mock.close(); } catch {}
  process.exit(1);
});
