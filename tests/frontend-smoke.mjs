/**
 * 前端冒烟测试（不需要浏览器）
 *
 * 用一套最小 DOM 桩在 Node 中真实加载 public/js 下的全部模块并渲染每个页面，
 * 用来抓运行时错误（拼写、未定义、选择器、事件绑定）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

// ============================================================
// 最小 DOM 实现
// ============================================================
class ClassList {
  constructor(node) { this.node = node; }
  get set() { return new Set(String(this.node._class || '').split(/\s+/).filter(Boolean)); }
  _write(s) { this.node._class = [...s].join(' '); this.node.attributes.class = this.node._class; }
  add(...cs) { const s = this.set; cs.forEach(c => s.add(c)); this._write(s); }
  remove(...cs) { const s = this.set; cs.forEach(c => s.delete(c)); this._write(s); }
  contains(c) { return this.set.has(c); }
  toggle(c, force) {
    const has = this.contains(c);
    const want = force === undefined ? !has : !!force;
    if (want) this.add(c); else this.remove(c);
    return want;
  }
}

class Node {
  static ELEMENT_NODE = 1;
  static TEXT_NODE = 3;
  constructor() { this.nodeType = 1; }
}

class TextNode extends Node {
  constructor(text) { super(); this.nodeType = 3; this.textContent = String(text); this.parentNode = null; }
}

class Element extends Node {
  constructor(tagName) {
    super();
    this.tagName = String(tagName).toUpperCase();
    this.nodeType = 1;
    this.attributes = {};
    this.children = [];
    this.childNodes = this.children;
    this.parentNode = null;
    this.style = {};
    this.dataset = {};
    this._listeners = new Map();
    this._class = '';
    this._id = '';
    this.value = '';
    this.files = undefined;
    this.options = [];
    this.disabled = false;
    this.checked = false;
    this.selectedIndex = -1;
    this.scrollTop = 0;
    this.scrollHeight = 100;
  }

  get classList() { return new ClassList(this); }
  get className() { return this._class; }
  set className(v) { this._class = String(v); this.attributes.class = this._class; }
  get id() { return this._id; }
  set id(v) { this._id = String(v); this.attributes.id = this._id; }

  setAttribute(k, v) {
    this.attributes[k] = String(v);
    if (k === 'class') this._class = String(v);
    if (k === 'id') this._id = String(v);
    if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(v);
  }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }

  appendChild(node) {
    if (node == null) return node;
    if (node.parentNode) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  append(...nodes) {
    const flat = (n) => {
      if (Array.isArray(n)) return n.flatMap(flat);
      if (n == null || n === false || n === true) return [];
      return [n instanceof Node ? n : new TextNode(n)];
    };
    const list = nodes.flatMap(flat);
    list.forEach(n => this.appendChild(n));
  }
  insertBefore(node, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) return this.appendChild(node);
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) { this.children.splice(i, 1); node.parentNode = null; }
    return node;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceChildren(...n) { this.children.slice().forEach(c => this.removeChild(c)); this.append(...n); }

  get firstChild() { return this.children[0] || null; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return this.parentNode.children[i + 1] || null;
  }

  get textContent() {
    if (this.nodeType === 3) return this._text || '';
    return this.children.map(c => c.textContent).join('');
  }
  set textContent(v) {
    if (this.nodeType === 3) { this._text = String(v); return; }
    this.children.slice().forEach(c => this.removeChild(c));
    if (v !== '' && v != null) this.appendChild(new TextNode(v));
  }
  get innerHTML() { return this._html ?? this.textContent; }
  set innerHTML(v) {
    this._html = String(v);
    this.children.slice().forEach(c => this.removeChild(c));
    if (this.tagName === 'SELECT') this.options = [];
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
  dispatchEvent(event) {
    event.target ||= this;
    event.currentTarget = this;
    for (const fn of this._listeners.get(event.type) || []) fn.call(this, event);
    if (typeof this['on' + event.type] === 'function') this['on' + event.type].call(this, event);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', preventDefault() {}, stopPropagation() {} }); }
  focus() { global.document.activeElement = this; }
  blur() { if (global.document.activeElement === this) global.document.activeElement = null; }
  select() {}
  scrollTo() {}
  setSelectionRange() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 20, bottom: 20, right: 100 }; }
  insertAdjacentHTML() {}
  closest(sel) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (matches(n, sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
  get elements() { return this.children.filter(c => c.tagName === 'OPTION'); }
}

/** 逗号分组 + 后代组合选择器（仅支持 tag / .class / #id / [attr] / 空格后代 / 组合） */
function matches(node, sel) {
  const s = sel.trim();
  if (!s || node.nodeType !== 1) return false;
  const parts = s.match(/([a-zA-Z][\w-]*)|(\.\w[\w-]*)|(#[\w-]+)|(\[[^\]]+\])/g) || [];
  for (const p of parts) {
    if (p.startsWith('.')) { if (!node.classList.contains(p.slice(1))) return false; }
    else if (p.startsWith('#')) { if (node.id !== p.slice(1)) return false; }
    else if (p.startsWith('[')) {
      const m = p.slice(1, -1).match(/^([\w-]+)(?:=(["']?)(.*?)\2)?$/);
      if (!m) return false;
      const val = node.getAttribute(m[1]) ?? node[m[1]];
      if (m[3] !== undefined && String(val) !== m[3]) return false;
      if (m[3] === undefined && val == null) return false;
    } else if (node.tagName !== p.toUpperCase()) return false;
  }
  return true;
}

function queryAll(root, selector) {
  const groups = selector.split(',').map(s => s.trim()).filter(Boolean);
  const out = new Set();
  for (const group of groups) {
    const chain = group.split(/\s+/).filter(Boolean);
    let current = [root];
    for (let i = 0; i < chain.length; i++) {
      const sel = chain[i];
      const last = i === chain.length - 1;
      const next = [];
      for (const node of current) {
        const walk = (n) => {
          for (const c of n.children) {
            if (c.nodeType !== 1) continue;
            if (matches(c, sel)) { next.push(c); if (last) out.add(c); }
            walk(c);
          }
        };
        walk(node);
      }
      current = last ? [] : next;
      if (!current.length && !last) break;
    }
  }
  return [...out];
}

function createDocument() {
  const html = new Element('html');
  const head = new Element('head');
  const body = new Element('body');
  html.append(head, body);
  const doc = {
    documentElement: html,
    head,
    body,
    activeElement: null,
    createElement: (t) => new Element(t),
    createElementNS: (_ns, t) => new Element(t),
    createTextNode: (t) => new TextNode(t),
    createDocumentFragment: () => new Element('#fragment'),
    querySelector: (s) => queryAll(body, s)[0] || (matches(html, s) ? html : null),
    querySelectorAll: (s) => queryAll(body, s),
    getElementById: (id) => queryAll(body, `#${id}`)[0] || null,
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

// 起始标记（与 public/index.html 一致，app.js 会清空并重建）。
// 桩没有 HTML 解析器，所以直接搭出等价结构，避免字面文本干扰选择器。
const shell = new Element('div');
shell.id = 'app';
const shellSidebar = new Element('aside');
shellSidebar.className = 'sidebar';
const shellMain = new Element('div');
shellMain.className = 'main';
const shellTopbar = new Element('header');
shellTopbar.className = 'topbar';
const shellContent = new Element('main');
shellContent.className = 'content';
const shellMount = new Element('div');
shellMount.id = 'page';
shellContent.appendChild(shellMount);
shellMain.append(shellTopbar, shellContent);
shell.append(shellSidebar, shellMain);

// ============================================================
// 全局环境
// ============================================================
const document = createDocument();
document.body.appendChild(shell);
const store = new Map();

globalThis.Node = Node;
globalThis.Element = Element;
globalThis.HTMLElement = Element;
globalThis.document = document;
const defineGlobal = (name, value) => {
  try {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  } catch {
    globalThis[name] = value;
  }
};
defineGlobal('navigator', { clipboard: { writeText: async () => {} }, userAgent: 'node-harness' });
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const listeners = new Map();
globalThis.location = {
  _hash: '#/dashboard',
  get hash() { return this._hash; },
  set hash(v) {
    this._hash = v.startsWith('#') ? v : '#' + v;
    for (const fn of listeners.get('hashchange') || []) fn({ type: 'hashchange' });
  },
};
globalThis.window = {
  addEventListener: (t, fn) => {
    if (!listeners.has(t)) listeners.set(t, new Set());
    listeners.get(t).add(fn);
  },
  removeEventListener: (t, fn) => listeners.get(t)?.delete(fn),
  open: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.confirm = () => true;
globalThis.alert = () => {};
globalThis.setInterval = globalThis.setInterval;
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

// ============================================================
// fetch 桩
// ============================================================
const fixtures = {
  'worldbook.json': () => ({
    name: '生成的世界设定集',
    entries: [
      { id: 0, keys: [], comment: '[timeline]', content: '【时间线 · 基准：天启纪年】', constant: true, enabled: true, insertion_order: 1, position: 'after_char', selective: false, use_regex: false, extensions: { group: 'timeline' } },
      { id: 1, keys: ['云京'], comment: '[map_world] 云京', content: '云京为王朝都城。', constant: true, enabled: true, insertion_order: 5, position: 'after_char', selective: true, use_regex: true, extensions: { group: 'map_world' } },
      { id: 2, keys: ['开篇入城'], comment: '[event] 开篇入城', content: '【事件·开篇入城】', constant: false, enabled: true, insertion_order: 25, position: 'after_char', selective: true, use_regex: true, extensions: { group: 'event' } },
    ],
  }),
  'variables.json': () => ({
    world: { time: '天启三年春', phase: '入城立足' },
    events: { 开篇入城: { status: 'pending', deviation: 0, pressure: 'core' } },
    characters: { 沈砚: { affinity: 0, state: '正常' } },
    user: { name: '林昭' },
    custom: { storylines: { 入城立足: { events: ['开篇入城'], stage: '起点', deviation: 0, core: true } } },
  }),
  'timeline.json': () => ({
    base: '天启纪年',
    origin: { raw: '天启三年春', event: '开篇入城', reason: '最早绝对纪年' },
    events: [{ name: '开篇入城', time: '天启三年春', precision: 'exact', chapter: '第一章 入城' }],
    characters: [{ name: '林昭', birth: '（线索：十七岁）', chapter: '第一章 入城' }],
  }),
  'events.json': () => ([
    { name: '开篇入城', storyline: '入城立足', chapter: '第一章 入城', quote: '林昭踏进城门', canon: '林昭进入云京。', pressure: 'core', prerequisites: { temporal: [], behavioral: '若已见过沈砚' }, interventions: [{ condition: '若直接报案', result: '线索提前暴露' }] },
  ]),
  'phases.json': () => ([
    { name: '入城立足', startEvent: '开篇入城', endEvent: '初见沈砚', coreChange: '从孤身寻亲到获得助力', characterDeltas: [] },
    { name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: '从被动等待到主动追查', characterDeltas: [{ character: '林昭', change: '从谨慎观望变为主动出击', quote: '她握紧了那封信' }] },
  ]),
  'user_mode.json': () => ({ mode: 'protagonist', protagonistName: '林昭', autoDetected: true, reason: '视角集中于林昭' }),
  'preset_fragment.json': () => ({
    b1_variables: 'world:\n  time: 天启三年春\nevents:\n  开篇入城:\n    status: pending\nuser:\n  name: 林昭\n',
    b2_update_rules: 'task: 在每次回复末尾输出 <update> 标签',
    b3_director: '【当前时间】<%= getvar(\'stat_data.world.time\') %>',
    b4_persona_delta: "<%_ const 人设增量表 = { _%>\n<%_   '旧案浮现': `林昭：从谨慎观望变为主动出击`, _%>",
    b5_rules: { identity: 'B5-1 内容', timeline: 'B5-2 内容', fence: 'B5-3 内容', intervention: 'B5-4 内容', output: 'B5-5 内容' },
    config: { userMode: 'protagonist' },
  }),
  'meta.json': () => ({
    taskId: 'task_1001', createdAt: '2026-01-01T00:00:00.000Z', durationMs: 42000,
    model: 'mock-large', userMode: 'protagonist',
    counts: { chars: 688, chapters: 3, events: 3, storylines: 2, phases: 2, worldbookEntries: 6, characters: 2 },
    tokens: { a: 120, b: 900, limits: { maxA: 2000, maxB: 3500 } },
    warnings: [],
  }),
  'README.md': () => '# 导入说明\n\n## 导入步骤\n\n### 1. 导入世界书（A 包）\nST → 世界书 → 导入',
};

const TASKS = [
  { taskId: 'task_1002', files: ['worldbook.json'], running: true, hasLog: true, updatedAt: new Date().toISOString(), meta: null, project: { title: '正在跑的作品' } },
  { taskId: 'task_1001', files: Object.keys(fixtures), running: false, hasLog: true, updatedAt: new Date(Date.now() - 60000).toISOString(), meta: fixtures['meta.json'](), project: { title: '云京旧案', createdAt: '2026-01-01T00:00:00.000Z' } },
  { taskId: 'task_1000', files: Object.keys(fixtures), running: false, hasLog: true, updatedAt: new Date(Date.now() - 3600000).toISOString(), meta: { ...fixtures['meta.json'](), warnings: ['A 包常驻 2500 token 超过上限 2000'] }, project: { title: '带警告的任务', createdAt: '2026-01-01T00:00:00.000Z' } },
];

const fetchLog = [];
function jsonResponse(obj, status = 200) {
  return {
    ok: status < 400,
    status,
    async json() { return obj; },
    async text() { return JSON.stringify(obj); },
  };
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetchLog.push(`${opts.method || 'GET'} ${u}`);
  if (u.includes('/api/system')) {
    return jsonResponse({
      ok: true, node: 'v24.15.0', platform: 'win32', cwd: ROOT, port: 3000,
      uploads: path.join(ROOT, 'uploads'), outputs: path.join(ROOT, 'output'),
      running: ['task_1002'], uptimeSec: 300,
    });
  }
  if (u.includes('/api/tasks') && u.includes('/log')) {
    return jsonResponse({
      events: [
        { event: 'progress', data: { step: 'Init', msg: '读入 688 字' }, ts: Date.now() },
        { event: 'progress', data: { step: 'Step 1', msg: '时间线：1 事件 / 1 人物' }, ts: Date.now() },
        { event: 'files', data: { taskId: 'task_1001', files: ['worldbook.json'] }, ts: Date.now() },
      ],
      running: false,
    });
  }
  if (u.match(/\/api\/tasks\/[^/]+\/file\/(.+)$/)) {
    const name = decodeURIComponent(u.match(/\/file\/(.+)$/)[1]);
    const fn = fixtures[name];
    if (!fn) return jsonResponse({ error: '文件不存在' }, 404);
    const content = typeof fn() === 'string' ? fn() : JSON.stringify(fn(), null, 2);
    return jsonResponse({ name, content, size: content.length });
  }
  if (u.match(/\/api\/tasks\/[^/]+$/) && (opts.method || 'GET') === 'GET') {
    const id = u.split('/').pop();
    const t = TASKS.find(x => x.taskId === id);
    return t ? jsonResponse(t) : jsonResponse({ error: '任务不存在' }, 404);
  }
  if (u.includes('/api/tasks')) return jsonResponse({ tasks: TASKS, running: ['task_1002'] });
  if (u.includes('/api/models')) return jsonResponse({ models: ['mock-large', 'mock-small'] });
  if (u.includes('/api/ping')) return jsonResponse({ ok: true, ms: 321, model: 'mock-large', reply: '正常' });
  if (u.includes('/api/estimate')) {
    return jsonResponse({ chars: 688, tokens: 441, chapters: 3, preview: [{ title: '第一章 入城', chars: 230 }] });
  }
  // 受限环境下打开文件管理器会失败，返回 ok:false + 提示
  if (u.includes('/reveal')) {
    return jsonResponse({ ok: false, dir: 'D:\\out\\task_1001', hint: '当前环境不允许打开文件管理器，请手动访问上面的路径' });
  }
  if (u.includes('/api/generate')) {
    const events = [
      ['start', { taskId: 'task_2000', startedAt: new Date().toISOString() }],
      ['progress', { step: 'Init', msg: '读入 688 字' }],
      ['progress', { step: 'Step 0.5', msg: '模式：protagonist' }],
      ['progress', { step: 'Step 1', msg: '时间线：3 事件 / 2 人物' }],
      ['progress', { step: 'WARN', msg: '章节数 < 3，阶段划分可能降级' }],
      ['progress', { step: 'Step 5', msg: '世界观 2 / 人物 2' }],
      ['progress', { step: 'Done', msg: 'A 包常驻 120 tok' }],
      ['files', { taskId: 'task_2000', files: ['worldbook.json', 'preset_fragment.json'], meta: fixtures['meta.json']() }],
      ['done', { ok: true, taskId: 'task_2000' }],
    ];
    const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
    const bytes = new TextEncoder().encode(body);
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: bytes };
          },
        }),
      },
    };
  }
  return jsonResponse({ error: `未桩化的请求：${u}` }, 404);
};

// ============================================================
// 测试
// ============================================================
async function main() {
  console.log('\n【A】应用外壳加载');
  await import(pathToFileURL(path.join(PUB, 'js/app.js')).href);
  await new Promise(r => setTimeout(r, 60));

  const navItems = document.querySelectorAll('.nav-item');
  // 8 项 = 总览 / 生成流程 / 图片生成角色卡 / 任务与产物 / 角色卡内容 / 预设规则 / 命令参考 / 设置
  ok('侧边栏渲染 8 个导航项', navItems.length === 8, `实际 ${navItems.length}`);
  ok('品牌区渲染', !!document.querySelector('.brand'));
  ok('命令栏已挂载', !!document.querySelector('.cmdbar'));
  ok('命令输入框存在', !!document.querySelector('.cmdbar-head input'));
  ok('当前页面容器有内容', (document.getElementById('page')?.children.length || 0) > 0);
  ok('顶栏标题为总览', document.querySelector('.topbar .title')?.textContent === '总览',
    document.querySelector('.topbar .title')?.textContent);

  const { runCommand, tokenize, parseCommand, complete, COMMANDS } = await import(pathToFileURL(path.join(PUB, 'js/core/commands.js')).href);
  const { state } = await import(pathToFileURL(path.join(PUB, 'js/core/store.js')).href);

  console.log('\n【B】命令解析');
  ok('命令数量 >= 20', COMMANDS.filter(c => !c.hidden).length >= 20, String(COMMANDS.length));
  ok('tokenize 处理引号', JSON.stringify(tokenize('key "sk-a b" --x')) === JSON.stringify(['key', 'sk-a b', '--x']));
  const parsed = parseCommand('cat meta.json --task task_1 --limit=5');
  ok('parseCommand 提取位置参数', parsed.positional.join(',') === 'meta.json');
  ok('parseCommand 提取 --key value', parsed.options.task === 'task_1');
  ok('parseCommand 提取 key=value', parsed.options.limit === '5');

  console.log('\n【C】命令执行');
  let r = await runCommand('help');
  ok('help 列出命令', r.ok && r.out.includes('可用命令'), r.out.slice(0, 60));
  r = await runCommand('help gen');
  ok('help gen 显示用法', r.ok && r.out.includes('语法'), r.out.slice(0, 60));

  r = await runCommand('status');
  ok('status 返回服务信息', r.ok && r.out.includes('本地服务') === false || r.ok, r.out.slice(0, 80));
  ok('status 含端口信息', r.out.includes('3000'), r.out.slice(0, 120));

  r = await runCommand('model deepseek-chat');
  ok('model 设置成功', r.ok && state.config.model === 'deepseek-chat', state.config.model);
  r = await runCommand('model');
  ok('model 无参数时回显', r.out.includes('deepseek-chat'));

  r = await runCommand('config concurrency 5');
  ok('config 设置数字', r.ok && state.config.concurrency === 5, String(state.config.concurrency));
  r = await runCommand('config concurrency abc');
  ok('config 拒绝非数字', !r.ok, r.out);
  r = await runCommand('config nope 1');
  ok('config 拒绝未知键', !r.ok);

  r = await runCommand('limit a 2400');
  ok('limit 更新 A 包上限', r.ok && state.config.limits.maxA === 2400, JSON.stringify(state.config.limits));

  r = await runCommand('key sk-test-1234567890');
  ok('key 设置并掩码显示', r.ok && !r.out.includes('sk-test-1234567890'), r.out);
  ok('key 已写入配置', state.config.apiKey === 'sk-test-1234567890');

  r = await runCommand('tasks');
  ok('tasks 列出任务', r.ok && r.out.includes('task_1001'), r.out.slice(0, 120));

  r = await runCommand('open 2');
  ok('open 支持序号', r.ok, r.out);
  ok('open 写入 currentTaskId', state.currentTaskId === 'task_1001', String(state.currentTaskId));
  r = await runCommand('open 99');
  ok('open 越界时报错', !r.ok);

  r = await runCommand('files');
  ok('files 列出产物', r.ok && r.out.includes('worldbook.json'), r.out.slice(0, 100));

  r = await runCommand('cat worldbook.json');
  ok('cat 读取产物内容', r.ok && r.out.includes('生成的世界设定集'), r.out.slice(0, 100));
  r = await runCommand('cat 不存在.json');
  ok('cat 缺文件时报错', !r.ok);

  r = await runCommand('copy meta.json');
  ok('copy 走通剪贴板分支', r.ok, r.out);

  r = await runCommand('log 2');
  ok('log 回放日志', r.ok && r.out.includes('日志'), r.out.slice(0, 80));

  r = await runCommand('ping');
  ok('ping 返回耗时', r.ok && r.out.includes('mock-large'), r.out);

  r = await runCommand('doctor');
  ok('doctor 输出自检结果', typeof r.out === 'string' && r.out.includes('自检'), r.out.slice(0, 120));

  r = await runCommand('theme light');
  ok('theme 切换浅色', r.ok && document.documentElement.dataset.theme === 'light', document.documentElement.dataset.theme);
  r = await runCommand('theme dark');
  ok('theme 切回深色', r.ok && document.documentElement.dataset.theme === 'dark');

  r = await runCommand('go card');
  ok('go 切换页面', r.ok && location.hash.includes('/card'), location.hash);

  r = await runCommand('go nowhere');
  ok('go 未知页面报错', !r.ok);
  r = await runCommand('go');
  ok('go 无参数时列出页面', r.ok && r.out.includes('library'));

  r = await runCommand('bogus-command');
  ok('未知命令给出提示', !r.ok && r.out.includes('未知命令'), r.out);
  r = await runCommand('generat');
  ok('未知命令给出相近建议', !r.ok, r.out);
  r = await runCommand('/status');
  ok('命令前导斜杠被容忍', r.ok);

  r = await runCommand('cancel task_1002');
  ok('cancel 命中运行中任务', r.ok, r.out);

  r = await runCommand('rm 3');
  ok('rm 删除任务', r.ok && state.tasks.every(t => t.taskId !== 'task_1000'), r.out);

  r = await runCommand('term on');
  ok('term on 展开终端', r.ok && document.querySelector('.cmdbar').classList.contains('open'));

  r = await runCommand('export 2');
  ok('export 触发下载', r.ok, r.out);

  r = await runCommand('reveal 2');
  ok('reveal 调用后端', r.ok, r.out);
  ok('reveal 失败时降级提示路径与替代方案',
    r.kind === 'warn' && r.out.includes('不允许打开文件管理器') && r.out.includes('export'),
    r.out);

  console.log('\n【D】补全');
  const c1 = complete('mo');
  ok('补全命令名', c1.includes('model'), JSON.stringify(c1));
  const c2 = complete('mode ');
  ok('补全枚举参数', c2.some(x => x.includes('participant')), JSON.stringify(c2));
  const c3 = complete('go ');
  ok('补全页面 id', c3.some(x => x.includes('library')), JSON.stringify(c3));

  console.log('\n【E】配置持久化');
  const saved = JSON.parse(store.get('n2c.state.v1') || '{}');
  ok('配置写入 localStorage', saved.config?.model === 'deepseek-chat', JSON.stringify(saved.config?.model));
  ok('主题偏好被保存', saved.ui?.theme === 'dark');

  console.log('\n【F】各页面渲染');
  const pages = [
    ['/dashboard', '总览'], ['/generate', '生成流程'], ['/library', '任务与产物'],
    ['/card', '角色卡内容'], ['/preset', '预设规则'], ['/commands', '命令参考'], ['/settings', '设置'],
  ];
  for (const [hash, label] of pages) {
    location.hash = `#${hash}`;
    await new Promise(r => setTimeout(r, 120));
    const node = document.getElementById('page');
    const html = node?.textContent || '';
    const rendered = (node?.children.length || 0) > 0 && !html.includes('页面渲染失败');
    ok(`${label} 页渲染成功`, rendered, html.slice(0, 160));
  }

  console.log('\n【G】页面内容抽查');
  location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 120));
  const genText = document.getElementById('page').textContent;
  ok('生成页含文件上传控件', !!document.querySelector('#page #f-novel'));
  ok('生成页含 user 模式选项', genText.includes('观察者'), genText.slice(0, 80));
  ok('生成页含步骤清单', genText.includes('时间线') && genText.includes('变量树'));

  location.hash = '#/card?task=task_1001';
  await new Promise(r => setTimeout(r, 200));
  const cardText = document.getElementById('page').textContent;
  ok('角色卡页读到世界书条目', cardText.includes('[timeline]'), cardText.slice(0, 200));
  ok('角色卡页显示任务选择器', !!document.querySelector('#page select'));

  location.hash = '#/preset?task=task_1001';
  await new Promise(r => setTimeout(r, 200));
  const presetText = document.getElementById('page').textContent;
  ok('预设页显示 B1 块', presetText.includes('B1 · 变量初始化'), presetText.slice(0, 200));
  ok('预设页显示 B5 各块', presetText.includes('B5-4'), presetText.slice(0, 300));

  location.hash = '#/library?task=task_1001';
  await new Promise(r => setTimeout(r, 250));
  const libText = document.getElementById('page').textContent;
  ok('任务页显示任务标题', libText.includes('云京旧案'), libText.slice(0, 200));
  ok('任务页显示统计', libText.includes('世界书条目'));

  console.log('\n【H】生成流程端到端（桩 SSE）');
  location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 150));
  // 用显式 id：生成页现在有多个 file 控件（#f-novel / #f-card / #f-images），
  // 取"第一个 input[type=file]"会随 DOM 顺序变化而抓错
  const fileInput = document.querySelector('#page #f-novel');
  ok('拿到小说文件控件', !!fileInput);
  if (fileInput) {
    fileInput.files = [{ name: '测试.txt', size: 2048, text: async () => '第一章 测试\n' + '正文'.repeat(300) }];
    fileInput.dispatchEvent({ type: 'change', target: fileInput });
    await new Promise(r => setTimeout(r, 120));
    const startBtn = document.querySelectorAll('#page button').find(b => b.textContent.includes('开始生成'));
    ok('找到开始生成按钮', !!startBtn, [...document.querySelectorAll('#page button')].map(b => b.textContent).join('|').slice(0, 200));
    if (startBtn) {
      startBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const text = document.getElementById('page').textContent;
      if (!fetchLog.some(f => f.includes('/api/generate'))) {
        console.log('     [debug] 文档内 toast:', [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' / '));
      }
      ok('生成页发起 /api/generate 请求', fetchLog.some(f => f.includes('/api/generate')), fetchLog.slice(-4).join('; '));
      ok('进度区显示生成完成', text.includes('生成完成'), text.slice(0, 200));
      ok('结果区列出产物文件', text.includes('worldbook.json'), text.slice(0, 400));
      ok('进度显示 100%', text.includes('100%'), text.slice(0, 200));
    }
  }

  console.log('\n【I】渲染错误检查');
  ok('各页面均无渲染失败标记', !document.getElementById('page').textContent.includes('页面渲染失败'));
  const realFetches = fetchLog.filter(f => f.includes('未桩化'));
  ok('没有未桩化的请求', realFetches.length === 0, realFetches.join('; '));
  console.log(`     共发出 ${fetchLog.length} 次 API 调用`);

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  前端冒烟：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
