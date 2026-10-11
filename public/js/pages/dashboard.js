/** 总览页：状态、快捷入口、流程说明 */

import { el, fmtRelative, fmtDuration, truncate } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, emit } from '../core/store.js';
import { navigate, navItem } from '../core/router.js';

export async function renderDashboard(mount) {
  const page = el('div', { class: 'page' });

  page.appendChild(el('div', { class: 'hero' },
    el('div', { class: 'h-txt' },
      el('h1', { text: '小说 → 角色卡生成器' }),
      el('p', { text: '把小说文本自动转换成 SillyTavern 角色卡：A 包世界书 + B 包酒馆助手预设，含时间线、事件压力与变量树。' }),
      el('div', { class: 'flow' },
        el('span', { class: 'node', text: '小说文本' }),
        el('span', { class: 'arrow', text: '→' }),
        el('span', { class: 'node', text: '时间线 / 事件 / 人物' }),
        el('span', { class: 'arrow', text: '→' }),
        el('span', { class: 'node', text: 'A 包世界书' }),
        el('span', { class: 'arrow', text: '+' }),
        el('span', { class: 'node', text: 'B 包预设' }),
      ),
    ),
    el('button', {
      class: 'btn primary lg',
      text: '开始生成 →',
      onclick: () => navigate('/generate'),
    }),
  ));

  // ---------- 数据加载 ----------
  let tasks = [];
  let system = null;
  try {
    const [t, s] = await Promise.all([api.tasks(), api.system()]);
    tasks = t.tasks;
    system = s;
    state.tasks = tasks;
    state.system = s;
    state.serverOk = true;
  } catch (e) {
    state.serverOk = false;
    page.appendChild(el('div', { class: 'card' },
      el('h2', { style: { color: 'var(--danger)' }, text: '⚠ 本地服务未响应' }),
      el('p', { class: 'hint', text: `无法访问 /api/system：${e.message}。请确认 node server.js 仍在运行。` }),
    ));
  }

  // ---------- 统计 ----------
  const done = tasks.filter(t => t.meta);
  const totalEvents = done.reduce((s, t) => s + (t.meta?.counts?.events || 0), 0);
  const totalChars = done.reduce((s, t) => s + (t.meta?.counts?.chars || 0), 0);
  const running = tasks.filter(t => t.running);

  const stats = el('div', { class: 'grid cols-4' },
    statCard('历史任务', tasks.length, '个'),
    statCard('已完成', done.length, '个', running.length ? `运行中 ${running.length}` : null),
    statCard('累计事件', totalEvents, '条'),
    statCard('累计处理', (totalChars / 10000).toFixed(1), '万字'),
  );
  page.appendChild(stats);

  // ---------- 两栏：最近任务 + 系统状态 ----------
  const cols = el('div', { class: 'grid cols-2', style: { marginTop: '14px' } });

  const recentCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '最近任务' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn sm ghost', text: '全部 →', onclick: () => navigate('/library') }),
    ),
  );
  if (!tasks.length) {
    recentCard.appendChild(el('div', { class: 'empty' },
      el('span', { class: 'big', text: '📄' }),
      el('div', { text: '还没有生成记录' }),
      el('button', { class: 'btn sm primary', style: { marginTop: '12px' }, text: '去做第一次生成', onclick: () => navigate('/generate') }),
    ));
  } else {
    for (const t of tasks.slice(0, 5)) {
      const title = t.project?.title || t.meta?.title || t.taskId;
      recentCard.appendChild(el('div', {
        class: 'task',
        style: { padding: '10px 12px', marginBottom: '7px' },
        onclick: () => navigate('/library', { task: t.taskId }),
      },
        el('div', { class: 't-main' },
          el('div', { class: 't-title', text: truncate(title, 26) }),
          el('div', { class: 't-sub', text: `${t.taskId} · ${fmtRelative(t.updatedAt)}${t.meta ? ` · ${fmtDuration(t.meta.durationMs)}` : ''}` }),
        ),
        statusTag(t),
      ));
    }
  }
  cols.appendChild(recentCard);

  const sysCard = el('div', { class: 'card' }, el('h3', { text: '系统状态' }));
  if (system) {
    sysCard.appendChild(el('div', { class: 'kv', style: { marginTop: '10px' } },
      el('div', { class: 'k', text: '本地服务' }), el('div', { class: 'v', style: { color: 'var(--ok)' }, text: `正常 · 127.0.0.1:${system.port}` }),
      el('div', { class: 'k', text: 'Node 版本' }), el('div', { class: 'v', text: system.node }),
      el('div', { class: 'k', text: '运行时长' }), el('div', { class: 'v', text: `${Math.round(system.uptimeSec / 60)} 分钟` }),
      el('div', { class: 'k', text: '产物目录' }), el('div', { class: 'v', text: system.outputs }),
      el('div', { class: 'k', text: '当前模型' }), el('div', { class: 'v', text: state.config.model || '（未设置）' }),
      el('div', { class: 'k', text: 'API Key' }), el('div', { class: 'v', text: state.config.apiKey ? '已设置' : '未设置' }),
    ));
  }
  sysCard.appendChild(el('div', { class: 'row', style: { marginTop: '14px' } },
    el('button', { class: 'btn sm', text: '⚒ 设置', onclick: () => navigate('/settings') }),
    el('button', { class: 'btn sm', text: '❯ 命令', onclick: () => navigate('/commands') }),
    el('button', {
      class: 'btn sm ghost', text: '运行自检',
      onclick: async (e) => {
        e.target.disabled = true;
        e.target.textContent = '自检中…';
        emit('command', 'doctor');
        setTimeout(() => { e.target.disabled = false; e.target.textContent = '运行自检'; }, 1200);
      },
    }),
  ));
  cols.appendChild(sysCard);
  page.appendChild(cols);

  // ---------- 快速上手 ----------
  const steps = [
    ['1', '配置 API', '在「设置」里填入 Base URL、API Key 与模型名，点“测试连接”确认可用。', '/settings'],
    ['2', '上传小说', '进入「生成流程」，选择 .txt / .md 小说；首张图片会作为角色卡头像。', '/generate'],
    ['3', '开始生成', '点击开始后可在同页看实时日志；也可在底栏输入 gen 命令启动。', '/generate'],
    ['4', '取用产物', '在「任务与产物」下载 worldbook.json 与 preset_fragment.json，按 README 导入 SillyTavern。', '/library'],
    ['5', '检查内容', '在「角色卡内容」核对世界书条目、变量树与阶段增量，在「预设规则」核对 B1–B5。', '/card'],
  ];
  const guide = el('div', { class: 'card' }, el('h3', { text: '快速上手' }));
  for (const [n, title, desc, path] of steps) {
    guide.appendChild(el('div', {
      class: 'cmd-row',
      onclick: () => navigate(path),
    },
      el('span', { class: 'c-syn', text: `${n}. ${title}` }),
      el('span', { class: 'c-desc', text: desc }),
      el('span', { class: 'c-args', text: '前往 →' }),
    ));
  }
  page.appendChild(guide);

  // ---------- 快捷键 ----------
  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '快捷键与命令' }),
    el('p', { class: 'hint', style: { margin: '6px 0 12px' }, text: '本项目内置命令行：底栏可直接输入，命令面板支持模糊搜索与补全。' }),
    el('div', { class: 'shortcut-grid' },
      shortcut('Ctrl + K', '打开命令面板'),
      shortcut('` (底栏聚焦)', '命令终端'),
      shortcut('Ctrl + `', '展开 / 收起终端'),
      shortcut('↑ / ↓', '调取命令历史'),
      shortcut('Tab', '补全命令与参数'),
      shortcut('help', '查看全部命令'),
    ),
  ));

  mount.appendChild(page);
}

function statCard(k, v, unit, extra) {
  return el('div', { class: 'stat' },
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v' }, String(v), unit ? el('span', { class: 'u', text: unit }) : null),
    extra ? el('div', { class: 'hint', text: extra }) : null,
  );
}

function statusTag(t) {
  if (t.running) return el('span', { class: 'tag ok' }, el('span', { class: 'spin' }), '运行中');
  if (t.meta?.warnings?.length) return el('span', { class: 'tag warn', text: `${t.meta.warnings.length} 条警告` });
  if (t.meta) return el('span', { class: 'tag ok', text: '完成' });
  return el('span', { class: 'tag', text: '未完成' });
}

function shortcut(key, desc) {
  return el('div', { class: 'shortcut' }, el('kbd', { text: key }), el('span', { text: desc }));
}
