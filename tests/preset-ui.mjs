/**
 * 生成预设 UI 测试（jsdom 真实 DOM）
 *
 * 覆盖：状态行、编辑与「应用编辑」、导入/导出/清空、持久化、
 * replace 二次确认、预览弹层、生成时真的把预设提交给后端。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过预设 UI 测试\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

// ------------------------------------------------------------
const dom = new JSDOM(`<!DOCTYPE html><html data-theme="dark"><body>
<div id="app"><aside class="sidebar"></aside><div class="main">
<header class="topbar"></header><main class="content"><div id="page"></div></main>
</div></div></body></html>`, { url: 'http://127.0.0.1:3000/#/generate', pretendToBeVisual: true });
const { window } = dom;

window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.alert = () => {};
let confirmAnswer = true;
window.confirm = () => confirmAnswer;
Object.defineProperty(window.navigator, 'clipboard', {
  value: { writeText: async (t) => { window.__copied = t; } }, configurable: true,
});

const defineGlobal = (n, v) => {
  try { Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true }); }
  catch { try { globalThis[n] = v; } catch {} }
};
globalThis.window = window;
globalThis.document = window.document;
defineGlobal('navigator', window.navigator);
defineGlobal('location', window.location);
defineGlobal('localStorage', window.localStorage);
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
// jsdom 不把 confirm 装到 globalThis；应用代码里用的是裸 confirm(...)
globalThis.confirm = (...args) => window.confirm(...args);
globalThis.alert = () => {};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

// ------------------------------------------------------------
// fetch 桩：记录 /api/generate 的 FormData
// ------------------------------------------------------------
const calls = [];
let generatePayload = null;
const json = (o, s = 200) => ({ ok: s < 400, status: s, async json() { return o; }, async text() { return JSON.stringify(o); } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(`${opts.method || 'GET'} ${u}`);

  if (u.includes('/api/generate')) {
    const fd = opts.body;
    generatePayload = {};
    for (const [k, v] of fd.entries()) {
      // jsdom 下给 file input 覆写 files 后，FormData 里可能是 File 也可能是其字符串形式
      const looksLikeFile = typeof v === 'object' && v !== null && ('size' in v || 'lastModified' in v);
      generatePayload[k] = looksLikeFile ? `[file:${v.name || 'blob'}]` : String(v);
    }
    const events = [
      ['start', { taskId: 'task_p1' }],
      ['progress', { step: 'Init', msg: '已应用预设' }],
      ['files', { taskId: 'task_p1', files: ['worldbook.json'], meta: { counts: {}, tokens: { a: 1, b: 1 } } }],
      ['done', { ok: true }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })) }) } };
  }
  if (u.includes('/api/preset/steps')) {
    return json({ steps: ['step0.5', 'step1', 'step2', 'step3', 'step4', 'step5'].map(n => ({ name: n, label: n })) });
  }
  if (u.includes('/api/preset/preview')) {
    const body = JSON.parse(opts.body);
    return json({
      step: body.step, mode: body.preset.mode, changed: true, warnings: [],
      system: `【内置指令】…\n\n---\n${body.preset.steps?.[body.step]?.system_suffix || body.preset.global?.system_suffix || ''}`,
      user: '章节原文',
    });
  }
  if (u.includes('/api/system')) return json({ ok: true, node: 'v', platform: 'win32', cwd: ROOT, port: 3000, uploads: '', outputs: '', running: [], uptimeSec: 1 });
  if (u.includes('/api/tasks')) return json({ tasks: [], running: [] });
  if (u.includes('/api/models')) return json({ models: ['mock-a'] });
  if (u.includes('/api/estimate')) return json({ chars: 1, tokens: 1, chapters: 1, preview: [] });
  return json({ error: '未桩化: ' + u }, 404);
};

// ------------------------------------------------------------
async function main() {
  await import(pathToFileURL(path.join(PUB, 'js/app.js')).href);
  await new Promise(r => setTimeout(r, 200));

  const { validatePreset } = await import(pathToFileURL(path.join(PUB, 'js/core/preset-manager.js')).href);
  const { state } = await import(pathToFileURL(path.join(PUB, 'js/core/store.js')).href);
  const page = () => window.document.getElementById('page');

  console.log('\n【A】预设卡片渲染');
  ok('生成页含「生成预设」卡片',
    [...page().querySelectorAll('h3')].some(h => h.textContent.includes('生成预设')),
    [...page().querySelectorAll('h3')].map(h => h.textContent).join(' | '));
  const status = page().querySelector('.preset-status');
  ok('状态行存在', !!status, page().textContent.slice(0, 80));
  ok('初始状态为未加载', /未加载预设/.test(status.textContent), status.textContent);
  ok('初始为 muted 语气', status.classList.contains('muted'), status.className);

  const editor = page().querySelector('#preset-editor');
  ok('编辑器存在且有 id/name', !!editor && editor.getAttribute('name') === 'presetJson',
    JSON.stringify(editor?.getAttribute('name')));
  ok('编辑器有 label 关联', !!page().querySelector('label[for="preset-editor"]'));

  const btns = [...page().querySelectorAll('button')].map(b => b.textContent.trim());
  for (const label of ['导入预设', '导出当前预设', '复制 JSON', '填入示例', '清空', '应用编辑']) {
    ok(`按钮存在：${label}`, btns.includes(label), btns.join(' | ').slice(0, 200));
  }
  ok('所有新增按钮都是 type=button',
    [...page().querySelectorAll('button')].every(b => b.getAttribute('type') === 'button'));

  console.log('\n【B】填入示例 → 校验 → 应用');
  const clickBtn = (label) => {
    const b = [...page().querySelectorAll('button')].find(x => x.textContent.trim() === label);
    b?.click();
    return !!b;
  };
  ok('点击「填入示例」', clickBtn('填入示例'));
  await new Promise(r => setTimeout(r, 60));
  const filled = JSON.parse(editor.value);
  ok('编辑器填入 5 个 Step', Object.keys(filled.steps).length === 5, Object.keys(filled.steps).join(','));
  ok('示例为 append 模式', filled.mode === 'append');

  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500)); // 等防抖校验
  const statusMsg = page().querySelector('#preset-editor-msg')?.textContent || '';
  ok('实时校验提示合法', /✓ 合法/.test(statusMsg), statusMsg.slice(0, 140));

  clickBtn('应用编辑');
  await new Promise(r => setTimeout(r, 60));
  ok('应用编辑后写入配置', !!state.config.preset && state.config.preset.name === '我的预设',
    JSON.stringify(state.config.preset?.name));
  const status2 = page().querySelector('.preset-status');
  ok('状态行变为已加载', /已加载：我的预设/.test(status2.textContent), status2.textContent);
  ok('状态行标为 ok（append）', status2.classList.contains('ok'), status2.className);
  ok('显示生效的 Step 明细', page().querySelectorAll('.preset-line').length === 5,
    String(page().querySelectorAll('.preset-line').length));
  ok('持久化到 localStorage',
    JSON.parse(window.localStorage.getItem('n2c.state.v1')).config.preset.name === '我的预设');

  console.log('\n【C】非法 JSON 处理');
  editor.value = '{ 坏 json';
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  const errMsg = page().textContent;
  ok('提示 JSON 解析失败', /JSON 解析失败/.test(errMsg), errMsg.slice(-140));
  const before = JSON.stringify(state.config.preset);
  clickBtn('应用编辑');
  await new Promise(r => setTimeout(r, 60));
  ok('非法内容不会被应用（保留原预设）', JSON.stringify(state.config.preset) === before);

  console.log('\n【D】replace 模式的危险提示');
  editor.value = JSON.stringify({
    name: '替换预设', mode: 'replace',
    steps: { step2: { system_suffix: '只用我的指令，但仍输出 JSON。' } },
  }, null, 2);
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  ok('校验提示 replace 风险', /replace/.test(page().textContent), page().textContent.slice(-160));
  clickBtn('应用编辑');
  await new Promise(r => setTimeout(r, 60));
  ok('replace 已应用', state.config.preset.mode === 'replace');
  ok('状态行标为 warn', page().querySelector('.preset-status').classList.contains('warn'),
    page().querySelector('.preset-status').className);

  console.log('\n【E】生成时二次确认 + 提交预设');
  // 用显式 id：生成页有多个 file 控件（#f-novel / #f-card / #f-images）
  const fileInput = page().querySelector('#page #f-novel');
  const file = new window.File(['x'], '测试.txt', { type: 'text/plain' });
  file.text = async () => '第一章 测试\n' + '正文'.repeat(300);
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));

  const startBtn = [...page().querySelectorAll('button')].find(b => b.textContent.includes('开始生成'));
  confirmAnswer = false;
  startBtn.click();
  await new Promise(r => setTimeout(r, 200));
  ok('replace 模式下用户拒绝确认则不生成',
    !calls.some(c => c.includes('/api/generate')), calls.slice(-2).join('; '));

  confirmAnswer = true;
  startBtn.click();
  for (let i = 0; i < 40 && !generatePayload; i++) await new Promise(r => setTimeout(r, 50));
  ok('确认后发出生成请求', !!generatePayload, calls.slice(-2).join('; '));
  ok('请求里带上了 preset 字段', !!generatePayload?.preset, Object.keys(generatePayload || {}).join(','));  const sentPreset = JSON.parse(generatePayload?.preset || '{}');
  ok('提交的预设内容正确',
    sentPreset.name === '替换预设' && sentPreset.mode === 'replace' &&
    sentPreset.steps.step2.system_suffix.includes('只用我的指令'),
    JSON.stringify(sentPreset).slice(0, 140));
  // 注意：jsdom 下给 file input 覆写 files 会把 File 强制转成 "[object File]" 字符串，
  // 这是桩的限制，因此这里只断言「文件名标识存在」，真实文件上传由 e2e 测试覆盖。
  ok('同时提交了常规字段（含小说文件）',
    !!generatePayload.baseUrl && !!generatePayload.model &&
    (generatePayload.novel === '[file:测试.txt]' || generatePayload.novel === '[object File]'),
    JSON.stringify({ b: generatePayload.baseUrl, m: generatePayload.model, n: generatePayload.novel }));

  console.log('\n【F】append 模式不弹确认');
  editor.value = JSON.stringify({ name: '安全预设', mode: 'append', global: { system_suffix: '安全后缀' } }, null, 2);
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  clickBtn('应用编辑');
  await new Promise(r => setTimeout(r, 60));
  generatePayload = null;
  confirmAnswer = false; // 若误弹确认框，生成会被中断
  startBtn.click();
  for (let i = 0; i < 40 && !generatePayload; i++) await new Promise(r => setTimeout(r, 50));
  ok('append 模式无需确认即可生成', !!generatePayload);
  ok('提交的是 append 预设', JSON.parse(generatePayload?.preset || '{}').mode === 'append');
  confirmAnswer = true;

  console.log('\n【G】预览弹层');
  await new Promise(r => setTimeout(r, 300));
  const previewBtn = [...page().querySelectorAll('button')].find(b => b.textContent.includes('预览实际 prompt'));
  ok('存在预览按钮', !!previewBtn, [...page().querySelectorAll('button')].map(b => b.textContent).join('|').slice(0, 200));
  if (previewBtn) {
    previewBtn.click();
    for (let i = 0; i < 30 && !window.document.querySelector('.palette'); i++) await new Promise(r => setTimeout(r, 50));
    const modal = window.document.querySelector('.palette');
    ok('预览弹层已打开', !!modal);
    await new Promise(r => setTimeout(r, 250));
    const modalText = modal?.textContent || '';
    ok('弹层显示预设名与模式', /安全预设/.test(modalText) && /append/.test(modalText), modalText.slice(0, 100));
    ok('弹层显示生效标记', /预设已生效/.test(modalText), modalText.slice(0, 200));
    ok('弹层展示了合并后的 system', /安全后缀/.test(modalText), modalText.slice(-120));
    const stepSel = modal?.querySelector('select');
    // 8 项 = 原有 7 个 Step + 分批评析新增的「分批摘要」
    ok('弹层有 Step 选择器且 8 项', stepSel?.options.length === 8, String(stepSel?.options.length));
    if (stepSel) {
      stepSel.value = 'step5';
      stepSel.dispatchEvent(new window.Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      ok('切换 Step 会重新请求预览',
        calls.filter(c => c.includes('/api/preset/preview')).length >= 2,
        String(calls.filter(c => c.includes('/api/preset/preview')).length));
    }
    [...window.document.querySelectorAll('.palette button')].find(b => b.textContent === '关闭')?.click();
    ok('可关闭弹层', !window.document.querySelector('.palette'));
  }

  console.log('\n【H】清空');
  await new Promise(r => setTimeout(r, 200));
  const clearBtn = [...page().querySelectorAll('button')].find(b => b.textContent.trim() === '清空');
  clearBtn?.click();
  await new Promise(r => setTimeout(r, 80));
  ok('清空后配置里没有预设', !state.config.preset, JSON.stringify(state.config.preset));
  ok('编辑器被清空', page().querySelector('#preset-editor').value === '');
  ok('状态行回到未加载', /未加载预设/.test(page().querySelector('.preset-status').textContent));
  ok('localStorage 里也清空了',
    !JSON.parse(window.localStorage.getItem('n2c.state.v1')).config.preset);

  console.log('\n【I】复制与导出');
  editor.value = JSON.stringify({ name: '导出测试', mode: 'append', global: { system_suffix: 'S' } });
  editor.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 500));
  clickBtn('应用编辑');
  await new Promise(r => setTimeout(r, 60));
  clickBtn('复制 JSON');
  await new Promise(r => setTimeout(r, 80));
  ok('复制到剪贴板的内容是预设 JSON',
    /"name": "导出测试"/.test(window.__copied || ''), (window.__copied || '').slice(0, 60));
  ok('预设校验器可直接复用（与后端同源）',
    validatePreset('{"name":"a","steps":{"step2":{"system_suffix":"b"}}}').ok === true);

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  预设 UI 测试：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
