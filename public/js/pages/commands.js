/** 命令参考页：命令手册 + 可交互终端 */

import { el, clear, fmtTime, truncate, field } from '../core/dom.js';
import { state, emit, setUI } from '../core/store.js';
import { COMMANDS, runCommand, CATEGORIES, tokenize } from '../core/commands.js';

export async function renderCommands(mount) {
  const page = el('div', { class: 'page' });
  mount.appendChild(page);

  page.appendChild(el('div', { class: 'hero' },
    el('div', { class: 'h-txt' },
      el('h1', { text: '命令系统' }),
      el('p', { text: '所有功能都可以用命令驱动：底栏输入、Ctrl+K 面板搜索、或点下面的任意一条直接执行。' }),
      el('div', { class: 'flow' },
        el('span', { class: 'node', text: 'Ctrl+K 面板' }),
        el('span', { class: 'arrow', text: '+' }),
        el('span', { class: 'node', text: '底栏终端' }),
        el('span', { class: 'arrow', text: '+' }),
        el('span', { class: 'node', text: '本页手册' }),
      ),
    ),
  ));

  // ---------- 内嵌终端 ----------
  const term = el('div', { class: 'log', style: { maxHeight: '260px', display: 'none' } });
  const inlineInput = el('input', {
    type: 'text', id: 'cmd-try-input', name: 'cmdTry',
    spellcheck: 'false', autocomplete: 'off',
    placeholder: '在这里直接执行命令，例如 doctor',
    style: { fontFamily: 'var(--mono)' },
  });
  const termCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '试运行' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm ghost', type: 'button', text: '打开底部终端',
        onclick: () => { setUI({ terminalOpen: true }); emit('terminal', true); },
      }),
    ),
    field({
      label: '命令输入',
      control: el('div', { class: 'row' },
        el('span', { class: 'mono', style: { color: 'var(--accent)' }, text: '❯' }),
        inlineInput),
      id: 'cmd-try-input',
      name: 'cmdTry',
      hideLabel: true,
    }),
    el('div', { style: { marginTop: '10px' } }, term),
  );
  page.appendChild(termCard);

  const history = [];
  let hIdx = 0;

  async function exec(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    term.style.display = 'block';
    history.push(raw);
    hIdx = history.length;
    term.appendChild(line_('❯ ' + raw, 'var(--accent)'));
    const res = await runCommand(raw);
    if (res?.out) {
      for (const l of String(res.out).split('\n')) {
        term.appendChild(line_(l, res.ok ? (res.kind === 'warn' ? 'var(--warn)' : 'var(--text-dim)') : 'var(--danger)'));
      }
    }
    term.scrollTop = term.scrollHeight;
    inlineInput.value = '';
  }

  function line_(text, color) {
    return el('div', { class: 'log-line' },
      el('span', { class: 'ts', text: fmtTime(Date.now()) }),
      el('span', { class: 'txt', style: { color, whiteSpace: 'pre-wrap' }, text }),
    );
  }

  inlineInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') exec(inlineInput.value);
    else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      hIdx = Math.max(0, hIdx - 1);
      inlineInput.value = history[hIdx] || '';
    } else if (e.key === 'ArrowDown' && history.length) {
      e.preventDefault();
      hIdx = Math.min(history.length, hIdx + 1);
      inlineInput.value = history[hIdx] || '';
    }
  });

  // ---------- 手册 ----------
  const search = el('input', {
    type: 'search', id: 'cmd-manual-search', name: 'cmdManualSearch',
    placeholder: '搜索命令或说明…', style: { maxWidth: '280px' },
  });
  const manual = el('div', { class: 'card', style: { padding: '6px 0' } });

  function paint() {
    const q = search.value.trim().toLowerCase();
    clear(manual);
    let shown = 0;
    for (const cat of CATEGORIES) {
      const list = COMMANDS.filter(c => !c.hidden && c.category === cat).filter(c => {
        if (!q) return true;
        return c.name.includes(q) || c.desc.toLowerCase().includes(q)
          || (c.alias || []).some(a => a.includes(q)) || (c.args || '').includes(q);
      });
      if (!list.length) continue;
      manual.appendChild(el('div', {
        class: 'nav-group-label', style: { padding: '12px 14px 4px' }, text: cat,
      }));
      for (const c of list) {
        shown++;
        manual.appendChild(el('div', {
          class: 'cmd-row',
          title: '点击执行',
          onclick: () => {
            const line = c.example || c.name;
            inlineInput.value = line;
            exec(line);
            inlineInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
          },
        },
          el('span', { class: 'c-syn' }, `${c.name}${c.args ? ' ' + c.args : ''}`),
          el('span', { class: 'c-desc', text: c.desc }),
          el('span', { class: 'c-args', text: c.example || '' }),
        ));
      }
    }
    if (!shown) manual.appendChild(el('div', { class: 'empty', text: '没有匹配的命令' }));
  }

  search.addEventListener('input', paint);
  page.appendChild(el('div', { class: 'card tight' },
    el('div', { class: 'row', style: { alignItems: 'flex-end' } },
      field({ label: '搜索命令', control: search, id: 'cmd-manual-search', name: 'cmdManualSearch' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: `共 ${COMMANDS.filter(c => !c.hidden).length} 条命令` }))));
  page.appendChild(manual);

  // ---------- 语法说明 ----------
  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '语法说明' }),
    el('div', { class: 'hint', style: { margin: '8px 0' }, text: '命令由「命令名 + 位置参数 + 选项」组成，选项支持 --key value 与 key=value 两种写法。' }),
    el('div', { class: 'shortcut-grid' },
      syntax('gen', '无参数：使用「生成流程」页当前选择的文件'),
      syntax('open 2', '位置参数：第 2 个任务'),
      syntax('open task_17…', '位置参数：任务 ID（支持前缀）'),
      syntax('cat meta.json --task task_1', '选项：--task 指定任务'),
      syntax('model "deepseek-chat"', '引号包裹含空格的值'),
      syntax('tasks --limit 5', '数字选项'),
    ),
  ));

  // ---------- 最近使用 ----------
  if (state.lastCommand) {
    page.appendChild(el('div', { class: 'card tight' },
      el('div', { class: 'row' },
        el('span', { class: 'hint', text: '最近执行：' }),
        el('code', { text: state.lastCommand }),
        el('button', { class: 'btn sm ghost', text: '再执行一次', onclick: () => exec(state.lastCommand) }),
      )));
  }

  paint();
}

function syntax(cmd, desc) {
  return el('div', { class: 'shortcut' },
    el('code', { style: { color: 'var(--accent)' }, text: cmd }),
    el('span', { class: 'hint', text: desc }),
  );
}
