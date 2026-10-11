/**
 * 全局状态：配置持久化 + 任务缓存 + 极简事件总线
 */

const LS_KEY = 'n2c.state.v1';

const DEFAULT_CONFIG = {
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  userMode: 'auto',
  temperature: 0.3,
  concurrency: 3,
  chunkMaxLen: 6000,
  maxCharacters: 15,
  worldProbeChars: 15000,
  charProbeChars: 10000,
  limits: { maxA: 2000, maxB: 3500 },
  autoOpenTerminal: true,
  /** 生成预设（prompt 附加/替换），结构见 src/preset.js；null 表示未启用 */
  preset: null,
};

const DEFAULT_UI = {
  theme: 'dark',
  lastPage: 'dashboard',
  terminalOpen: false,
  wizardCollapsed: {},
  /** 生成流程页的输出模式：card（完整角色卡）/ ab（A 包+B 包）/ both */
  outputMode: 'card',
  /** 生成流程页的任务模式：from_scratch（从零生成）/ augment（完善已有角色卡） */
  genMode: 'from_scratch',
};

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const persisted = load();

export const state = {
  config: { ...DEFAULT_CONFIG, ...(persisted.config || {}), limits: { ...DEFAULT_CONFIG.limits, ...(persisted.config?.limits || {}) } },
  ui: { ...DEFAULT_UI, ...(persisted.ui || {}) },
  /** @type {any[]} */
  tasks: [],
  /** 当前查看的任务 id */
  currentTaskId: null,
  /** 当前打开的文件内容缓存：`${taskId}/${name}` → 内容 */
  fileCache: new Map(),
  /** 运行中的任务 id */
  runningTaskId: null,
  /** 最近一次生成的任务 id */
  lastTaskId: null,
  system: null,
  serverOk: false,
};

export function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ config: state.config, ui: state.ui }));
  } catch { /* 隐私模式下可能失败 */ }
}

export function setConfig(patch) {
  Object.assign(state.config, patch);
  save();
  emit('config', state.config);
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  save();
  emit('ui', state.ui);
}

// ---------------- 事件总线 ----------------
const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, payload) {
  for (const fn of listeners.get(event) || []) {
    try { fn(payload); } catch (e) { console.error(`[store] ${event} listener`, e); }
  }
}

// ---------------- 主题 ----------------
export function applyTheme() {
  document.documentElement.dataset.theme = state.ui.theme === 'light' ? 'light' : 'dark';
}

export function toggleTheme() {
  setUI({ theme: state.ui.theme === 'light' ? 'dark' : 'light' });
  applyTheme();
  return state.ui.theme;
}

// ---------------- 提示气泡 ----------------
export function toast(message, kind = 'info', ms = 3000) {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  wrap.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
  return node;
}
