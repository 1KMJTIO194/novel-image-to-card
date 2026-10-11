/**
 * 命令系统
 *
 * 设计要点：
 *  - 命令只做「调度 + 状态修改」，真正的业务一律调用后端 API，和页面共用同一套接口
 *  - 解析支持：子命令、位置参数、--flag、key=value、引号包裹的字符串
 *  - 执行结果统一返回 { ok, out, kind }，由终端 / 面板负责展示
 */

import { api } from './api.js';
import { state, setConfig, setUI, toggleTheme, save, toast, emit } from './store.js';
import { navigate, navItem, NAV, render } from './router.js';
import { download, fmtDuration, fmtRelative, truncate, copyText } from './dom.js';
import {
  currentPreset, presetInfo, setPreset, clearPreset, exportPreset,
  importPresetFromFile, EXAMPLE_PRESET, STEP_NAMES, STEP_LABELS,
} from './preset-manager.js';

// ============================================================
// 参数解析
// ============================================================

/** 把一行命令切成 token，支持 "引号包裹" */
export function tokenize(input) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (const ch of String(input)) {
    if (quote) {
      if (ch === quote) { quote = null; } else { cur += ch; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || has) { out.push(cur); cur = ''; has = false; }
      continue;
    }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

/** 需要取值的选项名（其余布尔开关不带值） */
const VALUE_FLAGS = new Set(['task', 'tab', 'limit', 'title', 'file']);

export function parseCommand(input) {
  const tokens = tokenize(input);
  const name = (tokens.shift() || '').toLowerCase();
  const positional = [];
  const options = {};
  const pending = []; // 等待取值的布尔 flag

  for (const t of tokens) {
    const flag = t.match(/^--?([\w-]+)(?:=(.*))?$/);
    if (flag) {
      if (flag[2] !== undefined) {
        options[flag[1]] = flag[2];
      } else if (VALUE_FLAGS.has(flag[1]) && pending.length === 0) {
        pending.push(flag[1]);
      } else {
        options[flag[1]] = true;
      }
      continue;
    }
    const kv = t.match(/^([\w.-]+)=(.+)$/);
    if (kv && !positional.length) { options[kv[1]] = kv[2]; continue; }
    // 值优先补给前面等待取值的 flag
    if (pending.length) { options[pending.shift()] = t; continue; }
    positional.push(t);
  }
  // 形如 `cat --task`（缺值）的 flag 退化为布尔
  for (const f of pending) options[f] = true;

  return { name, positional, options, raw: input, tokens };
}

/** 判断配置键是否为数字型 */
const NUM_KEYS = new Set([
  'temperature', 'concurrency', 'chunkMaxLen', 'maxCharacters',
  'worldProbeChars', 'charProbeChars', 'maxA', 'maxB',
]);

// ============================================================
// 命令注册表
// ============================================================

/** @type {Array<{name:string,alias?:string[],args?:string,desc:string,category:string,example?:string,run:(c:any)=>any,complete?:(fragment:string)=>string[]}>} */
export const COMMANDS = [];

const def = (cmd) => { COMMANDS.push(cmd); return cmd; };

const ok = (out, kind = 'ok', extra = {}) => ({ ok: true, out, kind, ...extra });
const fail = (out) => ({ ok: false, out, kind: 'err' });

// ---------------- 配置类 ----------------
def({
  name: 'base', alias: ['baseurl'], args: '<URL>', category: '配置',
  desc: '设置 LLM API 的 Base URL', example: 'base https://api.deepseek.com/v1',
  complete: () => ['https://api.deepseek.com/v1', 'https://api.openai.com/v1', 'http://localhost:11434/v1'],
  run: ({ positional }) => {
    if (!positional[0]) return fail(`当前 Base URL：${state.config.baseUrl}\n用法：base <URL>`);
    setConfig({ baseUrl: positional[0].replace(/\/+$/, '') });
    return ok(`Base URL → ${state.config.baseUrl}`);
  },
});

def({
  name: 'key', alias: ['apikey'], args: '<KEY>', category: '配置',
  desc: '设置 API Key（只存在本机浏览器）', example: 'key sk-xxxxxxxx',
  run: ({ positional }) => {
    if (!positional[0]) {
      return ok(`API Key：${state.config.apiKey ? mask(state.config.apiKey) : '（未设置）'}\n用法：key <API_KEY>`);
    }
    setConfig({ apiKey: positional[0] });
    return ok(`API Key 已更新：${mask(state.config.apiKey)}`);
  },
});

def({
  name: 'model', alias: ['m'], args: '[名称]', category: '配置',
  desc: '设置或查看当前模型；--list 拉取可用模型', example: 'model deepseek-chat',
  complete: () => ['deepseek-chat', 'deepseek-reasoner', 'gpt-4o-mini', 'qwen-plus'],
  run: async ({ positional, options }) => {
    if (options.list || positional[0] === 'list') {
      const models = await api.models({ baseUrl: state.config.baseUrl, apiKey: state.config.apiKey });
      if (!models.models?.length) return ok('该 API 未返回模型列表');
      return ok(`可用模型（${models.models.length}）：\n` + models.models.slice(0, 60).map(m => '  ' + m).join('\n'));
    }
    if (!positional[0]) return ok(`当前模型：${state.config.model}\n用法：model <名称> | model --list`);
    setConfig({ model: positional[0] });
    return ok(`模型 → ${state.config.model}`);
  },
});

def({
  name: 'config', args: '[键] [值]', category: '配置',
  desc: '查看或修改任意配置项（如 concurrency=4）', example: 'config concurrency 4',
  complete: () => ['baseUrl', 'model', 'userMode', 'concurrency', 'temperature', 'chunkMaxLen', 'maxCharacters'],
  run: ({ positional }) => {
    const KEYS = ['baseUrl', 'apiKey', 'model', 'userMode', 'temperature', 'concurrency',
      'chunkMaxLen', 'maxCharacters', 'worldProbeChars', 'charProbeChars'];
    const [k, v] = positional;
    if (!k) {
      const lines = KEYS.map(key => {
        let val = state.config[key];
        if (key === 'apiKey') val = val ? mask(val) : '（未设置）';
        return `  ${key.padEnd(16)} ${val}`;
      });
      lines.push(`  ${'limits'.padEnd(16)} A≤${state.config.limits.maxA} / B≤${state.config.limits.maxB}`);
      return ok('当前配置：\n' + lines.join('\n'));
    }
    if (!KEYS.includes(k)) return fail(`未知配置项：${k}\n可用：${KEYS.join(', ')}`);
    if (v === undefined) return ok(`${k} = ${k === 'apiKey' ? mask(state.config[k]) : state.config[k]}`);
    let value = v;
    if (NUM_KEYS.has(k)) {
      value = Number(v);
      if (Number.isNaN(value)) return fail(`${k} 需要数字，收到：${v}`);
    }
    setConfig({ [k]: value });
    return ok(`${k} → ${k === 'apiKey' ? mask(value) : value}`);
  },
});

def({
  name: 'limit', args: '<A|B> <token数>', category: '配置',
  desc: '设置常驻 token 上限（超过会给出警告）', example: 'limit a 2400',
  run: ({ positional }) => {
    const [which, n] = positional;
    if (!which || !n) {
      return ok(`当前上限：A 包 ${state.config.limits.maxA} / B 包 ${state.config.limits.maxB}\n用法：limit <a|b> <token数>`);
    }
    const num = Number(n);
    if (!Number.isFinite(num) || num <= 0) return fail('token 上限需要是正数');
    setConfig({ limits: { ...state.config.limits, [which.toLowerCase() === 'a' ? 'maxA' : 'maxB']: num } });
    return ok(`上限已更新：A ${state.config.limits.maxA} / B ${state.config.limits.maxB}`);
  },
});

def({
  name: 'mode', args: '<auto|protagonist|participant|observer>', category: '配置',
  desc: '设置 user 角色模式', example: 'mode participant',
  complete: () => ['auto', 'protagonist', 'participant', 'observer'],
  run: ({ positional }) => {
    const valid = ['auto', 'protagonist', 'participant', 'observer'];
    if (!positional[0]) return ok(`当前模式：${state.config.userMode}\n可选：${valid.join(' / ')}`);
    if (!valid.includes(positional[0])) return fail(`无效模式：${positional[0]}\n可选：${valid.join(' / ')}`);
    setConfig({ userMode: positional[0] });
    return ok(`user 模式 → ${state.config.userMode}`);
  },
});

def({
  name: 'save', args: '[名称]', category: '配置',
  desc: '把当前配置导出为 JSON 文件', example: 'save my-profile',
  run: ({ positional }) => {
    const blob = new Blob([JSON.stringify({ config: state.config }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    download(url, `${positional[0] || 'novel2card-config'}.json`);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return ok('配置已导出（注意：导出文件包含 API Key，请勿分享）', 'warn');
  },
});

def({
  name: 'load', category: '配置',
  desc: '从 JSON 文件导入配置', example: 'load',
  run: () => new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(fail('未选择文件'));
      try {
        const parsed = JSON.parse(await file.text());
        const cfg = parsed.config || parsed;
        setConfig(cfg);
        resolve(ok('配置已导入：' + Object.keys(cfg).join(', ')));
      } catch (e) {
        resolve(fail('导入失败：' + e.message));
      }
    };
    input.click();
  }),
});

// ---------------- 连通性 ----------------
def({
  name: 'ping', category: '系统',
  desc: '测试 LLM 连通性并返回耗时', example: 'ping',
  run: async () => {
    const r = await api.ping({
      baseUrl: state.config.baseUrl,
      apiKey: state.config.apiKey,
      model: state.config.model,
    });
    return ok(`连接正常 · ${r.model} · ${fmtDuration(r.ms)}\n回显：${r.reply}`);
  },
});

// ---------------- 任务 ----------------
def({
  name: 'tasks', alias: ['ls'], args: '[--limit n]', category: '任务',
  desc: '列出历史生成任务', example: 'tasks',
  run: async ({ options }) => {
    const { tasks } = await api.tasks();
    state.tasks = tasks;
    emit('tasks', tasks);
    if (!tasks.length) return ok('还没有任何任务。运行 gen 开始第一次生成。');
    const limit = Number(options.limit) || 15;
    const lines = tasks.slice(0, limit).map((t, i) => {
      const status = t.running ? '● 运行中' : t.meta ? '✓ 完成' : '· 未完成';
      const name = t.project?.title || t.meta?.title || t.taskId;
      return `  ${String(i + 1).padStart(2)}. ${status}  ${t.taskId}  ${truncate(name, 22)}  ${fmtRelative(t.updatedAt)}`;
    });
    return ok(`任务列表（${tasks.length}）：\n` + lines.join('\n') + `\n\n用 open <序号|任务ID> 打开`);
  },
});

def({
  name: 'open', args: '<序号|任务ID> [--tab 页签]', category: '任务',
  desc: '打开任务：查看日志与产物', example: 'open 1',
  run: async ({ positional, options }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]);
    if (!task) return fail(`未找到任务：${positional[0] || '（请提供序号或 ID）'}`);
    state.currentTaskId = task.taskId;
    navigate('/library', { task: task.taskId, ...(options.tab ? { tab: options.tab } : {}) });
    return ok(`已打开 ${task.taskId}`);
  },
});

def({
  name: 'log', args: '<序号|任务ID>', category: '任务',
  desc: '回放任务的执行日志', example: 'log 1',
  run: async ({ positional }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]) || resolveTask(all, state.lastTaskId || state.currentTaskId);
    if (!task) return fail('未找到任务');
    const { events } = await api.taskLog(task.taskId);
    const lines = events.map(e => `  [${e.data?.step || e.event}] ${e.data?.msg || e.data?.message || ''}`.trimEnd());
    return ok(`${task.taskId} 日志（${events.length} 条）：\n` + lines.slice(-40).join('\n'));
  },
});

def({
  name: 'files', args: '<序号|任务ID>', category: '任务',
  desc: '列出任务产物文件', example: 'files 1',
  run: async ({ positional }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]) || resolveTask(all, state.lastTaskId || state.currentTaskId);
    if (!task) return fail('未找到任务');
    return ok(`${task.taskId} 产物（${task.files.length}）：\n` + task.files.map(f => '  ' + f).join('\n'));
  },
});

def({
  name: 'cat', args: '<文件> [--task ID]', category: '任务',
  desc: '查看产物文件内容（json/md/txt）', example: 'cat worldbook.json',
  complete: () => ['worldbook.json', 'preset_fragment.json', 'variables.json', 'timeline.json', 'events.json', 'phases.json', 'meta.json', 'README.md'],
  run: async ({ positional, options }) => {
    const name = positional[0];
    if (!name) return fail('用法：cat <文件名> [--task 任务ID]');
    const id = options.task || state.currentTaskId || state.lastTaskId;
    if (!id) return fail('请先用 open 指定任务，或加 --task <任务ID>');
    const r = await api.file(id, name);
    return ok(`── ${id}/${name}（${r.size} 字符）──\n${truncate(r.content, 4000)}`);
  },
});

def({
  name: 'export', alias: ['zip', 'download'], args: '[序号|任务ID]', category: '任务',
  desc: '把任务产物打包为 zip 下载', example: 'export 1',
  run: async ({ positional }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]) || resolveTask(all, state.lastTaskId || state.currentTaskId);
    if (!task) return fail('未找到任务');
    download(api.zipUrl(task.taskId), `${task.taskId}.zip`);
    return ok(`开始下载 ${task.taskId}.zip`);
  },
});

def({
  name: 'rm', alias: ['delete'], args: '<序号|任务ID>', category: '任务',
  desc: '删除任务及其产物', example: 'rm 3',
  run: async ({ positional }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]);
    if (!task) return fail(`未找到任务：${positional[0] || ''}`);
    if (task.running) return fail('任务正在运行，先 cancel 再删除');
    await api.remove(task.taskId);
    state.tasks = state.tasks.filter(t => t.taskId !== task.taskId);
    emit('tasks', state.tasks);
    return ok(`已删除 ${task.taskId}`, 'warn');
  },
});

def({
  name: 'cancel', args: '[任务ID]', category: '任务',
  desc: '取消正在运行的任务', example: 'cancel',
  run: async ({ positional }) => {
    const id = positional[0] || state.runningTaskId || (await ensureTasks()).find(t => t.running)?.taskId;
    if (!id) return fail('没有正在运行的任务');
    await api.cancel(id);
    return ok(`已请求取消 ${id}`, 'warn');
  },
});

def({
  name: 'rerun', args: '[--task ID]', category: '任务',
  desc: '用上次（或指定任务）的参数重新生成', example: 'rerun',
  run: async ({ options }) => {
    const id = options.task || state.lastTaskId || state.currentTaskId;
    if (!state.lastRun && !id) return fail('还没有可复用的生成参数，请先在「生成流程」页跑一次');
    if (!state.lastRun) return fail('当前会话没有缓存生成参数（文件需重新选择），请在「生成流程」页操作');
    await runGenerate();
    return ok('已用上次参数重新开始生成');
  },
});

def({
  name: 'reveal', args: '[序号|任务ID]', category: '任务',
  desc: '在系统文件管理器中打开产物目录', example: 'reveal 1',
  run: async ({ positional }) => {
    const all = await ensureTasks();
    const task = resolveTask(all, positional[0]) || resolveTask(all, state.lastTaskId || state.currentTaskId);
    if (!task) return fail('未找到任务');
    const r = await api.reveal(task.taskId);
    if (!r.ok) {
      return {
        ok: true,
        kind: 'warn',
        out: `${r.hint || '当前环境不允许打开文件管理器'}\n路径：${r.dir}\n可改用 export 打包下载。`,
      };
    }
    return ok(`已打开目录：${r.dir}`);
  },
});

// ---------------- 导航 ----------------
def({
  name: 'go', alias: ['page'], args: '<页面>', category: '导航',
  desc: '切换页面', example: 'go card',
  complete: () => NAV.flatMap(g => g.items.map(i => i.id)),
  run: ({ positional }) => {
    const key = (positional[0] || '').toLowerCase();
    if (!key) {
      return ok('可用页面：\n' + NAV.flatMap(g => g.items).map(i => `  ${i.id.padEnd(10)} ${i.label} — ${i.desc}`).join('\n'));
    }
    const item = navItem(key);
    if (!item) return fail(`未知页面：${key}`);
    navigate(item.path);
    return ok(`→ ${item.label}`);
  },
});

def({
  name: 'clear', category: '系统',
  desc: '清空命令行终端', example: 'clear',
  run: () => ({ ok: true, out: '', kind: 'ok', clear: true }),
});

def({
  name: 'page', hidden: true, category: '导航',
  desc: 'go 的别名', run: (c) => COMMANDS.find(x => x.name === 'go').run(c),
});

// ---------------- 界面 ----------------
def({
  name: 'theme', args: '[dark|light]', category: '界面',
  desc: '切换深色 / 浅色主题', example: 'theme light',
  complete: () => ['dark', 'light'],
  run: ({ positional }) => {
    const want = positional[0];
    if (want === 'dark' || want === 'light') {
      setUI({ theme: want });
      document.documentElement.dataset.theme = want;
      return ok(`主题 → ${want}`);
    }
    const now = toggleTheme();
    return ok(`主题 → ${now}`);
  },
});

def({
  name: 'term', args: '[on|off]', category: '界面',
  desc: '展开或收起底部命令终端', example: 'term on',
  complete: () => ['on', 'off'],
  run: ({ positional }) => {
    const open = positional[0] ? positional[0] === 'on' : !state.ui.terminalOpen;
    setUI({ terminalOpen: open });
    emit('terminal', open);
    return ok(`终端${open ? '已展开' : '已收起'}`);
  },
});

// ---------------- 系统 ----------------
def({
  name: 'status', alias: ['info'], category: '系统',
  desc: '查看服务与配置的当前状态', example: 'status',
  run: async () => {
    const [sys] = await Promise.all([api.system()]);
    state.system = sys;
    const { tasks } = await api.tasks();
    state.tasks = tasks;
    const done = tasks.filter(t => t.meta).length;
    return ok([
      `服务      ${sys.ok ? '正常' : '异常'} · Node ${sys.node} · ${sys.platform}`,
      `端口      ${sys.port}    运行时长 ${Math.round(sys.uptimeSec / 60)} 分钟`,
      `产物目录  ${sys.outputs}`,
      `模型      ${state.config.model}  (${state.config.baseUrl})`,
      `API Key   ${state.config.apiKey ? mask(state.config.apiKey) : '未设置'}`,
      `user 模式 ${state.config.userMode}`,
      `并发      ${state.config.concurrency}   分块 ${state.config.chunkMaxLen}   人物上限 ${state.config.maxCharacters}`,
      `任务      ${tasks.length} 个（已完成 ${done}）${sys.running.length ? ' · 运行中 ' + sys.running.join(',') : ''}`,
    ].join('\n'));
  },
});

def({
  name: 'doctor', category: '系统',
  desc: '自检：服务、配置、目录与连通性', example: 'doctor',
  run: async () => {
    const lines = [];
    let bad = 0;
    try {
      const sys = await api.system();
      lines.push(`  ✓ 本地服务正常（Node ${sys.node}）`);
    } catch (e) {
      lines.push(`  ✗ 本地服务不可用：${e.message}`);
      bad++;
    }
    if (!state.config.baseUrl) { lines.push('  ✗ 未设置 Base URL'); bad++; }
    else lines.push(`  ✓ Base URL ${state.config.baseUrl}`);
    if (!state.config.model) { lines.push('  ✗ 未设置模型'); bad++; }
    else lines.push(`  ✓ 模型 ${state.config.model}`);
    if (!state.config.apiKey && !/localhost|127\.0\.0\.1/.test(state.config.baseUrl)) {
      lines.push('  ! 未设置 API Key（云端 API 会失败）');
    } else {
      lines.push(`  ✓ API Key ${state.config.apiKey ? mask(state.config.apiKey) : '（本地服务，可空）'}`);
    }
    const t0 = Date.now();
    try {
      await api.ping({
        baseUrl: state.config.baseUrl, apiKey: state.config.apiKey, model: state.config.model,
      });
      lines.push(`  ✓ LLM 连通（${fmtDuration(Date.now() - t0)}）`);
    } catch (e) {
      lines.push(`  ✗ LLM 不可达：${e.message}`);
      bad++;
    }
    return bad
      ? { ok: false, kind: 'warn', out: `自检完成，${bad} 项需要处理：\n${lines.join('\n')}` }
      : ok(`自检全部通过：\n${lines.join('\n')}`);
  },
});

def({
  name: 'copy', args: '<文件> [--task ID]', category: '任务',
  desc: '复制产物内容到剪贴板', example: 'copy preset_fragment.json',
  complete: () => ['preset_fragment.json', 'worldbook.json', 'variables.json', 'README.md'],
  run: async ({ positional, options }) => {
    const name = positional[0];
    if (!name) return fail('用法：copy <文件名>');
    const id = options.task || state.currentTaskId || state.lastTaskId;
    if (!id) return fail('请先用 open 指定任务，或加 --task <任务ID>');
    const r = await api.file(id, name);
    const done = await copyText(r.content);
    return done ? ok(`已复制 ${name}（${r.size} 字符）到剪贴板`) : fail('复制失败，浏览器可能拒绝了剪贴板权限');
  },
});

def({
  name: 'help', alias: ['?'], args: '[命令名]', category: '系统',
  desc: '查看命令帮助', example: 'help gen',
  run: ({ positional }) => {
    const target = positional[0];
    if (target) {
      const cmd = findCommand(target);
      if (!cmd) return fail(`未知命令：${target}`);
      return ok([
        `命令      ${cmd.name}${cmd.alias?.length ? `（别名：${cmd.alias.join(', ')}）` : ''}`,
        `语法      ${cmd.name} ${cmd.args || ''}`,
        `说明      ${cmd.desc}`,
        cmd.example ? `示例      ${cmd.example}` : '',
      ].filter(Boolean).join('\n'));
    }
    const byCat = new Map();
    for (const c of COMMANDS) {
      if (c.hidden) continue;
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category).push(c);
    }
    const blocks = [...byCat.entries()].map(([cat, list]) =>
      `【${cat}】\n` + list.map(c => `  ${(c.name + ' ' + (c.args || '')).padEnd(34)} ${c.desc}`).join('\n')
    );
    return ok('可用命令：\n\n' + blocks.join('\n\n') +
      '\n\n提示：Ctrl+K 打开命令面板；↑/↓ 调历史；Tab 补全。');
  },
});

// ---------------- 生成预设 ----------------
def({
  name: 'preset', args: '[show|append|replace|clear]', category: '预设',
  desc: '查看或调整当前生成预设的模式', example: 'preset replace',
  complete: () => ['show', 'append', 'replace', 'clear'],
  run: ({ positional }) => {
    const sub = (positional[0] || 'show').toLowerCase();
    const cur = currentPreset();
    if (sub === 'clear') {
      if (!cur) return ok('当前没有预设');
      clearPreset({ silent: true });
      emit('preset', null);
      return ok('已清空预设', 'warn');
    }
    if (sub === 'append' || sub === 'replace') {
      if (!cur) return fail('当前没有预设，先导入或编辑一个（presetimport / 生成流程页）');
      setConfig({ preset: { ...cur, mode: sub } });
      emit('preset', currentPreset());
      return sub === 'replace'
        ? { ok: true, kind: 'warn', out: '已切换为 replace 模式：原始抽取指令将被替换（生成前会二次确认）' }
        : ok('已切换为 append 模式：后缀追加到原 prompt 末尾');
    }
    if (!cur) return ok('未加载预设 —— 将使用内置 prompt 抽取\n用 presetimport 导入，或到「生成流程 → ④ 生成预设」编辑');
    const info = presetInfo();
    const lines = [
      `名称      ${info.name || '未命名'}`,
      `模式      ${info.mode}`,
      `生效处    ${info.lines.length}`,
      ...info.lines.map(l => `          · ${l}`),
    ];
    if (info.raw.author) lines.splice(1, 0, `作者      ${info.raw.author}`);
    if (info.raw.description) lines.splice(2, 0, `说明      ${info.raw.description}`);
    lines.push('', '用 presetpreview <step> 查看某个 Step 的最终 prompt');
    return ok(lines.join('\n'), info.mode === 'replace' ? 'warn' : 'ok');
  },
});

def({
  name: 'presetimport', alias: ['presetload'], category: '预设',
  desc: '从 JSON 文件导入预设', example: 'presetimport',
  run: async () => {
    const r = await importPresetFromFile();
    if (r.cancelled) return ok('已取消');
    if (!r.ok) return fail(`导入失败：${(r.errors || []).join('；')}`);
    return {
      ok: true,
      kind: r.preset.mode === 'replace' ? 'warn' : 'ok',
      out: `已导入「${r.stats.name}」（${r.preset.mode}，${r.stats.stepCount} 个 Step 配置）` +
        (r.warnings?.length ? `\n提示：${r.warnings.join('\n      ')}` : ''),
    };
  },
});

def({
  name: 'presetexport', category: '预设',
  desc: '导出当前预设为 JSON 文件', example: 'presetexport',
  run: () => (exportPreset() ? ok('预设已导出') : fail('当前没有预设')),
});

def({
  name: 'presetexample', category: '预设',
  desc: '填入一份示例预设（含 5 个 Step 配置）', example: 'presetexample',
  run: () => {
    const v = setPreset(EXAMPLE_PRESET, { silent: true });
    return v.ok
      ? ok('已填入示例预设，可在「生成流程 → ④ 生成预设」里改成自己的内容')
      : fail(v.errors.join('；'));
  },
});

def({
  name: 'presetpreview', args: '[step名]', category: '预设',
  desc: '预览某个 Step 的最终 prompt（看预设有没有生效）', example: 'presetpreview step2',
  complete: () => STEP_NAMES,
  run: async ({ positional }) => {
    const cur = currentPreset();
    if (!cur) return fail('当前没有预设');
    const step = STEP_NAMES.includes(positional[0]) ? positional[0] : 'step2';
    const r = await api.presetPreview({ preset: cur, step });
    return ok([
      `Step      ${r.step}（${STEP_LABELS[r.step] || ''}）`,
      `模式      ${r.mode}`,
      `生效      ${r.changed ? '是' : '否 —— 该 Step 不受此预设影响'}`,
      '',
      '── system ──',
      r.system,
      '',
      '── user ──',
      r.user,
    ].join('\n'));
  },
});

/** 生成命令单独实现（需要复用页面里的表单逻辑） */
def({
  name: 'gen', alias: ['generate'], args: '[--title 标题]', category: '任务',
  desc: '用「生成流程」页当前选择的文件与参数开始生成', example: 'gen',
  run: async ({ options }) => {
    if (options.title) state.pendingTitle = options.title;
    const started = await runGenerate();
    return started ? ok('任务已启动，日志见「生成流程」页') : fail(state.lastGenerateError || '启动失败');
  },
});

// ============================================================
// 执行
// ============================================================

function mask(key) {
  const s = String(key);
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

async function ensureTasks() {
  const { tasks } = await api.tasks();
  state.tasks = tasks;
  emit('tasks', tasks);
  return tasks;
}

/** 支持用序号（1 起）或任务 ID 定位 */
export function resolveTask(tasks, ref) {
  if (!ref) return null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return tasks[Number(s) - 1] || null;
  return tasks.find(t => t.taskId === s) || tasks.find(t => t.taskId.startsWith(s)) || null;
}

export function findCommand(name) {
  const key = String(name || '').toLowerCase().replace(/^\//, '');
  return COMMANDS.find(c => c.name === key || c.alias?.includes(key));
}

/** 供生成页注册“运行生成”的实现，避免命令层依赖页面层 */
let generateImpl = null;
export function registerGenerate(fn) { generateImpl = fn; }
export async function runGenerate() {
  if (!generateImpl) {
    state.lastGenerateError = '生成器尚未就绪，请打开「生成流程」页';
    return false;
  }
  return generateImpl();
}

/**
 * 执行一行命令
 * @returns {Promise<{ok:boolean,out:string,kind:string}>}
 */
export async function runCommand(input) {
  const line = String(input || '').trim();
  if (!line) return { ok: true, out: '', kind: 'ok' };
  const parsed = parseCommand(line.replace(/^\//, ''));
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    const guess = COMMANDS
      .map(c => c.name)
      .filter(n => n.startsWith(parsed.name.slice(0, 2)))
      .slice(0, 4);
    return {
      ok: false,
      kind: 'err',
      out: `未知命令：${parsed.name}${guess.length ? `\n你是不是想输入：${guess.join(' / ')}` : ''}\n输入 help 查看全部命令。`,
    };
  }
  try {
    const result = await cmd.run(parsed);
    return result ?? ok('（无输出）');
  } catch (e) {
    return { ok: false, kind: 'err', out: `执行失败：${e?.message || e}` };
  }
}

/** 补全候选 */
export function complete(input) {
  const tokens = tokenize(input);
  const endsWithSpace = /\s$/.test(input);
  if (tokens.length <= 1 && !endsWithSpace) {
    const frag = (tokens[0] || '').toLowerCase();
    return COMMANDS.filter(c => !c.hidden && c.name.startsWith(frag)).map(c => c.name);
  }
  const cmd = findCommand(tokens[0]);
  if (!cmd) return [];
  const frag = endsWithSpace ? '' : (tokens[tokens.length - 1] || '');
  const candidates = cmd.complete?.(frag) || [];
  const prefix = tokens.slice(0, tokens.length - (endsWithSpace ? 0 : 1)).join(' ');
  return candidates
    .filter(c => c.toLowerCase().startsWith(frag.toLowerCase()))
    .map(c => (prefix ? `${prefix} ${c}` : c));
}

export const CATEGORIES = [...new Set(COMMANDS.filter(c => !c.hidden).map(c => c.category))];
export { ok, fail };
