/**
 * 真实 DOM 冒烟测试（jsdom）
 *
 * frontend-smoke.mjs 用的是自制 DOM 桩；这里用 jsdom 提供真实 DOM 实现，
 * 用来验证真实的 value 语义、querySelector 选择器、表单控件与事件绑定。
 *
 * 依赖 jsdom 为可选：未安装时本文件会跳过（不阻塞 npm test）。
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
  console.log('\n⚠ 未安装 jsdom，跳过真实 DOM 测试（npm i -D jsdom 后可运行）\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

// ============================================================
// 真实 DOM
// ============================================================
const html = `<!DOCTYPE html><html lang="zh-CN" data-theme="dark"><head></head><body>
<div id="app"><aside class="sidebar"></aside><div class="main">
<header class="topbar"></header><main class="content"><div id="page"></div></main>
</div></div></body></html>`;

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:3000/#/dashboard',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

// jsdom 没有实现这些
window.confirm = () => true;
window.alert = () => {};
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};
if (!window.navigator.clipboard) {
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
}

globalThis.window = window;
globalThis.document = window.document;
const defineGlobal = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
  catch { try { globalThis[name] = value; } catch {} }
};
defineGlobal('navigator', window.navigator);
defineGlobal('location', window.location);
defineGlobal('localStorage', window.localStorage);
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.requestAnimationFrame = window.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
globalThis.setInterval = setInterval;
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

// ============================================================
// fetch 桩（与 frontend-smoke 同源数据）
// ============================================================
const fixtures = {
  'worldbook.json': {
    name: '生成的世界设定集',
    entries: [
      { id: 0, keys: [], comment: '[timeline]', content: '【时间线 · 基准：天启纪年】', constant: true, enabled: true, insertion_order: 1, position: 'after_char', extensions: { group: 'timeline' } },
      { id: 1, keys: ['云京'], comment: '[map_world] 云京', content: '云京为王朝都城。', constant: true, enabled: true, insertion_order: 5, position: 'after_char', extensions: { group: 'map_world' } },
      { id: 2, keys: ['开篇入城'], comment: '[event] 开篇入城', content: '【事件·开篇入城】', constant: false, enabled: true, insertion_order: 25, position: 'after_char', extensions: { group: 'event' } },
    ],
  },
  'variables.json': {
    world: { time: '天启三年春', phase: '入城立足' },
    events: { 开篇入城: { status: 'pending', deviation: 0, pressure: 'core' } },
    characters: { 沈砚: { affinity: 0, state: '正常' } },
    user: { name: '林昭' },
    custom: { storylines: { 入城立足: { events: ['开篇入城'], stage: '起点', deviation: 0, core: true } } },
  },
  'timeline.json': {
    base: '天启纪年',
    origin: { raw: '天启三年春', event: '开篇入城', reason: '最早绝对纪年' },
    events: [{ name: '开篇入城', time: '天启三年春', precision: 'exact', chapter: '第一章 入城' }],
    characters: [{ name: '林昭', birth: '（线索：十七岁）', chapter: '第一章 入城' }],
  },
  'events.json': [{
    name: '开篇入城', storyline: '入城立足', chapter: '第一章 入城', quote: '林昭踏进城门',
    canon: '林昭进入云京。', pressure: 'core',
    prerequisites: { temporal: [], behavioral: '若已见过沈砚' },
    interventions: [{ condition: '若直接报案', result: '线索提前暴露' }],
  }],
  'phases.json': [
    { name: '入城立足', startEvent: '开篇入城', endEvent: '初见沈砚', coreChange: '从孤身寻亲到获得助力', characterDeltas: [] },
    { name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: '从被动等待到主动追查', characterDeltas: [{ character: '林昭', change: '从谨慎观望变为主动出击', quote: '她握紧了那封信' }] },
  ],
  'user_mode.json': { mode: 'protagonist', protagonistName: '林昭', autoDetected: true, reason: '视角集中于林昭' },
  'preset_fragment.json': {
    b1_variables: 'world:\n  time: 天启三年春\nevents:\n  开篇入城:\n    status: pending\nuser:\n  name: 林昭\n',
    b2_update_rules: 'task: 在每次回复末尾输出 <update> 标签',
    b3_director: "【当前时间】<%= getvar('stat_data.world.time') %>",
    b4_persona_delta: "<%_ const 人设增量表 = { _%>\n<%_   '旧案浮现': `林昭：从谨慎观望变为主动出击`, _%>",
    b5_rules: { identity: 'B5-1 内容', timeline: 'B5-2 内容', fence: 'B5-3 内容', intervention: 'B5-4 内容', output: 'B5-5 内容' },
    config: { userMode: 'protagonist' },
  },
  'meta.json': {
    taskId: 'task_1001', createdAt: '2026-01-01T00:00:00.000Z', durationMs: 42000,
    model: 'mock-large', userMode: 'protagonist',
    counts: { chars: 688, chapters: 3, events: 3, storylines: 2, phases: 2, worldbookEntries: 6, characters: 2 },
    tokens: { a: 120, b: 900, limits: { maxA: 2000, maxB: 3500 } },
    warnings: [],
  },
  'README.md': '# 导入说明\n\n## 导入步骤\n\n### 1. 导入世界书（A 包）\nST → 世界书 → 导入',
};

const TASKS = [
  {
    taskId: 'task_1001', files: Object.keys(fixtures), running: false, hasLog: true,
    updatedAt: new Date().toISOString(), meta: fixtures['meta.json'],
    project: { title: '云京旧案', createdAt: '2026-01-01T00:00:00.000Z' },
  },
];

const fetchLog = [];
const json = (obj, status = 200) => ({
  ok: status < 400, status,
  async json() { return obj; },
  async text() { return JSON.stringify(obj); },
});

const fetchStub = async (url, opts = {}) => {
  const u = String(url);
  fetchLog.push(`${opts.method || 'GET'} ${u}`);
  if (u.includes('/api/system')) {
    return json({
      ok: true, node: process.version, platform: process.platform, cwd: ROOT, port: 3000,
      uploads: path.join(ROOT, 'uploads'), outputs: path.join(ROOT, 'output'),
      running: [], uptimeSec: 120,
    });
  }
  if (u.includes('/log')) {
    return json({ events: [{ event: 'progress', data: { step: 'Init', msg: '读入 688 字' }, ts: Date.now() }], running: false });
  }
  if (u.match(/\/file\/(.+)$/)) {
    const name = decodeURIComponent(u.match(/\/file\/(.+)$/)[1]);
    const fx = fixtures[name];
    if (!fx) return json({ error: '文件不存在' }, 404);
    const content = typeof fx === 'string' ? fx : JSON.stringify(fx, null, 2);
    return json({ name, content, size: content.length });
  }
  // 任务详情：/api/tasks/<id>（注意要在 /api/tasks 之前判断）
  const detail = u.match(/\/api\/tasks\/([^/?]+)$/);
  if (detail && (opts.method || 'GET') === 'GET') {
    const t = TASKS.find(x => x.taskId === detail[1]);
    return t ? json(t) : json({ error: '任务不存在' }, 404);
  }
  if (u.includes('/api/tasks')) return json({ tasks: TASKS, running: [] });
  if (u.includes('/api/models')) return json({ models: ['mock-large'] });
  if (u.includes('/api/ping')) return json({ ok: true, ms: 210, model: 'mock-large', reply: '正常' });
  if (u.includes('/reveal')) {
    return json({ ok: false, dir: 'D:\\out\\task_1001', hint: '当前环境不允许打开文件管理器，请手动访问上面的路径' });
  }
  if (u.includes('/api/estimate')) return json({ chars: 688, tokens: 441, chapters: 3, preview: [{ title: '第一章 入城', chars: 230 }] });
  if (u.includes('/api/generate')) {
    const events = [
      ['start', { taskId: 'task_2000' }],
      ['progress', { step: 'Init', msg: '读入 688 字' }],
      ['progress', { step: 'Step 1', msg: '时间线：3 事件' }],
      ['files', { taskId: 'task_2000', files: ['worldbook.json', 'preset_fragment.json'], meta: fixtures['meta.json'] }],
      ['done', { ok: true }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
      ok: true, status: 200,
      body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })) }) },
    };
  }
  return json({ error: '未桩化: ' + u }, 404);
};

globalThis.fetch = fetchStub;
window.fetch = fetchStub;

// ============================================================
// 测试
// ============================================================
async function main() {
  console.log('\n【A】应用在真实 DOM 中加载');
  await import(pathToFileURL(path.join(PUB, 'js/app.js')).href);
  await new Promise(r => setTimeout(r, 150));

  // 8 项：新增「图片生成角色卡」后从 7 变 8
  ok('侧边栏 8 个导航项', window.document.querySelectorAll('.nav-item').length === 8,
    String(window.document.querySelectorAll('.nav-item').length));
  ok('总览标题渲染', window.document.querySelector('.topbar .title')?.textContent === '总览',
    window.document.querySelector('.topbar .title')?.textContent);
  ok('总览页有内容', window.document.querySelector('#page .hero') !== null);
  ok('命令栏存在', window.document.querySelector('.cmdbar input') !== null);

  console.log('\n【B】真实表单值语义（jsdom 会校验 setAttribute vs 属性赋值）');
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 150));

  const inputs = [...window.document.querySelectorAll('#page input')];
  const baseInput = inputs.find(i => i.type === 'text' && i.value.startsWith('http'));
  const modelInput = inputs.find(i => i.type === 'text' && /gpt|deepseek|qwen/i.test(i.value));
  ok('Base URL 输入框有真实值', !!baseInput && baseInput.value.length > 8, JSON.stringify(baseInput?.value));
  ok('模型输入框有真实值', !!modelInput && modelInput.value.length > 2, JSON.stringify(modelInput?.value));
  ok('存在密码类型输入框', inputs.some(i => i.type === 'password'));

  const selects = [...window.document.querySelectorAll('#page select')];
  ok('user 模式下拉有 4 个选项', selects.some(s => s.options.length === 4),
    JSON.stringify(selects.map(s => s.options.length)));
  /**
   * 按 name 找，**不按下标** —— 页面新增下拉（如"生成档位"）会插到前面，
   * 下标断言会假失败。这个坑踩过一次。
   */
  const userModeSelect = selects.find(s => s.name === 'userMode') || selects[0];
  ok('下拉可被赋值选中（userMode）', userModeSelect.value === 'auto', userModeSelect.value);
  // 新增的生成档位下拉：默认基础版
  const levelSelect = selects.find(s => s.name === 'detailLevel');
  ok('存在「生成档位」下拉且默认 basic',
    !!levelSelect && levelSelect.value === 'basic', JSON.stringify(levelSelect?.value));

  console.log('\n【C】页面切换与选择器');
  for (const [hash, sel, label] of [
    ['#/card?task=task_1001', '.wb-entry', '角色卡内容'],
    ['#/preset?task=task_1001', '.preset-block', '预设规则'],
    ['#/library?task=task_1001', '.task', '任务与产物'],
    ['#/commands', '.cmd-row', '命令参考'],
    ['#/settings', '.card', '设置'],
    ['#/dashboard', '.hero', '总览'],
    ['#/image-card', '.dropzone', '图片生成角色卡'],
  ]) {
    window.location.hash = hash;
    await new Promise(r => setTimeout(r, 180));
    const n = window.document.querySelectorAll('#page ' + sel).length;
    const text = window.document.querySelector('#page')?.textContent || '';
    ok(`${label}：${sel} 渲染出元素`, n > 0 && !text.includes('页面渲染失败'), `n=${n}`);
  }

  console.log('\n【C2】图片生成角色卡页的关键控件');
  {
    window.location.hash = '#/image-card';
    await new Promise(r => setTimeout(r, 200));
    const p = window.document.querySelector('#page');
    // 文件选择必须支持多选（一次传多张图是本功能的核心用法）
    const fileInput = p.querySelector('input[type=file]');
    ok('有文件选择控件', !!fileInput);
    ok('文件选择支持多选', fileInput?.multiple === true);
    ok('accept 限定图片格式', /png|jpg|jpeg|webp|gif/.test(fileInput?.getAttribute('accept') || ''),
      fileInput?.getAttribute('accept'));
    // 每个控件都要有 id/name（表单规范）
    const ctrls = [...p.querySelectorAll('input, textarea, select')];
    ok('控件都带 id', ctrls.every(c => c.id), JSON.stringify(ctrls.filter(c => !c.id).map(c => c.outerHTML.slice(0, 50))));
    ok('控件都带 name', ctrls.every(c => c.name), JSON.stringify(ctrls.filter(c => !c.name).map(c => c.outerHTML.slice(0, 50))));
    ok('有标题输入框', !!p.querySelector('#image-card-title'));
    ok('有文字补充设定框', !!p.querySelector('#image-card-hint'));
    ok('有世界观开关', !!p.querySelector('#image-card-world'));
    // 长漫画支持：每批张数可调
    const batchEl = p.querySelector('#image-card-batch');
    ok('有每批张数输入框', !!batchEl);
    ok('每批张数默认值与后端一致（6）', batchEl?.value === '6', String(batchEl?.value));
    ok('每批张数有上下限', batchEl?.min === '1' && batchEl?.max === '12',
      `${batchEl?.min}..${batchEl?.max}`);
    ok('页面说明会自动分批', /分批/.test(p.textContent || ''), '');
    ok('页面说明含新的上限张数', /最多 60 张/.test(p.textContent || ''), '');
    ok('有开始按钮', [...p.querySelectorAll('button')].some(b => /开始生成/.test(b.textContent)));
    ok('页面说明需要视觉模型', /视觉/.test(p.textContent || ''), '');
  }

  window.location.hash = '#/preset?task=task_1001';
  await new Promise(r => setTimeout(r, 200));
  const presetText = window.document.querySelector('#page')?.textContent || '';
  ok('预设页含 B1–B5 标签', ['B1 · 变量初始化', 'B2 · 更新规则', 'B5-5 · 输出格式'].every(k => presetText.includes(k)),
    presetText.slice(0, 120));
  const presetBlocks = window.document.querySelectorAll('#page .preset-block');
  ok('预设块展开后有正文', presetBlocks.length === 9 && presetBlocks[0].textContent.length > 20,
    `${presetBlocks.length} 块 / 首块 ${presetBlocks[0]?.textContent.length} 字符`);

  window.location.hash = '#/card?task=task_1001';
  await new Promise(r => setTimeout(r, 180));
  const wbText = window.document.querySelector('#page')?.textContent || '';
  ok('世界书条目显示备注与正文', wbText.includes('[timeline]') && wbText.includes('云京为王朝都城。'), wbText.slice(0, 120));

  console.log('\n【D】真实 DOM 下的生成流程');
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 180));
  // 用显式 id：生成页现在有多个 file 控件（#f-novel / #f-card / #f-images）
  const fileInput = window.document.querySelector('#page #f-novel');
  ok('文件输入存在', !!fileInput);

  // jsdom 支持 DataTransfer 时构造 FileList；否则退化为数组
  // jsdom 的 Blob.text 支持不稳定，直接桩掉，专注验证上层流程
  const file = new window.File(['第一章 测试\n' + '正文'.repeat(300)], '测试.txt', { type: 'text/plain' });
  file.text = async () => '第一章 测试\n' + '正文'.repeat(300);
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  // 文件读取 + 预估是异步的，轮询等待而不是固定 sleep
  for (let i = 0; i < 30 && !fetchLog.some(f => f.includes('/api/estimate')); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  ok('选择文件后触发本地预估', fetchLog.some(f => f.includes('/api/estimate')),
    fetchLog.slice(-3).join('; ') + ' || 预览区: ' + (window.document.querySelector('#page .hint')?.textContent || '').slice(0, 80));

  const startBtn = [...window.document.querySelectorAll('#page button')].find(b => b.textContent.includes('开始生成'));
  ok('开始生成按钮存在', !!startBtn);
  startBtn.click();
  for (let i = 0; i < 40 && !fetchLog.some(f => f.includes('/api/generate')); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 250));

  const genText = window.document.querySelector('#page')?.textContent || '';
  ok('生成请求已发出', fetchLog.some(f => f.includes('/api/generate')), fetchLog.slice(-3).join('; '));
  ok('界面显示生成完成', genText.includes('生成完成'), genText.slice(-200));
  ok('产物清单渲染', window.document.querySelectorAll('#page .file-chip').length >= 2,
    String(window.document.querySelectorAll('#page .file-chip').length));
  ok('进度条到 100%', genText.includes('100%'));

  console.log('\n【E】命令面板与终端（真实事件）');
  const before = window.document.querySelectorAll('.palette').length;
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  await new Promise(r => setTimeout(r, 60));
  ok('Ctrl+K 打开命令面板', window.document.querySelectorAll('.palette').length === before + 1);
  const paletteInput = window.document.querySelector('.palette-input input');
  ok('面板输入框存在', !!paletteInput);
  if (paletteInput) {
    paletteInput.value = 'doc';
    paletteInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    const items = [...window.document.querySelectorAll('.palette-item')].map(i => i.textContent);
    ok('面板能搜到 doctor', items.some(t => t.includes('doctor')), items.join(' | ').slice(0, 120));
    paletteInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    ok('Esc 关闭面板', window.document.querySelectorAll('.palette').length === before);
  }

  const cmdInput = window.document.querySelector('.cmdbar input');
  cmdInput.value = 'status';
  cmdInput.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const termText = window.document.querySelector('.cmd-term')?.textContent || '';
  ok('终端输出 status 结果', termText.includes('本地服务') || termText.includes('服务'), termText.slice(0, 160));
  ok('终端记录了输入回显', termText.includes('status'));

  console.log('\n【F】CSS 与选择器一致性');
  const css = await import('node:fs/promises').then(fs =>
    Promise.all([
      fs.readFile(path.join(PUB, 'css/base.css'), 'utf-8'),
      fs.readFile(path.join(PUB, 'css/panels.css'), 'utf-8'),
    ]).then(a => a.join('\n')));
  const classes = new Set();
  for (const el of window.document.querySelectorAll('*')) for (const c of el.classList) classes.add(c);
  const unused = [...classes].filter(c => !css.includes('.' + c) && !c.startsWith('sel') && !c.startsWith('active'));
  ok('页面用到的 class 基本都在 CSS 里有定义', unused.length <= 6, `未覆盖：${unused.join(', ')}`);

  const styles = window.document.styleSheets.length;
  ok('CSS 已注入（含主题变量）', css.includes('--accent') && css.includes('data-theme'));

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  真实 DOM 冒烟：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
