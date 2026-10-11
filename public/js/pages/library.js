/** 任务与产物页：历史列表 + 详情（日志 / 产物 / README） */

import { el, clear, fmtRelative, fmtDate, fmtDuration, truncate, download, field } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, toast, emit } from '../core/store.js';
import { navigate } from '../core/router.js';
import { createSummaryBlock } from '../core/summary-view.js';

export async function renderLibrary(mount, params) {
  const page = el('div', { class: 'page wide' });
  const layout = el('div', { class: 'grid', style: { gridTemplateColumns: 'minmax(0,320px) minmax(0,1fr)', alignItems: 'start' } });
  const aside = el('div');
  const detail = el('div');
  layout.append(aside, detail);
  page.appendChild(layout);
  mount.appendChild(page);

  const searchInput = el('input', {
    type: 'search', id: 'task-search', name: 'taskSearch',
    placeholder: '搜索标题 / 任务 ID…', 'aria-label': '搜索任务',
  });
  const listBox = el('div');
  const refreshBtn = el('button', { class: 'btn sm', type: 'button', text: '↻', title: '刷新' });
  const asideCard = el('div', { class: 'card tight' },
    el('div', { class: 'row', style: { marginBottom: '10px' } },
      el('h3', { text: '任务列表' }),
      el('span', { class: 'spacer' }),
      refreshBtn,
    ),
    field({ label: '搜索任务', control: searchInput, id: 'task-search', name: 'taskSearch' }),
    el('div', { style: { marginTop: '10px' } }, listBox),
  );
  aside.appendChild(asideCard);

  let tasks = [];
  let selected = params?.task || state.currentTaskId || null;

  async function loadTasks() {
    try {
      const r = await api.tasks();
      tasks = r.tasks;
      state.tasks = tasks;
      emit('tasks', tasks);
    } catch (e) {
      listBox.innerHTML = '';
      listBox.appendChild(el('div', { class: 'hint', style: { color: 'var(--danger)' }, text: `加载失败：${e.message}` }));
      return;
    }
    paintList();
    if (!selected && tasks.length) selected = tasks[0].taskId;
    if (selected) await showDetail(selected);
  }

  function paintList() {
    clear(listBox);
    const q = searchInput.value.trim().toLowerCase();
    const filtered = tasks.filter(t => {
      if (!q) return true;
      const title = (t.project?.title || t.meta?.title || '').toLowerCase();
      return title.includes(q) || t.taskId.toLowerCase().includes(q);
    });
    if (!filtered.length) {
      listBox.appendChild(el('div', { class: 'empty', text: tasks.length ? '没有匹配的任务' : '还没有任务' }));
      return;
    }
    for (const t of filtered) {
      const title = t.project?.title || t.meta?.title || t.taskId;
      const row = el('div', {
        class: 'task',
        style: {
          padding: '9px 11px', marginBottom: '6px',
          borderColor: t.taskId === selected ? 'var(--accent)' : '',
          background: t.taskId === selected ? 'var(--accent-soft)' : '',
        },
        onclick: () => {
          selected = t.taskId;
          state.currentTaskId = t.taskId;
          paintList();
          showDetail(t.taskId);
        },
      },
        el('div', { class: 't-main' },
          el('div', { class: 't-title', style: { fontSize: '13px' }, text: truncate(title, 20) }),
          el('div', { class: 't-sub', text: `${t.taskId.replace('task_', '')} · ${fmtRelative(t.updatedAt)}` }),
        ),
        t.running
          ? el('span', { class: 'spin' })
          : el('span', { class: 'tag', style: { fontSize: '10px' }, text: t.meta ? '完成' : '未完成' }),
      );
      listBox.appendChild(row);
    }
  }

  searchInput.addEventListener('input', paintList);
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    await loadTasks();
    refreshBtn.disabled = false;
  });

  // ============================================================
  // 详情
  // ============================================================
  let pollTimer = null;
  let listPoller = null;

  /** 有任务在运行时定期刷新列表，这样"运行中"状态会自己变化 */
  function ensureListPolling() {
    if (listPoller) return;
    listPoller = setInterval(async () => {
      if (!tasks.some(t => t.running)) { clearInterval(listPoller); listPoller = null; return; }
      try {
        const r = await api.tasks();
        // 只要"运行中"的集合变了就重绘，避免打断用户阅读
        const before = tasks.filter(t => t.running).map(t => t.taskId).join(',');
        tasks = r.tasks;
        state.tasks = tasks;
        emit('tasks', tasks);
        const after = tasks.filter(t => t.running).map(t => t.taskId).join(',');
        if (before !== after) paintList();
      } catch { /* 下个周期再试 */ }
    }, 4000);
  }
  document.addEventListener('dsh:route-leave', () => {
    clearInterval(listPoller);
    clearInterval(pollTimer);
  }, { once: true });

  async function showDetail(taskId) {
    clearInterval(pollTimer);
    if (tasks.some(t => t.running)) ensureListPolling();
    clear(detail);
    let info;
    try {
      info = await api.task(taskId);
    } catch (e) {
      detail.appendChild(el('div', { class: 'card' }, el('div', { class: 'hint', text: `任务不存在：${e.message}` })));
      return;
    }
    // 批次信息：判断"这个任务能不能接着跑"。读不到就当没有（老任务没有 batches/ 目录）。
    let batchInfo = null;
    try { batchInfo = await api.batches(taskId); } catch { /* 忽略 */ }

    const title = info.project?.title || info.meta?.title || info.taskId || taskId;
    const meta = info.meta;
    // 兼容应答不完整的情况（例如产物目录被手工清理过）
    info.files = Array.isArray(info.files) ? info.files : [];
    info.warnings = Array.isArray(info.warnings) ? info.warnings : [];

    // ---------- 头部 ----------
    const head = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h2', { text: title }),
        el('span', { class: 'spacer' }),
        info.running ? el('span', { class: 'tag ok' }, el('span', { class: 'spin' }), '运行中') : null,
        info.meta?.warnings?.length ? el('span', { class: 'tag warn', text: `${info.meta.warnings.length} 警告` }) : null,
      ),
      el('div', { class: 'row', style: { marginBottom: '12px' } },
        el('span', { class: 'tag', text: info.taskId }),
        meta?.model ? el('span', { class: 'tag info', text: meta.model }) : null,
        meta?.userMode ? el('span', { class: 'tag', text: `user: ${meta.userMode}` }) : null,
        el('span', { class: 'hint', text: `创建于 ${fmtDate(info.project?.createdAt || info.updatedAt)}` }),
      ),
      el('div', { class: 'row' },
        info.running ? el('button', {
          class: 'btn primary sm', type: 'button', text: '📈 查看实时进度',
          title: '回到生成流程页，看这个任务的实时步骤与日志',
          onclick: () => navigate('/generate'),
        }) : null,
        // 断点续跑：有已落盘批次、且任务没在跑时才给这个入口。
        // 全部批次完成的任务也给 —— 用户可能想换模型重跑后面的步骤。
        !info.running && batchInfo?.total
          ? el('button', {
            class: 'btn sm', type: 'button',
            text: batchInfo.complete < batchInfo.total
              ? `⏯ 继续未完成（${batchInfo.complete}/${batchInfo.total} 批）`
              : `↻ 复用批次重跑（${batchInfo.total} 批）`,
            title: '回到生成页，复用已保存的批次结果继续跑，不会重跑已完成的章节',
            onclick: () => navigate('/generate', { resume: taskId }),
          })
          : null,
        el('button', {
          class: 'btn primary sm', type: 'button', text: '↓ 打包下载',
          onclick: () => download(api.zipUrl(taskId), `${taskId}.zip`),
        }),
        el('button', {
          class: 'btn sm', type: 'button', text: '📂 打开目录',
          onclick: async (ev) => {
            const btn = ev.currentTarget || ev.target;
            btn.disabled = true;
            try {
              const r = await api.reveal(taskId);
              if (r.ok) toast('已在文件管理器中打开', 'ok');
              else toast(r.hint || `无法打开文件管理器，路径：${r.dir}`, 'warn', 7000);
            } catch (e) {
              toast(e.message, 'error');
            } finally {
              btn.disabled = false;
            }
          },
        }),
        info.running ? el('button', {
          class: 'btn sm danger', type: 'button', text: '■ 取消',
          onclick: async (ev) => {
            ev.target.disabled = true;
            try { await api.cancel(taskId); toast('已请求取消', 'warn'); } catch (e) { toast(e.message, 'error'); }
          },
        }) : el('button', {
          class: 'btn sm danger', type: 'button', text: '删除任务',
          onclick: async () => {
            if (!confirm(`确定删除 ${taskId} 及其全部产物？此操作不可撤销。`)) return;
            try {
              await api.remove(taskId);
              toast('已删除', 'warn');
              selected = null;
              await loadTasks();
            } catch (e) { toast(e.message, 'error'); }
          },
        }),
      ),
    );
    detail.appendChild(head);

    // ---------- 分批进度（只有分批任务才有）----------
    if (batchInfo?.total) {
      const done = batchInfo.complete || 0;
      detail.appendChild(el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', { text: '分批评析' }),
          el('span', { class: 'spacer' }),
          el('span', {
            class: `tag ${done === batchInfo.total ? 'ok' : 'warn'}`,
            text: `${done} / ${batchInfo.total} 批完成`,
          }),
        ),
        el('div', { class: 'bar', style: { marginBottom: '10px' } },
          el('i', { style: { width: `${Math.round(done / batchInfo.total * 100)}%` } })),
        el('div', { class: 'grid cols-4' },
          stat('批数', batchInfo.total),
          stat('已完成', done),
          stat('总字数', (batchInfo.batches.reduce((s, b) => s + (b.chars || 0), 0)).toLocaleString()),
          stat('每批上限', batchInfo.state
            ? `${batchInfo.state.batchChapters ?? '-'} 章 / ${Math.round((batchInfo.state.batchChars ?? 0) / 10000)} 万字`
            : '-'),
        ),
      ));
    }

    // ---------- 统计 ----------
    if (meta?.counts) {
      const c = meta.counts;
      detail.appendChild(el('div', { class: 'grid cols-4', style: { marginBottom: '14px' } },
        stat('字数', c.chars.toLocaleString()),
        stat('章节块', c.chapters),
        stat('事件', `${c.events}`, `${c.storylines} 条线`),
        stat('阶段', `${c.phases}`, `${c.characters} 人物`),
      ));
      detail.appendChild(el('div', { class: 'grid cols-4', style: { marginBottom: '14px' } },
        stat('世界书条目', c.worldbookEntries),
        stat('A 包常驻', `${meta.tokens.a}`, `阈值 ${meta.tokens.limits?.maxA ?? '-'}`),
        stat('B 包常驻', `${meta.tokens.b}`, `阈值 ${meta.tokens.limits?.maxB ?? '-'}`),
        stat('耗时', fmtDuration(meta.durationMs)),
      ));
    }

    // ---------- 警告 ----------
    if (meta?.warnings?.length) {
      detail.appendChild(el('div', { class: 'card' },
        el('h3', { text: '校验警告' }),
        el('div', { style: { marginTop: '8px' } },
          meta.warnings.map(w => el('div', { class: 'warn-item', text: `⚠ ${w}` }))),
      ));
    }

    // ---------- 页签 ----------
    // 「变更总结」放第一个：用户最关心"这次改了什么"，而不只是文件列表
    const tabs = [
      { id: 'summary', label: '变更总结' },
      { id: 'files', label: '产物文件' },
      { id: 'log', label: '执行日志' },
      { id: 'preview', label: '文件预览' },
      { id: 'readme', label: '导入说明' },
    ];
    let active = params?.tab || 'summary';
    const tabBar = el('div', { class: 'tabs' });
    const panel = el('div', { class: 'card' });
    const paintTabs = () => {
      clear(tabBar);
      for (const t of tabs) {
        tabBar.appendChild(el('div', {
          class: `tab ${t.id === active ? 'active' : ''}`,
          text: t.label,
          onclick: () => { active = t.id; paintTabs(); paintPanel(); },
        }));
      }
    };

    async function paintPanel() {
      clear(panel);
      if (active === 'summary') {
        // 总结由后端算/读（旧任务现算，新任务直接落盘），这里只负责挂载
        panel.appendChild(await createSummaryBlock(info.taskId));
        return;
      }
      if (active === 'files') {
        panel.appendChild(el('div', { class: 'card-head' }, el('h3', { text: `产物文件（${info.files.length}）` })));
        const grid = el('div', { class: 'file-grid' });
        for (const f of info.files) {
          grid.appendChild(el('div', {
            class: 'file-chip',
            title: `下载 ${f}`,
            onclick: () => download(api.downloadUrl(taskId, f), f),
          },
            el('span', { class: 'fi', text: f.endsWith('.json') ? '⬡' : /\.(png|jpe?g|webp|gif)$/i.test(f) ? '🖼' : '📄' }),
            el('span', { class: 'fn', text: f }),
          ));
        }
        panel.appendChild(grid);
      } else if (active === 'log') {
        panel.appendChild(el('div', { class: 'card-head' },
          el('h3', { text: '执行日志' }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint', text: info.running ? '运行中，每 2 秒刷新' : '来自 output/<task>/log.jsonl' }),
        ));
        const logBox = el('div', { class: 'log', style: { maxHeight: '520px' } });
        panel.appendChild(logBox);
        const draw = async () => {
          try {
            const { events, running } = await api.taskLog(taskId);
            clear(logBox);
            for (const ev of events) {
              const kind = ev.event === 'error' ? 'error'
                : ev.event === 'cancelled' ? 'warn'
                : ev.event === 'files' ? 'ok' : 'info';
              const step = ev.data?.step || ev.event;
              const msg = ev.data?.msg || ev.data?.message
                || (ev.event === 'files' ? `写出 ${ev.data.files?.length || 0} 个文件` : JSON.stringify(ev.data || {}));
              logBox.appendChild(el('div', { class: `log-line ${kind}` },
                el('span', { class: 'ts', text: new Date(ev.ts).toLocaleTimeString('zh-CN', { hour12: false }) }),
                el('span', { class: 'step-tag', text: `[${step}]` }),
                el('span', { class: 'txt', text: msg }),
              ));
            }
            logBox.scrollTop = logBox.scrollHeight;
            if (running) pollTimer = setTimeout(draw, 2000);
          } catch (e) {
            logBox.textContent = `日志读取失败：${e.message}`;
          }
        };
        draw();
      } else if (active === 'preview') {
        const select = el('select', { id: 'task-file-select', name: 'taskFile' }, info.files
          .filter(f => /\.(json|md|txt|ya?ml)$/i.test(f))
          .map(f => el('option', { value: f }, f)));
        const box = el('pre', { class: 'code', text: '选择一个文件查看内容' });
        select.addEventListener('change', async () => {
          box.textContent = '读取中…';
          try {
            const r = await api.file(taskId, select.value);
            box.textContent = r.content;
          } catch (e) {
            box.textContent = `读取失败：${e.message}`;
          }
        });
        panel.appendChild(field({
          label: '选择文件', control: select, id: 'task-file-select', name: 'taskFile',
        }));
        panel.appendChild(box);
        if (select.options.length) {
          select.value = 'meta.json';
          if (!select.value) select.selectedIndex = 0;
          select.dispatchEvent(new Event('change'));
        }
      } else if (active === 'readme') {
        panel.appendChild(el('div', { class: 'card-head' },
          el('h3', { text: '导入说明（README.md）' }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'btn sm ghost', text: '新的窗口打开',
            onclick: () => window.open(api.downloadUrl(taskId, 'README.md'), '_blank'),
          }),
        ));
        const box = el('pre', { class: 'code', text: '读取中…' });
        panel.appendChild(box);
        api.file(taskId, 'README.md')
          .then(r => { box.textContent = r.content; })
          .catch(e => { box.textContent = `读取失败：${e.message}（该任务可能未生成 README）`; });
      }
    }

    paintTabs();
    paintPanel();
    detail.append(tabBar, panel);
  }

  await loadTasks();
}

function stat(k, v, extra) {
  return el('div', { class: 'stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v sm', text: String(v) }),
    extra ? el('div', { class: 'hint', text: String(extra) }) : null,
  );
}
