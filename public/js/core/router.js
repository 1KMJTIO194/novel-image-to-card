/** hash 路由与页面注册 */

import { clear } from './dom.js';
import { emit, setUI } from './store.js';

/** 导航分组（侧边栏 + 顶栏标题都取自这里） */
export const NAV = [
  {
    group: '工作台',
    items: [
      { id: 'dashboard', path: '/dashboard', label: '总览', icon: '◈', desc: '项目状态、快捷入口与流程说明' },
      { id: 'generate', path: '/generate', label: '生成流程', icon: '▶', desc: '上传小说、配置参数、实时日志' },
      { id: 'image-card', path: '/image-card', label: '图片生成角色卡', icon: '🖼', desc: '上传人物图，从画面读取外貌服饰生成角色卡' },
      { id: 'library', path: '/library', label: '任务与产物', icon: '▦', desc: '历史任务、产物浏览与打包下载' },
    ],
  },
  {
    group: '角色卡',
    items: [
      { id: 'card', path: '/card', label: '角色卡内容', icon: '☰', desc: '世界书条目、变量树、时间线与阶段' },
      { id: 'preset', path: '/preset', label: '预设规则', icon: '⚙', desc: 'B 包 B1–B5 内容与导入指引' },
    ],
  },
  {
    group: '系统',
    items: [
      { id: 'commands', path: '/commands', label: '命令参考', icon: '❯', desc: '全部可用命令、参数与示例' },
      { id: 'settings', path: '/settings', label: '设置', icon: '⚒', desc: 'API 配置、生成参数、外观与数据' },
    ],
  },
];

const PAGES = new Map();
const ctx = { params: {} };

export function registerPage(id, render) {
  PAGES.set(id, render);
}

export function currentRoute() {
  const raw = location.hash.replace(/^#/, '') || '/dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(queryPart || ''));
  const found = NAV.flatMap(g => g.items).find(i => i.path === pathPart);
  return { path: pathPart, id: found?.id || 'dashboard', meta: found, params };
}

export function navigate(path, params) {
  const qs = params && Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const target = `#${path}${qs}`;
  if (location.hash === target) return render();
  location.hash = target;
}

export function navItem(id) {
  return NAV.flatMap(g => g.items).find(i => i.id === id);
}

/** 渲染当前路由 */
export async function render() {
  const route = currentRoute();
  ctx.params = route.params;
  const mount = document.getElementById('page');
  if (!mount) return;
  // 通知上一个页面做清理（定时器、订阅等），否则会随导航泄漏。
  // 用 document.createEvent 创建，避免依赖 CustomEvent 构造函数在所有环境都存在。
  emit('route-leave', route);
  try {
    const evt = document.createEvent('Event');
    evt.initEvent('dsh:route-leave', true, false);
    document.dispatchEvent(evt);
  } catch { /* 清洁失败不应阻断渲染 */ }
  clear(mount);
  const renderer = PAGES.get(route.id);
  emit('route', route);
  try {
    if (renderer) await renderer(mount, route.params);
    else mount.textContent = '页面不存在';
  } catch (e) {
    console.error(e);
    const box = document.createElement('div');
    box.className = 'card';
    box.innerHTML = `<h2 style="color:var(--danger)">页面渲染失败</h2>
      <pre class="code">${String(e?.stack || e?.message || e).replace(/[<>&]/g, '')}</pre>`;
    mount.appendChild(box);
  }
  document.querySelector('.content')?.scrollTo({ top: 0 });
}

export function startRouter() {
  window.addEventListener('hashchange', render);
  if (!location.hash) location.hash = `#${navItem('dashboard').path}`;
  render();
}
