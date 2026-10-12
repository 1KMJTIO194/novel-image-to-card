/**
 * 任务注册表：把核心流程跑起来并把事件流分发给客户端。
 *
 * 为什么不用 `server.js` 里的那套：那个文件顶层有 `app.listen()` 与整套 express 路由，
 * import 它会在宿主进程里**再起一个 HTTP 服务器**。所以这里独立实现，
 * 但复用的是同一批核心模块（`src/pipeline.js` / `src/augment.js` / `src/image_card.js`），
 * 所以产物、算法、行为与本地版完全一致。
 */
import { mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { importCore } from './loader.js';

/** 任务表（进程内；插件重载后丢失，产物仍在磁盘上） */
const jobs = new Map();

/** 事件缓冲上限：够晚连的客户端回放，不至于吃光内存 */
const MAX_BUFFER = 4000;

export function getJob(taskId) {
  return jobs.get(taskId) || null;
}

export function listJobs() {
  return [...jobs.values()].map(j => ({
    taskId: j.taskId,
    kind: j.kind,
    title: j.title,
    startedAt: j.startedAt,
    status: j.status,
    error: j.error || null,
  })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function newTaskId() {
  return `task_${Date.now()}`;
}

/**
 * 建任务骨架并返回 job。`run` 由调用方在返回后异步启动。
 *
 * @param {{kind:string, title:string, baseDir:string, input:object}} opts
 */
export async function createJob({ kind, title, baseDir, input = {} }) {
  const taskId = newTaskId();
  const outDir = path.join(baseDir, 'output', taskId);
  await mkdir(outDir, { recursive: true });

  const job = {
    taskId,
    kind,
    title: title || '未命名',
    startedAt: new Date().toISOString(),
    status: 'running',
    error: null,
    outDir,
    input,
    events: [],
    listeners: new Set(),
    controller: new AbortController(),
    paused: false,
    done: null,          // Promise，供撤销/等待
  };
  jobs.set(taskId, job);

  job.emit = (event, data) => {
    const rec = { event, data, ts: Date.now() };
    if (event !== 'checkpoint') {
      job.events.push(rec);
      if (job.events.length > MAX_BUFFER) job.events.shift();
    }
    for (const fn of job.listeners) {
      try { fn(rec); } catch { /* 单个监听器出错不影响任务 */ }
    }
  };

  /** SSE 订阅：先回放已有事件，再继续推送 */
  job.subscribe = (fn) => {
    for (const rec of job.events) {
      try { fn(rec); } catch { /* 同上 */ }
    }
    job.listeners.add(fn);
    return () => job.listeners.delete(fn);
  };

  job.finish = (status, error = null) => {
    job.status = status;
    if (error) job.error = error;
    job.emit('__end', { status, error });   // 内部事件，路由层据此结束 SSE
  };

  return job;
}

/**
 * 启动一次「从零生成角色卡」。
 *
 * 输入文本必须落到磁盘：`runPipeline` 是文件路径驱动的（它自己负责编码检测）。
 */
export async function startGenerate(job, {
  novelText = '', novelPath = null, imagePaths = [],
  baseUrl, apiKey, model, title, userMode = 'auto', outputMode = 'card',
  chapterRange = 'all', limits = null, preset = null,
  // 高级项，与本地版同名同义
  options = {},
}) {
  const { runPipeline } = await importCore('pipeline.js');

  let srcPath = novelPath;
  if (!srcPath) {
    srcPath = path.join(job.outDir, 'novel.txt');
    await writeFile(srcPath, String(novelText || ''), 'utf-8');
  }

  await writeFile(path.join(job.outDir, 'project.json'), JSON.stringify({
    taskId: job.taskId,
    title,
    source: novelPath ? path.basename(novelPath) : '（面板粘贴的文本）',
    createdAt: job.startedAt,
    userMode,
    model,
    outputMode,
    via: 'dsh-plugin',
  }, null, 2), 'utf-8');

  job.emit('start', { taskId: job.taskId, startedAt: job.startedAt });
  job.emit('progress', { step: 'Init', msg: `任务 ${job.taskId} 已创建`, ts: Date.now() });

  const config = {
    outDir: job.outDir,
    novelPath: srcPath,
    imagePaths,
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model,
    title,
    userMode,
    outputMode,
    chapterRange: chapterRange || 'all',
    limits: limits || undefined,
    preset: preset || null,
    signal: job.controller.signal,
    isPaused: () => job.paused === true,
    resumeBatches: false,
    ...options,
  };
  return runPipeline(config, job.emit);
}

/**
 * 启动一次「完善已有角色卡」。
 */
export async function startAugment(job, {
  cardPath, novelText, novelPath = null, strategy = 'merge',
  baseUrl, apiKey, model, chapterRange = 'all', preset = null, options = {},
}) {
  const { runAugment } = await importCore('augment.js');

  let srcPath = novelPath;
  if (!srcPath && novelText) {
    srcPath = path.join(job.outDir, 'novel.txt');
    await writeFile(srcPath, String(novelText), 'utf-8');
  }

  job.emit('start', { taskId: job.taskId, startedAt: job.startedAt });
  job.emit('progress', { step: 'Init', msg: `增补任务已创建（策略：${strategy}）`, ts: Date.now() });

  return runAugment({
    outDir: job.outDir,
    cardPath,
    cardFileName: path.basename(cardPath),
    novelPath: srcPath,
    novelText,
    strategy,
    chapterRange: chapterRange || 'all',
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    apiKey,
    model,
    preset: preset || null,
    signal: job.controller.signal,
    ...options,
  }, job.emit);
}

/**
 * 启动一次「图片生成角色卡」。
 */
export async function startImageCard(job, {
  imagePaths, title, hint = '', wantWorldbook = true,
  baseUrl, apiKey, model, preset = null,
  batchSize = undefined, concurrency = undefined,
}) {
  const {
    extractCharactersFromImages, buildCardFromExtraction, writeImageCardOutputs, summarizeCard,
    DEFAULT_VISION_BATCH, DEFAULT_VISION_CONCURRENCY,
  } = await importCore('image_card.js');

  const emit = job.emit;
  emit('start', { taskId: job.taskId, startedAt: job.startedAt });
  emit('progress', { step: 'Init', msg: `图片任务已创建（${imagePaths.length} 张）`, ts: Date.now() });

  const vision = await extractCharactersFromImages({
    imagePaths, hint,
    baseUrl: String(baseUrl || '').replace(/\/+$/, ''),
    apiKey, model, preset,
    batchSize: batchSize || DEFAULT_VISION_BATCH,
    concurrency: concurrency || DEFAULT_VISION_CONCURRENCY,
    send: emit,
  });

  if (!vision.quality?.usable) {
    throw new Error(`模型 ${model} 没有给出可用的视觉分析（${vision.quality?.detail || '未识别出角色'}）。`
      + '请换用支持视觉的模型。');
  }
  const result = await buildCardFromExtraction({
    profiles: vision.profiles,
    title,
    wantWorldbook: wantWorldbook !== false,
  });
  const sum = summarizeCard(result);
  emit('progress', {
    step: 'Assemble',
    msg: `角色 ${sum.characters} 人 / 世界书 ${sum.worldbook} 条 / ${sum.entries} 条条目`,
    ts: Date.now(),
  });

  const written = await writeImageCardOutputs(job.outDir, result, {
    imagePaths,
    vision: { raw: vision.raw, profiles: vision.profiles },
    meta: {
      taskId: job.taskId, kind: 'image-card', title,
      createdAt: job.startedAt, model,
      imageCount: imagePaths.length,
      counts: { images: imagePaths.length, characters: sum.characters, worldbook: sum.worldbook, entries: sum.entries },
      visionVerified: !!vision.quality?.verified,
      sawImage: vision.sawImage,
    },
  });

  emit('files', { taskId: job.taskId, taskDir: job.outDir, files: written, summary: null });
  return { taskId: job.taskId, outDir: job.outDir, ...result, written };
}

/** 列出任务产物（文件名 + 字节数） */
export async function listArtifacts(outDir) {
  const names = await readdir(outDir).catch(() => []);
  const out = [];
  for (const n of names) {
    if (n === 'batches' || n === 'images') continue;
    const st = await stat(path.join(outDir, n)).catch(() => null);
    if (st?.isFile()) out.push({ name: n, size: st.size });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 读一个产物文件（限定在任务目录内，防目录穿越） */
export async function readArtifact(outDir, name) {
  const base = path.resolve(outDir);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('非法文件名');
  }
  return readFile(target);
}

/** 删除任务记录与产物 */
export async function removeJob(taskId) {
  const job = jobs.get(taskId);
  if (job) {
    job.controller.abort();
    jobs.delete(taskId);
    await rm(job.outDir, { recursive: true, force: true });
    return true;
  }
  return false;
}
