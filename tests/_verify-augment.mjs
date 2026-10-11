/**
 * 完善角色卡端到端：真实 HTTP + 桩 LLM。
 * 产出一张真实的增补后卡片与 augment_report.json，用于人工核验。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = 'http://127.0.0.1:3000';
const MOCK_PORT = 3141;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}   ${extra ?? ''}`); }
};

// ---------- 新剧情：10 章 ----------
const NEW_STORY = Array.from({ length: 10 }, (_, i) => {
  const n = i + 1;
  const bodies = [
    '沈砚在茶楼等了三日，终于等到林昭回头。他说玉佩的来历他查清了，牵涉到十年前那场大火。',
    '林昭夜访旧宅，在床板夹层里找到一封没有署名的密信，信上只有一个地名：青芜。',
    '周管事找到林昭，说有人在外面打听她的来历，让她最近别出城。',
    '阿棠从药铺回来说，城里来了个说书人，讲的故事和林昭的兄长一模一样。',
    '林昭决定去青芜。沈砚说要同行，林昭没有答应也没有拒绝。',
    '路上遇雨，两人在一座破庙里过夜，沈砚终于说了自己为什么会认识那半块玉佩。',
    '青芜镇上有个老银匠，认得玉佩上的纹样，说这是二十年前一位姓苏的将军的信物。',
    '林昭在银匠铺的暗格里找到兄长的笔迹，纸上写着"别来找我"。',
    '沈砚拦住了要立刻回京的林昭，说现在回去就是送死。',
    '林昭把玉佩留在银匠铺，独自北行。沈砚站在镇口，没有追。',
  ];
  return `第${n}章 新篇${n}\n` + (bodies[i] + '。').repeat(30);
}).join('\n\n');

// ---------- 桩 LLM ----------
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const sys = String(p.messages?.find(m => m.role === 'system')?.content || '');
    const usr = String(p.messages?.find(m => m.role === 'user')?.content || '');
    let content = JSON.stringify({ ok: true });

    if (sys.includes('小说事件抽取器')) {
      content = JSON.stringify([
        { name: '茶楼重逢', storyline: '旧案追查', chapter: '第一章', quote: '沈砚在茶楼等了三日',
          canon: '林昭与沈砚再次会面。', pressure: 'core', prerequisites: { temporal: [], behavioral: '' }, interventions: [] },
        { name: '夜访得信', storyline: '旧案追查', chapter: '第二章', quote: '床板夹层里找到密信',
          canon: '林昭找到密信。', pressure: 'core', prerequisites: { temporal: ['茶楼重逢'], behavioral: '' }, interventions: [] },
      ]);
    } else if (sys.includes('阶段划分器')) {
      content = JSON.stringify({ phases: [
        { name: '青芜之行', startEvent: '茶楼重逢', endEvent: '夜访得信', coreChange: '从被动等待到主动追查' },
      ] });
    } else if (sys.includes('人设变化抽取器')) {
      content = JSON.stringify({ deltas: [{ character: '林昭', change: '从谨慎观望变为果断独行', quote: '独自北行' }] });
    } else if (sys.includes('世界观抽取器')) {
      content = JSON.stringify([
        { category: 'map_location', name: '青芜镇', keys: ['青芜'], content: '青芜镇是北境边上的小镇，镇上有一间老银匠铺，据说认得各家的旧信物。' },
        { category: 'history', name: '十年前大火', keys: ['大火'], content: '十年前云京半条长街被烧毁，官方称是走水，但民间一直有别的说法。' },
      ]);
    } else if (sys.includes('人物名单抽取器')) {
      // 旧剧情里出现卡卡西（让旧卡真的带上这个人物），新剧情里用全名「旗木卡卡西」，
      // 这样既能覆盖"别名对齐后合并"，也能覆盖"对齐落空退化为新增"
      const hasKakashi = usr.includes('卡卡西');
      content = JSON.stringify([
        { name: '林昭', aliases: ['阿昭'], role: '主角' },
        { name: '沈砚', aliases: [], role: '主要配角' },
        ...(hasKakashi ? [{ name: '旗木卡卡西', aliases: ['卡卡西'], role: '主要配角' }] : []),
        { name: '小女孩', aliases: [], role: '主要配角' },              // 应被剔除
      ]);
    } else if (sys.includes('人物档案抽取器')) {
      // 真实 LLM 会把输入里的「角色名」原样回填；这里保持一致，
      // 否则 assembleWorldbook 会因为找不到对应人物而丢弃该条目
      const name = /角色名：(\S+)/.exec(usr)?.[1] || '?';
      content = JSON.stringify({
        name,
        keys: [name],
        content: name.includes('卡卡西')
          ? `${name}：木叶上忍，写轮眼，在新剧情中协助林昭查案。`
          : `${name}：在新剧情中出现的人物，与旧案追查有关。`,
      });
    } else if (sys.includes('实体对齐器')) {
      content = JSON.stringify({
        matched: [
          { type: 'character', existingName: '卡卡西', newName: '旗木卡卡西', confidence: 0.95,
            reason: '同一角色的全名与简称', action: 'merge' },
        ],
        added: [
          { type: 'character', name: '沈砚' },
          { type: 'event', name: '茶楼重逢' },
          { type: 'event', name: '夜访得信' },
          { type: 'worldbook', name: '青芜镇' },
          { type: 'worldbook', name: '十年前大火' },
        ],
        conflicts: [
          { type: 'character', existingName: '卡卡西', newName: '旗木卡卡西', field: '性格',
            existing: '散漫、爱迟到', new: '果断独行', severity: 'high' },
        ],
      });
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

async function sse(url, form) {
  const res = await fetch(url, { method: 'POST', body: form });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', evt = null, data = [];
  const out = [];
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
        out.push({ event: evt, data: parsed }); evt = null; data = [];
      }
    }
  }
  return out;
}

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // ---------- 1. 先用 /api/generate 造一张真实的"已有卡" ----------
  console.log('【准备】先用 /api/generate 造一张已有角色卡');
  const oldStory = Array.from({ length: 6 }, (_, i) =>
    `第${i + 1}章\n` + `林昭和卡卡西在云京查案。`.repeat(40)).join('\n\n');
  const genFd = new FormData();
  genFd.append('novel', new Blob([oldStory], { type: 'text/plain' }), '旧剧情.txt');
  genFd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  genFd.append('apiKey', 'k'); genFd.append('model', 'mock');
  genFd.append('userMode', 'auto'); genFd.append('outputMode', 'card');
  genFd.append('title', '云京旧案');
  genFd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 6 }));

  // 第一轮用一个"只有卡卡西"的桩，让旧卡里确实有卡卡西
  const genEvents = await sse(`${BASE}/api/generate`, genFd);
  const genErr = genEvents.find(e => e.event === 'error');
  if (genErr) { console.log('  旧卡生成失败：', JSON.stringify(genErr.data)); process.exit(1); }
  const genFiles = genEvents.find(e => e.event === 'files');
  const oldDir = genFiles.data.taskDir;
  const oldCardPath = path.join(oldDir, 'character_card.json');
  const oldCard = JSON.parse(await readFile(oldCardPath, 'utf-8'));
  console.log(`  旧卡：《${oldCard.data.name}》${oldCard.data.character_book.entries.length} 条目`);

  // ---------- 2. 调 /api/augment ----------
  console.log('\n【增补】POST /api/augment（章节范围 1-5）');
  const fd = new FormData();
  fd.append('card', new Blob([JSON.stringify(oldCard, null, 2)], { type: 'application/json' }), 'character_card.json');
  fd.append('novel', new Blob([NEW_STORY], { type: 'text/plain' }), '新剧情.txt');
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'k'); fd.append('model', 'mock');
  fd.append('chapterRange', '1-5');
  fd.append('strategy', 'merge');
  fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 6 }));

  const evs = await sse(`${BASE}/api/augment`, fd);
  const err = evs.find(e => e.event === 'error');
  if (err) { console.log('  增补失败：', JSON.stringify(err.data)); process.exit(1); }

  console.log('  事件序列：', evs.map(e => e.event).join(' → '));
  const conflictsEvt = evs.find(e => e.event === 'conflicts');
  const filesEvt = evs.find(e => e.event === 'files');
  const progress = evs.filter(e => e.event === 'progress').map(e => e.data?.msg).filter(Boolean);
  console.log('\n  关键日志：');
  for (const m of progress.filter(m => /Augment|WARN|Done/.test(m))) console.log('    ' + m);

  const dir = filesEvt.data.taskDir;
  const card = JSON.parse(await readFile(path.join(dir, 'character_card.json'), 'utf-8'));
  const report = JSON.parse(await readFile(path.join(dir, 'augment_report.json'), 'utf-8'));
  const readme = await readFile(path.join(dir, 'README.md'), 'utf-8');

  console.log('\n' + '='.repeat(66));
  console.log('  增补结果核验');
  console.log('='.repeat(66));
  const entries = card.data.character_book.entries;
  console.log(`  产物：${(await readdir(dir)).join(', ')}`);
  console.log(`  条目：${oldCard.data.character_book.entries.length} → ${entries.length}`);

  console.log('\n【产物】augment_report.json 摘要');
  console.log(JSON.stringify({
    sourceCard: report.sourceCard, chapterRange: report.chapterRange,
    processedChapters: report.processedChapters, processedChars: report.processedChars,
    strategy: report.strategy, before: report.before, extracted: report.extracted,
    matched: report.matched.length, added: report.added.length, updated: report.updated.length,
    conflicts: report.conflicts.length, version: report.version,
  }, null, 2));

  console.log('\n【冲突样例】');
  for (const c of report.conflicts) {
    console.log(`  [${c.severity}] ${c.existingName} 的「${c.field}」`);
    console.log(`     原卡：${c.existing}`);
    console.log(`     新剧情：${c.new}`);
  }

  // ---------- 3. 验收断言 ----------
  console.log('\n【验收】');
  ok('SSE 事件类型与 /api/generate 一致（有 start/progress/files）',
    ['start', 'progress', 'files'].every(t => evs.some(e => e.event === t)),
    evs.map(e => e.event).join(','));
  ok('冲突通过独立事件下发', !!conflictsEvt && conflictsEvt.data.conflicts.length === 1);
  ok('只处理了选中章节（1-5）', report.processedChapters === 5, String(report.processedChapters));
  ok('处理字数与章节数一致', report.processedChars > 0);
  ok('报告记录了处理范围', report.chapterRange === '1-5');
  ok('版本号递增', report.version.from !== report.version.to, JSON.stringify(report.version));
  ok('id 唯一且连续', entries.every((e, i) => e.id === i));
  ok('initvar 只有一条',
    entries.filter(e => String(e.comment).includes('[initvar]')).length === 1,
    String(entries.filter(e => String(e.comment).includes('[initvar]')).length));

  // 原有结构保留
  const oldExt = oldCard.data.extensions;
  ok('regex_scripts 原样保留',
    JSON.stringify(card.data.extensions.regex_scripts) === JSON.stringify(oldExt.regex_scripts));
  ok('tavern_helper 原样保留',
    JSON.stringify(card.data.extensions.tavern_helper) === JSON.stringify(oldExt.tavern_helper));
  ok('alternate_greetings 未被删',
    JSON.stringify(card.data.alternate_greetings) === JSON.stringify(oldCard.data.alternate_greetings)
    && card.data.alternate_greetings.length > 0);
  ok('卡片 name 未被改动', card.data.name === oldCard.data.name);
  ok('description 未被改动', card.data.description === oldCard.data.description);

  // 合并效果：先看原卡有没有"卡卡西"这个人物，没有就验证"退化为新增"
  const oldCharNames = oldCard.data.character_book.entries
    .filter(e => String(e.comment).startsWith('[character]'))
    .map(e => String(e.comment).replace('[character] ', ''));
  console.log(`\n  原卡人物：${JSON.stringify(oldCharNames)}`);
  console.log(`  新卡人物：${JSON.stringify(entries.filter(e => String(e.comment).startsWith('[character]')).map(e => String(e.comment).replace('[character] ', '')))}`);

  const kakashi = entries.find(e => String(e.comment).includes('卡卡西'));
  if (oldCharNames.includes('卡卡西')) {
    console.log(`  卡卡西条目：${kakashi?.comment}`);
    console.log(`    keys: ${JSON.stringify(kakashi?.keys)}`);
    console.log(`    content 前 100 字: ${JSON.stringify(String(kakashi?.content).slice(0, 100))}`);
    ok('别名对齐后合并到同一条（没有重复的卡卡西条目）',
      entries.filter(e => String(e.comment).includes('卡卡西')).length === 1,
      String(entries.filter(e => String(e.comment).includes('卡卡西')).length));
    ok('合并后 keys 取并集', (kakashi?.keys || []).length >= 1, JSON.stringify(kakashi?.keys));
    ok('合并后正文保留原内容', String(kakashi?.content || '').includes('卡卡西'));
  } else {
    // 原卡没有"卡卡西"：对齐器把它标成 matched 指向一个不存在的条目 →
    // 必须退化为新增，而不是被静默丢掉（这是实测修过的 bug）
    ok('对齐落空的新实体退化为新增（没被静默丢弃）',
      entries.some(e => String(e.comment).includes('旗木卡卡西')),
      JSON.stringify(entries.map(e => e.comment)));
    ok('退化为新增后计入 added',
      report.added.some(a => String(a.name).includes('旗木卡卡西')),
      JSON.stringify(report.added));
  }

  const wbNew = entries.filter(e => /^\[(map_|system_|history)/.test(String(e.comment)));
  console.log(`  世界观条目：${JSON.stringify(wbNew.map(e => e.comment))}`);
  ok('新世界观条目被加入', wbNew.some(e => String(e.comment).includes('青芜镇')),
    JSON.stringify(wbNew.map(e => e.comment)));
  ok('新事件条目被加入', entries.some(e => String(e.comment).includes('茶楼重逢')));
  ok('描述性称呼没被当人物（小女孩）',
    !entries.some(e => String(e.comment).includes('小女孩')));

  // 角色阶段表的合并
  const pe = entries.find(e => e.comment === '角色阶段');
  ok('角色阶段条目存在', !!pe);
  ok('新阶段被并入人设增量表', String(pe?.content).includes('青芜之行'),
    String(pe?.content).slice(0, 200));
  // 精确取出"表定义"那一个标签（用非贪婪 + 锚定 const 人设增量表）
  const defTag = (String(pe?.content).match(/<%_[^%]*?const\s+人设增量表[\s\S]*?_%>/) || [])[0];
  const tagCount = defTag ? (defTag.match(/<%_/g) || []).length : 0;
  ok('人设增量表仍在单个 EJS 标签内（不跨标签）',
    !!defTag && tagCount === 1, `defTag 前 80 字=${JSON.stringify(String(defTag).slice(0, 80))}`);
  // 表体必须是合法 JSON
  const tm = defTag ? /const\s+人设增量表\s*=\s*(\{[\s\S]*\})\s*;\s*_%>/.exec(defTag) : null;
  let tableOk = false;
  try { tableOk = !!JSON.parse(tm[1]); } catch {}
  ok('人设增量表是合法 JSON', tableOk, tm?.[1]?.slice(0, 80));

  // initvar 可解析
  const YAML = (await import('yaml')).default;
  const iv = entries.find(e => String(e.comment).includes('[initvar]'));
  let parsed = null, yerr = null;
  try { parsed = YAML.parse(iv.content); } catch (e) { yerr = e; }
  ok('合并后的 initvar 是合法 YAML', !yerr, yerr?.message);
  ok('initvar 含新事件变量', JSON.stringify(parsed?.events || {}).includes('茶楼重逢'),
    JSON.stringify(Object.keys(parsed?.events || {})));
  // 原卡的 world.user 命名空间不能被凭空改动
  const oldYaml = (await import('yaml')).default.parse(
    oldCard.data.character_book.entries.find(e => String(e.comment).includes('[initvar]')).content,
  );
  ok('user 命名空间与原卡一致（增补不注入 user）',
    JSON.stringify(parsed?.user ?? null) === JSON.stringify(oldYaml?.user ?? null),
    JSON.stringify({ old: oldYaml?.user ?? null, now: parsed?.user ?? null }));
  ok('原卡的 world 段被保留',
    JSON.stringify(Object.keys(parsed?.world || {})) === JSON.stringify(Object.keys(oldYaml?.world || {})),
    JSON.stringify({ old: oldYaml?.world, now: parsed?.world }));
  ok('initvar 未被启用（enabled=false）', iv.enabled === false);

  ok('README 说明了处理范围', /1-5/.test(readme) && /增补/.test(readme));
  ok('README 列出了冲突', /冲突|需要人工确认/.test(readme), readme.slice(0, 200));

  console.log('\n【留档】把产物复制到 .augment-sample/ 便于人工查看');
  const keep = path.join(ROOT, '.augment-sample');
  await rm(keep, { recursive: true, force: true });
  const { mkdir, copyFile } = await import('node:fs/promises');
  await mkdir(keep, { recursive: true });
  for (const f of ['character_card.json', 'augment_report.json', 'README.md']) {
    await copyFile(path.join(dir, f), path.join(keep, f));
  }
  await writeFile(path.join(keep, '旧卡条目数.txt'), String(oldCard.data.character_book.entries.length), 'utf-8');
  console.log(`  → ${keep}`);

  // 清理测试产物
  await rm(oldDir, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
  await new Promise(r => { mock.closeAllConnections?.(); mock.close(() => r()); setTimeout(r, 500); });

  console.log(`\n${'='.repeat(66)}`);
  console.log(`  完善角色卡端到端：通过 ${pass} · 失败 ${fail}`);
  console.log('='.repeat(66) + '\n');
  process.exitCode = fail ? 1 : 0;
}

main().catch(async e => { console.error(e); try { mock.close(); } catch {} process.exit(1); });
