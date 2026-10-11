/**
 * 模型选择器（组合框）
 *
 * 为什么不用 <datalist>：
 *   - 纯文本候选，无法显示"当前 / 常用"等信息
 *   - 无法表达「加载中 / 加载失败 / 未拉取」这些状态
 *   - Safari 对 datalist 支持一直不完整，行为在各浏览器差异很大
 *   - 不能自定义样式与键盘交互
 *
 * 本组件：输入框 + 独立下拉面板，可自由输入、可过滤、可键盘操作、
 * 并明确区分「未加载 / 加载中 / 已加载 N 个 / 加载失败」四种状态。
 */
import { el, clear } from './dom.js';

/** 常见模型的粗略提示（仅用于候选右侧的小标签，不作为限制） */
const KNOWN = [
  { re: /deepseek/i, tag: 'DeepSeek' },
  { re: /^gpt|^o1|^o3|^o4|openai/i, tag: 'OpenAI' },
  { re: /claude/i, tag: 'Anthropic' },
  { re: /qwen|通义/i, tag: '通义' },
  { re: /glm|chatglm|zhipu/i, tag: '智谱' },
  { re: /moonshot|kimi/i, tag: 'Kimi' },
  { re: /ernie|文心/i, tag: '文心' },
  { re: /llama|mistral|qwen|gemma|phi/i, tag: '开源' },
];

const tagOf = (name) => KNOWN.find(k => k.re.test(name))?.tag || '';

/**
 * @param {object} o
 * @param {HTMLInputElement} o.input            已有的输入框
 * @param {() => Promise<string[]>} o.loadModels 拉取候选（点「拉取」或自动触发）
 * @param {(name:string)=>void} [o.onPick]      用户从候选里选中时
 * @param {string} [o.placeholder]              输入框 placeholder
 * @param {boolean} [o.autoLoad]                首次聚焦时自动拉取
 * @param {string} [o.emptyHint]                未加载时的提示语
 */
export function createModelPicker({
  input,
  loadModels,
  onPick,
  placeholder = 'deepseek-chat',
  autoLoad = true,
  emptyHint = '还没有候选列表',
}) {
  input.type = 'text';
  input.placeholder = placeholder;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-autocomplete', 'list');

  const state = {
    models: [],
    status: 'idle',      // idle | loading | ready | error
    error: null,
    filter: '',
    active: -1,
    open: false,
    source: '',          // 上一次成功拉取时的 endpoint 标记
  };

  const panel = el('div', { class: 'mp-panel', role: 'listbox', hidden: true });
  const panelList = el('div', { class: 'mp-list' });
  const panelFoot = el('div', { class: 'mp-foot' });
  panel.append(panelList, panelFoot);

  const caret = el('button', {
    class: 'mp-caret', type: 'button', tabindex: '-1',
    title: '选择模型',
    'aria-label': '选择模型',
  }, el('span', { class: 'mp-caret-icon' }));

  const wrap = el('div', { class: 'mp' }, input, caret, panel);

  // ---------- 渲染 ----------
  function visibleModels() {
    const q = state.filter.trim().toLowerCase();
    if (!q) return state.models;
    return state.models.filter(m => m.toLowerCase().includes(q));
  }

  function paintList() {
    clear(panelList);
    const list = visibleModels();

    if (state.status === 'loading') {
      panelList.appendChild(el('div', { class: 'mp-state' }, el('span', { class: 'spin' }), ' 正在拉取模型列表…'));
      return;
    }
    if (state.status === 'error') {
      panelList.appendChild(el('div', { class: 'mp-state error' },
        el('div', { text: `✗ ${state.error || '拉取失败'}` }),
        el('div', { class: 'mp-state-hint', text: '检查 Base URL 与 API Key 后重试；也可以直接手动输入模型名' }),
      ));
      return;
    }
    if (state.status === 'idle') {
      panelList.appendChild(el('div', { class: 'mp-state' },
        el('div', { text: emptyHint }),
        el('div', { class: 'mp-state-hint', text: '点下方「拉取模型列表」，或直接手动输入模型名' }),
      ));
      return;
    }
    if (!list.length) {
      panelList.appendChild(el('div', { class: 'mp-state' },
        state.filter ? `没有匹配「${state.filter}」的模型` : '该 API 未返回任何模型',
        el('div', { class: 'mp-state-hint', text: '你仍然可以直接输入任意模型名' }),
      ));
      return;
    }

    const current = input.value.trim();
    list.slice(0, 300).forEach((name, i) => {
      const tag = tagOf(name);
      const row = el('div', {
        class: `mp-item${i === state.active ? ' active' : ''}${name === current ? ' current' : ''}`,
        role: 'option',
        'aria-selected': name === current ? 'true' : 'false',
        title: name,
        onclick: () => pick(name),
        onmouseenter: () => { state.active = i; paintActive(); },
      },
        el('span', { class: 'mp-name', text: name }),
        name === current ? el('span', { class: 'mp-badge cur', text: '当前' }) : null,
        tag ? el('span', { class: 'mp-badge', text: tag }) : null,
      );
      panelList.appendChild(row);
    });
    if (list.length > 300) {
      panelList.appendChild(el('div', { class: 'mp-state-hint', style: { padding: '6px 10px' } },
        `仅显示前 300 个（共 ${list.length} 个），可用输入框过滤`));
    }
  }

  function paintActive() {
    const rows = [...panelList.querySelectorAll('.mp-item')];
    rows.forEach((r, i) => r.classList.toggle('active', i === state.active));
    rows[state.active]?.scrollIntoView({ block: 'nearest' });
  }

  function paintFoot() {
    clear(panelFoot);
    const n = state.models.length;
    const shown = visibleModels().length;
    if (state.status === 'ready') {
      panelFoot.append(
        el('span', { class: 'mp-count', text: state.filter && shown !== n ? `${shown} / ${n} 个模型` : `共 ${n} 个模型` }),
        el('button', { class: 'mp-link', type: 'button', text: '重新拉取', onclick: () => load() }),
      );
    } else if (state.status === 'error') {
      panelFoot.append(el('button', { class: 'mp-link', type: 'button', text: '重试', onclick: () => load() }));
    } else if (state.status === 'idle') {
      panelFoot.append(el('button', { class: 'mp-link', type: 'button', text: '拉取模型列表', onclick: () => load() }));
    }
  }

  function paint() {
    paintList();
    paintFoot();
  }

  function setOpen(open) {
    state.open = open;
    panel.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    caret.classList.toggle('open', open);
    if (open) {
      // 打开面板时列表要展示全部候选。
      // 输入框里的值是「当前选中的模型」，不是搜索词 ——
      // 若拿它当过滤条件，就会出现"没有匹配 deepseek-chat 的模型"这种荒谬结果。
      state.filter = '';
      state.active = -1;
      paint();
    }
  }

  function pick(name) {
    input.value = name;
    // 用 input 所属 document 的 Event 构造器。
    // 直接用全局 Event 在非浏览器宿主（如 jsdom 测试）里会因跨 realm 而被拒绝，
    // 导致 dispatchEvent 抛错、后续 setOpen(false) 不执行。
    const EventCtor = input.ownerDocument?.defaultView?.Event || Event;
    input.dispatchEvent(new EventCtor('change', { bubbles: true }));
    onPick?.(name);
    // 先关面板再还焦点；顺序反了会被 focus 相关逻辑重新打开
    setOpen(false);
    input.focus();
  }

  // ---------- 拉取 ----------
  let lastKey = null;
  async function load({ silent = false } = {}) {
    state.status = 'loading';
    state.error = null;
    if (state.open) paint();
    try {
      const list = (await loadModels()) || [];
      state.models = [...new Set(list.map(m => String(m).trim()).filter(Boolean))];
      state.status = 'ready';
      lastKey = null;
      if (!state.models.length) {
        state.status = 'error';
        state.error = '该 API 未返回任何模型（有些服务不提供 /models）';
      }
    } catch (e) {
      state.status = 'error';
      state.error = e?.message || String(e);
    }
    // 无论面板是否打开都重绘，这样展开时立刻能看到结果
    paint();
    return state.models.length;
  }

  /** endpoint 变了就丢弃旧候选，避免"换了 Key 还在用上一个服务的模型列表" */
  function invalidate(key) {
    if (key === undefined) return;
    if (lastKey !== null && lastKey !== key) {
      state.models = [];
      state.status = 'idle';
      state.error = null;
      if (state.open) paint();
    }
    lastKey = key;
  }

  // ---------- 交互 ----------
  let tried = false;

  /**
   * 只在用户"明确想选模型"时展开面板：点下拉按钮、方向键、开始输入。
   *
   * 刻意不在 focus 时展开：那样用户点进输入框改个字就被弹一脸面板，
   * 而且 pick() 内部会把焦点还给输入框，会立刻把刚关掉的面板重新打开。
   */
  function openByUser() {
    if (!state.open) setOpen(true);
  }

  input.addEventListener('mousedown', () => {
    openByUser();
    if (autoLoad && !tried && state.status === 'idle') {
      tried = true;
      setTimeout(() => load(), 0);
    }
  });

  input.addEventListener('input', () => {
    state.filter = input.value;
    state.active = -1;
    if (!state.open) setOpen(true);
    else paint();
  });

  input.addEventListener('keydown', (e) => {
    const list = visibleModels();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openByUser();
      if (autoLoad && !tried && state.status === 'idle') {
        tried = true;
        load();
        return;
      }
      if (!list.length) return;
      state.active = e.key === 'ArrowDown'
        ? Math.min(list.length - 1, state.active + 1)
        : Math.max(0, state.active - 1);
      paintActive();
    } else if (e.key === 'Enter') {
      if (state.open && state.active >= 0 && list[state.active]) {
        e.preventDefault();
        pick(list[state.active]);
      } else if (state.open) {
        setOpen(false);
      }
    } else if (e.key === 'Escape') {
      if (state.open) { e.preventDefault(); setOpen(false); }
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  });

  // caret：mousedown 阻止输入框失焦，click 负责开合（鼠标与键盘都能触发）
  caret.addEventListener('mousedown', (e) => e.preventDefault());
  caret.addEventListener('click', (e) => {
    e.preventDefault();
    if (state.open) setOpen(false);
    else {
      setOpen(true);
      if (autoLoad && !tried && state.status === 'idle') {
        tried = true;
        load();
      }
    }
  });

  // 点击外部关闭
  const onDocDown = (e) => {
    if (state.open && !wrap.contains(e.target)) setOpen(false);
  };
  document.addEventListener('mousedown', onDocDown);

  /** 供页面卸载时清理 */
  const destroy = () => document.removeEventListener('mousedown', onDocDown);

  return {
    wrap, panel, input, caret,
    load,
    invalidate,
    destroy,
    setOpen,
    get models() { return [...state.models]; },
    get status() { return state.status; },
    get error() { return state.error; },
    /** 给外部展示的简短状态文案 */
    summary() {
      if (state.status === 'ready') return `已载入 ${state.models.length} 个模型`;
      if (state.status === 'loading') return '拉取中…';
      if (state.status === 'error') return `拉取失败：${state.error}`;
      return '未拉取候选（可直接输入）';
    },
  };
}
