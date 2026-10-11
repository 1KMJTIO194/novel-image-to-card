/**
 * 应用外壳：侧边栏、顶栏、路由注册、快捷键、任务轮询
 */

import { el, clear, $ } from './core/dom.js';
import { state, applyTheme, on, emit, toast } from './core/store.js';
import { NAV, startRouter, currentRoute, navigate, registerPage } from './core/router.js';
import { api } from './core/api.js';
import { createCommandBar, createPalette, bindShortcuts } from './core/terminal.js';

import { renderDashboard } from './pages/dashboard.js';
import { renderGenerate } from './pages/generate.js';
import { renderImageCard } from './pages/image-card.js';
import { renderLibrary } from './pages/library.js';
import { renderCard } from './pages/card.js';
import { renderPreset } from './pages/preset.js';
import { renderCommands } from './pages/commands.js';
import { renderSettings } from './pages/settings.js';
import * as run from './core/active-run.js';

// ============================================================
// 页面注册
// ============================================================
registerPage('dashboard', renderDashboard);
registerPage('generate', renderGenerate);
registerPage('image-card', renderImageCard);
registerPage('library', renderLibrary);
registerPage('card', renderCard);
registerPage('preset', renderPreset);
registerPage('commands', renderCommands);
registerPage('settings', renderSettings);

// ============================================================
// 外壳搭建
// ============================================================
applyTheme();

const app = $('#app');
clear(app);

const navBox = el('nav', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
const badges = new Map();

for (const group of NAV) {
  navBox.appendChild(el('div', { class: 'nav-group-label', text: group.group }));
  for (const item of group.items) {
    const badge = el('span', { class: 'badge', style: { display: 'none' } });
    badges.set(item.id, badge);
    const node = el('a', {
      class: 'nav-item',
      href: `#${item.path}`,
      dataset: { nav: item.id },
      onclick: () => { /* hash 路由处理 */ },
    },
      el('span', { class: 'ico', text: item.icon }),
      el('span', { text: item.label }),
      badge,
    );
    navBox.appendChild(node);
  }
}

const serverDot = el('span', { class: 'dot', title: '本地服务状态' });

// 全局生成状态指示：在任何页面都能看到当前任务进度，点击回生成页
const runBar = el('div', { class: 'run-indicator', style: { display: 'none' } });
runBar.addEventListener('click', () => navigate('/generate'));

const sidebar = el('aside', { class: 'sidebar' },
  el('div', { class: 'brand' },
    el('div', { class: 'logo', text: '卡' }),
    el('div', {},
      el('div', { class: 'name', text: '角色卡生成器' }),
      el('div', { class: 'ver', text: 'v1.2 · localhost' }),
    ),
  ),
  runBar,
  navBox,
  el('div', { class: 'sidebar-foot' },
    el('div', {}, serverDot, el('span', { id: 'server-text', text: '检测中…' })),
    el('div', { style: { marginTop: '6px' } },
      el('kbd', { text: 'Ctrl+K' }), ' 命令面板'),
    el('div', {}, el('kbd', { text: 'help' }), ' 查看命令'),
  ),
);

/** 由 active-run 状态驱动侧边栏指示器 */
function paintRunIndicator(snap) {
  const status = snap?.status ?? 'idle';
  if (status === 'idle' || !snap?.task) {
    runBar.style.display = 'none';
    return;
  }
  const d = run.derive();
  const pct = Math.round((d.progress || 0) * 100);
  runBar.style.display = '';
  runBar.className = `run-indicator ${status}`;
  clear(runBar);
  runBar.append(
    el('div', { class: 'ri-head' },
      el('span', { class: `ri-dot ${status === 'running' ? 'spin-dot' : ''}` }),
      el('span', { class: 'ri-text', text: run.statusText() }),
    ),
    el('div', { class: 'ri-bar' }, el('i', { style: { width: `${pct}%` } })),
    el('div', { class: 'ri-sub', text: snap.task.title || snap.taskId || '' }),
  );
}
on('run', paintRunIndicator);

const titleEl = el('div', { class: 'title', text: '总览' });
const subEl = el('div', { class: 'sub', text: '' });
const paletteBtn = el('button', {
  class: 'btn sm ghost',
  title: '命令面板 (Ctrl+K)',
  onclick: () => palette.open(),
}, el('span', { text: '❯' }), ' 命令 ', el('kbd', { text: 'Ctrl+K' }));

const topbar = el('header', { class: 'topbar' },
  el('div', {}, titleEl, subEl),
  el('span', { class: 'spacer' }),
  paletteBtn,
);

const content = el('main', { class: 'content' }, el('div', { id: 'page' }));

const main = el('div', { class: 'main' }, topbar, content);

app.append(sidebar, main);

const bar = createCommandBar();
main.appendChild(bar);

const palette = createPalette();
bindShortcuts(palette, bar);

// ============================================================
// 导航高亮 & 顶栏
// ============================================================
on('route', (route) => {
  for (const node of navBox.querySelectorAll('.nav-item')) {
    node.classList.toggle('active', node.dataset.nav === route.id);
  }
  if (route.meta) {
    titleEl.textContent = route.meta.label;
    subEl.textContent = route.meta.desc;
  }
});

// ============================================================
// 任务数徽标
// ============================================================
function updateBadges(tasks) {
  const running = tasks.filter(t => t.running).length;
  const libBadge = badges.get('library');
  if (libBadge) {
    if (tasks.length) {
      libBadge.style.display = '';
      libBadge.textContent = String(tasks.length);
      libBadge.classList.toggle('live', running > 0);
    } else {
      libBadge.style.display = 'none';
    }
  }
}
on('tasks', updateBadges);

async function pollTasks() {
  try {
    const { tasks } = await api.tasks();
    state.tasks = tasks;
    state.serverOk = true;
    updateBadges(tasks);
    setServer(true);
    return tasks;
  } catch {
    state.serverOk = false;
    setServer(false);
    return [];
  }
}

function setServer(ok) {
  serverDot.className = `dot ${ok ? 'on' : 'off'}`;
  const t = $('#server-text');
  if (t) t.textContent = ok ? '本地服务正常' : '服务未响应';
}

let lastRunning = 0;
setInterval(async () => {
  const tasks = await pollTasks();
  const running = tasks.filter(t => t.running).length;
  if (lastRunning > 0 && running === 0) {
    toast('生成任务已结束，可在「任务与产物」查看结果', 'ok', 4500);
    const route = currentRoute();
    if (route.id === 'library') emit('refresh');
  }
  lastRunning = running;
}, 5000);

// ============================================================
// 启动
// ============================================================
await pollTasks();
try {
  const sys = await api.system();
  state.system = sys;
} catch { /* 服务不可用时页面自身会提示 */ }

// 刷新页面后若服务端仍有任务在跑，自动接上它（进度不丢）
try {
  const resumed = await run.restore();
  if (resumed) {
    paintRunIndicator(run.snapshot());
    toast(`已接上正在运行的任务 ${resumed}`, 'ok', 4000);
  }
} catch { /* 忽略 */ }

startRouter();

// 首次访问给出提示
if (!state.config.apiKey) {
  setTimeout(() => {
    toast('还没配置 API Key，先到「设置」页填写', 'warn', 5000);
  }, 900);
}
