/**
 * 端到端：用真实的 GBK 小说走完整条流水线
 *
 * 目的：证明"GBK 小说不再乱码"——
 *   - Init 日志里出现编码检测结果
 *   - meta.json / project.json 记录 sourceEncoding
 *   - 切出的章节标题是真正的中文（不是乱码）
 *   - 传给 LLM 的 prompt 里是正确中文
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3113;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const REAL_GBK = path.join(ROOT, 'uploads', 'f4c2b164027d2a30b9f09842599c95ae');

// 记录收到的 prompt，用来验证送进 LLM 的是正确中文
const received = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}
    const system = payload.messages?.find(m => m.role === 'system')?.content || '';
    const user = payload.messages?.find(m => m.role === 'user')?.content || '';
    received.push({ system, user });

    const s = String(system);
    let content;
    if (s.includes('叙事结构')) content = JSON.stringify({ hasSingleProtagonist: true, protagonistName: '林晚晴', reason: '视角集中' });
    else if (s.includes('时间线抽取器')) content = JSON.stringify([
      { type: 'absolute', raw: '2020年6月10日', quote: '2020年6月10日', event: '开篇拍卖会' },
      { type: 'age', raw: '二十四岁', quote: '二十四岁', subject: '林晚晴' },
      { type: 'age', raw: '二十七岁', quote: '二十七岁', subject: '沈砚' },
    ]);
    else if (s.includes('时间线锚点识别器')) content = JSON.stringify({ base: '公元纪年', origin: { raw: '2020年6月10日', event: '开篇拍卖会', reason: '最早绝对时间' } });
    else if (s.includes('小说事件抽取器')) content = JSON.stringify([{
      name: '开篇拍卖会', storyline: '暗局浮现', chapter: '第一章', quote: '第一章：扭曲的开',
      canon: '林晚晴在拍卖会上遇见沈砚。', pressure: 'core',
      prerequisites: { temporal: [], behavioral: '' }, interventions: [],
    }]);
    else if (s.includes('阶段划分器')) content = JSON.stringify({ phases: [{ name: '暗局浮现', startEvent: '开篇拍卖会', endEvent: '开篇拍卖会', coreChange: '从不知情到起疑' }] });
    else if (s.includes('人设变化抽取器')) content = JSON.stringify({ phase: '暗局浮现', deltas: [] });
    else if (s.includes('热门作品')) content = JSON.stringify({ wellKnown: false, reason: '原创' });
    else if (s.includes('世界观抽取器')) content = JSON.stringify([]);
    else if (s.includes('人物档案抽取器')) content = JSON.stringify({ name: '林晚晴', keys: ['林晚晴'], content: '林晚晴，拍卖会上的买家。' });
    else content = JSON.stringify({ ok: true });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
  });
});

async function sse(form) {
  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    for (const line of lines) {
      if (line.startsWith('event:')) evt = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      else if (line.trim() === '' && evt) {
        let p = null;
        try { p = JSON.parse(data.join('\n')); } catch {}
        events.push({ event: evt, data: p });
        evt = null; data = [];
      }
    }
  }
  return events;
}

async function main() {
  let gbk;
  try { gbk = await readFile(REAL_GBK); } catch {
    console.log('\n⚠ 未找到真实 GBK 文件，跳过（uploads/ 里没有残留）\n');
    process.exit(0);
  }
  console.log(`\n真实 GBK 文件：${(gbk.length / 1024).toFixed(0)} KB`);

  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

  console.log('\n【1】提交 GBK 小说并跑完整流水线');
  received.length = 0;
  const fd = new FormData();
  fd.append('novel', new Blob([gbk], { type: 'text/plain' }), '高贵仙子的痴女改造1-5.txt');
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'k');
  fd.append('model', 'mock');
  fd.append('userMode', 'auto');
  fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 2 }));

  const events = await sse(fd);
  const err = events.find(e => e.event === 'error');
  const filesEvt = events.find(e => e.event === 'files');
  ok('流水线未报错', !err, JSON.stringify(err?.data));
  ok('收到产物事件', !!filesEvt, JSON.stringify(events.map(e => e.event)));
  if (!filesEvt) { report(); return; }

  const taskId = filesEvt.data.taskId;
  const logs = events.filter(e => e.event === 'progress').map(e => `[${e.data?.step}] ${e.data?.msg}`);

  console.log('\n【2】Init 日志必须说明编码处理');
  const encLog = logs.find(l => /检测到编码|检测到 BOM/.test(l));
  ok('日志里出现编码检测说明', !!encLog, logs.slice(0, 4).join(' | '));
  if (encLog) console.log(`     ${encLog}`);
  ok('编码说明指向 GB 系', /GB/i.test(encLog || ''), encLog || '');
  ok('没有出现"未能识别编码"', !logs.some(l => /未能识别编码/.test(l)), logs.filter(l => /编码/.test(l)).join(' | '));

  console.log('\n【3】传入 LLM 的 prompt 必须是正确中文');
  const allText = received.map(r => r.system + r.user).join('\n');
  ok('LLM 收到了请求', received.length > 0, String(received.length));
  ok('prompt 里出现正确的小说标题', allText.includes('高贵仙子的痴女改造'), allText.slice(0, 120));
  ok('prompt 里出现正确章节名', /第一章/.test(allText));
  ok('prompt 里没有常见 UTF-8 误读乱码', !/锟斤拷|鈥|锛/.test(allText));
  ok('prompt 里没有 latin1 展开的乱码', !/æµ‹|è¯•|ç«/.test(allText));
  // 源文件末尾有一个被截断的字节，必然产生 1 个替换字符；这里按比例断言
  const badChars = [...allText].filter(c => c === '\uFFFD').length;
  const badRatio = badChars / allText.length;
  ok('prompt 替换字符比例可忽略（原文件末尾截断所致）', badRatio < 0.0005,
    `${badChars} / ${allText.length} = ${(badRatio * 100).toFixed(4)}%`);

  console.log('\n【4】产物记录编码信息');
  const dir = path.join(ROOT, 'output', taskId);
  const files = await readdir(dir);
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
  ok('meta.json 有 sourceEncoding', !!meta.sourceEncoding, JSON.stringify(meta.sourceEncoding));
  ok('记录了原始编码名', /gb/i.test(meta.sourceEncoding?.original || ''), JSON.stringify(meta.sourceEncoding));
  ok('记录了置信度', typeof meta.sourceEncoding?.confidence === 'number', String(meta.sourceEncoding?.confidence));
  ok('标记了已转码', meta.sourceEncoding?.transcoded === true);
  ok('记录了字节数', meta.sourceEncoding?.bytes === gbk.length, `${meta.sourceEncoding?.bytes} vs ${gbk.length}`);

  const project = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8'));
  ok('project.json 标题为正确中文', project.title === '高贵仙子的痴女改造1-5', JSON.stringify(project.title));
  ok('project.json 记录了源文件名', project.sourceFile === '高贵仙子的痴女改造1-5.txt', JSON.stringify(project.sourceFile));
  ok('slug 里有编码记录（sourceFileRaw 仅在需要时出现）',
    project.sourceFileRaw === undefined || typeof project.sourceFileRaw === 'string');

  console.log('\n【5】切章结果正确（不是"1 个事件"式的失败）');
  const timeline = JSON.parse(await readFile(path.join(dir, 'timeline.json'), 'utf-8'));
  ok('抽到了事件', timeline.events?.length >= 1, JSON.stringify(timeline.events?.length));
  ok('人物名可辨认', timeline.characters?.some(c => c.name === '林晚晴'),
    JSON.stringify(timeline.characters?.map(c => c.name)));
  const userMode = JSON.parse(await readFile(path.join(dir, 'user_mode.json'), 'utf-8'));
  ok('主角名是中国姓名（非乱码）', userMode.protagonistName === '林晚晴', JSON.stringify(userMode.protagonistName));

  const chapterLog = logs.find(l => /切分为/.test(l));
  const nChunks = Number((chapterLog?.match(/切分为 (\d+) 块/) || [])[1] || 0);
  ok('章节数符合原文章节数（该文件共 5 章）', nChunks === 5, chapterLog || '未找到切分日志');
  console.log(`     ${chapterLog}`);

  console.log('\n【6】产物文件内容为正确中文');
  const worldbook = JSON.parse(await readFile(path.join(dir, 'worldbook.json'), 'utf-8'));
  const wbText = JSON.stringify(worldbook);
  ok('世界书内容无替换字符', !wbText.includes('\uFFFD'));
  ok('世界书含正确事件名', wbText.includes('开篇拍卖会'));

  await rm(dir, { recursive: true, force: true });
  console.log(`\n（已清理测试产物 ${taskId}）`);

  // 先彻底关掉 mock 服务并等所有连接结束，再打印结论并退出。
  // 否则在 Windows 上会与未关闭的 socket 抢 libuv 句柄，触发 async.c 断言。
  await new Promise((resolve) => {
    mock.closeAllConnections?.();
    mock.close(() => resolve());
    setTimeout(resolve, 1500); // 兜底，避免个别连接卡住
  });

  report();
}

function report() {
  console.log(`\n${'='.repeat(46)}`);
  console.log(`  GBK 端到端：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  // 只设置退出码，让 Node 自然退出（所有服务已关闭，事件循环会自行清空）
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => {
  console.error('\n测试异常：', e);
  try { mock.close(); } catch {}
  process.exit(1);
});
