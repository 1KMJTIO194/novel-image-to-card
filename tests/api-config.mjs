/**
 * API 配置功能测试
 *
 * 覆盖服务端真正用来调用 LLM 的代码路径（src/llm.js + server.js 的 /api/models、
 * /api/ping、/api/generate 转发），用本地假服务当"上游 API"，断言：
 *   - Base URL 拼接正确（含结尾斜杠、带/不带 /v1）
 *   - Authorization 头正确、Key 不会被丢弃或改写
 *   - 请求体包含 model / messages / temperature / max_tokens / response_format
 *   - 模型列表解析（OpenAI 风格 {data:[...]} 与裸数组）
 *   - 各类上游错误（401/404/429/500/超时/非 JSON）都被转成可读中文错误
 *   - 生成接口确实把浏览器传来的 baseUrl/apiKey/model 用上了
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3116;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const llm = await import(pathToFileURL(path.join(ROOT, 'src/llm.js')).href);

// ============================================================
// 假上游 API：按路径与鉴权决定返回什么
// ============================================================
const seen = [];
let mode = 'ok';        // ok | 401 | 404 | 429 | 500 | html | slow

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    const entry = { url: req.url, method: req.method, auth, body };
    seen.push(entry);

    if (mode === 'slow') return; // 故意不响应，测超时

    if (mode === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end('{"error":"invalid api key"}'); }
    if (mode === '404') { res.writeHead(404); return res.end('not found'); }
    if (mode === '429') { res.writeHead(429); return res.end('rate limited'); }
    if (mode === '500') { res.writeHead(500); return res.end('boom'); }
    if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>login page</html>'); }

    if (req.url.includes('/models')) {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('bare')) return res.end(JSON.stringify(['bare-a', 'bare-b']));
      return res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }, { id: 'mock-large' }] }));
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
});

const url = (p = '') => `http://127.0.0.1:${MOCK_PORT}${p}`;

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

  // ============================================================
  console.log('\n【1】Base URL 拼接');
  for (const [base, label] of [
    [url('/v1'), '标准 /v1'],
    [url('/v1/'), '/v1 带结尾斜杠'],
    [url(), '无路径（会打到 /chat/completions）'],
    [url('/'), '仅斜杠（同上）'],
    [url('/openai/v1'), '多级路径'],
  ]) {
    seen.length = 0;
    const client = llm.makeLLM({ baseUrl: base, apiKey: 'k', model: 'm' });
    await client.chatJSON('S', 'U', 'step1');
    const hit = seen[0];
    const expect = `${new URL(base).pathname.replace(/\/+$/, '')}/chat/completions`;
    ok(`${label} → ${hit?.url}`, hit?.url === expect, `期望 ${expect}`);
  }

  console.log('\n【1b】Base URL 合理性检查（防"漏写 /v1"）');
  {
    const cases = [
      ['https://api.deepseek.com/v1', false, '标准写法'],
      ['http://localhost:11434/v1', false, '本地带 /v1'],
      ['http://localhost:11434', true, '本地漏写 /v1'],
      ['https://api.deepseek.com', true, '官方域名漏写 /v1'],
      ['https://api.openai.com/v1/', false, '结尾斜杠'],
      ['not-a-url', true, '非法地址'],
      ['', true, '空地址'],
    ];
    for (const [u, shouldWarn, label] of cases) {
      const r = llm.checkBaseUrl(u);
      ok(`${label}：${shouldWarn ? '给出提示' : '通过'}`, (!!r.warn) === shouldWarn,
        JSON.stringify(r.warn?.split('\n')[0] || null));
    }
    const r = llm.checkBaseUrl('http://localhost:11434');
    ok('提示里点明了实际会请求的地址',
      /\/chat\/completions/.test(r.warn || ''), r.warn);
    ok('提示里给出了正确写法', /\/v1/.test(r.warn || ''), r.warn);
  }

  // ============================================================
  console.log('\n【2】鉴权与请求体');
  {
    seen.length = 0;
    const client = llm.makeLLM({ baseUrl: url('/v1'), apiKey: 'sk-test-1234567890', model: 'deepseek-chat' });
    await client.chatJSON('SYS', 'USR', 'step1', { temperature: 0.42, maxTokens: 777 });
    const r = seen[0];
    ok('Authorization 头格式正确', r.auth === 'Bearer sk-test-1234567890', r.auth);
    ok('方法为 POST', r.method === 'POST');
    const body = JSON.parse(r.body);
    ok('body.model 正确', body.model === 'deepseek-chat', body.model);
    ok('messages 有 system + user',
      body.messages.length === 2 && body.messages[0].role === 'system' && body.messages[1].role === 'user');
    ok('temperature 透传', body.temperature === 0.42, String(body.temperature));
    ok('max_tokens 透传', body.max_tokens === 777, String(body.max_tokens));
    ok('chatJSON 会带 response_format', body.response_format?.type === 'json_object',
      JSON.stringify(body.response_format));
  }

  // ============================================================
  console.log('\n【3】模型列表：两种返回结构都支持');
  {
    const a = await llm.listModels({ baseUrl: url('/v1'), apiKey: 'k' });
    ok('解析 OpenAI 风格 {data:[...]}', a.length === 3, JSON.stringify(a));
    const b = await llm.listModels({ baseUrl: url('/v1/bare'), apiKey: 'k' });
    ok('解析裸数组', b.join(',') === 'bare-a,bare-b', JSON.stringify(b));
  }

  // ============================================================
  console.log('\n【4】上游错误 → 可读错误');
  {
    const cases = [
      ['401', /HTTP 401/, 'API Key 无效'],
      ['404', /HTTP 404/, '路径不对'],
      ['429', /HTTP 429/, '限流'],
      ['500', /HTTP 500/, '服务端错误'],
    ];
    for (const [m, re, label] of cases) {
      mode = m;
      const client = llm.makeLLM({ baseUrl: url('/v1'), apiKey: 'k', model: 'm' });
      let err = null;
      try { await client.chatJSON('S', 'U', 'step1'); } catch (e) { err = e; }
      ok(`${label}（${m}）抛出可读错误`, err && re.test(err.message), err?.message?.slice(0, 80));
    }

    mode = 'html';
    const client = llm.makeLLM({ baseUrl: url('/v1'), apiKey: 'k', model: 'm' });
    let err = null;
    try { await client.chatJSON('S', 'U', 'step1'); } catch (e) { err = e; }
    ok('返回 HTML 时给出中文指引（而不是原始 JSON 报错）',
      !!err && /不是 JSON/.test(err.message) && /\/v1/.test(err.message),
      err?.message?.slice(0, 90));

    mode = 'ok';
  }

  // ============================================================
  console.log('\n【5】超时处理');
  {
    mode = 'slow';
    const client = llm.makeLLM({ baseUrl: url('/v1'), apiKey: 'k', model: 'm', requestTimeout: 700 });
    const t0 = Date.now();
    let err = null;
    try { await client.chatJSON('S', 'U', 'step1', { retries: 1 }); } catch (e) { err = e; }
    const ms = Date.now() - t0;
    ok('超时后抛出"请求超时"', !!err && /超时/.test(err.message), err?.message);
    ok('确实在超时时间附近返回', ms < 4000, `${ms}ms`);
    mode = 'ok';
  }

  // ============================================================
  console.log('\n【6】连通性测试 testConnection');
  {
    seen.length = 0;
    const r = await llm.testConnection({ baseUrl: url('/v1'), apiKey: 'sk-x', model: 'mock-large' });
    ok('返回 ok 与耗时', r.ok === true && typeof r.ms === 'number');
    ok('回显 model', r.model === 'mock-large', r.model);
    const body = JSON.parse(seen[0].body);
    ok('连通性测试用极短请求（max_tokens 很小）', body.max_tokens <= 32, String(body.max_tokens));
    ok('连通性测试温度为 0', body.temperature === 0, String(body.temperature));
    ok('带上了 API Key', seen[0].auth === 'Bearer sk-x', seen[0].auth);
  }

  // ============================================================
  console.log('\n【7】本地服务接口：/api/models 与 /api/ping');
  {
    const r1 = await fetch(`${BASE}/api/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: url('/v1'), apiKey: 'k' }),
    });
    const j1 = await r1.json();
    ok('POST /api/models 返回模型', Array.isArray(j1.models) && j1.models.length >= 2, JSON.stringify(j1));

    const r2 = await fetch(`${BASE}/api/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: '' }),
    });
    ok('缺少 baseUrl 时 400', r2.status === 400, String(r2.status));

    const r3 = await fetch(`${BASE}/api/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: url('/v1'), apiKey: 'k', model: 'mock-large' }),
    });
    const j3 = await r3.json();
    ok('POST /api/ping 连通', j3.ok === true, JSON.stringify(j3));

    const r4 = await fetch(`${BASE}/api/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: url('/v1') }),
    });
    ok('缺少 model 时 400', r4.status === 400, String(r4.status));

    // 上游 401 应转成 502 + 提示
    mode = '401';
    const r5 = await fetch(`${BASE}/api/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: url('/v1'), apiKey: 'bad', model: 'mock-large' }),
    });
    const j5 = await r5.json();
    ok('上游 401 → 502 且带中文说明', r5.status === 502 && /连接失败/.test(j5.error || ''), JSON.stringify(j5));
    ok('错误里点明 Key 无效', /API Key 无效/.test(j5.error || ''), j5.error);
    mode = 'ok';

    // 漏写 /v1 时应通过 warn 字段提示（不阻断请求）
    const r6 = await fetch(`${BASE}/api/ping`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'k', model: 'mock-large' }),
    });
    const j6 = await r6.json();
    ok('漏写 /v1 时返回 warn 提示', typeof j6.warn === 'string' && /\/v1/.test(j6.warn), JSON.stringify(j6.warn));
    ok('但仍照常尝试请求（不阻断）', j6.ok === true, JSON.stringify(j6).slice(0, 100));

    const r7 = await fetch(`${BASE}/api/models`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}`, apiKey: 'k' }),
    });
    const j7 = await r7.json();
    ok('/api/models 同样返回 warn', typeof j7.warn === 'string' && /\/v1/.test(j7.warn), JSON.stringify(j7.warn));
  }

  // ============================================================
  console.log('\n【8】生成接口确实使用了页面传来的 API 配置');
  {
    seen.length = 0;
    const fd = new FormData();
    fd.append('novel', new Blob([Buffer.from(
      '第一章 甲\n\n' + '林晚晴与沈砚在拍卖会上相遇。'.repeat(20) +
      '\n\n第二章 乙\n\n' + '暗中的布局已经持续三年。'.repeat(20) +
      '\n\n第三章 丙\n\n' + '真相逐渐浮出水面。'.repeat(20)
    )], { type: 'text/plain' }), 'api-test.txt');
    // 特意用带结尾斜杠、且 Key 有特殊字符的配置
    fd.append('baseUrl', `${url('/v1')}/`);
    fd.append('apiKey', 'sk-abc-123_XYZ');
    fd.append('model', 'mock-large');
    fd.append('userMode', 'auto');
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
          let p = null; try { p = JSON.parse(data.join('\n')); } catch {}
          events.push({ event: evt, data: p }); evt = null; data = [];
        }
      }
    }
    const err = events.find(e => e.event === 'error');
    ok('生成完成无错误', !err, JSON.stringify(err?.data));
    ok('上游收到了请求', seen.length > 0, String(seen.length));
    ok('上游收到的 Key 与页面一致', seen.every(s => s.auth === 'Bearer sk-abc-123_XYZ'),
      JSON.stringify([...new Set(seen.map(s => s.auth))]));
    ok('上游 path 未因结尾斜杠出错', seen.every(s => s.url === '/v1/chat/completions'),
      JSON.stringify([...new Set(seen.map(s => s.url))]));
    ok('上游收到的 model 与页面一致',
      seen.every(s => JSON.parse(s.body).model === 'mock-large'));

    const filesEvt = events.find(e => e.event === 'files');
    if (filesEvt) {
      const { rm } = await import('node:fs/promises');
      await rm(path.join(ROOT, 'output', filesEvt.data.taskId), { recursive: true, force: true });
    }
  }

  // ============================================================
  console.log('\n【9】缺少 API Key 时的行为');
  {
    // 云端地址且没有 Key，应在生成前就拦下
    const fd = new FormData();
    fd.append('novel', new Blob([Buffer.from('第一章 甲\n\n' + '内容'.repeat(300))]), 'x.txt');
    fd.append('baseUrl', 'https://api.example.com/v1');
    fd.append('apiKey', '');
    fd.append('model', 'm');
    const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: fd });
    const text = await res.text();
    ok('云端地址缺 Key 时给出错误', /缺少 API Key/.test(text), text.slice(-120));

    // 本地地址允许留空
    const fd2 = new FormData();
    fd2.append('novel', new Blob([Buffer.from('第一章 甲\n\n' + '内容'.repeat(300))]), 'y.txt');
    fd2.append('baseUrl', 'http://127.0.0.1:1/v1');
    fd2.append('apiKey', '');
    fd2.append('model', 'm');
    const res2 = await fetch(`${BASE}/api/generate`, { method: 'POST', body: fd2 });
    const t2 = await res2.text();
    ok('本地地址允许 Key 留空（不报"缺少 API Key"）', !/缺少 API Key/.test(t2), t2.slice(-120));
  }

  await new Promise((resolve) => {
    mock.closeAllConnections?.();
    mock.close(() => resolve());
    setTimeout(resolve, 1200);
  });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  API 配置：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(async e => {
  console.error('\n测试异常：', e);
  try { mock.close(); } catch {}
  process.exit(1);
});
