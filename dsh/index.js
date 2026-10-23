/**
 * DSH 插件（宿主侧）：小说 / 图片 → SillyTavern 角色卡。
 *
 * 复用仓库 `src/` 的核心流程（pipeline / augment / image_card / summary），
 * 不重写算法 —— 所以插件产物与本地 Web 版逐字节一致。
 *
 * 路由都挂在 `/novel2card/` 前缀下：
 *   webserver 的路由表**重复 (kind, path) 会直接抛错**，命名空间是硬要求。
 *
 * 每条注册都在 `ctx.effect()` 里，返回 disposer —— 插件卸载后路由随之消失。
 */
import { tmpdir } from 'node:os';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  createJob, getJob, listJobs, removeJob,
  startGenerate, startAugment, startImageCard,
  listArtifacts, readArtifact,
} from './lib/tasks.js';
import { getBoundary, readBody, parseMultipart, collectMultipart } from './lib/multipart.js';
import { requestRejection } from './lib/guard.js';

export const name = 'novel2card';

/**
 * 声明 `webServer` 与 `connection`：
 *   · `webServer` 必需 —— 没有它本插件保持不激活，而不是抛错
 *   · `connection` 提供信任栅栏 `requestRejection`，用来挡住非授权请求
 *     （它本身是可选的：拿不到时 `lib/guard.js` 会回落到自带校验）
 * （模型的 baseUrl/apiKey 由面板传入，不复用宿主 LLM 服务 —— 见 README「与 DSH 的关系」。）
 */
export const inject = ['webServer'];

/** 插件数据根目录：遵守 `$DSH_HOME` 惯例 */
function dataRoot() {
  const home = process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || tmpdir(), '.dsh');
  return path.join(home, 'novel2card');
}

/** 上传临时目录（跨平台） */
function uploadRoot() {
  return path.join(tmpdir(), 'novel2card-uploads');
}

// ---------- HTTP 小工具 ----------

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res, code, text) {
  const body = String(text);
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

/**
 * 读请求体并归一化成 `{ fields, files }`。
 * 支持 JSON 与 multipart/form-data 两种（前端按有没有文件二选一）。
 */
async function readRequest(req, { maxBytes } = {}) {
  const ct = String(req.headers['content-type'] || '');
  if (ct.startsWith('application/json')) {
    const buf = await readBody(req, maxBytes);
    if (!buf.length) return { fields: {}, files: [] };
    return { fields: JSON.parse(buf.toString('utf-8')), files: [] };
  }
  if (ct.startsWith('multipart/form-data')) {
    const boundary = getBoundary(ct);
    if (!boundary) throw new Error('multipart 缺少 boundary');
    const buf = await readBody(req, maxBytes);
    return collectMultipart(parseMultipart(buf, boundary));
  }
  // 兜底：当作纯文本正文
  const buf = await readBody(req, maxBytes);
  return { fields: buf.length ? { text: buf.toString('utf-8') } : {}, files: [] };
}

/** 把上传的图片落到临时目录，返回绝对路径 */
async function saveUploads(files, dir) {
  const saved = [];
  for (const [i, f] of files.entries()) {
    if (f.field !== 'images') continue;
    await mkdir(dir, { recursive: true });
    const ext = (path.extname(f.filename || '') || '.png').toLowerCase();
    const p = path.join(dir, `img_${String(i).padStart(3, '0')}_${randomUUID().slice(0, 8)}${ext}`);
    await writeFile(p, f.data);
    saved.push(p);
  }
  return saved;
}

/** 统一异常 → JSON（handler 抛错 webserver 会回 400，但那样看不出原因） */
function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch { /* 已断开 */ } return; }
      const code = e?.code === 'BODY_TOO_LARGE' ? 413 : 500;
      sendJson(res, code, { error: e?.message || String(e) });
    }
  };
}

// ---------- 插件主体 ----------

export function apply(ctx) {
  const baseDir = dataRoot();

  /**
   * 宿主信任栅栏。
   *
   * `connection.requestRejection(req)` 是 DSH 自己的请求校验（它知道 `--trusted-host`）。
   * 取不到时（服务缺失或旧版本）`lib/guard.js` 会回落到插件自带的
   * 回环 / 跨站 / 同源校验，仍然挡得住。
   */
  let fence = null;
  try {
    const conn = ctx.get ? ctx.get('connection') : null;
    if (conn && typeof conn.requestRejection === 'function') fence = conn;
  } catch { /* 保持 null，走自带校验 */ }
  if (!fence) {
    try {
      console.warn('[novel2card] 未拿到宿主信任栅栏（connection.requestRejection 缺失）：'
        + '已启用插件自带的回环 / 跨站 / 同源校验。');
    } catch { /* 忽略 */ }
  }

  const route = (kind, path, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind,
      path,
      /**
       * ⚠️ 每条路由都必须过栅栏。
       *
       * 实测过：DSH 自己的路由对非授权请求返回 401，而**插件注册的路由
       * 完全不受那套校验保护** —— `/novel2card/meta` 返回 200 而同源的应用路由返回 401。
       * 本插件还要接收 API Key（generate）和读出用户小说产物（file），
       * 所以这里挡不住就等于把凭据和内容敞开。
       */
      handler: guard(async (req, res) => {
        const deny = requestRejection(req, { fence });
        if (deny !== null) {
          res.writeHead(deny, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '请求未通过信任校验（仅限本机 / 同源）' }));
        }
        return handler(req, res);
      }),
    }), `novel2card:${path}`);
  };

  // 1) 能力探测（顺带把核心目录解析结果报出来，安装出问题时一眼能看到）
  route('exact', '/novel2card/meta', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
    const pkg = await import('./package.json', { with: { type: 'json' } }).catch(() => ({ default: {} }));
    const { describeResolution } = await import('./lib/loader.js');
    const resolved = describeResolution();
    sendJson(res, 200, {
      ok: true,
      name: 'novel2card',
      version: pkg.default?.version || '0.0.0',
      dataDir: baseDir,
      kinds: ['generate', 'augment', 'image-card'],
      limits: { maxUploadBytes: 64 * 1024 * 1024 },
      // 插件复用仓库的 src/ 核心；这里报出实际解析到的位置
      core: {
        ...resolved,
        ok: !!resolved.srcDir,
        hint: resolved.srcDir ? undefined
          : '未找到核心 src/ —— 设 NOVEL2CARD_SRC 指到仓库的 src 目录，或用软链安装',
      },
    });
  });

  // 2) 任务列表
  route('exact', '/novel2card/tasks', async (req, res) => {
    if (req.method !== 'GET') return sendJson(res, 405, { error: '只支持 GET' });
    sendJson(res, 200, { tasks: listJobs() });
  });

  // 3) 建任务（生成 / 完善 / 图片）
  route('exact', '/novel2card/generate', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });

    const { fields, files } = await readRequest(req);
    const kind = String(fields.kind || 'generate');
    const baseUrl = String(fields.baseUrl || '').trim();
    const apiKey = String(fields.apiKey || '').trim();
    const model = String(fields.model || '').trim();

    if (!baseUrl) return sendJson(res, 400, { error: '缺少 baseUrl（LLM 接口地址）' });
    if (!model) return sendJson(res, 400, { error: '缺少 model' });

    const title = String(fields.title || '').trim() || '由 DSH 生成的角色卡';
    const common = { baseUrl, apiKey, model, title };

    // 图片任务
    if (kind === 'image-card') {
      const imgFiles = files.filter(f => f.field === 'images');
      if (!imgFiles.length) return sendJson(res, 400, { error: '图片任务需要至少 1 张图片' });
      const job = await createJob({ kind, title, baseDir, input: { images: imgFiles.length } });
      const dir = path.join(uploadRoot(), job.taskId);
      const imagePaths = await saveUploads(imgFiles, dir);
      kick(job, () => startImageCard(job, {
        ...common,
        imagePaths,
        hint: String(fields.hint || ''),
        wantWorldbook: fields.wantWorldbook !== false && fields.wantWorldbook !== 'false',
        batchSize: Number(fields.batchSize) || undefined,
        concurrency: Number(fields.concurrency) || undefined,
        preset: null,
      }));
      return sendJson(res, 200, { taskId: job.taskId, kind });
    }

    // 完善任务
    if (kind === 'augment') {
      const cardFile = files.find(f => f.field === 'card');
      if (!cardFile) return sendJson(res, 400, { error: '完善任务需要上传已有的 character_card.json' });
      const novelText = String(fields.novelText || fields.text || '');
      if (!novelText.trim()) return sendJson(res, 400, { error: '完善任务需要新剧情文本' });

      /**
       * 完善指令：告诉这次要怎么做（挑哪些角色、地图势力要不要、是否贴合原卡）。
       * 会拼进每个抽取步骤的 prompt（见 src/augment_context.js）。
       * 限长与本地版一致 —— 这段文本进入每一次抽取调用，太长会把正文挤出上下文。
       */
      const instruction = String(fields.instruction || '').trim();
      if (instruction.length > 2000) {
        return sendJson(res, 400, {
          error: `完善指令过长（${instruction.length} 字，上限 2000 字）：请精简后重试`,
        });
      }

      const dir = path.join(uploadRoot(), 'cards');
      await mkdir(dir, { recursive: true });
      const cardPath = path.join(dir, `card_${randomUUID().slice(0, 8)}.json`);
      await writeFile(cardPath, cardFile.data);

      const job = await createJob({
        kind, title, baseDir,
        input: { strategy: fields.strategy || 'merge', hasInstruction: !!instruction },
      });
      kick(job, () => startAugment(job, {
        cardPath,
        novelText,
        strategy: String(fields.strategy || 'merge'),
        chapterRange: String(fields.chapterRange || 'all'),
        instruction: instruction || undefined,
        ...common,
      }));
      return sendJson(res, 200, { taskId: job.taskId, kind });
    }

    // 从零生成
    const novelFile = files.find(f => f.field === 'novel');
    const novelText = String(fields.novelText || fields.text || '');
    if (!novelFile && !novelText.trim()) {
      return sendJson(res, 400, { error: '请提供小说文本（粘贴或上传 .txt）' });
    }
    let novelPath = null;
    if (novelFile) {
      const dir = path.join(uploadRoot(), 'novels');
      await mkdir(dir, { recursive: true });
      novelPath = path.join(dir, `novel_${randomUUID().slice(0, 8)}${path.extname(novelFile.filename || '') || '.txt'}`);
      await writeFile(novelPath, novelFile.data);
    }

    const job = await createJob({ kind, title, baseDir, input: { outputMode: fields.outputMode || 'card' } });
    kick(job, () => startGenerate(job, {
      ...common,
      novelText,
      novelPath,
      userMode: String(fields.userMode || 'auto'),
      outputMode: String(fields.outputMode || 'card'),
      chapterRange: String(fields.chapterRange || 'all'),
      preset: null,
    }));
    return sendJson(res, 200, { taskId: job.taskId, kind });
  });

  // 4) 任务状态 + 产物
  route('exact', '/novel2card/task', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const taskId = url.searchParams.get('id');
    const job = taskId ? getJob(taskId) : null;
    if (!job) return sendJson(res, 404, { error: '任务不存在（插件重载后内存任务会丢失，产物仍在磁盘上）' });
    sendJson(res, 200, {
      taskId: job.taskId,
      kind: job.kind,
      title: job.title,
      status: job.status,
      error: job.error,
      startedAt: job.startedAt,
      outDir: job.outDir,
      artifacts: await listArtifacts(job.outDir),
    });
  });

  /**
   * 在系统文件管理器里打开产物目录。
   *
   * 用户反馈：插件的数据目录在 `~/.dsh/novel2card/output/task_<时间戳>/`，
   * 手动翻文件很麻烦。这个路由让面板上的「打开目录」按钮直接把它打开。
   *
   * ⚠️ 安全：**不接受任意路径**。目录只能来自服务端自己的任务记录
   *（`job.outDir`），并且必须落在插件自己的数据根之下 —— 否则这个接口
   * 就变成一个"让宿主帮任意调用者打开任意目录"的洞。
   * 写操作（POST）+ 信任栅栏已在 `route` 里统一覆盖。
   */
  route('exact', '/novel2card/reveal', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    let body = {};
    try {
      const raw = await readBody(req, 64 * 1024);
      body = raw?.length ? JSON.parse(raw.toString('utf8')) : {};
    } catch (e) {
      return sendJson(res, 400, { error: `请求体不是合法 JSON：${e.message}` });
    }
    const job = body?.taskId ? getJob(String(body.taskId)) : null;
    if (!job) return sendJson(res, 404, { error: '任务不存在（插件重载后内存任务会丢失，但产物仍在磁盘上）' });

    const outDir = path.resolve(job.outDir);
    const root = path.resolve(baseDir);
    // 目录必须真的在插件数据根之下（防路径穿越 / 防被改造成打开任意目录）
    if (outDir !== root && !outDir.startsWith(root + path.sep)) {
      return sendJson(res, 403, { error: '产物目录不在插件数据目录内，已拒绝打开' });
    }
    if (!existsSync(outDir)) {
      return sendJson(res, 404, { error: `目录不存在：${outDir}` });
    }

    /** 各平台打开目录的命令（detached，不阻塞请求） */
    const cmd = process.platform === 'win32' ? 'explorer.exe'
      : process.platform === 'darwin' ? 'open'
        : 'xdg-open';
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(cmd, [outDir], { detached: true, stdio: 'ignore' });
      // Explorer 在新窗口打开后可能不退出，不 unref 会拖住宿主进程
      child.unref();
      // explorer.exe 即使成功也常返回非 0，所以不 await 它的退出码
      child.on('error', () => { /* 交给下面返回的提示 */ });
    } catch (e) {
      return sendJson(res, 500, {
        error: `无法调用 ${cmd}（${e.message}）：可直接复制面板上显示的路径`,
        outDir,
      });
    }
    sendJson(res, 200, { ok: true, outDir, opened: cmd });
  });

  // 5) 事件流（SSE）
  route('exact', '/novel2card/stream', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const taskId = url.searchParams.get('id');
    const job = taskId ? getJob(taskId) : null;
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('任务不存在');
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let ended = false;
    const end = (payload) => {
      if (ended) return;
      ended = true;
      try {
        res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
      } catch { /* 客户端已断开 */ }
    };
    const write = (rec) => {
      if (ended) return;
      /**
       * 结束信号由**缓冲里的 `__end` 记录**驱动，而不是另外查一次 job.status。
       *
       * 踩过的坑：原来先 `subscribe()`（会同步回放历史事件），再在
       * `job.status !== 'running'` 时额外 write 一次 done 并 `res.end()` ——
       * 于是回放还在继续、`res` 已经关闭，抛出
       * `ERR_STREAM_WRITE_AFTER_END`（未捕获的话会打挂宿主进程）。
       * 用户表现：打开一个**已完成**的任务就崩。
       *
       * 现在只有这一条出口；`ended` 保证幂等。
       */
      if (rec.event === '__end') return end({ status: rec.data.status, error: rec.data.error });
      try {
        res.write(`event: ${rec.event}\ndata: ${JSON.stringify(rec.data ?? null)}\n\n`);
      } catch { ended = true; }
    };

    // 回放历史 + 后续推送（同一个 writer）。已结束的任务会在回放里遇到 __end。
    const unsubscribe = job.subscribe(write);

    /**
     * 兜底：任务已结束但缓冲里没有 `__end`（例如插件重载前的旧记录），
     * 或者订阅时刚好错过了结束信号 —— 直接把当前状态收尾。
     * 用 `queueMicrotask` 让回放先跑完。
     */
    queueMicrotask(() => {
      if (!ended && job.status !== 'running') end({ status: job.status, error: job.error });
    });

    const cleanup = () => { unsubscribe(); ended = true; };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  // 6) 下载产物
  route('exact', '/novel2card/file', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const taskId = url.searchParams.get('id');
    const name = url.searchParams.get('name');
    const job = taskId ? getJob(taskId) : null;
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    if (!name) return sendJson(res, 400, { error: '缺少 name' });
    let buf;
    try {
      buf = await readArtifact(job.outDir, name);
    } catch (e) {
      return sendJson(res, 404, { error: e.message });
    }
    res.writeHead(200, {
      'Content-Type': name.endsWith('.json') ? 'application/json; charset=utf-8' : 'application/octet-stream',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    });
    res.end(buf);
  });

  // 7) 取消 / 删除任务
  route('exact', '/novel2card/cancel', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    const { fields } = await readRequest(req);
    const job = fields.taskId ? getJob(String(fields.taskId)) : null;
    if (!job) return sendJson(res, 404, { error: '任务不存在' });
    job.controller.abort();
    sendJson(res, 200, { ok: true });
  });

  route('exact', '/novel2card/remove', async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    const { fields } = await readRequest(req);
    const taskId = fields.taskId ? String(fields.taskId) : null;
    if (!taskId) return sendJson(res, 400, { error: '缺少 taskId' });
    const ok = await removeJob(taskId);
    sendJson(res, ok ? 200 : 404, { ok });
  });

  ctx.logger?.info?.(`[novel2card] 已就绪，数据目录 ${baseDir}`);

  // 插件卸载时清掉上传临时目录
  ctx.effect(() => () => { rm(uploadRoot(), { recursive: true, force: true }).catch(() => {}); }, 'novel2card:cleanup');
}

/**
 * 异步跑任务，把结果/异常收进 job 状态。
 *
 * 任务在**后台**跑：HTTP 请求立刻返回 taskId，进度走 SSE。
 * 这与本地版一致（长任务不能挂在一个请求上）。
 */
function kick(job, fn) {
  job.done = (async () => {
    try {
      await fn();
      job.finish('done');
    } catch (e) {
      const aborted = e?.name === 'AbortError' || /已取消|aborted/i.test(e?.message || '');
      job.finish(aborted ? 'cancelled' : 'error', e?.message || String(e));
    }
  })();
  // 不让未处理的 rejection 影响宿主
  job.done.catch(() => {});
}
