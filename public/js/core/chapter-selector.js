/**
 * 章节选择组件（**从零生成**与**完善角色卡**共用同一套）。
 *
 * 需求明确要求两个模式复用同一套章节 UI 与同一个 /api/chapters，
 * 所以这里做成一个独立组件：谁需要章节选择就 createChapterSelector() 一个，
 * 内部状态、三种模式（全部 / 指定范围 / 自定义勾选）、chapterRange 生成逻辑
 * 全部只有这一份实现。
 *
 * 组件本身**不做网络请求**：上传后由调用方把文件交给 loadFromFile()，
 * 请求哪个后端接口由调用方决定（两个模式都打 /api/chapters）。
 */
import { el, clear } from '../core/dom.js';

/**
 * @param {{onChange?: (range: string, info: object) => void, upload: (file: File) => Promise<object>}} opts
 *   upload: 把文件发到 /api/chapters 并返回 { totalChapters, totalChars, chapters }
 */
export function createChapterSelector({ onChange, upload } = {}) {
  const state = {
    loaded: false,
    totalChapters: 0,
    totalChars: 0,
    chapters: [],
    mode: 'all',          // all | range | custom
    start: 1,
    end: 1,
    checked: new Set(),
    error: '',
    loading: false,
  };

  const root = el('div', { class: 'chapter-selector' });

  // ---------- 状态 → chapterRange ----------
  function getRange() {
    if (!state.loaded) return 'all';
    if (state.mode === 'all') return 'all';
    if (state.mode === 'range') {
      const s = clamp(state.start, 1, state.totalChapters);
      const e = clamp(state.end, 1, state.totalChapters);
      return s <= e ? `${s}-${e}` : `${e}-${s}`;
    }
    const sel = [...state.checked].sort((a, b) => a - b);
    return sel.length ? sel.join(',') : 'all';
  }

  /** 选中了哪些章（用于显示"已选 N 章 / 约 M 字"） */
  function getSelection() {
    if (!state.loaded) return { count: 0, chars: 0, indices: [] };
    if (state.mode === 'all') {
      return { count: state.totalChapters, chars: state.totalChars, indices: state.chapters.map(c => c.index) };
    }
    if (state.mode === 'range') {
      const s = clamp(state.start, 1, state.totalChapters);
      const e = clamp(state.end, 1, state.totalChapters);
      const [lo, hi] = s <= e ? [s, e] : [e, s];
      const hit = state.chapters.filter(c => c.index >= lo && c.index <= hi);
      return { count: hit.length, chars: hit.reduce((n, c) => n + c.chars, 0), indices: hit.map(c => c.index) };
    }
    const hit = state.chapters.filter(c => state.checked.has(c.index));
    return { count: hit.length, chars: hit.reduce((n, c) => n + c.chars, 0), indices: hit.map(c => c.index) };
  }

  function notify() {
    if (typeof onChange === 'function') {
      onChange(getRange(), {
        loaded: state.loaded,
        totalChapters: state.totalChapters,
        totalChars: state.totalChars,
        ...getSelection(),
      });
    }
  }

  function clamp(v, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.min(hi, Math.max(lo, Math.trunc(n)));
  }

  // ---------- 渲染 ----------
  function render() {
    clear(root);

    if (state.loading) {
      root.appendChild(el('div', { class: 'chapter-header' },
        el('span', { class: 'spin' }), ' 正在解析章节…'));
      return;
    }

    if (state.error) {
      root.appendChild(el('div', { class: 'chapter-header', style: { color: 'var(--danger)' } },
        `章节解析失败：${state.error}`));
      return;
    }

    if (!state.loaded) {
      root.appendChild(el('div', { class: 'chapter-header', text: '选择小说后自动列出章节' }));
      return;
    }

    const sel = getSelection();

    root.appendChild(el('div', { class: 'chapter-header' },
      `共 ${state.totalChapters} 章，约 ${(state.totalChars / 10000).toFixed(1)} 万字`));

    // 三种模式
    const radio = (value, label, id) => el('label', { for: id },
      el('input', {
        type: 'radio', name: `chapter-mode-${id}`, id, value, checked: state.mode === value,
        onchange: () => {
          state.mode = value;
          if (value === 'custom' && state.checked.size === 0) {
            state.chapters.forEach(c => state.checked.add(c.index));   // 默认全选
          }
          render();
          notify();
        },
      }), ` ${label}`);

    root.appendChild(el('div', { class: 'chapter-mode' },
      radio('all', '全部章节', 'chapter-mode-all'),
      radio('range', '指定范围', 'chapter-mode-range'),
      radio('custom', '自定义勾选', 'chapter-mode-custom'),
    ));

    // 指定范围
    if (state.mode === 'range') {
      const num = (id, val, on) => el('input', {
        type: 'number', id, name: id, min: 1, max: state.totalChapters, value: val,
        onchange: (e) => { on(clamp(e.target.value, 1, state.totalChapters)); render(); notify(); },
      });
      root.appendChild(el('div', { class: 'chapter-range-input' },
        el('label', { for: 'chapter-start', text: '从' }),
        num('chapter-start', state.start, v => { state.start = v; }),
        el('label', { for: 'chapter-end', text: '到' }),
        num('chapter-end', state.end, v => { state.end = v; }),
        el('span', { text: '章' }),
      ));
    }

    // 自定义勾选
    if (state.mode === 'custom') {
      const list = el('div', { class: 'chapter-list' });
      const allBox = el('input', {
        type: 'checkbox', id: 'chapter-check-all',
        checked: state.checked.size === state.totalChapters,
        onchange: (e) => {
          state.checked.clear();
          if (e.target.checked) state.chapters.forEach(c => state.checked.add(c.index));
          render(); notify();
        },
      });
      list.appendChild(el('label', { class: 'chapter-item', style: { fontWeight: '600' } },
        allBox, ' 全选 / 全不选'));

      for (const ch of state.chapters) {
        const cb = el('input', {
          type: 'checkbox', 'data-index': ch.index,
          checked: state.checked.has(ch.index),
          onchange: (e) => {
            if (e.target.checked) state.checked.add(ch.index);
            else state.checked.delete(ch.index);
            notify();
          },
        });
        list.appendChild(el('label', { class: 'chapter-item' },
          cb,
          ` 第${ch.index}章 ${String(ch.title).replace(/^第.+?[章回节]\s*/, '')}（${ch.chars} 字）`,
        ));
      }
      root.appendChild(list);
    }

    root.appendChild(el('div', { class: 'chapter-summary' },
      '已选：', el('span', { id: 'chapter-count', text: String(sel.count) }), ' 章',
      sel.count ? ` / 约 ${(sel.chars / 10000).toFixed(1)} 万字` : '',
      state.mode === 'custom' && sel.count === 0
        ? el('span', { style: { color: 'var(--warn)' } }, '（未勾选任何章节，将按全部处理）')
        : null,
    ));
  }

  // ---------- 对外 ----------
  async function loadFromFile(file) {
    if (!file) return null;
    state.loading = true;
    state.error = '';
    render();
    try {
      const data = await upload(file);
      state.loaded = true;
      state.totalChapters = Number(data?.totalChapters) || 0;
      state.totalChars = Number(data?.totalChars) || 0;
      state.chapters = Array.isArray(data?.chapters) ? data.chapters : [];
      state.mode = 'all';
      state.start = 1;
      state.end = state.totalChapters;
      state.checked = new Set(state.chapters.map(c => c.index));
      state.loading = false;
      render();
      notify();
      return data;
    } catch (e) {
      state.loading = false;
      state.loaded = false;
      state.error = e?.message || String(e);
      render();
      notify();
      return null;
    }
  }

  function reset() {
    state.loaded = false;
    state.totalChapters = 0;
    state.totalChars = 0;
    state.chapters = [];
    state.mode = 'all';
    state.checked = new Set();
    state.error = '';
    state.loading = false;
    render();
    notify();
  }

  render();

  return {
    root,
    getRange,
    getSelection,
    loadFromFile,
    reset,
    get state() { return state; },
  };
}
