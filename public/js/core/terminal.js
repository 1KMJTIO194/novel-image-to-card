/**
 * 命令交互界面：
 *  - 底部常驻命令栏 + 可展开终端（CmdTerm）
 *  - Ctrl+K 命令面板（CommandPalette）
 */

import { el, clear, $ } from './dom.js';
import { state, setUI, on } from './store.js';
import { COMMANDS, runCommand, complete, findCommand, tokenize } from './commands.js';

const HISTORY_KEY = 'n2c.cmd.history.v1';
const HISTORY_MAX = 100;

function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveHistory(arr) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-HISTORY_MAX))); } catch {}
}

// ============================================================
// 底部命令终端
// ============================================================

export function createCommandBar() {
  const term = el('div', { class: 'cmd-term' });
  const cursor = el('span', { text: '▍', style: { color: 'var(--accent)', animation: 'none' } });
  const input = el('input', {
    type: 'text',
    id: 'cmd-input',
    name: 'command',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: '输入命令，help 查看全部（Ctrl+K 打开面板）',
    'aria-label': '命令输入',
  });
  const counter = el('span', { class: 'hint', style: { fontFamily: 'var(--mono)', fontSize: '11px' } });
  const toggle = el('button', { class: 'btn sm ghost', type: 'button', title: '展开/收起终端 (Ctrl+`)', text: '⌃' });

  const bar = el('div', { class: 'cmdbar' },
    el('div', { class: 'cmdbar-head' },
      el('span', { class: 'pfx', text: '❯' }),
      input,
      counter,
      el('button', { class: 'btn sm', type: 'button', text: '执行', onclick: () => submit(input.value) }),
      toggle,
    ),
    term,
  );

  let history = loadHistory();
  let hIndex = history.length;

  function setOpen(open) {
    bar.classList.toggle('open', open);
    setUI({ terminalOpen: open });
    if (open) {
      requestAnimationFrame(() => {
        term.scrollTop = term.scrollHeight;
        input.focus();
      });
    }
  }

  function print(text, kind = 'ok', echo = null) {
    if (echo !== null) {
      term.appendChild(el('div', { class: 'ct-line' },
        el('span', { class: 'ct-in', text: '❯' }),
        el('span', { class: 'ct-out', style: { color: 'var(--text)' }, text: echo }),
      ));
    }
    if (text) {
      term.appendChild(el('div', { class: `ct-line ${kind}` },
        el('span', { class: 'ct-in', text: kind === 'err' ? '✗' : kind === 'warn' ? '!' : '·' }),
        el('span', { class: 'ct-out', text: text }),
      ));
    }
    term.scrollTop = term.scrollHeight;
  }

  function clearTerm() {
    clear(term);
    print('命令终端已就绪。输入 help 查看全部命令，Ctrl+K 打开命令面板。', 'ok');
  }

  async function submit(line) {
    const raw = String(line ?? input.value).trim();
    if (!raw) return;
    if (!bar.classList.contains('open')) setOpen(true);
    input.value = '';
    counter.textContent = '';

    if (raw !== history[history.length - 1]) history.push(raw);
    history = history.slice(-HISTORY_MAX);
    hIndex = history.length;
    saveHistory(history);

    state.lastCommand = raw;

    if (raw === 'clear' || raw === 'cls') {
      clearTerm();
      return;
    }

    print(null, 'ok', raw);
    const res = await runCommand(raw);
    if (res?.out) print(res.out, res.kind || (res.ok ? 'ok' : 'err'));
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (input.value.trim() === 'help' || input.value.trim() === '?') {
        // 直接展开终端看长输出
        setOpen(true);
      }
      submit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!history.length) return;
      hIndex = Math.max(0, hIndex - 1);
      input.value = history[hIndex] || '';
      input.setSelectionRange(input.value.length, input.value.length);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!history.length) return;
      hIndex = Math.min(history.length, hIndex + 1);
      input.value = history[hIndex] || '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const cands = complete(input.value);
      if (!cands.length) return;
      if (cands.length === 1) {
        input.value = cands[0] + ' ';
        counter.textContent = '';
      } else {
        // 补全到公共前缀，并提示候选项
        const prefix = commonPrefix(cands);
        if (prefix.length > input.value.length) input.value = prefix;
        counter.textContent = cands.slice(0, 6).map(c => c.split(' ').pop()).join(' ');
      }
    } else if (e.key === 'Escape') {
      if (input.value) { input.value = ''; counter.textContent = ''; }
      else setOpen(false);
    } else if (e.key === '`' && e.ctrlKey) {
      setOpen(!bar.classList.contains('open'));
    }
  });

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (!val) { counter.textContent = ''; return; }
    const cmd = findCommand(tokenize(val)[0]);
    if (cmd) {
      const cands = (cmd.complete?.('') || []).slice(0, 4);
      counter.textContent = cands.length ? cands.join('  ') : (cmd.args || '');
    } else {
      const matches = COMMANDS.filter(c => !c.hidden && c.name.startsWith(val.toLowerCase())).map(c => c.name);
      counter.textContent = matches.slice(0, 5).join('  ');
    }
  });

  toggle.addEventListener('click', () => setOpen(!bar.classList.contains('open')));

  on('terminal', (open) => {
    bar.classList.toggle('open', !!open);
    if (open) requestAnimationFrame(() => { term.scrollTop = term.scrollHeight; input.focus(); });
  });

  on('command', (line) => submit(line));

  clearTerm();
  if (state.ui.terminalOpen) bar.classList.add('open');

  return bar;
}

function commonPrefix(arr) {
  if (!arr.length) return '';
  let p = arr[0];
  for (const s of arr.slice(1)) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
  }
  return p;
}

// ============================================================
// Ctrl+K 命令面板
// ============================================================

export function createPalette() {
  let mask = null;
  let items = [];
  let sel = 0;

  const input = el('input', {
    type: 'text',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: '搜索命令，或直接输入命令后回车执行…',
  });
  const list = el('div', { class: 'palette-list' });
  const palette = el('div', { class: 'palette' },
    el('div', { class: 'palette-input' }, el('span', { class: 'chev', text: '❯' }), input),
    list,
    el('div', { class: 'palette-foot' },
      el('span', {}, el('kbd', { text: '↑↓' }), ' 选择'),
      el('span', {}, el('kbd', { text: 'Enter' }), ' 执行'),
      el('span', {}, el('kbd', { text: 'Tab' }), ' 补全'),
      el('span', {}, el('kbd', { text: 'Esc' }), ' 关闭'),
    ),
  );

  function buildItems(query) {
    const q = query.trim().toLowerCase();
    if (!q) {
      return COMMANDS.filter(c => !c.hidden).map(c => ({ cmd: c, text: c.name, desc: c.desc }));
    }
    const first = tokenize(query)[0]?.toLowerCase() || '';
    const cmd = findCommand(first);
    const out = [];
    if (cmd) {
      out.push({ cmd, text: query, desc: `执行：${cmd.desc}`, exec: true });
      for (const cand of cmd.complete?.('') || []) {
        out.push({ cmd, text: `${cmd.name} ${cand}`, desc: '参数建议' });
      }
    }
    for (const c of COMMANDS) {
      if (c.hidden) continue;
      if (c.name.startsWith(q) || c.alias?.some(a => a.startsWith(q))) {
        out.push({ cmd: c, text: c.name, desc: c.desc });
      } else if (c.desc.includes(q)) {
        out.push({ cmd: c, text: c.name, desc: c.desc });
      }
    }
    // 去重
    const seen = new Set();
    return out.filter(i => {
      const k = i.text + i.desc;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 40);
  }

  function paint() {
    clear(list);
    if (!items.length) {
      list.appendChild(el('div', { class: 'empty', text: '没有匹配的命令' }));
      return;
    }
    items.forEach((it, i) => {
      const row = el('div', {
        class: `palette-item ${i === sel ? 'sel' : ''}`,
        onclick: () => { input.value = it.text; if (it.exec) execute(); else input.focus(); },
      },
        el('span', { class: 'pi-cmd', text: it.text }),
        el('span', { class: 'pi-desc', text: it.desc }),
      );
      list.appendChild(row);
    });
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  }

  async function execute() {
    const value = input.value.trim();
    if (!value) return;
    close();
    const { emit } = await import('./store.js');
    emit('command', value);
  }

  function refresh() {
    items = buildItems(input.value);
    sel = 0;
    paint();
  }

  function open(prefill = '') {
    if (mask) return;
    mask = el('div', {
      class: 'palette-mask',
      onclick: (e) => { if (e.target === mask) close(); },
    }, palette);
    document.body.appendChild(mask);
    input.value = prefill;
    refresh();
    requestAnimationFrame(() => input.focus());
  }

  function close() {
    mask?.remove();
    mask = null;
  }

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); paint(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); paint(); }
    else if (e.key === 'Enter') { e.preventDefault(); execute(); }
    else if (e.key === 'Tab') {
      e.preventDefault();
      const cands = complete(input.value);
      if (cands.length) { input.value = cands[0] + ' '; refresh(); }
    } else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  return { open, close, isOpen: () => !!mask };
}

// ============================================================
// 全局快捷键
// ============================================================

export function bindShortcuts(palette, bar) {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');

    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.isOpen() ? palette.close() : palette.open();
      return;
    }
    if (mod && e.key === '`') {
      e.preventDefault();
      const input = $('.cmdbar-head input');
      const open = !$('.cmdbar')?.classList.contains('open');
      setUI({ terminalOpen: open });
      bar.classList.toggle('open', open);
      if (open) input?.focus();
      return;
    }
    if (e.key === 'Escape') {
      if (palette.isOpen()) { palette.close(); return; }
    }
    // 单键 / 打开面板
    if (!typing && !mod && e.key === '/') { e.preventDefault(); palette.open(); }
    if (!typing && !mod && e.key === '?') { e.preventDefault(); palette.open('help '); }
  });
}
