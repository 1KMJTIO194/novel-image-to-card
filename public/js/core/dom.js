/** DOM 与格式化小工具 */

/** 直接写成 DOM 属性而非 HTML 特性的键（表单控件语义更可靠） */
const PROP_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate']);

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  // 没有显式指定 type 的按钮一律是普通按钮：
  // 避免浏览器默认的 type="submit"，将来被包进 <form> 时会误触发提交
  if (String(tag).toLowerCase() === 'button' && !attrs.type) node.type = 'button';
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (PROP_KEYS.has(k)) node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ============================================================
// 表单字段
// ============================================================

let uid = 0;
/** 生成页面内唯一的控件 id */
export function nextId(prefix = 'f') {
  uid += 1;
  return `${prefix}-${uid}`;
}

/**
 * 把控件包成完整字段：label[for] ↔ 控件[id]，并补上 name。
 * 注意 label 只包住控件本身，hint / 附加控件放在外面，避免语义含糊。
 *
 * control 若是普通表单控件就直接用；若是一段容器（例如 input + button 并排），
 * 则把 label 指到容器里的第一个表单控件上，并给容器一个 id 以便定位。
 *
 * @param {{label:string, control:HTMLElement, id?:string, name?:string,
 *          hint?:string|Node|(string|Node)[], extra?:Node[], hideLabel?:boolean}} o
 *        extra 用于放 datalist 这类附属节点；hideLabel 用于紧凑工具条（视觉隐藏但保留可访问名）
 */
export function field({ label, control, id, name, hint, extra = [], hideLabel = false } = {}) {
  const isControl = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
  const inner = isControl ? control : control.querySelector('input, select, textarea');
  const target = inner || control;
  const fid = id || target.id || nextId();

  control.id = control.id || (isControl ? fid : `${fid}-group`);
  target.id = target.id || fid;
  // name 由这里统一决定（覆盖 attachDatalist 之类函数补的兜底名）
  if (name) target.setAttribute('name', name);
  else if (!target.getAttribute('name')) target.setAttribute('name', target.id);
  if (hideLabel && !target.getAttribute('aria-label')) target.setAttribute('aria-label', label);

  const hints = hint == null ? [] : [hint].flat();
  return el('div', { class: 'field' },
    el('label', { class: hideLabel ? 'lbl sr-only' : 'lbl', for: target.id, text: label }),
    control,
    ...hints.map(h => (typeof h === 'string' ? el('div', { class: 'hint', text: h }) : h)),
    ...extra,
  );
}

/**
 * 给文本输入挂上 datalist 候选（保留给简单场景）。
 *
 * 模型选择已改用 core/model-picker.js —— datalist 在各浏览器支持不一，
 * 且无法表达「加载中 / 加载失败」状态。这里不再往元素写 dataset 标记，
 * 那属于实现细节泄漏到 DOM，没有任何功能作用。
 *
 * @param {HTMLInputElement} input 需要已有 id（或由 id 参数补上）
 * @param {{id?:string, options?:string[]|(()=>string[]|Promise<string[]>), hint?:string}} o
 * @returns {{input:HTMLInputElement, datalist:HTMLDataListElement, listId:string,
 *            setOptions:(list:string[])=>number, load:()=>Promise<number>,
 *            note:HTMLElement, attach:(fieldNode:HTMLElement)=>HTMLElement}}
 */
export function attachDatalist(input, { id, options = [], hint } = {}) {
  if (id) input.id = id;
  if (!input.id) input.id = nextId('combo');
  const listId = `${input.id}-list`;
  const datalist = el('datalist', { id: listId });
  input.setAttribute('list', listId);

  const setOptions = (items) => {
    const seen = new Set();
    clear(datalist);
    for (const item of items || []) {
      const v = String(item ?? '').trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      datalist.appendChild(el('option', { value: v }));
    }
    return seen.size;
  };

  const load = async () => {
    const list = typeof options === 'function' ? await options() : options;
    return setOptions(list);
  };

  const note = el('div', { class: 'hint hint-combo' },
    hint || '可直接输入，也可从候选列表中选择');

  /** 把 datalist 挂进字段容器（datalist 本身不渲染，位置只影响语义） */
  const attach = (fieldNode) => {
    fieldNode.appendChild(datalist);
    return fieldNode;
  };

  return { input, datalist, listId, setOptions, load, note, attach };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** 高亮关键字（用于命令面板 / 世界书搜索） */
export function highlight(text, query) {
  const s = String(text ?? '');
  if (!query) return escapeHtml(s);
  const i = s.toLowerCase().indexOf(String(query).toLowerCase());
  if (i < 0) return escapeHtml(s);
  const q = s.slice(i, i + query.length);
  return escapeHtml(s.slice(0, i)) + '<mark>' + escapeHtml(q) + '</mark>' + escapeHtml(s.slice(i + query.length));
}

export function fmtTime(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(+d)) return '-';
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

export function fmtDate(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(+d)) return '-';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtRelative(ts) {
  const t = +new Date(ts);
  if (Number.isNaN(t)) return '-';
  const diff = Date.now() - t;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return fmtDate(ts);
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 把长文本截断到 n 个字符 */
export function truncate(s, n = 60) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

/** 复制到剪贴板，返回是否成功 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = String(text);
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 触发浏览器下载 */
export function download(url, filename) {
  const a = el('a', { href: url, download: filename || '' });
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 简单防抖 */
export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/** 把 JSON 折叠渲染成可展开的树 */
export function jsonTree(value, { depth = 0, maxDepth = 3 } = {}) {
  const wrap = el('div', { class: 'mono', style: { fontSize: '12px', paddingLeft: depth ? '14px' : '0' } });
  if (Array.isArray(value)) {
    if (!value.length) return el('span', { class: 'mono', text: '[]' });
    if (depth >= maxDepth) return el('span', { class: 'mono', text: `[${value.length} 项]` });
    value.slice(0, 200).forEach((v, i) => {
      wrap.appendChild(el('div', { style: { display: 'flex', gap: '6px' } },
        el('span', { style: { color: 'var(--text-mute)' }, text: `${i}` }),
        jsonTree(v, { depth: depth + 1, maxDepth })
      ));
    });
    return wrap;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return el('span', { class: 'mono', text: '{}' });
    if (depth >= maxDepth) return el('span', { class: 'mono', text: `{${keys.length} 项}` });
    for (const k of keys.slice(0, 200)) {
      wrap.appendChild(el('div', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        el('span', { style: { color: 'var(--accent-2)', flex: '0 0 auto' }, text: `${k}:` }),
        jsonTree(value[k], { depth: depth + 1, maxDepth })
      ));
    }
    return wrap;
  }
  const color = typeof value === 'number' ? 'var(--info)'
    : typeof value === 'boolean' ? 'var(--warn)'
    : value === null ? 'var(--text-mute)' : 'var(--text)';
  return el('span', { class: 'mono', style: { color, wordBreak: 'break-all' }, text: JSON.stringify(value) });
}
