/**
 * 变更总结面板（生成页 / 任务与产物页共用）
 *
 * 用户诉求：「生成角色卡后总结增加了什么内容，修改了哪些地方」。
 *
 * 数据来自后端 `/api/tasks/:id/summary`（结构化）或 SSE `files` 事件里带的 `summary`。
 * 这里只负责渲染 —— 所有计算都在 `src/summary.js`，一边一份实现容易走偏。
 */

import { el, clear, copyText } from './dom.js';
import { api } from './api.js';
import { toast } from './store.js';

const GROUP_LABEL = {
  character: '人物', event: '剧情事件', worldbook: '世界观',
  storyline: '故事线', phase: '角色阶段', other: '其它',
};

/** 变化量徽标：+N / ±0 / -N */
function deltaChip(n) {
  const cls = n > 0 ? 'ok' : n < 0 ? 'danger' : 'mute';
  const txt = n > 0 ? `+${n}` : n === 0 ? '±0' : String(n);
  return el('span', { class: `chip ${cls}`, text: txt });
}

/** 按类型分组的名字列表（每类一行） */
function groupedList(items = []) {
  const box = el('div', { class: 'sum-groups' });
  const groups = new Map();
  for (const it of items) {
    const t = it?.type || 'other';
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(String(it?.name || '(无名)'));
  }
  if (!groups.size) return null;
  for (const [t, names] of groups) {
    const shown = names.slice(0, 14);
    const rest = names.length - shown.length;
    box.appendChild(el('div', { class: 'sum-group' },
      el('div', { class: 'sum-group-head' },
        el('span', { class: 'sum-group-label', text: GROUP_LABEL[t] || t }),
        el('span', { class: 'sum-group-count', text: String(names.length) })),
      el('div', { class: 'sum-group-names' },
        shown.join('、') + (rest > 0 ? ` 等 ${names.length} 项` : ''))));
  }
  return box;
}

/**
 * 渲染总结面板。
 *
 * @param {object} summary 后端返回的结构化总结
 * @param {{compact?:boolean}} [opts] compact = 生成页用（少一层标题）
 * @returns {HTMLElement}
 */
export function renderSummaryPanel(summary, { compact = false } = {}) {
  const s = summary || {};
  const isAug = s.kind === 'augment';
  const card = el('div', { class: 'card sum-card' });

  // ---------- 标题 ----------
  card.appendChild(el('div', { class: 'sum-head' },
    el('h3', { text: isAug ? `🧾 完善总结：${s.title || ''}` : `🧾 生成总结：${s.title || ''}` }),
    el('span', { class: 'hint', text: s.baseline || '' })));

  if (s.model) card.appendChild(el('div', { class: 'hint', text: `模型：${s.model}` }));

  // ---------- 一句话变化 / 本次产出 ----------
  if (s.highlights?.length) {
    card.appendChild(el('div', { class: 'sum-highlight', text: s.highlights.join('  ·  ') }));
  } else if (isAug) {
    card.appendChild(el('div', { class: 'sum-highlight mute', text: '本次没有新增或修改条目' }));
  }

  // ---------- 改动前后对照（仅完善） ----------
  const rows = [
    ['entries', '总条目'], ['characters', '人物'],
    ['events', '事件'], ['worldbook', '世界观'],
  ].filter(([k]) => s.before?.[k] !== undefined || s.after?.[k] !== undefined);
  if (isAug && rows.length) {
    const table = el('table', { class: 'sum-table' });
    table.appendChild(el('thead', {}, el('tr', {},
      el('th', { text: '项目' }), el('th', { text: '改动前' }),
      el('th', { text: '改动后' }), el('th', { text: '变化' }))));
    const tb = el('tbody');
    for (const [k, cn] of rows) {
      tb.appendChild(el('tr', {},
        el('td', { text: cn }),
        el('td', { class: 'num', text: String(s.before?.[k] ?? '—') }),
        el('td', { class: 'num', text: String(s.after?.[k] ?? '—') }),
        el('td', { class: 'num' }, deltaChip(s.delta?.[k] ?? 0))));
    }
    table.appendChild(tb);
    card.appendChild(table);
  }

  // 生成路径：本次产出的规格
  if (!isAug && (s.tierText || s.kitText)) {
    if (s.tierText) card.appendChild(el('div', { class: 'hint', text: `人物分层：${s.tierText}` }));
    if (s.kitText) card.appendChild(el('div', { class: 'hint', text: s.kitText }));
  }
  if (s.source) card.appendChild(el('div', { class: 'hint', text: s.source }));

  // ---------- 新增 / 修改 ----------
  const addBox = groupedList(s.added);
  if (addBox) {
    card.appendChild(el('div', { class: 'sum-section-title ok',
      text: `新增内容（${s.added.length} 项）` }));
    card.appendChild(addBox);
  }
  const updBox = groupedList(s.updated);
  if (updBox) {
    card.appendChild(el('div', { class: 'sum-section-title',
      text: `修改内容（${s.updated.length} 项）` }));
    card.appendChild(updBox);
  }
  if (s.matchedCount) {
    card.appendChild(el('div', { class: 'hint',
      text: `与已有条目对齐 ${s.matchedCount} 项（按策略合并，未重复新增）` }));
  }

  // ---------- 冲突 ----------
  if (s.conflicts?.length) {
    const box = el('div', { class: 'sum-section-title danger', text: `冲突 ${s.conflicts.length} 处（需确认）` });
    card.appendChild(box);
    for (const c of s.conflicts.slice(0, 8)) {
      card.appendChild(el('div', { class: 'hint',
        text: `· ${c?.name || c?.target || '(无名)'}${c?.reason ? `：${c.reason}` : ''}` }));
    }
  }

  // ---------- 处理范围 ----------
  if (s.chapters?.length) {
    card.appendChild(el('div', { class: 'hint',
      text: `处理范围：${s.chapters.slice(0, 6).join('、')}`
        + (s.chapters.length > 6 ? ` 等 ${s.chapters.length} 章` : '') }));
  }

  // ---------- 抽取统计 ----------
  const st = s.extracted || {};
  const stats = [['事件', st.events], ['人物', st.characters], ['世界观', st.worldbook], ['阶段', st.phases]]
    .filter(([, v]) => typeof v === 'number');
  if (stats.length) {
    card.appendChild(el('div', { class: 'hint',
      text: `抽取统计：${stats.map(([k, v]) => `${k} ${v}`).join(' / ')}` }));
  }

  // ---------- 需要注意 ----------
  if (s.notes?.length) {
    for (const n of s.notes) {
      card.appendChild(el('div', { class: 'sum-note', text: `⚠ ${n}` }));
    }
  }

  if (s.version?.from) {
    card.appendChild(el('div', { class: 'hint', text: `卡片版本 ${s.version.from} → ${s.version.to}` }));
  }

  return card;
}

/**
 * 带"加载中 / 失败"处理的异步版本：给任务页用（任务可能是旧产物，要向后端要）。
 *
 * @param {string} taskId
 * @param {{onDone?:(markdown:string)=>void}} [opts]
 */
export async function createSummaryBlock(taskId, { onDone } = {}) {
  const host = el('div', { class: 'sum-host' });
  host.appendChild(el('div', { class: 'hint', text: '正在读取总结…' }));
  try {
    const r = await api.summary(taskId);
    clear(host);
    if (!r?.summary) {
      host.appendChild(el('div', { class: 'hint', text: '这个任务没有可用的总结数据' }));
      return host;
    }
    host.appendChild(renderSummaryPanel(r.summary));
    if (r.source === 'derived') {
      host.appendChild(el('div', { class: 'hint',
        text: '（这个任务是旧产物，总结是现算的；新任务会直接落盘 SUMMARY.md）' }));
    }
    if (typeof onDone === 'function') onDone(r.markdown || '');
    // 操作：复制 Markdown / 下载
    host.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } },
      el('button', {
        class: 'btn sm ghost', type: 'button', text: '复制 Markdown 总结',
        onclick: async () => {
          const ok = await copyText(r.markdown || '');
          toast(ok ? '总结已复制' : '复制失败', ok ? 'ok' : 'err');
        },
      }),
      el('a', {
        class: 'btn sm ghost', href: api.downloadUrl(taskId, 'SUMMARY.md'),
        text: '下载 SUMMARY.md', download: 'SUMMARY.md',
      }),
    ));
  } catch (e) {
    clear(host);
    host.appendChild(el('div', { class: 'hint', style: { color: 'var(--danger)' },
      text: `总结读取失败：${e.message}` }));
  }
  return host;
}
