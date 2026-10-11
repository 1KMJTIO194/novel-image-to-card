/**
 * 活动生成任务的状态中心
 *
 * 关键设计：所有与「当前这次生成」有关的状态都放在模块作用域，而不是页面里。
 *   - SSE 流由本模块持有 → 切走页面时流**不断**，进度不丢
 *   - 事件日志由本模块持有 → 回到生成页时按日志重建步骤、日志、进度
 *   - 订阅由本模块分发 → 任意页面都能显示"生成中"
 *
 * 页面只负责渲染，销毁时退订即可；模块不依赖任何 DOM 节点。
 */
import { api } from './api.js';
import { emit } from './store.js';

const MAX_LOG = 1200;
const POLL_MS = 2000;

/** 生成流程的阶段顺序（与 pipeline 的 step 名一致） */
export const STEP_SEQUENCE = [
  'Init', 'Step 0.5', 'Step 1', 'Step 2', 'Step 3',
  'Step 4', 'Step 5', 'Step 6', 'Step 8', 'Done',
];

/** 进度估算：每个阶段占的区间（Init 起、Done 收尾） */
export const STEP_PROGRESS = {
  'Init': 0.04,
  'Step 0.5': 0.10,
  'Step 1': 0.28,
  'Step 2': 0.45,
  'Step 3': 0.55,
  'Step 4': 0.65,
  'Step 5': 0.82,
  'Step 6': 0.88,
  'Step 8': 0.95,
  'Done': 1,
};

/** 从一条 progress 消息里识别阶段（容忍 "提及 3/11" 这类同阶段内的多条日志） */
export function stepFromMessage(msg) {
  const m = String(msg).match(/^\s*(Step\s*[\d.]+|Init|Done|WARN)\b/i);
  if (!m) return null;
  const raw = m[1].toLowerCase().replace(/\s+/g, '');
  if (raw === 'init') return 'Init';
  if (raw === 'done') return 'Done';
  if (raw === 'warn') return 'WARN';
  const num = raw.replace('step', '');
  return `Step ${num}`;
}

const run = {
  /** @type {null|{taskId:string, title:string, model:string, startedAt:number}} */
  task: null,
  status: 'idle',           // idle | running | done | error | cancelled
  events: [],               // {event, data, ts}
  finalMeta: null,          // 完成时的 meta
  files: null,              // 完成时的产物列表
  error: null,
  controller: null,         // 手动中止连接用（不是取消服务端任务）
  poller: null,
  pendingPoll: false,       // detach 时还没拿到 taskId，等到手再启动轮询
  detached: false,          // 已主动放弃本地连接，服务端仍在跑
  sawFiles: false,
  /** 后端在 files 事件里带回的变更总结（生成/完善/图片三条路径都会带） */
  summary: null,
  endpoint: '/api/generate', // 本次任务打的是哪个 SSE 接口（生成 / 增补）
  /** 分批评析进度：{index, total, chapters, chars, tokens} —— 只保留最近一次的 batch 事件 */
  batch: null,
  /** 服务端已确认暂停 */
  paused: false,
  /** 已发出暂停请求、服务端还没确认（批次跑到一半时会停在这个状态） */
  pausing: false,
  /** 最近一次恢复的时刻：早于它的 paused 事件在 derive 里作废 */
  resumedAt: 0,
};

const listeners = new Set();

/** 订阅状态变化；返回退订函数 */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of [...listeners]) {
    try { fn(run); } catch (e) { console.error('[active-run] listener', e); }
  }
  emit('run', snapshot());
}

/** 供 UI 使用的只读快照 */
export function snapshot() {
  return {
    status: run.status,
    running: run.status === 'running',
    task: run.task,
    taskId: run.task?.taskId || null,
    events: run.events,
    meta: run.finalMeta,
    files: run.files,
    /** 本次运行的变更总结（后端在 files 事件里带回），没有则为 null */
    summary: run.summary || null,
    error: run.error,
    batch: run.batch,
    paused: run.paused,
    pausing: run.pausing,
  };
}

export function isRunning() {
  return run.status === 'running';
}

export function currentTaskId() {
  return run.task?.taskId || null;
}

export function events() {
  return run.events;
}

/**
 * 把事件日志归约成渲染所需的全部状态。
 * 页面挂载时调用一次即可，不需要自己累积状态。
 */
export function derive() {
  const steps = new Map();       // step → {status, msg, ts}
  const logs = [];
  let progress = 0;
  let lastStep = null;
  let batch = null;              // {index, total, ...} 最近一次 batch 事件
  let batchProgress = 0;         // 批次视角算出的进度（与步骤进度取更靠后的那个）
  let paused = run.paused;
  // 恢复时刻：早于它的 paused 事件已经作废。
  //
  // 不能用"日志里有 paused 事件"当判据 —— 事件是**只增不删**的，
  // 一旦暂停过，之后无论怎么恢复，derive() 都会重新把 paused 翻回 true
  //（实测症状：点了"继续"，按钮却还是"已暂停"）。
  const resumedAt = run.resumedAt || 0;

  for (const ev of run.events) {
    const { event, data, ts } = ev;
    if (event === 'start' && data?.taskId) {
      steps.set('Init', { status: 'active', msg: `任务 ${data.taskId} 已创建`, ts });
      progress = Math.max(progress, STEP_PROGRESS['Init']);
      lastStep = 'Init';
      continue;
    }
    // 分批进度：start 与 done 都记，done 时把 index 当作"已完成数"展示。
    //
    // 进度条也要在这里推进 —— batch 事件之后不一定紧跟一条 progress 事件，
    // 只在 progress 分支里算批次进度的话，进度条会停在批次开始前的水平不动。
    if (event === 'batch') {
      if (data?.phase === 'start') batch = { ...data, done: false };
      else if (data?.phase === 'done') batch = { ...data, done: true };
      if (batch && batch.total > 0) {
        const doneCount = batch.done ? batch.index + 1 : batch.index;
        const frac = Math.min(1, doneCount / batch.total);
        // 映射到**整个分批阶段**：从 Step 1 的起点，一直铺到"组装之前的终点"。
        //
        // 为什么必须铺满这一整段，而不是只映射 Step 1→Step 2：
        // 分批阶段是长篇任务里最耗时的一段（每批 4 次 LLM 调用），而 pipeline 会在
        // 批次之间穿插打 Step 2/3/4 的日志 —— 任何一条都会把"步骤进度"一下推过去。
        // 若批次值只在 10%→28% 里走，它永远追不上，进度条整段卡死不动。
        //
        // 终点取 Step 5 的值（0.82）：批次全部跑完时进度条正好走到"即将进入组装"，
        // 与后面真正的 Step 5/6/8 日志天然衔接，不会出现"分批跑完了还停在 81%"。
        const END = STEP_PROGRESS['Step 5'];
        const START = STEP_PROGRESS['Step 1'];
        batchProgress = START + (END - START) * frac;
      }
      continue;
    }
    if (event === 'paused') { if (ts >= resumedAt) paused = true; continue; }
    if (event === 'progress') {
      // 「已恢复」由 pipeline 以 Step 'Pause' 记一条；这里把它翻回未暂停
      if (data?.step === 'Pause' && /已恢复/.test(data?.msg || '')) paused = false;
      const step = data?.step || stepFromMessage(data?.msg) || 'Init';
      const msg = data?.msg || '';
      logs.push({ kind: step === 'WARN' ? 'warn' : 'info', step, msg, ts: data?.ts || ts });

      if (step === 'WARN') {
        // 警告不推进阶段，只把当前阶段标成 warn 文案
        const cur = lastStep && steps.get(lastStep);
        if (cur) cur.msg = msg;
        continue;
      }
      const idx = STEP_SEQUENCE.indexOf(step);
      if (idx >= 0) {
        // 抵达新阶段：把之前的阶段统一收尾为 done
        for (let i = 0; i < idx; i++) {
          const key = STEP_SEQUENCE[i];
          const node = steps.get(key);
          if (node && node.status !== 'done') node.status = 'done';
        }
        const node = steps.get(step) || {};
        node.status = step === 'Done' ? 'done' : 'active';
        node.msg = msg;
        node.ts = data?.ts || ts;
        steps.set(step, node);
        progress = Math.max(progress, STEP_PROGRESS[step] ?? progress);
        lastStep = step;
      }
      continue;
    }
    if (event === 'files') {
      logs.push({ kind: 'ok', step: 'Done', msg: `产物已写入 output/${data?.taskId}/（${data?.files?.length ?? 0} 个文件）`, ts });
      progress = 1;
      for (const key of STEP_SEQUENCE) {
        const node = steps.get(key);
        if (node) node.status = 'done';
      }
      continue;
    }
    if (event === 'error') logs.push({ kind: 'error', step: 'Error', msg: data?.message || '未知错误', ts });
    if (event === 'cancelled') logs.push({ kind: 'warn', step: 'Cancel', msg: data?.message || '任务已取消', ts });
  }

  if (run.status === 'done') progress = 1;

  /**
   * 合并"步骤进度"与"批次进度"。
   *
   * 为什么是取更靠后的那个，而不是 Math.max：批次边界与步骤日志是**交错**的 ——
   * pipeline 在批次之间会打 Step 5 之类的日志（把步骤进度一下推到 82%），
   * 紧接着第 2 批完成事件带着 68% 进来。批次那 68% 是**已经发生**的事实，
   * 用 Math.max 会被 82% 压住，进度条于是卡在 82% 不动（实测踩过）。
   * 反过来也不能直接用批次值 —— 那会让进度条倒退。
   * 取两者中更靠后的，既不会倒退，也不会被提前跳到的步骤值压住。
   */
  if (run.status !== 'done') progress = Math.max(progress, batchProgress);

  return {
    status: run.status,
    running: run.status === 'running',
    task: run.task,
    steps,
    reached: lastStep,
    logs,
    progress,
    meta: run.finalMeta,
    files: run.files,
    error: run.error,
    batch,
    paused,
    pausing: run.pausing,
  };
}

/** 从回放/轮询得到的原始事件重建内部日志 */
function setEvents(list) {
  run.events = (list || []).slice(-MAX_LOG);
}

function appendEvent(event, data, ts = Date.now()) {
  run.events.push({ event, data, ts });
  if (run.events.length > MAX_LOG) run.events.splice(0, run.events.length - MAX_LOG);
}

// ============================================================
// 生命周期
// ============================================================

function startPoller() {
  stopPoller();
  run.poller = setInterval(async () => {
    const id = run.task?.taskId;
    if (!id || run.status !== 'running') return stopPoller();
    try {
      const { events: live, running } = await api.taskLog(id);
      if (eventsChanged(live)) {
        setEvents(live);
        notify();
      }
      if (!running) {
        // 任务在服务端已结束：补一次最终状态
        await finishFromServer(id);
      }
    } catch { /* 服务短暂不可用时忽略，下个周期再试 */ }
  }, POLL_MS);
}

function stopPoller() {
  if (run.poller) clearInterval(run.poller);
  run.poller = null;
}

function eventsChanged(live) {
  if (live.length !== run.events.length) return true;
  const a = run.events[run.events.length - 1];
  const b = live[live.length - 1];
  return !a || !b || a.ts !== b.ts || a.event !== b.event;
}

/** 服务端任务已结束时，把内存状态补齐（刷新页面后也能恢复） */
async function finishFromServer(taskId) {
  stopPoller();
  try {
    const info = await api.task(taskId);
    if (Array.isArray(info.files) && info.files.length) {
      run.files = info.files;
      if (!run.sawFiles) {
        appendEvent('files', { taskId, files: info.files, meta: info.meta || null });
        run.sawFiles = true;
      }
    }
    if (info.meta) run.finalMeta = info.meta;
  } catch { /* 任务可能已被删除 */ }

  if (run.status === 'running') {
    const hasError = run.events.some(e => e.event === 'error');
    const cancelled = run.events.some(e => e.event === 'cancelled');
    run.status = hasError ? 'error' : cancelled ? 'cancelled' : 'done';
  }
  run.detached = false;
  if (run.task) run.task.taskId = taskId;
  notify();
}

/**
 * 开始一次生成。
 * 调用前可先用 setTaskInfo() 填入标题/模型，让进度卡在服务端返回 taskId 之前就有信息。
 * @param {FormData} formData
 * @param {{endpoint?: string}} [opts] endpoint 默认 /api/generate；完善角色卡传 '/api/augment'
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function start(formData, { endpoint = '/api/generate' } = {}) {
  if (run.status === 'running') return { ok: false, error: '已有任务在运行' };

  const keep = run.task || { title: '', model: '' };
  run.status = 'running';
  run.events = [];
  run.finalMeta = null;
  run.files = null;
  run.summary = null;      // 新任务开始 → 丢掉上一次的总结，否则会显示旧结果
  run.error = null;
  run.endpoint = endpoint;
  run.task = { taskId: null, title: keep.title || '', model: keep.model || '', startedAt: Date.now() };
  run.controller = new AbortController();
  run.sawFiles = false;
  run.detached = false;
  run.pendingPoll = false;
  run.batch = null;
  run.paused = false;
  run.pausing = false;
  notify();

  // 不 await：流在后台跑，页面切走也继续
  const promise = api.generate(formData, {
    signal: run.controller.signal,
    endpoint,
    onEvent: (event, data) => {
      appendEvent(event, data);
      if (event === 'start') {
        run.task.taskId = data?.taskId || null;
        if (run.task.taskId) {
          startPoller();
          run.pendingPoll = false;
        }
      } else if (event === 'files') {
        run.sawFiles = true;
        run.files = data?.files || [];
        run.finalMeta = data?.meta || null;
        // 变更总结：后端在 files 事件里一起带回来，前端不必再请求
        run.summary = data?.summary || null;
      } else if (event === 'paused') {
        run.paused = true;
        run.pausing = false;
      } else if (event === 'batch') {
        run.batch = data || null;
      } else if (event === 'error') {
        run.error = data?.message || '未知错误';
      }
      notify();
    },
  }).then(
    () => {
      // 主动转入后台时流是被我们关掉的，服务端其实还在跑：
      // 这种情况下绝不能判定为完成，交给轮询继续跟随。
      if (run.detached) return;
      stopPoller();
      if (run.status === 'running') {
        run.status = run.error ? 'error' : 'done';
      }
      notify();
    },
    (e) => {
      if (run.detached) return;
      stopPoller();
      if (e?.name === 'AbortError') {
        // 只是放弃了这条连接；服务端仍在跑，交给轮询继续跟随
        if (run.task?.taskId) {
          run.detached = true;
          startPoller();
        }
        return;
      }
      run.status = 'error';
      run.error = e?.message || String(e);
      appendEvent('error', { message: run.error });
      notify();
    }
  );

  return { ok: true, promise };
}

/**
 * 暂停当前任务（在下一个批次边界停下）。
 *
 * 与 cancel 的区别：暂停只是挂起，已完成的批次都在盘上，
 * 之后可以「继续」接着跑，也可以直接关页面过会儿用同一个任务续跑。
 *
 * 注意这里**不**放弃 SSE 连接：pipeline 暂停时会抛 checkpoint，
 * 服务端返回 paused 事件并结束这次流；本地状态由那个事件驱动。
 * 如果服务端此刻正好在批次中间，它会先把这一批跑完再停 —— 所以给用户提示"正在暂停…"。
 */
export async function pause() {
  const id = run.task?.taskId;
  if (!id) return { ok: false, error: '任务还没开始' };
  run.pausing = true;
  notify();
  try {
    await api.pause(id);
  } catch (e) {
    run.pausing = false;
    notify();
    return { ok: false, error: e?.message || String(e) };
  }
  return { ok: true };
}

/**
 * 恢复被暂停的任务。
 *
 * 服务端的 job 还在（暂停≠结束），所以直接放行即可，同一条 SSE 流会继续推事件。
 */
export async function resume() {
  const id = run.task?.taskId;
  if (!id) return { ok: false, error: '任务还没开始' };
  try {
    await api.resume(id);
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
  run.paused = false;
  run.pausing = false;
  // 记下恢复时刻：让日志里那些旧的 paused 事件在 derive() 里作废
  run.resumedAt = Date.now();
  notify();
  return { ok: true };
}

/**
 * 取消当前任务（会真的通知服务端取消）
 */
export async function cancel() {
  const id = run.task?.taskId;
  stopPoller();
  if (id) {
    try { await api.cancel(id); } catch { /* 可能已经结束 */ }
  }
  run.status = 'cancelled';
  run.paused = false;
  run.pausing = false;
  if (id) appendEvent('cancelled', { message: '任务已被用户取消' });
  notify();
  return true;
}

/**
 * 放弃本地连接，让任务继续在服务端跑（"转入后台"）。
 *
 * 与 cancel 的区别：不通知服务端取消。
 * 必须保证轮询已启动，否则用户会完全失去这个任务的进度——所以如果此刻还没拿到
 * taskId（连接刚建立），就先标记 pendingPoll，等 start 事件到了再补上。
 */
export function detach() {
  const hasTaskId = !!run.task?.taskId;
  run.detached = true;
  if (hasTaskId) {
    stopPoller();
    startPoller();
  } else {
    run.pendingPoll = true;
  }
  try { run.controller?.abort(); } catch {}
  run.controller = null;
  notify();
  return hasTaskId;
}

export function reset() {
  stopPoller();
  run.status = 'idle';
  run.events = [];
  run.finalMeta = null;
  run.files = null;
  run.summary = null;
  run.error = null;
  run.task = null;
  run.controller = null;
  run.batch = null;
  run.paused = false;
  run.pausing = false;
  notify();
}

/** 开始前填入标题/模型，让进度卡立即可读 */
export function setTaskInfo({ title, model } = {}) {
  if (!run.task) run.task = { taskId: null, title: '', model: '', startedAt: Date.now() };
  if (title != null) run.task.title = title;
  if (model != null) run.task.model = model;
  notify();
}

/**
 * 页面挂载时调用：让内存状态与指定任务对齐。
 * - 正在跑 → 保证轮询在跑
 * - 已结束 → 补元信息
 * @param {string} taskId
 */
export async function attach(taskId) {
  if (!taskId) return snapshot();
  if (!run.task) run.task = { taskId, title: '', model: '', startedAt: Date.now() };
  run.task.taskId = taskId;

  if (run.status === 'running') {
    if (!run.poller) startPoller();
    return snapshot();
  }

  // 非运行态：从服务端把事件与元信息补齐（刷新页面 / 从任务页跳回）
  try {
    const { events: live, running } = await api.taskLog(taskId);
    setEvents(live);
    if (running) {
      run.status = 'running';
      if (!run.poller) startPoller();
    } else {
      await finishFromServer(taskId);
    }
  } catch { /* 日志不存在：任务刚创建或已被清理 */ }
  notify();
  return snapshot();
}

/**
 * 应用启动时恢复：如果服务端还有任务在跑（例如用户刷新了页面），
 * 自动接上它，这样侧边栏与生成页都能继续显示进度。
 */
export async function restore() {
  try {
    const { tasks } = await api.tasks();
    const running = tasks.find(t => t.running);
    if (!running) return null;
    run.task = { taskId: running.taskId, title: running.project?.title || '', model: running.meta?.model || '', startedAt: Date.now() };
    run.status = 'running';
    const { events: live } = await api.taskLog(running.taskId);
    setEvents(live);
    startPoller();
    notify();
    return running.taskId;
  } catch {
    return null;
  }
}

/** 侧边栏/顶栏用的简短描述，例如「生成中 · Step 2 · 45%」 */
export function statusText() {
  if (run.status === 'idle') return '';
  const d = derive();
  const pct = Math.round(d.progress * 100);
  if (run.status === 'running') {
    if (run.paused) return '已暂停 · 可继续';
    if (run.pausing) return '正在暂停…';
    const step = !d.reached ? '准备中'
      : d.reached === 'Init' ? '读入切分'
      : d.reached === 'Done' ? '收尾'
      : d.reached;
    // 分批期间显示"批次 N / 总批数" —— 长篇有十几批，只显示 Step 号看不出还要多久
    const batchPart = d.batch && d.batch.total > 0 && (d.reached === 'Step 1' || d.reached === 'Step 2')
      ? ` · 批次 ${Math.min(d.batch.index + 1, d.batch.total)}/${d.batch.total}`
      : '';
    return `生成中 · ${step}${batchPart} · ${pct}%`;
  }
  if (run.status === 'done') return `已完成 · ${pct}%`;
  if (run.status === 'cancelled') return '已取消';
  if (run.status === 'error') return '生成失败';
  return '';
}
