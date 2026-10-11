/** 预设规则页：查看 B 包 B1–B5 与导入指引 */

import { el, clear, copyText, download, truncate, field } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, toast } from '../core/store.js';
import { navigate } from '../core/router.js';

const BLOCKS = [
  { key: 'b1_variables', label: 'B1 · 变量初始化', note: 'MVU 变量树的初始值，粘贴到预设的变量初始化区' },
  { key: 'b2_update_rules', label: 'B2 · 更新规则', note: '约束模型每次回复末尾输出 <update> 并写 _.set' },
  { key: 'b3_director', label: 'B3 · 导演指令', note: '当前时间 / 阶段 / 事件压力 / 偏离度的运行时注入' },
  { key: 'b4_persona_delta', label: 'B4 · 人设增量', note: '按 world.phase 切换的角色内在变化表' },
  { key: 'b5_rules.identity', label: 'B5-1 · 身份与三层分离', note: '叙事 / 时间线 / 状态严格分离' },
  { key: 'b5_rules.timeline', label: 'B5-2 · 推进规则', note: '事件顺序推进、不跳事件、时间流逝纪律' },
  { key: 'b5_rules.fence', label: 'B5-3 · 元信息围栏与认知隔离', note: '禁止泄漏元信息、角色认知边界' },
  { key: 'b5_rules.intervention', label: 'B5-4 · 干预与偏离度', note: '偏离度三档 + 原著压力组合规则' },
  { key: 'b5_rules.output', label: 'B5-5 · 输出格式', note: 'thinking / context / update 的固定顺序' },
];

function pick(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export async function renderPreset(mount, params) {
  const page = el('div', { class: 'page' });
  mount.appendChild(page);

  let tasks = [];
  try { tasks = (await api.tasks()).tasks.filter(t => t.meta); } catch {}
  if (!tasks.length) {
    page.appendChild(el('div', { class: 'card' },
      el('div', { class: 'empty' },
        el('span', { class: 'big', text: '⚙' }),
        el('div', { text: '还没有生成过的预设' }),
        el('button', { class: 'btn sm primary', style: { marginTop: '12px' }, text: '去生成', onclick: () => navigate('/generate') }))));
    return;
  }

  let currentId = params?.task || state.currentTaskId || tasks[0].taskId;
  if (!tasks.some(t => t.taskId === currentId)) currentId = tasks[0].taskId;

  const picker = el('select', { id: 'preset-task', name: 'presetTask', style: { maxWidth: '340px' } });
  for (const t of tasks) {
    picker.appendChild(el('option', { value: t.taskId },
      `${truncate(t.project?.title || t.meta?.title || t.taskId, 26)} · ${t.taskId.replace('task_', '')}`));
  }
  picker.value = currentId;
  picker.addEventListener('change', () => {
    currentId = picker.value;
    state.currentTaskId = currentId;
    navigate('/preset', { task: currentId });
  });

  page.appendChild(el('div', { class: 'card tight' },
    el('div', { class: 'row', style: { alignItems: 'flex-end' } },
      field({ label: '查看任务', control: picker, id: 'preset-task', name: 'presetTask' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm', type: 'button', text: '复制全部',
        onclick: async () => {
          const r = await api.file(currentId, 'preset_fragment.json');
          (await copyText(r.content)) ? toast('已复制完整 preset_fragment.json', 'ok') : toast('复制失败', 'error');
        },
      }),
      el('button', {
        class: 'btn sm primary', type: 'button', text: '↓ 下载 JSON',
        onclick: () => download(api.downloadUrl(currentId, 'preset_fragment.json'), 'preset_fragment.json'),
      }),
    ),
  ));

  // 导入指引
  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '导入步骤' }),
    el('div', { style: { marginTop: '10px' } },
      guideRow('①', '导入世界书（A 包）', 'SillyTavern → 世界书 → 导入 → 选择 worldbook.json'),
      guideRow('②', '填入预设（B 包）', '酒馆助手 → 预设管理 → 编辑，把下面 9 个块按标注位置粘贴'),
      guideRow('③', '设置角色卡', '角色 → 创建/编辑：上传 avatar.png 作为头像'),
      guideRow('④', '首条消息', '以 timeline.json 的首个事件作为开场'),
      guideRow('⑤', '验证', '首轮对话后检查状态栏是否出现变量、<update> 是否输出'),
    ),
  ));

  const container = el('div');
  page.appendChild(container);

  let preset;
  try {
    preset = JSON.parse((await api.file(currentId, 'preset_fragment.json')).content);
  } catch (e) {
    console.error('[preset] 读取 preset_fragment.json 失败', e);
    container.appendChild(el('div', { class: 'card' },
      el('div', { class: 'hint', style: { color: 'var(--danger)' }, text: `读取 preset_fragment.json 失败：${e.message}` })));
    return;
  }

  const search = el('input', {
    type: 'search', id: 'preset-search', name: 'presetSearch',
    placeholder: '搜索预设内容…', style: { maxWidth: '260px' },
  });
  const expandBtn = el('button', { class: 'btn sm ghost', type: 'button', text: '全部展开' });
  const blocksWrap = el('div');

  page.insertBefore(el('div', { class: 'card tight' },
    el('div', { class: 'row', style: { alignItems: 'flex-end' } },
      field({ label: '搜索预设内容', control: search, id: 'preset-search', name: 'presetSearch' }),
      el('span', { class: 'spacer' }),
      expandBtn)),
    container);
  container.appendChild(blocksWrap);

  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(blocksWrap);
    for (const b of BLOCKS) {
      const content = pick(preset, b.key);
      if (content === undefined || content === null) continue;
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      if (q && !text.toLowerCase().includes(q) && !b.label.toLowerCase().includes(q)) continue;
      const blockNode = el('details', { class: 'preset-block card', open: !q },
        el('summary', { class: 'pb-head', style: { cursor: 'pointer', listStyle: 'none' } },
          el('span', { class: 'pb-name', text: b.label }),
          el('span', { class: 'hint', style: { flex: '1' }, text: b.note }),
          el('span', { class: 'tag', text: `${text.length} 字符` }),
          el('button', {
            class: 'btn sm ghost', text: '复制',
            onclick: async (ev) => {
              ev.preventDefault();
              (await copyText(text)) ? toast(`已复制 ${b.label}`, 'ok') : toast('复制失败', 'error');
            },
          }),
        ),
        el('pre', { text }),
      );
      blocksWrap.appendChild(blockNode);
    }
    if (!blocksWrap.children.length) {
      blocksWrap.appendChild(el('div', { class: 'card' }, el('div', { class: 'empty', text: '没有匹配的预设块' })));
    }
  };

  search.addEventListener('input', render);
  expandBtn.addEventListener('click', () => {
    const all = blocksWrap.querySelectorAll('details');
    const anyClosed = [...all].some(d => !d.open);
    all.forEach(d => { d.open = anyClosed; });
    expandBtn.textContent = anyClosed ? '全部收起' : '全部展开';
  });
  render();

  if (preset.config) {
    blocksWrap.appendChild(el('div', { class: 'card' },
      el('h3', { text: '运行时配置' }),
      el('div', { class: 'kv', style: { marginTop: '8px' } },
        Object.entries(preset.config).map(([k, v]) => [
          el('div', { class: 'k', text: k }),
          el('div', { class: 'v', text: String(v) }),
        ]).flat()),
    ));
  }
}

function guideRow(no, title, desc) {
  return el('div', { class: 'cmd-row', style: { cursor: 'default' } },
    el('span', { class: 'c-syn', style: { flex: '0 0 210px' }, text: `${no} ${title}` }),
    el('span', { class: 'c-desc', text: desc }),
  );
}
