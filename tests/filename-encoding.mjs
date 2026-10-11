/**
 * 上传文件名编码检测
 *
 * multipart 的 filename 按 RFC 是 latin1 字节串，multer/busboy 会逐字节映射成
 * JS 字符串，于是中文名会变成「é«˜è´µ...」这类乱码。
 *
 * 本测试：
 *   1. 探针接口 /api/upload/name-probe 返回服务端实际拿到的名字
 *   2. 真跑一次生成，确认 project.json 里的标题是正确中文
 * 这样既验证修复生效，也能在 multer/busboy 行为变化时立刻发现。
 */
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, rm } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3114;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const CN_NAME = '高贵仙子的痴女改造1-5.txt';
const CN_TEXT = '第一章 初见\n\n' + '林晚晴在拍卖会上见到了沈砚，她并不知道这个人已经布局三年。'.repeat(12)
  + '\n\n第二章 暗局\n\n' + '沈砚的棋局远比她想象的更早开始。'.repeat(12);

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}
    const s = String(payload.messages?.find(m => m.role === 'system')?.content || '');
    let content;
    if (s.includes('叙事结构')) content = JSON.stringify({ hasSingleProtagonist: true, protagonistName: '林晚晴' });
    else if (s.includes('时间线抽取器')) content = JSON.stringify([
      { type: 'age', raw: '二十四岁', quote: '二十四岁', subject: '林晚晴' },
    ]);
    else if (s.includes('时间线锚点识别器')) content = JSON.stringify({ base: '相对纪元', origin: { raw: '开场', event: '初见', reason: 'r' } });
    else if (s.includes('小说事件抽取器')) content = JSON.stringify([{
      name: '初见', storyline: '暗局', chapter: '第一章', quote: '林晚晴在拍卖会上见到了沈砚',
      canon: '两人初见。', pressure: 'core', prerequisites: { temporal: [], behavioral: '' }, interventions: [],
    }]);
    else if (s.includes('阶段划分器')) content = JSON.stringify({ phases: [] });
    else if (s.includes('热门作品')) content = JSON.stringify({ wellKnown: false, reason: '原创' });
    else if (s.includes('世界观抽取器')) content = JSON.stringify([]);
    else if (s.includes('人物档案抽取器')) content = JSON.stringify({ name: '林晚晴', keys: ['林晚晴'], content: '林晚晴。' });
    else content = JSON.stringify({ ok: true });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

async function sse(form) {
  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: form });
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
        let p = null; try { p = JSON.parse(data.join('\n')); } catch {}
        out.push({ event: evt, data: p }); evt = null; data = [];
      }
    }
  }
  return out;
}

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // ============================================================
  console.log('\n【1】探针：服务端实际拿到的文件名');
  {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('测试内容')]), CN_NAME);
    const r = await fetch(`${BASE}/api/upload/name-probe`, { method: 'POST', body: fd });
    const j = await r.json();
    console.log(`     客户端发送：${CN_NAME}`);
    console.log(`     服务端收到：${j.received}`);
    console.log(`     修正结果  ：${j.fixed}`);

    ok('探针接口可用', r.ok, String(r.status));
    ok('修正后等于原始中文名', j.fixed === CN_NAME, JSON.stringify(j.fixed));
    ok('received 字段存在', typeof j.received === 'string');
    if (j.mojibake) {
      console.log('     → 当前环境 multer 确实按 latin1 展开，修复逻辑生效');
      ok('确实检出了乱码', j.received !== CN_NAME);
    } else {
      console.log('     → 当前环境下 multer 已正确解码，修复逻辑按"不改变"处理（幂等）');
      ok('未乱码时保持原样（不会二次破坏）', j.fixed === j.received || j.fixed === CN_NAME);
    }
  }

  // ============================================================
  console.log('\n【2】边界：ASCII 名与已含 >0xFF 字符的名都不能被破坏');
  {
    for (const [name, label] of [['novel.txt', '纯 ASCII 名'], ['测试.txt', '中文名（服务端已正确解码时）']]) {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.from('x')]), name);
      const j = await (await fetch(`${BASE}/api/upload/name-probe`, { method: 'POST', body: fd })).json();
      ok(`${label}不被改动`, j.fixed === name, `received=${JSON.stringify(j.received)} fixed=${JSON.stringify(j.fixed)}`);
    }
  }

  // ============================================================
  console.log('\n【3】真跑生成：project.json 标题应为正确中文');
  {
    const fd = new FormData();
    fd.append('novel', new Blob([Buffer.from(CN_TEXT, 'utf-8')], { type: 'text/plain' }), CN_NAME);
    fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
    fd.append('apiKey', 'k');
    fd.append('model', 'mock');
    fd.append('userMode', 'auto');
    fd.append('options', JSON.stringify({ concurrency: 1, maxCharacters: 1 }));

    const events = await sse(fd);
    const filesEvt = events.find(e => e.event === 'files');
    ok('生成成功', !!filesEvt, JSON.stringify(events.find(e => e.event === 'error')?.data));
    if (filesEvt) {
      const dir = path.join(ROOT, 'output', filesEvt.data.taskId);
      const project = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8'));
      console.log(`     project.title      = ${project.title}`);
      console.log(`     project.sourceFile = ${project.sourceFile}`);
      ok('标题为正确中文（无扩展名）', project.title === '高贵仙子的痴女改造1-5', JSON.stringify(project.title));
      ok('源文件名为正确中文', project.sourceFile === CN_NAME, JSON.stringify(project.sourceFile));
      ok('标题不含 latin1 展开的乱码', !/æ|è|é|ç|å/.test(project.title), project.title);
      ok('标题不含替换字符', !project.title.includes('\uFFFD'));

      const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
      ok('meta.json 标题同样正确', meta.title === '高贵仙子的痴女改造1-5', JSON.stringify(meta.title));

      await rm(dir, { recursive: true, force: true });
      console.log(`     （已清理 ${filesEvt.data.taskId}）`);
    }
  }

  // ============================================================
  console.log('\n【4】任务列表里显示正确标题');
  {
    const fd = new FormData();
    fd.append('novel', new Blob([Buffer.from(CN_TEXT, 'utf-8')]), '任务列表测试.txt');
    fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
    fd.append('apiKey', 'k');
    fd.append('model', 'mock');
    fd.append('userMode', 'auto');
    fd.append('options', JSON.stringify({ concurrency: 1, maxCharacters: 1 }));
    const events = await sse(fd);
    const ev = events.find(e => e.event === 'files');
    if (ev) {
      const list = await (await fetch(`${BASE}/api/tasks`)).json();
      const t = list.tasks.find(x => x.taskId === ev.data.taskId);
      ok('列表里的标题正确', t?.project?.title === '任务列表测试', JSON.stringify(t?.project?.title));
      await rm(path.join(ROOT, 'output', ev.data.taskId), { recursive: true, force: true });
    } else {
      ok('列表里的标题正确', false, '生成失败');
    }
  }

  await new Promise((resolve) => {
    mock.closeAllConnections?.();
    mock.close(() => resolve());
    setTimeout(resolve, 1200);
  });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  文件名编码：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(async e => {
  console.error('\n测试异常：', e);
  try { mock.close(); } catch {}
  process.exit(1);
});
