/**
 * 小说 → 角色卡生成器 · 本地服务
 *
 * 页面：/            单页多视图（hash 路由）
 * API ：/api/*       任务、产物、命令、连通性
 *
 * 只监听 127.0.0.1；API Key 仅在内存中转发给 LLM，不落盘。
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdir, readdir, readFile, writeFile, stat, rm, copyFile,
} from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { exec } from 'node:child_process';
import { platform } from 'node:os';
import archiver from 'archiver';
import { runPipeline } from './src/pipeline.js';
import { runAugment } from './src/augment.js';
import { listModels, testConnection, checkBaseUrl, makeLLM } from './src/llm.js';
import { chunkText, estimateTokens, listChapters } from './src/utils.js';
import { detectAndDecode } from './src/encoding.js';
import { validatePreset, previewStep, STEP_NAMES, STEP_LABELS } from './src/preset.js';
import * as S_STEPS from './src/steps.js';
import {
  extractCharactersFromImages, buildCardFromExtraction,
  writeImageCardOutputs, summarizeCard, listImagesInDir,
  MAX_IMAGES, DEFAULT_VISION_BATCH, DEFAULT_VISION_CONCURRENCY,
} from './src/image_card.js';
import { extractCardSummary } from './src/image_summary.js';
import { refineMainAppearance } from './src/image_detail.js';
import { summarizeAugment, summarizeGenerate, renderSummaryMarkdown } from './src/summary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'output');
const PUBLIC_DIR = path.join(ROOT, 'public');
/** 与 pipeline 里同名 —— 批次进度概览文件 */
const BATCH_STATE_FILE = 'batch_state.json';

/** 端口优先级：命令行 --port > 环境变量 PORT > 3000 */
function resolvePort() {
  const argv = process.argv.slice(2);
  const i = argv.findIndex(a => a === '--port' || a === '-p');
  const fromArg = i >= 0 ? argv[i + 1] : (argv.find(a => /^--port=/.test(a))?.split('=')[1]);
  const n = Number(fromArg || process.env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
}
const PORT = resolvePort();
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
const upload = multer({
  dest: UPLOAD_DIR,
  /**
   * ⚠️ `files` 是 busboy 的**硬上限**，在按字段计数（maxCount）之前就触发。
   *
   * 踩过的坑：这里原来写的是 `files: 6`，而前端早就允许选 8 张 ——
   * 等于"界面能选 8 张，传上去第 7 张就被拒"，报错还是 multer 原始的
   * `Too many files`，完全看不出是哪里限的。
   *
   * 现在按图片上限放大，留些余量给其它字段（小说文件 / 卡片 / 头像）。
   */
  limits: { fileSize: 100 * 1024 * 1024, files: MAX_IMAGES + 8 },
});

/** 正在运行的任务：taskId → { listeners:Set, buffer:[], signal:AbortController, startedAt, paused } */
const jobs = new Map();

app.use(express.json({ limit: '2mb' }));

/**
 * 界面静态资源一律不缓存。
 *
 * 这是本地单机应用：资源就在磁盘上，缓存省不下什么，但过期缓存代价很大——
 * 改完代码后浏览器仍执行旧模块，会出现「明明修好了还是白屏」，
 * 或者旧模块 import 一个已被移动的路径而报 404。
 */
app.use((req, res, next) => {
  if (/\.(?:js|mjs|css|html)$/.test(req.path) || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
  }
  next();
});

/**
 * 静态资源：HTML / JS 一律 **no-store**。
 *
 * 为什么：这是个本地工具，代码随时会被改。浏览器把 `js/pages/*.js` 缓存住之后，
 * 会出现「**页面是旧的、后端是新的**」的错配 —— 用户点了新功能，
 * 前端却按旧逻辑把请求拦下（或只发旧字段），表现为"点了没反应/生成失败"，
 * 而且**没有任何报错能指向真正原因**。我自己排查时就撞了一次：
 * 用户以为重启过，实际浏览器还在跑旧 JS。
 *
 * 关掉缓存对这个工具没有代价（文件都在本机、只有几十 KB）。
 */
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (/\.(html|js|mjs|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  },
}));

// ============================================================
// 任务持久化辅助
// ============================================================

const logFileOf = (taskId) => path.join(OUTPUT_DIR, taskId, 'log.jsonl');
const tidyTaskId = (s) => String(s || '').replace(/[^\w.-]/g, '');
const tidyFileName = (s) => String(s || '').replace(/[^\w.\u4e00-\u9fff-]/g, '');

async function appendLog(taskId, event, data) {
  try {
    await writeFile(logFileOf(taskId), JSON.stringify({ event, data, ts: Date.now() }) + '\n', { flag: 'a' });
  } catch { /* 日志失败不影响主流程 */ }
}

async function readTaskMeta(taskId) {
  const dir = path.join(OUTPUT_DIR, taskId);
  try {
    const [metaRaw, files] = await Promise.all([
      readFile(path.join(dir, 'meta.json'), 'utf-8').catch(() => null),
      readdir(dir),
    ]);
    const st = await stat(dir);
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    const projectJson = await readFile(path.join(dir, 'project.json'), 'utf-8').catch(() => null);
    return {
      taskId,
      files: files.filter(f => f !== 'log.jsonl'),
      hasLog: files.includes('log.jsonl'),
      updatedAt: st.mtime.toISOString(),
      running: jobs.has(taskId),
      meta,
      project: projectJson ? JSON.parse(projectJson) : null,
    };
  } catch {
    return null;
  }
}

/**
 * 轻量的任务状态：任务还在跑（没有 meta.json）时也能拿到标题与进度概况。
 * 生成页在切换回来 / 刷新后靠它恢复顶部信息。
 */
app.get('/api/tasks/:taskId/meta', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const dir = path.join(OUTPUT_DIR, taskId);
  try {
    await stat(dir);
  } catch {
    return res.status(404).json({ error: '任务不存在' });
  }
  const job = jobs.get(taskId);
  const readJson = async (name) => {
    const raw = await readFile(path.join(dir, name), 'utf-8').catch(() => null);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  const [project, meta] = await Promise.all([readJson('project.json'), readJson('meta.json')]);
  let files = [];
  try { files = (await readdir(dir)).filter(f => f !== 'log.jsonl'); } catch {}
  res.json({
    taskId,
    running: !!job,
    startedAt: job ? new Date(job.startedAt).toISOString() : project?.createdAt || null,
    elapsedMs: job ? Date.now() - job.startedAt : (meta?.durationMs ?? null),
    title: project?.title || meta?.title || null,
    model: meta?.model || project?.model || null,
    userMode: meta?.userMode || project?.userMode || null,
    preset: meta?.preset || project?.preset || null,
    counts: meta?.counts || null,
    tokens: meta?.tokens || null,
    durationMs: meta?.durationMs ?? null,
    warnings: meta?.warnings || [],
    complete: !!meta,
    files,
  });
});

async function listTasks() {  await mkdir(OUTPUT_DIR, { recursive: true });
  const names = (await readdir(OUTPUT_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory())
    .map(d => d.name);
  const tasks = (await Promise.all(names.map(readTaskMeta))).filter(Boolean);
  return tasks.sort((a, b) => (a.taskId < b.taskId ? 1 : -1));
}

// ============================================================
// 上传文件名
// ============================================================

/**
 * 修复 multipart 文件名乱码。
 *
 * 背景：multipart/form-data 的 filename 参数按 RFC 应视为 latin1 字节串，
 * busboy/multer 逐字节映射成 JS 字符串，于是「测试.txt」的 UTF-8 字节
 * 会变成「æµ‹è¯•.txt」这类乱码。
 *
 * 但不能无脑 Buffer.from(name,'latin1').toString('utf8')：
 * 若某天 multer/busboy 已按 UTF-8 正确解码，那样做会把「测试」变成「æµ‹è¯•」。
 * 所以先判断当前字符串是否"看起来像被 latin1 展开的 UTF-8"：
 *   - 只含 latin1 可逆区间（<= 0xFF）
 *   - 转回 UTF-8 后不再含替换字符
 *   - 且确实包含多字节序列（否则纯 ASCII 无需处理）
 * 满足才转码，否则原样保留。
 */
function fixUploadName(name) {
  const original = String(name ?? '');
  if (!original) return '';
  if (!/^[\x00-\xFF]*$/.test(original)) return original;   // 已含 >0xFF 字符，不可能需要转
  const bytes = Buffer.from(original, 'latin1');
  const utf8 = bytes.toString('utf8');
  if (utf8.includes('\uFFFD')) return original;            // 不是合法 UTF-8，保持原样
  if (Buffer.byteLength(utf8, 'utf8') === bytes.length && utf8 === original) return original; // 纯 ASCII
  return utf8;
}

/** 判断字符串是否像被 latin1 展开的 UTF-8（供诊断接口使用） */
function looksMojibake(name) {
  const s = String(name ?? '');
  return fixUploadName(s) !== s;
}

// ============================================================
// 生成：SSE
// ============================================================

app.post(
  '/api/generate',
  upload.fields([{ name: 'novel', maxCount: 1 }, { name: 'images', maxCount: 5 }]),
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* 客户端已断开 */ }
    };

    const novelFile = req.files?.novel?.[0];
    if (!novelFile) {
      send('error', { message: '未上传小说文件' });
      return res.end();
    }

    const { baseUrl, apiKey, model, userMode, title, outputMode, chapterRange, resumeTaskId: resumeRaw } = req.body || {};
    if (!baseUrl || !model) {
      send('error', { message: 'API 配置不完整（需要 Base URL 与模型名）' });
      return res.end();
    }
    if (!apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
      send('error', { message: '缺少 API Key' });
      return res.end();
    }

    let options = {};
    try { options = JSON.parse(req.body.options || '{}'); } catch {}
    let limits;
    try { limits = JSON.parse(req.body.limits || 'null') || undefined; } catch {}
    // 生成预设（prompt 附加/替换）：非法预设不阻断生成，只在日志里说明
    let preset = null;
    let presetIssue = null;
    if (req.body.preset) {
      const v = validatePreset(req.body.preset);
      if (v.ok) {
        preset = v.preset;
      } else {
        presetIssue = v.errors.join('；');
      }
    }

    const newTaskId = `task_${Date.now()}`;

    /**
     * 断点续跑。
     *
     * 关键点：续跑必须**复用原 task 目录**，因为已完成的批次就落在
     * `output/<taskId>/batches/` 下。新开目录等于从零开始，续跑就无从谈起。
     *
     * 所以这里 `resumeTaskId` 同时承担两个作用：
     *   ① 指定 taskId（沿用旧目录）
     *   ② 开关 `config.resumeBatches`（允许复用批次文件）
     * 校验它确实存在且有 `batches/` 目录，避免用户瞎填一个 ID 就复用了别人的产物。
     */
    let resumeTaskId = null;
    const wanted = tidyTaskId(resumeRaw);
    if (wanted) {
      try {
        const st = await stat(path.join(OUTPUT_DIR, wanted, 'batches'));
        if (st.isDirectory()) resumeTaskId = wanted;
      } catch { /* 校验失败 → 当作全新任务 */ }
    }

    const taskId = resumeTaskId || newTaskId;
    const outDir = path.join(OUTPUT_DIR, taskId);
    const controller = new AbortController();
    const job = { taskId, buffer: [], controller, startedAt: Date.now(), paused: false };
    jobs.set(taskId, job);

    // 上传文件名可能是 latin1 展开的 UTF-8，这里统一修好再落盘
    const originalName = fixUploadName(novelFile.originalname);
    const titleFromName = originalName.replace(/\.[^.]+$/, '');
    const finalTitle = title || titleFromName;

    // 输出模式：card（完整角色卡）/ ab（A 包 + B 包）/ both（两者都要，默认）
    const mode = ['card', 'ab', 'both'].includes(outputMode) ? outputMode : 'both';

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15_000);

    send('start', { taskId, startedAt: new Date().toISOString() });

    try {
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'project.json'), JSON.stringify({
        taskId,
        title: finalTitle,
        sourceFile: originalName,
        // 原始（可能乱码的）名字也留一份，便于排查编码问题
        sourceFileRaw: novelFile.originalname !== originalName ? novelFile.originalname : undefined,
        createdAt: new Date().toISOString(),
        userMode: userMode || 'auto',
        model,
        outputMode: mode,
        preset: preset ? { name: preset.name, mode: preset.mode } : null,
      }, null, 2));

      const config = {
        outDir,
        novelPath: novelFile.path,
        imagePaths: (req.files?.images || []).map(f => f.path),
        baseUrl: String(baseUrl).replace(/\/+$/, ''),
        apiKey,
        model,
        title: finalTitle,
        userMode: userMode || 'auto',
        outputMode: mode,
        // 章节范围：'' / undefined / 'all' 一律按全部处理
        chapterRange: chapterRange || 'all',
        limits,
        preset,
        signal: controller.signal,
        // 暂停：pipeline 在每个批次边界轮询这个回调
        isPaused: () => job.paused === true,
        // 断点续跑：复用了旧目录时才允许读回已完成的批次
        resumeBatches: !!resumeTaskId,
        ...options,
      };

      const emit = (event, data) => {
        // 暂停检查点：pipeline 在批次边界抛出这个信号，表示"停下来等我"。
        // 这里不把它当作完成，也不写进 SSE —— 直接抛出，由外层 catch 收成 paused 事件。
        if (event === 'checkpoint') {
          const err = new Error('任务已在检查点暂停');
          err.name = 'PausedError';
          err.checkpoint = data || null;
          throw err;
        }
        send(event, data);
        job.buffer.push({ event, data, ts: Date.now() });
        if (job.buffer.length > 4000) job.buffer.shift();
        appendLog(taskId, event, data);
      };
      emit('progress', { step: 'Init', msg: `任务 ${taskId} 已创建`, ts: Date.now() });
      if (presetIssue) {
        emit('progress', {
          step: 'WARN',
          msg: `预设无法使用，已忽略：${presetIssue}`,
          ts: Date.now(),
        });
      }

      const result = await runPipeline(config, emit);
      send('done', { ok: true, taskId: result.taskId, meta: result.meta });
    } catch (e) {
      const aborted = e?.name === 'AbortError' || /已取消|aborted/i.test(e?.message || '');
      const paused = e?.name === 'PausedError';
      const payload = {
        message: paused ? '任务已暂停（已完成批次已落盘，可随时继续）'
          : aborted ? '任务已被用户取消'
          : (e?.message || String(e)),
      };
      send(paused ? 'paused' : aborted ? 'cancelled' : 'error', payload);
      await appendLog(taskId, paused ? 'paused' : aborted ? 'cancelled' : 'error', payload);
    } finally {
      clearInterval(heartbeat);
      jobs.delete(taskId);
      try { rm(novelFile.path, { force: true }); } catch {}
      for (const f of req.files?.images || []) {
        try { rm(f.path, { force: true }); } catch {}
      }
      res.end();
    }
  }
);

// ============================================================
// 任务与产物
// ============================================================

app.get('/api/tasks', async (req, res) => {
  try {
    res.json({ tasks: await listTasks(), running: [...jobs.keys()] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tasks/:taskId', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const meta = await readTaskMeta(taskId);
  if (!meta) return res.status(404).json({ error: '任务不存在' });
  res.json(meta);
});

app.get('/api/tasks/:taskId/log', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  let raw = '';
  try {
    raw = await readFile(logFileOf(taskId), 'utf-8');
  } catch {
    // 正在运行但还没有落盘日志时，回放内存缓冲
    const job = jobs.get(taskId);
    if (!job) return res.status(404).json({ error: '无日志' });
    return res.json({ events: job.buffer, running: true });
  }
  const events = raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  res.json({ events, running: jobs.has(taskId) });
});

/** 运行中任务的事件缓冲（刷新页面后重新挂载用，做轮询即可） */
app.get('/api/tasks/:taskId/stream', (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const job = jobs.get(taskId);
  if (!job) return res.status(404).json({ error: '任务未在运行' });
  res.json({ events: job.buffer, running: true });
});

app.post('/api/tasks/:taskId/cancel', (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const job = jobs.get(taskId);
  if (!job) return res.status(404).json({ error: '任务未在运行' });
  // 被暂停的任务不能只 abort 就完事：pipeline 正卡在暂停轮询里，
  // abort 后它会在下一轮检查到 signal.aborted 并抛 AbortError —— 这是想要的，
  // 但为了让用户马上看到反馈，先把暂停标志清掉，让它能走到那个检查。
  job.paused = false;
  job.controller.abort();
  res.json({ ok: true, taskId });
});

/**
 * 暂停 / 恢复。
 *
 * 语义是"在下一个批次边界停下"，不是立刻中断：
 * 正在飞的那几个 LLM 请求会跑完（否则已经花掉的 token 白费），
 * 但不会开始新的批次。已完成的批次都已落盘，所以暂停后：
 *   - 关掉页面 / 关掉服务都不丢进度；
 *   - 用同一个 taskId 续跑即可继续。
 */
app.post('/api/tasks/:taskId/pause', (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const job = jobs.get(taskId);
  if (!job) return res.status(404).json({ error: '任务未在运行' });
  job.paused = true;
  res.json({ ok: true, taskId, paused: true });
});

app.post('/api/tasks/:taskId/resume', (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const job = jobs.get(taskId);
  if (!job) return res.status(404).json({ error: '任务未在运行' });
  job.paused = false;
  res.json({ ok: true, taskId, paused: false });
});

/**
 * 已落盘的批次清单（前端展示"批次 N / 总批数"、以及判断能否续跑）。
 * 不依赖内存里的 job —— 服务重启后依然能读出来。
 */
app.get('/api/tasks/:taskId/batches', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const dir = path.join(OUTPUT_DIR, taskId, 'batches');
  let files = [];
  try {
    files = (await readdir(dir)).filter(f => /^batch_\d+\.json$/.test(f)).sort();
  } catch {
    return res.json({ taskId, batches: [], complete: 0, total: 0 });
  }
  const batches = [];
  for (const f of files) {
    const raw = await readFile(path.join(dir, f), 'utf-8').catch(() => null);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw);
      batches.push({
        index: j.index,
        chapters: Array.isArray(j.chapters) ? j.chapters : [],
        chars: j.chars || 0,
        tokens: j.tokens || 0,
        complete: j.complete === true,
        firstTitle: j.firstTitle || '',
        lastTitle: j.lastTitle || '',
        error: j.error || null,
      });
    } catch { /* 半个文件（写入中断）直接跳过，续跑时会重跑该批 */ }
  }
  const state = await readFile(path.join(OUTPUT_DIR, taskId, BATCH_STATE_FILE), 'utf-8').catch(() => null);
  res.json({
    taskId,
    batches,
    complete: batches.filter(b => b.complete).length,
    total: batches.length,
    state: state ? (() => { try { return JSON.parse(state); } catch { return null; } })() : null,
    running: jobs.has(taskId),
    paused: jobs.get(taskId)?.paused === true,
  });
});

app.delete('/api/tasks/:taskId', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  if (jobs.has(taskId)) return res.status(409).json({ error: '任务正在运行，无法删除' });
  await rm(path.join(OUTPUT_DIR, taskId), { recursive: true, force: true });
  res.json({ ok: true });
});

/**
 * 任务总结：生成的"产出了什么" / 完善的"改了什么"。
 *
 * 优先读已落盘的 `summary.json`（新任务都有）；旧任务没有这个文件时**现场生成** ——
 * 完善任务从 `augment_report.json` 算差异，生成任务从 `meta.json` 列产出。
 * 这样"生成总结"对历史任务也能用，不需要重跑任务。
 */
app.get('/api/tasks/:taskId/summary', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  if (!taskId) return res.status(400).json({ error: 'bad param' });
  const dir = path.join(OUTPUT_DIR, taskId);

  const readJSON = async (name) => {
    try { return JSON.parse(await readFile(path.join(dir, name), 'utf-8')); } catch { return null; }
  };

  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return res.status(404).json({ error: '任务不存在' });
  } catch {
    return res.status(404).json({ error: '任务不存在' });
  }

  // ① 已有总结直接用
  const saved = await readJSON('summary.json');
  if (saved) return res.json({ summary: saved, markdown: renderSummaryMarkdown(saved), source: 'saved' });

  // ② 完善任务：从 augment_report 现算
  const aug = await readJSON('augment_report.json');
  if (aug) {
    const s = summarizeAugment(aug);
    return res.json({ summary: s, markdown: renderSummaryMarkdown(s), source: 'derived' });
  }

  // ③ 生成任务：从 meta 现算
  const meta = await readJSON('meta.json');
  if (meta) {
    // 成品规格要从实际卡里数，meta 里只有抽取阶段的统计
    let kit = null;
    const card = await readJSON('character_card.json');
    if (card) {
      kit = {
        entries: card.data?.character_book?.entries?.length || 0,
        regex: card.data?.extensions?.regex_scripts?.length || 0,
        cardBytes: Buffer.byteLength(JSON.stringify(card, null, 2), 'utf8'),
      };
    }
    const s = summarizeGenerate({ ...meta, kit: meta.kit || kit }, meta.counts || {});
    return res.json({ summary: s, markdown: renderSummaryMarkdown(s), source: 'derived' });
  }

  return res.status(404).json({ error: '这个任务没有可总结的产物（缺 summary.json / augment_report.json / meta.json）' });
});

app.get('/api/tasks/:taskId/file/:name', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const name = tidyFileName(req.params.name);
  if (!taskId || !name) return res.status(400).end('bad param');
  const filePath = path.join(OUTPUT_DIR, taskId, name);
  if (!filePath.startsWith(path.join(OUTPUT_DIR, taskId))) return res.status(400).end('bad path');
  try {
    const st = await stat(filePath);
    if (!st.isFile()) return res.status(404).end('not found');
  } catch {
    return res.status(404).json({ error: '文件不存在' });
  }
  if (req.query.raw === '1' || /\.(json|md|txt|ya?ml)$/i.test(name)) {
    const content = await readFile(filePath, 'utf-8');
    return res.json({ name, content, size: content.length });
  }
  res.download(filePath, name);
});

app.get('/api/tasks/:taskId/download/:name', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const name = tidyFileName(req.params.name);
  if (!taskId || !name) return res.status(400).end('bad param');
  res.download(path.join(OUTPUT_DIR, taskId, name), name, err => {
    if (err && !res.headersSent) res.status(404).end('not found');
  });
});

/** 任务产物打包为 zip */
app.get('/api/tasks/:taskId/zip', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const dir = path.join(OUTPUT_DIR, taskId);
  try { await stat(dir); } catch { return res.status(404).json({ error: '任务不存在' }); }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${taskId}.zip"`);
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', e => { try { res.status(500).end(e.message); } catch {} });
  archive.pipe(res);
  archive.glob('**/*', { cwd: dir, ignore: ['log.jsonl'] });
  await archive.finalize();
});

/**
 * 安全地拉起一个外部命令。
 *
 * 注意：child_process.exec 在 spawn 失败时会**同步抛出**（例如沙箱/权限限制下的 EPERM），
 * 如果不接住，异常会冒泡成未捕获异常，直接把整个服务进程带走。
 * 这里同时兜住「同步抛」与「异步回调报错」两种情况，任何失败都只记录、不影响服务。
 *
 * @returns {boolean} 是否成功发起
 */
function spawnDetached(cmd, { label = '外部命令' } = {}) {
  try {
    const child = exec(cmd, { windowsHide: true }, (err) => {
      if (err) console.warn(`[${label}] 执行失败（服务继续运行）：${err.message}`);
    });
    child.on?.('error', (err) => {
      console.warn(`[${label}] 进程错误（服务继续运行）：${err.message}`);
    });
    return true;
  } catch (e) {
    console.warn(`[${label}] 无法启动（服务继续运行）：${e.message}`);
    return false;
  }
}

/** 在系统文件管理器中打开目录 */
app.get('/api/tasks/:taskId/reveal', async (req, res) => {
  const taskId = tidyTaskId(req.params.taskId);
  const dir = path.join(OUTPUT_DIR, taskId);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) throw new Error('不是目录');
  } catch {
    return res.status(404).json({ error: '任务不存在' });
  }

  const p = platform();
  const cmd = p === 'win32' ? `explorer "${dir}"`
    : p === 'darwin' ? `open "${dir}"`
    : `xdg-open "${dir}"`;
  const ok = spawnDetached(cmd, { label: '打开产物目录' });

  res.json({
    ok,
    dir,
    ...(ok ? {} : { hint: '当前环境不允许打开文件管理器，请手动访问上面的路径' }),
  });
});

// ============================================================
// 命令面板会用到的小工具
// ============================================================

/** 模型列表 */
app.post('/api/models', async (req, res) => {
  const { baseUrl, apiKey } = req.body || {};
  if (!baseUrl) return res.status(400).json({ error: '缺少 baseUrl' });
  // 常见的 Base URL 配置坑：只写主机名，请求会打到 /chat/completions
  const check = checkBaseUrl(baseUrl);
  try {
    const models = await listModels({ baseUrl, apiKey });
    res.json({ models, warn: check.warn, hint: check.hint });
  } catch (e) {
    res.status(502).json({ error: `获取模型列表失败：${e.message}`, warn: check.warn, hint: check.hint });
  }
});

/** 连通性测试 */
app.post('/api/ping', async (req, res) => {
  const { baseUrl, apiKey, model } = req.body || {};
  if (!baseUrl || !model) return res.status(400).json({ error: '缺少 baseUrl / model' });
  const check = checkBaseUrl(baseUrl);
  try {
    res.json({ ...(await testConnection({ baseUrl, apiKey, model })), warn: check.warn, hint: check.hint });
  } catch (e) {
    res.status(502).json({ error: `连接失败：${e.message}`, warn: check.warn, hint: check.hint });
  }
});

/** 预设：可用 Step 列表与说明 */
app.get('/api/preset/steps', (req, res) => {
  res.json({ steps: STEP_NAMES.map(name => ({ name, label: STEP_LABELS[name] })) });
});

/** 预设：校验（前端导入/编辑时调用，返回与生成时完全一致的判定） */
app.post('/api/preset/validate', (req, res) => {
  const result = validatePreset(req.body?.preset ?? req.body ?? '');
  res.json(result);
});

/**
 * 预设：预览某个 Step 的最终 prompt。
 * 这是让用户确认「预设到底有没有生效」的关键接口。
 */
app.post('/api/preset/preview', (req, res) => {
  const { preset, step } = req.body || {};
  const stepName = STEP_NAMES.includes(step) ? step : 'step2';
  const v = validatePreset(preset);
  if (!v.ok) return res.status(400).json({ error: v.errors.join('；'), ...v });

  // 取该 Step 真实使用的 prompt 作为基线，保证预览与运行时一致
  const BASELINE = {
    'step0.5': [S_STEPS.STEP_0_5_PROBE, '（此处为该小说前 3 章原文，预览时从略）'],
    step1: [S_STEPS.STEP_1_MENTIONS, '章节：第一章\n\n（此处为章节原文）'],
    step2: [S_STEPS.STEP_2_EVENTS, '章节：第一章\n\n（此处为章节原文）'],
    step3: [S_STEPS.STEP_3_PHASES, '（此处为事件列表 JSON）'],
    step4: [S_STEPS.STEP_4_DELTAS, '阶段名：…\n核心变化：…\n原文：\n（此处为阶段原文）'],
    step5: [S_STEPS.STEP_5_WORLDBOOK, '（此处为原文节选）'],
  };
  const [system, user] = BASELINE[stepName];
  const preview = previewStep({
    preset: v.preset, stepName, system, user, json: true, maxLen: 2000,
  });
  res.json({ ...preview, mode: v.preset.mode, name: v.preset.name, warnings: v.warnings });
});

/** 本地估算：选择小说文件后预览章节切分与 token 规模（不上传正文） */
app.post('/api/estimate', async (req, res) => {
  const { text, chunkMaxLen } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: '缺少文本' });
  }
  const chunks = chunkText(text, { maxLen: Number(chunkMaxLen) || 6000 });
  res.json({
    chars: text.length,
    tokens: estimateTokens(text),
    chapters: chunks.length,
    preview: chunks.map(c => ({ title: c.title, chars: c.text.length })),
  });
});

/**
 * 上传文件名编码自检：POST 一个文件，返回服务端实际拿到的名字与修正结果。
 * 用于确认当前环境下 multipart 文件名是否会被 latin1 展开。
 */
app.post('/api/upload/name-probe', upload.single('file'), (req, res) => {
  const raw = req.file?.originalname ?? null;
  if (req.file?.path) rm(req.file.path, { force: true }).catch(() => {});
  res.json({
    received: raw,
    fixed: raw == null ? null : fixUploadName(raw),
    mojibake: raw == null ? null : looksMojibake(raw),
  });
});

/**
 * 章节概览：POST 小说文件 → 返回章节列表。
 * 「从零生成」与「完善角色卡」**共用**这一个接口。
 * ⚠️ 纯字符串处理，**不调用 LLM**，必须秒回（前端上传后立即要显示章节数）。
 */
app.post('/api/chapters', upload.fields([{ name: 'novel', maxCount: 1 }]), async (req, res) => {
  try {
    const file = req.files?.novel?.[0];
    if (!file) return res.status(400).json({ error: '未上传小说文件' });

    const buffer = await readFile(file.path);
    const decoded = detectAndDecode(buffer);
    const text = typeof decoded === 'string' ? decoded : (decoded?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: '文件内容为空' });

    const chapters = listChapters(text);
    res.json({
      totalChapters: chapters.length,
      totalChars: text.length,
      chapters,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  } finally {
    const f = req.files?.novel?.[0];
    if (f?.path) rm(f.path, { force: true }).catch(() => {});
  }
});

/**
 * 完善已有角色卡：POST 角色卡 + 新剧情 → SSE 流，事件类型与 /api/generate 完全一致。
 *
 * 与 /api/generate 的共性：同一套 upload、同一套 chapterRange 语义、
 * 同一套 SSE 事件（start / progress / conflicts / files / error / done）。
 */
app.post(
  '/api/augment',
  upload.fields([
    { name: 'card', maxCount: 1 },
    { name: 'novel', maxCount: 1 },
    { name: 'images', maxCount: 5 },
  ]),
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* 客户端已断开 */ }
    };

    const cardFile = req.files?.card?.[0];
    const novelFile = req.files?.novel?.[0];
    // 新剧情两种输入方式：上传文件 或 直接粘贴文本（同一字段名，两种模式共用）
    const pastedText = req.body?.novelText || req.body?.text || '';

    try {
      if (!cardFile) {
        send('error', { message: '未上传角色卡（character_card.json）' });
        return res.end();
      }
      if (!novelFile && !String(pastedText).trim()) {
        send('error', { message: '未提供新剧情（上传文件或粘贴文本）' });
        return res.end();
      }

      const { baseUrl, apiKey, model, chapterRange, strategy, preset, options, instruction } = req.body || {};
      if (!baseUrl || !model) {
        send('error', { message: 'API 配置不完整（需要 Base URL 与模型名）' });
        return res.end();
      }
      if (!apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
        send('error', { message: '缺少 API Key' });
        return res.end();
      }

      /**
       * 用户指令：告诉这次完善要怎么做（挑哪些角色、地图势力要不要、是否贴合原卡）。
       * 会拼进每个抽取步骤的 prompt（见 src/augment_context.js）。
       *
       * 限长是必要的：这段文本会进入**每一次**抽取调用，塞一整本书进来
       * 会把新剧情正文挤出上下文。
       */
      const inst = String(instruction || '').trim();
      const INST_MAX = 2000;
      if (inst.length > INST_MAX) {
        send('error', { message: `完善指令过长（${inst.length} 字，上限 ${INST_MAX} 字）：请精简后重试` });
        return res.end();
      }

      let opts = {};
      try { opts = JSON.parse(options || '{}'); } catch {}

      // 预设校验：非法预设不阻断，只在日志里说明（与 /api/generate 一致）
      let presetObj = null;
      if (preset) {
        const v = validatePreset(preset);
        if (v.ok) presetObj = v.preset;
        else send('progress', { step: 'WARN', msg: `预设无效已忽略：${v.errors.join('；')}`, ts: Date.now() });
      }

      const strategyName = ['append', 'merge', 'overwrite'].includes(strategy) ? strategy : 'merge';
      const controller = new AbortController();
      req.on('close', () => controller.abort());

      send('progress', {
        step: 'Init',
        msg: `增补任务已创建（策略：${strategyName}，章节范围：${chapterRange || 'all'}）`,
        ts: Date.now(),
      });

      const result = await runAugment({
        baseUrl: String(baseUrl).replace(/\/+$/, ''),
        apiKey,
        model,
        cardPath: cardFile.path,
        cardFileName: fixUploadName(cardFile.originalname),
        novelPath: novelFile?.path || null,
        novelText: novelFile ? null : String(pastedText),
        chapterRange: chapterRange || 'all',
        strategy: strategyName,
        // 用户指令：拼进每个抽取步骤的 prompt
        instruction: inst || undefined,
        outputDir: OUTPUT_DIR,
        preset: presetObj,
        signal: controller.signal,
        ...opts,
      }, send);

      send('done', { ok: true, taskId: result.taskId });
    } catch (e) {
      console.error('[augment]', e);
      send('error', { message: e.message || String(e) });
    } finally {
      res.end();
      for (const f of [cardFile, novelFile, ...(req.files?.images || [])]) {
        if (f?.path) rm(f.path, { force: true }).catch(() => {});
      }
    }
  },
);

/**
 * 图片 → 角色卡：POST 若干图片 → SSE 流。
 *
 * 事件类型与 /api/generate 完全一致（start / progress / done / error），
 * 产物目录结构也一致（character_card.json / worldbook.json / …），
 * 所以「任务与产物」页、下载、打包、进度条都直接复用，不需要为新功能改前端基建。
 *
 * ⚠️ 视觉抽取依赖模型真的能看图。当前端点（api.deepseek.com）接受图片字段但不做视觉理解，
 * 所以这里会**如实**把模型的回复透出来（若模型说"无法查看图片"，任务会失败并给出可读原因），
 * 而不是静默产出一张编造的卡。
 */
app.post(
  '/api/image-card',
  // 上限与 MAX_IMAGES 保持一致（长漫画按话分批已由 src/image_card.js 内部处理）
  upload.fields([{ name: 'images', maxCount: MAX_IMAGES }]),
  (err, req, res, next) => {
    // multer 在进入处理函数**之前**就会失败（超数量 / 超体积），
    // 而它的原始报错是 `Too many files` / `File too large`，用户看不懂是哪里限的。
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_COUNT'
      ? `图片数量超过上限：一次最多 ${MAX_IMAGES} 张（长漫画请按话分批生成）`
      : err.code === 'LIMIT_FILE_SIZE'
        ? '有文件超过单张 100MB 上限：请先压缩后再上传'
        : `上传失败：${err.message}`;
    res.status(400).json({ error: msg });
  },
  async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch { /* 客户端已断开 */ }
    };

    const files = req.files?.images || [];
    const { baseUrl, apiKey, model, title, hint, wantWorldbook, preset: presetRaw, options } = req.body || {};

    /**
     * 「从本机目录生成」：直接填漫画/本子的一话目录，不用一张张选图。
     *
     * 为什么放在服务端：浏览器拿不到"目录列表"，只能让本机服务去读。
     * 所以这里必须自己把关：
     *   · **只允许来自回环地址的请求**（本机用户在页面上操作）。
     *     HOST 允许被设成 0.0.0.0，但读了任意目录等于把整台机器的文件暴露出去，
     *     所以即使 HOST=0.0.0.0，这个入口也只服务 127.0.0.1。
     *   · 只接受图片扩展名，且沿用 MAX_IMAGES 上限。
     */
    const dirPathRaw = String(req.body?.dirPath || '').trim();
    let dirImages = [];
    if (dirPathRaw) {
      const ip = req.socket?.remoteAddress || '';
      const isLoopback = /^(::1|::ffff:127\.|127\.)/.test(ip);
      if (!isLoopback) {
        send('error', { message: '「从本机目录生成」只允许本机访问（远程请求请用上传图片）' });
        return res.end();
      }
      const listed = await listImagesInDir(dirPathRaw);
      for (const w of listed.warnings) send('progress', { step: 'WARN', msg: w, ts: Date.now() });
      if (!listed.ok) {
        send('error', { message: listed.errors.join('；') });
        return res.end();
      }
      dirImages = listed.images;
    }

    const taskId = `task_${Date.now()}`;
    const outDir = path.join(OUTPUT_DIR, taskId);
    const controller = new AbortController();
    const job = { taskId, buffer: [], controller, startedAt: Date.now(), paused: false };

    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15_000);

    // 上传的图先搬进任务目录 —— multer 的临时文件会在 finally 里删掉，
    // 而头像要用原图、产物也要留一份原始输入便于复查
    let localImages = [];
    try {
      if (!files.length && !dirImages.length) {
        send('error', { message: '未提供图片（上传图片，或填一个本机图片目录）' });
        return res.end();
      }
      if (!baseUrl || !model) {
        send('error', { message: 'API 配置不完整（需要 Base URL 与模型名）' });
        return res.end();
      }
      if (!apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
        send('error', { message: '缺少 API Key' });
        return res.end();
      }

      let opts = {};
      try { opts = JSON.parse(options || '{}'); } catch {}

      let preset = null;
      if (presetRaw) {
        const v = validatePreset(presetRaw);
        if (v.ok) preset = v.preset;
      }

      jobs.set(taskId, job);
      send('start', { taskId, startedAt: new Date().toISOString() });

      await mkdir(outDir, { recursive: true });

      // 搬图（保留原始扩展名，视觉接口对格式敏感）
      const imgDir = path.join(outDir, 'images');
      await mkdir(imgDir, { recursive: true });
      for (const [i, f] of files.entries()) {
        const ext = path.extname(fixUploadName(f.originalname)).toLowerCase() || '.png';
        const dest = path.join(imgDir, `image_${String(i + 1).padStart(2, '0')}${ext}`);
        await copyFile(f.path, dest);
        localImages.push(dest);
      }
      // 从目录读的图也复制一份进任务目录 —— 产物要能独立复查，不能依赖用户原目录还在
      for (const src of dirImages) {
        const ext = path.extname(src).toLowerCase() || '.png';
        const dest = path.join(imgDir, `image_${String(localImages.length + 1).padStart(2, '0')}${ext}`);
        await copyFile(src, dest);
        localImages.push(dest);
      }
      if (dirImages.length) {
        send('progress', {
          step: 'Init',
          msg: `从目录读取 ${dirImages.length} 张：${dirPathRaw}`,
          ts: Date.now(),
        });
      }

      const finalTitle = String(title || '').trim() || '图片生成的角色卡';

      await writeFile(path.join(outDir, 'project.json'), JSON.stringify({
        taskId,
        kind: 'image-card',
        title: finalTitle,
        imageCount: localImages.length,
        createdAt: new Date().toISOString(),
        model,
        hint: String(hint || '').trim() || null,
      }, null, 2), 'utf-8');

      const emit = (event, data) => {
        send(event, data);
        job.buffer.push({ event, data, ts: Date.now() });
        appendLog(taskId, event, data);
      };

      emit('progress', {
        step: 'Init',
        msg: `图片任务 ${taskId} 已创建（${localImages.length} 张图）`,
        ts: Date.now(),
      });

      // ---------- 视觉抽取 ----------
      // batchSize / concurrency 允许前端覆盖（长漫画可调），默认值来自 src/image_card.js
      const vision = await extractCharactersFromImages({
        imagePaths: localImages,
        hint,
        baseUrl: String(baseUrl).replace(/\/+$/, ''),
        apiKey,
        model,
        preset,
        batchSize: Number(req.body.batchSize) || DEFAULT_VISION_BATCH,
        concurrency: Number(req.body.concurrency) || DEFAULT_VISION_CONCURRENCY,
        send: emit,
      });

      /**
       * 模型"看不见图"时必须**失败**，不能默默产出一张空壳卡。
       *
       * 实测踩过两次，第二次尤其危险：
       *   ① `deepseek-v4-pro` 接受图片字段、返回 200，内容写"我无法查看这张图片"
       *   ② 它还会返回**结构完全正确的 JSON**，只是每个字段都是
       *      `图片未提供或无法解析，无法辨认任何外貌特征`
       *
       * 第 ② 种只靠匹配拒绝词会漏 —— 于是静默产出一张看起来正常、
       * 实际一个字有用信息都没有的卡。所以判据是**正向的**：
       * 真看到图的档案，appearance 里必然有具体视觉细节（颜色/发型/材质…），
       * 由 assessVisionQuality 判定（它已在抽取阶段算好）。
       */
      if (!vision.quality?.usable) {
        const withRaw = vision.quality?.reason === 'no-visual-content'
          ? `\n模型返回的字段内容示例：${String(vision.profiles[0]?.appearance || '').slice(0, 120)}`
          : '';
        throw new Error(
          `模型 ${model} 没有给出可用的视觉分析（${vision.quality?.detail || '未识别出角色'}）。${withRaw}\n`
          + `当前端点/模型不具备图片理解能力。请换用支持视觉的模型`
          + `（如 gpt-4o、gemini、qwen-vl、ollama+llava 等），或在「设置」里切换端点。`
        );
      }

      /**
       * 分批时有批次失败 / 有空批次 → 卡仍然生成（成功的批次有价值），
       * 但必须**明说结果不完整**，否则用户只会觉得"怎么少了几个人"。
       */
      if (vision.failedBatches || vision.emptyBatches) {
        const parts = [
          vision.failedBatches ? `${vision.failedBatches}/${vision.batches} 批失败` : '',
          vision.emptyBatches ? `${vision.emptyBatches}/${vision.batches} 批没抽出人物` : '',
        ].filter(Boolean).join('、');
        emit('progress', {
          step: 'WARN',
          msg: `人物档案不完整：${parts}（共 ${vision.profiles.length} 条，来自 ${vision.images.length} 张图）`
            + ' —— 可只保留出问题的那几张图重试',
          ts: Date.now(),
        });
      }

      // ---------- 把图片里的信息总结成设定 ----------
      /**
       * 这是图片路径的正路：
       *   把「转录的文字 + 画面上看得见的事实」总结成**角色与世界的设定**。
       *
       * 刻意**不抽剧情**（不产出事件列表 / 故事线 / 阶段）——
       * 用户明确要求过："不是图片里面怎么怎么样，图片里发生了什么剧情"。
       * 图片给的是**信息**，归纳成设定就够了；剧情留给用户自己玩。
       *
       * 总结失败就返回 null，装配段回退到"只有画面事实"的模式。
       */
      emit('progress', { step: 'Summary', msg: '总结图片里的信息，归纳成角色与世界的设定…', ts: Date.now() });
      let settingSummary = null;
      try {
        // 复用同一套 LLM 配置（baseUrl / key / 模型 / 预设）
        const summaryLlm = makeLLM({
          baseUrl: String(baseUrl).replace(/\/+$/, ''),
          apiKey,
          model,
        }, preset || null);
        settingSummary = await extractCardSummary({
          llm: summaryLlm,
          profiles: vision.profiles,
          hint: String(hint || '').trim() || undefined,
          send: (ev) => emit(ev.step || 'Summary', ev.msg, ev),
        });
      } catch (e) {
        // 总结失败不能让整个任务挂掉 —— 回退到画面事实仍然能出一张卡
        emit('progress', {
          step: 'WARN',
          msg: `总结图片信息失败，将只按画面事实生成人物档案：${e.message}`,
          ts: Date.now(),
        });
      }
      if (settingSummary) {
        emit('progress', {
          step: 'Summary',
          msg: `设定总结完成：人物 ${settingSummary.characters.length} 人 · `
            + `地点 ${settingSummary.world.locations.length} · 势力 ${settingSummary.world.factions.length} · `
            + `体系 ${settingSummary.world.systems.length}`,
          ts: Date.now(),
        });

        /**
         * 主要角色的**外貌/服装精修**（用户要求）。
         *
         * 为什么要单独一轮：总结那步要同时产出人物 + 世界观 + 舞台，注意力被摊薄，
         * 外貌/服装往往只剩一句"黑色长发、深色外套"。而这两项是**图片独有的信息**。
         * 所以对 主角 / 主要NPC 再各跑一次「只看外观」的请求。
         *
         * 可以用 `refineMainAppearance:false` 关掉（每多一个主要角色就多一次带图请求）。
         */
        if (opts.refineMainAppearance !== false) {
          try {
            const summaryLlm = makeLLM({
              baseUrl: String(baseUrl).replace(/\/+$/, ''),
              apiKey, model,
            }, preset || null);
            const refined = await refineMainAppearance({
              llm: summaryLlm,
              summary: settingSummary,
              images: localImages.map((p, i) => ({ index: i, path: p })),
              profiles: vision.profiles,
              max: Math.max(0, Math.min(5, Number(opts.detailMax) || 3)),
              send: (ev) => emit(ev.step || 'Detail', ev.msg, ev),
            });
            if (refined.refined.length) {
              emit('progress', {
                step: 'Detail',
                msg: `主要角色外观精修完成：${refined.refined.map(r => r.name).join('、')}`
                  + (refined.skipped.length ? `（跳过 ${refined.skipped.length} 个）` : ''),
                ts: Date.now(),
              });
            }
          } catch (e) {
            // 精修失败不影响主流程
            emit('progress', {
              step: 'WARN',
              msg: `主要角色外观精修失败（保留原有描述）：${e.message}`,
              ts: Date.now(),
            });
          }
        }
      } else {
        emit('progress', {
          step: 'Summary',
          msg: '没能总结出设定，将只按画面事实生成（卡会比较薄）',
          ts: Date.now(),
        });
      }

      // ---------- 装配 ----------
      emit('progress', { step: 'Assemble', msg: '组装角色卡（变量树 / 状态栏 / 世界书）', ts: Date.now() });
      const result = await buildCardFromExtraction({
        profiles: vision.profiles,
        title: finalTitle,
        summary: settingSummary,
        wantWorldbook: wantWorldbook !== 'false' && wantWorldbook !== false,
      });

      const sum = summarizeCard(result);
      emit('progress', {
        step: 'Assemble',
        msg: `角色 ${sum.characters} 人 / 世界书 ${sum.worldbook} 条 / `
          + `状态栏主题 ${result.statusbar.statusbar.theme} / ${sum.entries} 条条目`,
        ts: Date.now(),
      });
      for (const e of result.statusbar.validation.errors) {
        emit('progress', { step: 'WARN', msg: `状态栏校验未通过：${e}`, ts: Date.now() });
      }
      if (sum.thinProfiles.length) {
        emit('progress', {
          step: 'WARN',
          msg: `${sum.thinProfiles.length} 份档案偏短（${sum.thinProfiles.join('、')}）—— 可能是图片细节不足`,
          ts: Date.now(),
        });
      }
      /**
       * 模型漏答 `sawImage` 时，视觉可见性**没有被验证**。
       *
       * 必须显式告知：否则用户无法分辨"这张卡确实来自图片分析"还是
       * "模型没看图、只是按字段名编了一段"。这是本功能最要紧的诚实性提示。
       */
      if (!vision.quality?.verified) {
        emit('progress', {
          step: 'WARN',
          msg: '模型没有回答"是否看到图片"（sawImage），因此**图片可见性未经验证**：'
            + '本卡内容来自模型的描述，请自行核对是否与图片相符',
          ts: Date.now(),
        });
      }

      const meta = {
        taskId,
        kind: 'image-card',
        title: finalTitle,
        createdAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        model,
        baseUrl,
        hint: String(hint || '').trim() || null,
        counts: {
          images: localImages.length,
          characters: sum.characters,
          worldbook: sum.worldbook,
          entries: sum.entries,
        },
        // 图片可见性是否被模型确认过（false 表示模型没答 sawImage，内容是未验证的）
        visionVerified: !!vision.quality?.verified,
        sawImage: vision.sawImage,
        tokens: { card: Math.round(sum.cardBytes / 1.6) },
        usage: {
          calls: vision.usage.calls.length,
          inputChars: vision.usage.inputChars,
          outputChars: vision.usage.outputChars,
          byStep: vision.usage.byStep,
        },
      };

      const written = await writeImageCardOutputs(outDir, result, {
        imagePaths: localImages,
        vision: { raw: vision.raw, profiles: vision.profiles },
        // 设定总结单独落盘（card_summary.json），便于事后核对模型总结出了什么
        cardSummary: settingSummary,
        meta,
      });

      /**
       * 把变更总结**一起发回来**。
       *
       * writeImageCardOutputs 已经写了 summary.json / SUMMARY.md，
       * 但事件里不带的话前端就要再请求一次才能显示总结；
       * 生成页与完善页都是在这里带 `summary` 的，图片路径保持同一形状。
       * 同时补 `taskId`（原来漏了，前端拿不到任务号就无法回退查询）。
       */
      let summary = null;
      try {
        summary = JSON.parse(await readFile(path.join(outDir, 'summary.json'), 'utf-8'));
      } catch { /* 没有总结不影响产物，前端会回退到 /api/tasks/:id/summary */ }

      emit('files', {
        taskId,
        taskDir: outDir,
        files: written,
        meta,
        summary,
        note: '外貌来自图片视觉分析；姓名/身份/经历为推断或占位，正文已标注',
      });
      send('done', { ok: true, taskId, meta });
    } catch (e) {
      const aborted = e?.name === 'AbortError' || /已取消|aborted/i.test(e?.message || '');
      const payload = { message: aborted ? '任务已被用户取消' : (e?.message || String(e)) };
      send(aborted ? 'cancelled' : 'error', payload);
      try { await appendLog(taskId, aborted ? 'cancelled' : 'error', payload); } catch {}
    } finally {
      clearInterval(heartbeat);
      jobs.delete(taskId);
      for (const f of files) { try { rm(f.path, { force: true }); } catch {} }
      res.end();
    }
  },
);

/** 运行环境信息 */
app.get('/api/system', (req, res) => {  res.json({
    ok: true,
    node: process.version,
    platform: platform(),
    cwd: ROOT,
    port: PORT,
    uploads: UPLOAD_DIR,
    outputs: OUTPUT_DIR,
    running: [...jobs.keys()],
    uptimeSec: Math.round(process.uptime()),
  });
});

// ============================================================
// 启动
// ============================================================

// 兜底：任何漏网的同步/异步异常都不应该让本地服务直接退出
process.on('uncaughtException', (err) => {
  console.error(`\n[未捕获异常] 服务继续运行：${err?.stack || err?.message || err}\n`);
});
process.on('unhandledRejection', (reason) => {
  console.error(`\n[未处理的 Promise 拒绝] 服务继续运行：${reason?.stack || reason}\n`);
});

app.use((err, req, res, next) => {
  console.error('[请求处理异常]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || '服务器内部错误' });
});

await mkdir(UPLOAD_DIR, { recursive: true });
await mkdir(OUTPUT_DIR, { recursive: true });

const server = app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n✅ 角色卡生成器已启动`);
  console.log(`   界面：${url}`);
  console.log(`   产物：${OUTPUT_DIR}`);
  console.log(`   Node：${process.version}`);
  console.log(`   按 Ctrl+C 停止\n`);
  // 启动脚本会自己开浏览器（避免重复开），因此设 NO_OPEN=1 时这里不处理
  if (process.env.NO_OPEN !== '1') openBrowser(url);
});

/** 端口被占用等启动错误：给出可操作的中文提示，并以非 0 退出码结束，便于启动脚本判断 */
server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用，无法启动。`);
    console.error(`   可能是上一次的生成器还在运行，或者别的程序占用了这个端口。`);
    console.error(`\n   解决办法（任选其一）：`);
    console.error(`     1. 关掉占用 ${PORT} 端口的程序后重试`);
    console.error(`     2. 换个端口启动：`);
    if (platform() === 'win32') {
      console.error(`          set PORT=3001 && npm start`);
    } else {
      console.error(`          PORT=3001 npm start`);
    }
    console.error(`     3. 直接指定端口：node server.js --port 3001\n`);
    process.exit(1);
  }
  if (err?.code === 'EACCES') {
    console.error(`\n❌ 没有权限监听端口 ${PORT}。请换一个 1024 以上的端口，或使用管理员权限。\n`);
    process.exit(1);
  }
  console.error(`\n❌ 服务启动失败：${err?.message || err}\n`);
  process.exit(1);
});

function openBrowser(url) {
  const p = platform();
  const cmd =
    p === 'darwin' ? `open "${url}"` :
    p === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}" 2>/dev/null || sensible-browser "${url}" 2>/dev/null`;
  if (!spawnDetached(cmd, { label: '打开浏览器' })) {
    console.log(`无法自动打开浏览器，请手动访问：${url}`);
  }
}
