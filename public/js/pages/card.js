/** 角色卡内容页：世界书条目 / 变量树 / 时间线 / 阶段增量 */

import { el, clear, truncate, copyText, jsonTree, download, field } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, toast } from '../core/store.js';
import { navigate } from '../core/router.js';
import { parseEntryYaml, sortFields, isUnmentioned, densityStats } from '../core/entry-view.js';

/**
 * 条目正文视图：结构化 YAML → 逐字段卡片；普通文本 → 原样 <pre>。
 * 只建 DOM 节点，不做 innerHTML —— 正文来自 LLM，必须当不可信文本。
 */
function contentView(text) {
  const parsed = parseEntryYaml(text);
  if (!parsed) return el('pre', { text: text || '（空）' });
  return el('div', { class: 'entry-fields' },
    sortFields(parsed.fields).map(f => el('div', {
      class: `entry-field${isUnmentioned(f.value) ? ' muted' : ''}`,
    },
      el('div', { class: 'ef-label', text: f.label }),
      el('div', { class: 'ef-value', text: f.value || '（空）' }),
    )),
  );
}

/** 任务选择器：所有需要「选一个任务」的页面共用 */
export function taskPicker(currentId, onChange) {
  const select = el('select', { id: 'card-task-picker', name: 'cardTask', style: { maxWidth: '320px' } });
  const fill = (tasks) => {
    clear(select);
    for (const t of tasks) {
      const title = t.project?.title || t.meta?.title || t.taskId;
      select.appendChild(el('option', { value: t.taskId }, `${truncate(title, 24)} · ${t.taskId.replace('task_', '')}`));
    }
    if (currentId) select.value = currentId;
  };
  api.tasks().then(({ tasks }) => {
    state.tasks = tasks;
    if (!tasks.length) {
      clear(select);
      select.appendChild(el('option', { value: '' }, '（暂无任务）'));
      return;
    }
    fill(tasks);
  }).catch(() => {});
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

export async function renderCard(mount, params) {
  const page = el('div', { class: 'page' });
  mount.appendChild(page);

  let tasks = [];
  try {
    tasks = (await api.tasks()).tasks;
    state.tasks = tasks;
  } catch { /* 保持空列表 */ }

  const doneTasks = tasks.filter(t => t.meta);
  if (!doneTasks.length) {
    page.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('span', { class: 'big', text: '☰' }),
        el('div', { text: '还没有可查看的角色卡' }),
        el('button', { class: 'btn sm primary', style: { marginTop: '12px' }, text: '去生成', onclick: () => navigate('/generate') }),
      )));
    return;
  }

  let currentId = params?.task || state.currentTaskId || doneTasks[0].taskId;
  if (!doneTasks.some(t => t.taskId === currentId)) currentId = doneTasks[0].taskId;
  state.currentTaskId = currentId;

  const picker = el('select', { id: 'card-task', name: 'cardTask', style: { maxWidth: '340px' } });
  for (const t of doneTasks) {
    const title = t.project?.title || t.meta?.title || t.taskId;
    picker.appendChild(el('option', { value: t.taskId }, `${truncate(title, 26)} · ${t.taskId.replace('task_', '')}`));
  }
  picker.value = currentId;
  picker.addEventListener('change', () => {
    currentId = picker.value;
    state.currentTaskId = currentId;
    navigate('/card', { task: currentId });
  });

  const head = el('div', { class: 'card tight' },
    el('div', { class: 'row', style: { alignItems: 'flex-end' } },
      field({ label: '查看任务', control: picker, id: 'card-task', name: 'cardTask' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm primary', type: 'button', text: '↓ 打包下载',
        onclick: () => download(api.zipUrl(currentId), `${currentId}.zip`),
      }),
    ),
  );
  page.appendChild(head);

  const TABS = [
    { id: 'worldbook', label: '世界书条目' },
    { id: 'variables', label: '变量树' },
    { id: 'timeline', label: '时间线与事件' },
    { id: 'phases', label: '阶段与人设增量' },
  ];

  /**
   * 只保留这个任务**真的有产物**的标签页。
   *
   * 早期版本固定渲染四个标签、默认打开「世界书条目」，而它读的是 worldbook.json ——
   * 那是 A/B 包模式才产出的文件，于是"🎴 完整角色卡"模式的任务一进来就报
   * "该任务没有 worldbook.json"，整页内容打不开（用户实际报过的故障）。
   * 现在那份文件始终会写出来，但**老任务**仍然没有，所以这里按实际产物裁剪标签。
   */
  const taskFiles = (() => {
    try { return (tasks.find(t => t.taskId === currentId)?.files) || []; } catch { return []; }
  })();
  const TAB_FILE = {
    worldbook: 'worldbook.json',
    variables: 'variables.json',
    timeline: 'timeline.json',
    phases: 'phases.json',
  };
  const visibleTabs = TABS.filter(t => !taskFiles.length || taskFiles.includes(TAB_FILE[t.id]));
  const missingTabs = TABS.filter(t => !visibleTabs.includes(t));
  let active = params?.tab && visibleTabs.some(t => t.id === params.tab) ? params.tab
    : (visibleTabs[0]?.id || 'variables');
  if (!visibleTabs.length) {
    page.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('span', { class: 'big', text: '☰' }),
        el('div', { text: '这个任务没有可预览的内容文件' }),
        el('div', { class: 'hint', style: { marginTop: '6px' }, text: `产物：${taskFiles.join('、') || '（无）'}` }))));
    return;
  }

  const tabBar = el('div', { class: 'tabs' });
  const body = el('div');
  const paintTabs = () => {
    clear(tabBar);
    for (const t of visibleTabs) {
      tabBar.appendChild(el('div', {
        class: `tab ${t.id === active ? 'active' : ''}`,
        text: t.label,
        onclick: () => { active = t.id; paintTabs(); paint(); },
      }));
    }
    // 老任务缺文件时明确说一声，而不是留一个点了就报错的标签
    if (missingTabs.length) {
      tabBar.appendChild(el('div', {
        class: 'hint', style: { marginLeft: 'auto', alignSelf: 'center' },
        text: `（本任务没有 ${missingTabs.map(t => TAB_FILE[t.id]).join('、')}）`,
      }));
    }
  };
  page.append(tabBar, body);

  // 数据缓存
  const cache = {};
  async function load(name) {
    if (cache[name] === undefined) {
      try {
        const r = await api.file(currentId, name);
        cache[name] = JSON.parse(r.content);
      } catch (e) {
        cache[name] = null;
      }
    }
    return cache[name];
  }

  async function paint() {
    clear(body);
    const loading = el('div', { class: 'card' }, el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' 读取产物…'));
    body.appendChild(loading);
    try {
      if (active === 'worldbook') await paintWorldbook();
      else if (active === 'variables') await paintVariables();
      else if (active === 'timeline') await paintTimeline();
      else await paintPhases();
    } catch (e) {
      clear(body);
      body.appendChild(el('div', { class: 'card' }, el('div', { class: 'hint', style: { color: 'var(--danger)' }, text: `读取失败：${e.message}` })));
    }
    clear(loading);
  }

  // ---------- 世界书 ----------
  async function paintWorldbook() {
    const wb = await load('worldbook.json');
    if (!wb) throw new Error('该任务没有 worldbook.json');
    const entries = wb.entries || [];

    const q = el('input', { type: 'search', id: 'wb-search', name: 'wbSearch', placeholder: '搜索条目名 / 内容 / 触发词…' });
    const groupSel = el('select', { id: 'wb-group', name: 'wbGroup' });
    const groups = [...new Set(entries.map(e => e.extensions?.group || 'other'))];
    groupSel.appendChild(el('option', { value: '' }, '全部分组'));
    for (const g of groups) {
      const n = entries.filter(e => (e.extensions?.group || 'other') === g).length;
      groupSel.appendChild(el('option', { value: g }, `${g}（${n}）`));
    }
    const onlyConst = el('select', { id: 'wb-only-const', name: 'wbOnlyConst' });
    onlyConst.append(
      el('option', { value: '' }, '全部条目'),
      el('option', { value: '1' }, '仅常驻'),
      el('option', { value: '0' }, '仅关键词触发'),
    );
    const count = el('span', { class: 'hint' });

    const listBox = el('div');
    const card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'wb-toolbar' },
      field({ label: '搜索条目', control: q, id: 'wb-search', name: 'wbSearch' }),
      field({ label: '分组', control: groupSel, id: 'wb-group', name: 'wbGroup' }),
      field({ label: '常驻筛选', control: onlyConst, id: 'wb-only-const', name: 'wbOnlyConst' }),
      count));
    card.appendChild(listBox);
    clear(body);
    body.appendChild(card);

    const draw = () => {
      const query = q.value.trim().toLowerCase();
      const grp = groupSel.value;
      const only = onlyConst.value;
      const filtered = entries.filter(e => {
        if (grp && (e.extensions?.group || 'other') !== grp) return false;
        if (only === '1' && !e.constant) return false;
        if (only === '0' && e.constant) return false;
        if (!query) return true;
        return (e.comment || '').toLowerCase().includes(query)
          || (e.content || '').toLowerCase().includes(query)
          || (e.keys || []).some(k => String(k).toLowerCase().includes(query));
      });
      count.textContent = `${filtered.length} / ${entries.length} 条`;
      clear(listBox);
      if (!filtered.length) {
        listBox.appendChild(el('div', { class: 'empty', text: '没有匹配的条目' }));
        return;
      }
      for (const e of filtered.slice(0, 400)) {
        listBox.appendChild(el('details', { class: 'wb-entry' },
          el('summary', {},
            el('span', { class: 'idx', text: `#${e.id}` }),
            el('span', { class: 'name', text: e.comment || `条目 ${e.id}` }),
            e.constant ? el('span', { class: 'tag ok', text: '常驻' }) : null,
            // 结构化条目给一个"密度"徽标，一眼看出内容够不够厚
            (() => {
              const d = densityStats(e.content);
              return d.structured
                ? el('span', { class: 'tag info', text: `${d.fields} 字段 / ${d.chars} 字` })
                : null;
            })(),
            el('span', { class: 'keys' }, (e.keys || []).slice(0, 4).map(k => el('span', { class: 'tag', text: k }))),
          ),
          el('div', { class: 'body' },
            el('div', { class: 'row', style: { marginBottom: '8px' } },
              el('span', { class: 'tag', text: `order ${e.insertion_order}` }),
              el('span', { class: 'tag', text: e.position }),
              e.use_regex ? el('span', { class: 'tag', text: 'regex' }) : null,
              el('span', { class: 'spacer' }),
              el('button', {
                class: 'btn sm ghost', text: '复制正文',
                onclick: async (ev) => {
                  ev.preventDefault();
                  (await copyText(e.content)) ? toast('已复制', 'ok') : toast('复制失败', 'error');
                },
              }),
            ),
            contentView(e.content),
          ),
        ));
      }
    };
    q.addEventListener('input', draw);
    groupSel.addEventListener('change', draw);
    onlyConst.addEventListener('change', draw);
    draw();
  }

  // ---------- 变量树 ----------
  async function paintVariables() {
    const vars = await load('variables.json');
    if (!vars) throw new Error('该任务没有 variables.json');
    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: 'MVU 变量树（B1 初始化内容）' }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn sm ghost', text: '复制 YAML 源',
          onclick: async () => {
            const r = await api.file(currentId, 'variables.json');
            (await copyText(r.content)) ? toast('已复制', 'ok') : toast('复制失败', 'error');
          },
        }),
      ),
      el('div', { class: 'row', style: { marginBottom: '12px' } },
        el('span', { class: 'tag', text: `world.${Object.keys(vars.world || {}).length} 字段` }),
        el('span', { class: 'tag', text: `${Object.keys(vars.events || {}).length} 事件` }),
        el('span', { class: 'tag', text: `${Object.keys(vars.characters || {}).length} 人物` }),
        el('span', { class: 'tag info', text: `user.${Object.keys(vars.user || {}).length} 字段` }),
        vars.custom?.storylines ? el('span', { class: 'tag', text: `${Object.keys(vars.custom.storylines).length} 故事线` }) : null,
      ),
      jsonTree(vars, { maxDepth: 2 }),
    );
    clear(body);
    body.appendChild(card);
  }

  // ---------- 时间线与事件 ----------
  async function paintTimeline() {
    const [tl, events] = await Promise.all([load('timeline.json'), load('events.json')]);
    if (!tl && !events) throw new Error('该任务没有 timeline.json / events.json');
    clear(body);

    if (tl) {
      const card = el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', { text: '时间线' }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'tag', text: `基准：${tl.base || '相对纪元'}` }),
        ),
      );
      if (tl.origin?.event) {
        card.appendChild(el('div', { class: 'hint', style: { marginBottom: '10px' } },
          `原点事件：${tl.origin.event}${tl.origin.reason ? ` — ${tl.origin.reason}` : ''}`));
      }
      const table = el('div', {});
      const rows = tl.events || [];
      if (!rows.length) card.appendChild(el('div', { class: 'empty', text: '未抽取到明确时间锚点' }));
      for (const e of rows) {
        table.appendChild(el('div', { class: 'cmd-row', style: { cursor: 'default' } },
          el('span', { class: 'c-syn', style: { flex: '0 0 200px' }, text: e.time || '（未定）' }),
          el('span', { class: 'c-desc', text: e.name }),
          el('span', {
            class: `tag ${e.precision === 'exact' ? 'ok' : ''}`,
            text: e.precision === 'exact' ? '精确' : '推断',
          }),
          el('span', { class: 'c-args', text: e.chapter || '' }),
        ));
      }
      card.appendChild(table);
      if (tl.characters?.length) {
        card.appendChild(el('h3', { style: { margin: '16px 0 8px' }, text: '人物时间线索' }));
        for (const c of tl.characters) {
          card.appendChild(el('div', { class: 'cmd-row', style: { cursor: 'default' } },
            el('span', { class: 'c-syn', style: { flex: '0 0 200px' }, text: c.name }),
            el('span', { class: 'c-desc', text: c.birth }),
            el('span', { class: 'c-args', text: c.chapter || '' }),
          ));
        }
      }
      body.appendChild(card);
    }

    if (events) {
      const card = el('div', { class: 'card' },
        el('div', { class: 'card-head' },
          el('h3', { text: `事件（${events.length}）` }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint', text: '核 = core · 缓 = buffer · 弹 = flexible' }),
        ),
      );
      const pressureTag = p => el('span', {
        class: `tag ${p === 'core' ? 'danger' : p === 'buffer' ? 'warn' : ''}`,
        text: p === 'core' ? '核' : p === 'buffer' ? '缓' : '弹',
      });
      for (const e of events) {
        card.appendChild(el('details', { class: 'wb-entry' },
          el('summary', {},
            el('span', { class: 'name', text: e.name }),
            pressureTag(e.pressure),
            el('span', { class: 'tag', text: e.storyline || '主线' }),
            el('span', { class: 'c-args', text: e.chapter || '' }),
          ),
          el('div', { class: 'body' },
            el('div', { style: { marginBottom: '8px' } }, el('strong', { text: '原著：' }), e.canon || '—'),
            e.prerequisites?.temporal?.length
              ? el('div', { class: 'hint', text: `前置事件：${e.prerequisites.temporal.join('、')}` }) : null,
            e.prerequisites?.behavioral
              ? el('div', { class: 'hint', text: `前置行为：${e.prerequisites.behavioral}` }) : null,
            e.quote ? el('div', { class: 'hint', style: { fontStyle: 'italic', marginTop: '6px' }, text: `“${e.quote}”` }) : null,
            e.interventions?.length
              ? el('div', { style: { marginTop: '10px' } },
                  el('div', { class: 'hint', text: '干预分支：' }),
                  e.interventions.map(i => el('div', { class: 'hint', text: `  · 若${i.condition} → ${i.result}` })))
              : null,
          ),
        ));
      }
      body.appendChild(card);
    }
  }

  // ---------- 阶段 ----------
  async function paintPhases() {
    const phases = await load('phases.json');
    const mode = await load('user_mode.json');
    if (!phases) throw new Error('该任务没有 phases.json');
    clear(body);

    if (mode) {
      body.appendChild(el('div', { class: 'card tight' },
        el('div', { class: 'row' },
          el('span', { class: 'hint', text: 'user 模式判定：' }),
          el('span', { class: 'tag ok', text: mode.mode }),
          mode.protagonistName ? el('span', { class: 'tag', text: `主角 ${mode.protagonistName}` }) : null,
          mode.autoDetected ? el('span', { class: 'tag info', text: '自动判定' }) : el('span', { class: 'tag', text: '手动指定' }),
          mode.reason ? el('span', { class: 'hint', text: mode.reason }) : null,
        )));
    }

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: `剧情阶段（${phases.length}）` }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', text: '阶段名会写入 world.phase，用于 B4 人设增量切换' }),
      ),
    );
    phases.forEach((p, i) => {
      card.appendChild(el('div', { class: 'card', style: { background: 'var(--panel-2)', marginBottom: '10px' } },
        el('div', { class: 'row', style: { marginBottom: '6px' } },
          el('span', { class: 'tag info', text: `阶段 ${i + 1}` }),
          el('strong', { text: p.name }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint', text: `${p.startEvent || '?'} → ${p.endEvent || '?'}` }),
        ),
        el('div', { class: 'hint', style: { marginBottom: '10px' }, text: p.coreChange || '' }),
        p.characterDeltas?.length
          ? el('div', {}, p.characterDeltas.map(d => el('div', { class: 'row tight', style: { padding: '3px 0' } },
              el('span', { class: 'tag', text: d.character }),
              el('span', { style: { fontSize: '12.5px' }, text: d.change }),
              d.quote ? el('span', { class: 'hint', style: { fontStyle: 'italic' }, text: `“${truncate(d.quote, 30)}”` }) : null,
            )))
          : el('div', { class: 'hint', text: i === 0 ? '首个阶段不需要增量' : '未抽到人设增量' }),
      ));
    });
    body.appendChild(card);
  }

  paintTabs();
  await paint();
}
