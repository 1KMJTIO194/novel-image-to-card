/**
 * Agent 工具：让 DSH 在聊天里**直接跑**角色卡生成任务。
 *
 * 用户的反馈："插件版感觉不如直接让 dsh 直接跑角色卡生成任务"。
 * 插件原来只有"面板 + HTTP 路由"——那是给人点表单用的；模型在对话里够不到。
 * 这里把同一批核心能力（`lib/tasks.js` → `src/pipeline.js` / `augment.js` / `image_card.js`）
 * 注册成 **DSH 工具**，于是用户可以直接说：
 *
 *   「把 D:\书\斗破.txt 做成角色卡，完整版」
 *   「用这张卡和这段新剧情完善一下」
 *   「把 D:\图\角色 里的图片做成卡」
 *
 * 工具与面板共用同一套 task 实现与产物目录，所以两边产出一致；
 * 区别只是调用入口：面板点按钮 vs 模型调工具。
 *
 * 接口配置优先级：工具参数 > 面板保存的默认配置 > 环境变量。
 * （面板保存的默认配置见 `lib/tool_config.js`；浏览器 localStorage 宿主进程读不到。）
 */
import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

import {
  createJob, startGenerate, startAugment, startImageCard,
  listArtifacts, readArtifact,
} from './tasks.js';
import { readToolConfig, resolveLLMConfig } from './tool_config.js';
import { resolveTaskDir } from './task_paths.js';

const CARD_FILE = 'character_card.json';
const IMG_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** 单次工具调用允许的图片上限（与面板一致） */
const MAX_IMAGE_COUNT = 60;
/** text 参数上限：约 200 万字符，再大应改用 novelPath */
const MAX_TEXT_CHARS = 2_000_000;
/** read_result 默认最多回多少字符（模型上下文友好） */
const DEFAULT_READ_CHARS = 12_000;

// ------------------------------------------------------------
// 参数校验与通用小工具
// ------------------------------------------------------------

function trimStr(v) {
  return String(v ?? '').trim();
}

function oneOf(allowed, value, fallback, label) {
  const v = trimStr(value) || fallback;
  if (!allowed.includes(v)) throw new Error(`${label} 只能是 ${allowed.join(' / ')}，收到：${v}`);
  return v;
}

function assertFile(p, label) {
  const abs = path.resolve(String(p || ''));
  if (!p || !existsSync(abs)) throw new Error(`${label}不存在：${String(p || '(空)')}`);
  if (!statSync(abs).isFile()) throw new Error(`${label}不是文件：${abs}`);
  return abs;
}

function assertDir(p, label) {
  const abs = path.resolve(String(p || ''));
  if (!p || !existsSync(abs)) throw new Error(`${label}不存在：${String(p || '(空)')}`);
  if (!statSync(abs).isDirectory()) throw new Error(`${label}不是目录：${abs}`);
  return abs;
}

/** 小说输入：novelPath 或 text 二选一（路径优先） */
function novelSource(args) {
  const novelPath = trimStr(args.novelPath);
  const text = String(args.text ?? '');
  if (novelPath) return { novelPath: assertFile(novelPath, '小说文件'), novelText: '' };
  if (!text.trim()) throw new Error('需要 novelPath（小说文件路径）或 text（小说正文）之一');
  if (text.length > MAX_TEXT_CHARS) {
    throw new Error(`text 过长（${text.length} 字符，上限 ${MAX_TEXT_CHARS}）：请先把正文存成文件再传 novelPath`);
  }
  return { novelPath: null, novelText: text };
}

/** 图片输入：imagePaths / imageDir 二选一；目录按文件名排序后取前 60 张 */
async function imageSource(args) {
  const imageDir = trimStr(args.imageDir);
  let list = Array.isArray(args.imagePaths) ? args.imagePaths.map(p => trimStr(p)).filter(Boolean) : [];
  if (imageDir) {
    const dir = assertDir(imageDir, '图片目录');
    const names = (await readdir(dir)).filter(n => IMG_RE.test(n)).sort();
    list = names.map(n => path.join(dir, n));
  }
  if (!list.length) throw new Error('需要 imagePaths（图片文件路径数组）或 imageDir（图片目录）之一');
  if (list.length > MAX_IMAGE_COUNT) {
    throw new Error(`图片 ${list.length} 张超过上限 ${MAX_IMAGE_COUNT} 张：请分批或先删减`);
  }
  return list.map(p => assertFile(p, '图片文件'));
}

function defaultTitle(novelPath) {
  if (!novelPath) return '未命名角色卡';
  return path.basename(novelPath, path.extname(novelPath)) || '未命名角色卡';
}

function abortError() {
  const e = new Error('任务已取消');
  e.name = 'AbortError';
  return e;
}

/**
 * 建任务、把工具调用的取消信号接到任务控制器上、等待执行完成。
 *
 * 为什么要桥接：工具侧拿到的是 `exec.signal`（宿主在取消/超时时会 abort 它），
 * 而 `tasks.js` 用 `job.controller.signal` 做流水线的取消开关。两者必须连起来，
 * 否则用户取消工具调用后，后台流水线还会继续烧 token。
 */
async function runTask({ baseDir, kind, title, input, exec, run }) {
  const signal = exec?.signal;
  if (signal?.aborted) throw abortError();
  const job = await createJob({ kind, title, baseDir, input });
  const onAbort = () => {
    try { job.controller.abort(); } catch { /* 已结束 */ }
  };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await run(job);
    job.finish('done');
    return { job, result };
  } catch (e) {
    job.finish('error', e?.message || String(e));
    throw e;
  } finally {
    if (signal) {
      try { signal.removeEventListener('abort', onAbort); } catch { /* 忽略 */ }
    }
  }
}

/** 读一张卡的角色/世界书条目数（`[character` 前缀是卡的约定） */
function countCardEntries(card) {
  const entries = card?.data?.character_book?.entries || [];
  const chars = entries.filter(e => /^\[character/i.test(String(e?.comment || ''))).length;
  return { entries: entries.length, characters: chars, worldbookEntries: entries.length - chars };
}

/**
 * 任务完成后收集"给人看也够用"的结果：任务 id、产物目录、卡片路径、统计、用量、文件清单。
 * 刻意都是**有界的**：文件清单最多 24 条、warnings 最多 6 条。
 */
async function describeTask(job, extra = {}) {
  const cardPath = path.join(job.outDir, CARD_FILE);
  let card = null;
  let meta = null;
  try { card = JSON.parse(await readFile(cardPath, 'utf-8')); } catch { /* 没有卡片也正常（比如只出预设） */ }
  try { meta = JSON.parse(await readFile(path.join(job.outDir, 'meta.json'), 'utf-8')); } catch { /* augment 不写 meta */ }
  const files = await listArtifacts(job.outDir);
  let counts = meta?.counts || null;
  if (!counts && card) counts = countCardEntries(card);
  return {
    ok: true,
    taskId: job.taskId,
    outDir: job.outDir,
    cardPath: existsSync(cardPath) ? cardPath : '',
    title: card?.data?.name || meta?.title || job.title || '',
    counts,
    usage: meta?.usage
      ? {
        calls: Number(meta.usage.calls) || 0,
        inputChars: Number(meta.usage.inputChars) || 0,
        outputChars: Number(meta.usage.outputChars) || 0,
      }
      : null,
    files: files.slice(0, 24),
    fileCount: files.length,
    warnings: Array.isArray(meta?.warnings) ? meta.warnings.slice(0, 6) : [],
    ...extra,
  };
}

/** 生成类工具统一的结论文本（第一次给模型看的就是这段） */
function renderTaskResult(value) {
  if (!value || value.ok === false) return [{ type: 'text', text: `✗ ${value?.message || '任务没有成功'}` }];
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const lines = [];
  const kindLabel = value.kind === 'augment' ? '角色卡已完善' : value.kind === 'image-card' ? '角色卡已生成（图片）' : '角色卡已生成';
  lines.push(`✅ ${kindLabel}：《${value.title || '未命名'}》`);
  lines.push(`任务：${value.taskId}`);
  lines.push(`产物目录：${value.outDir}`);
  if (value.cardPath) lines.push(`卡片：${value.cardPath}`);
  const c = value.counts;
  if (c) {
    const parts = [];
    if (c.characters != null) parts.push(`人物 ${c.characters}`);
    if (c.worldbookEntries != null) parts.push(`世界书 ${c.worldbookEntries} 条`);
    else if (c.worldbook != null) parts.push(`世界书 ${c.worldbook} 条`);
    if (c.events != null) parts.push(`事件 ${c.events}`);
    if (c.chapters != null) parts.push(`章节 ${c.chapters}`);
    if (c.entries != null && c.characters == null) parts.push(`条目 ${c.entries}`);
    if (parts.length) lines.push(`统计：${parts.join(' / ')}`);
  }
  if (value.usage) lines.push(`用量：${value.usage.calls} 次调用，输入 ${n(value.usage.inputChars)} 字符 / 输出 ${n(value.usage.outputChars)} 字符`);
  if (value.warnings?.length) lines.push(`提醒：${value.warnings.join('；')}`);
  lines.push('要读卡片或报告内容，用 novel2card_read_result；要列历史产物用 novel2card_list_results。');
  return [{ type: 'text', text: lines.join('\n') }];
}

// ------------------------------------------------------------
// 工具定义
// ------------------------------------------------------------

/** 三个生成类工具共用的模型接口参数 */
const LLM_PARAMS = {
  baseUrl: { type: 'string', description: '模型接口 Base URL（省略时用面板「模型接口设置」保存的默认配置）' },
  model: { type: 'string', description: '模型名（省略时用保存的默认配置）' },
  apiKey: { type: 'string', description: 'API Key（省略时用保存的默认配置；本机服务通常不需要）' },
};

function generateTool(baseDir) {
  return {
    name: 'novel2card_generate',
    description: '把小说生成 SillyTavern 角色卡：世界书（人物 / 事件 / 世界观条目）、时间线、MVU 变量树、'
      + '状态栏与酒馆助手预设。会真实调用模型接口，书越长耗时越久（几分钟）。'
      + '需要先在插件面板保存模型接口默认配置，或通过参数传入 baseUrl/model。',
    parameters: {
      type: 'object',
      properties: {
        novelPath: { type: 'string', description: '小说 .txt 的绝对路径（与 text 二选一，长文推荐）' },
        text: { type: 'string', description: '直接提供的小说正文（与 novelPath 二选一，上限 200 万字符）' },
        title: { type: 'string', description: '角色卡名称；省略时取小说文件名' },
        detailLevel: { type: 'string', enum: ['basic', 'full'], description: '生成档位：basic 省 token（默认）；full 更细（事件按剧情段落写、主要角色按出场章节取样）' },
        contentMode: { type: 'string', enum: ['general', 'adult'], description: '角色卡版本：general 普通（默认）/ adult 成人' },
        cardFormat: { type: 'string', enum: ['enhanced', 'plain'], description: '角色卡格式：enhanced 完整卡（默认，含状态栏与变量）/ plain 普通卡（无美化与变量）' },
        chapterRange: { type: 'string', description: '章节范围：all（默认）/ 1-10 / 1,3,5' },
        ...LLM_PARAMS,
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => renderTaskResult(value),
    },
    async execute(args, exec) {
      const a = args || {};
      const llm = resolveLLMConfig(a, await readToolConfig(baseDir));
      const source = novelSource(a);
      const title = trimStr(a.title) || defaultTitle(source.novelPath);
      const { job } = await runTask({
        baseDir, kind: 'generate', title, exec,
        input: { source: source.novelPath ? path.basename(source.novelPath) : '（工具提供的正文）' },
        run: (j) => startGenerate(j, {
          ...source,
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          title,
          userMode: 'auto',
          outputMode: 'card',
          chapterRange: trimStr(a.chapterRange) || 'all',
          detailLevel: oneOf(['basic', 'full'], a.detailLevel, 'basic', 'detailLevel'),
          contentMode: oneOf(['general', 'adult'], a.contentMode, 'general', 'contentMode'),
          cardFormat: oneOf(['enhanced', 'plain'], a.cardFormat, 'enhanced', 'cardFormat'),
        }),
      });
      return describeTask(job, {
        kind: 'generate',
        detailLevel: oneOf(['basic', 'full'], a.detailLevel, 'basic', 'detailLevel'),
      });
    },
  };
}

function augmentTool(baseDir) {
  return {
    name: 'novel2card_augment',
    description: '用新剧情完善一张已有角色卡：抽取新事件 / 人物 / 世界观，合并进原卡世界书，'
      + '并把变化整合进已有人物条目（冲突以新剧情为准）。需要 cardPath（character_card.json 的绝对路径）。'
      + '会真实调用模型接口，耗时几分钟。',
    parameters: {
      type: 'object',
      properties: {
        cardPath: { type: 'string', description: '已有角色卡 character_card.json 的绝对路径（必填）' },
        novelPath: { type: 'string', description: '新剧情 .txt 的绝对路径（与 text 二选一）' },
        text: { type: 'string', description: '直接提供的新剧情正文（与 novelPath 二选一，上限 200 万字符）' },
        instruction: { type: 'string', description: '完善指令，如「只并角色，角色设定要符合原卡世界观」' },
        strategy: { type: 'string', enum: ['merge', 'append', 'overwrite'], description: '合并策略：merge 追加进已有条目（默认）/ append 只新增 / overwrite 替换已有条目' },
        integrateCharacters: { type: 'boolean', description: '是否把新剧情整合重写进已有人物条目（默认 true；append 策略下不生效）' },
        chapterRange: { type: 'string', description: '章节范围：all（默认）/ 1-10 / 1,3,5' },
        ...LLM_PARAMS,
      },
      required: ['cardPath'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => renderTaskResult(value),
    },
    async execute(args, exec) {
      const a = args || {};
      const cardPath = assertFile(a.cardPath, '已有角色卡');
      const llm = resolveLLMConfig(a, await readToolConfig(baseDir));
      const source = novelSource(a);
      const title = `完善：${path.basename(cardPath, path.extname(cardPath))}`;
      const integrate = a.integrateCharacters !== false;
      const { job, result } = await runTask({
        baseDir, kind: 'augment', title, exec,
        input: { card: path.basename(cardPath), source: source.novelPath ? path.basename(source.novelPath) : '（工具提供的正文）' },
        run: (j) => startAugment(j, {
          cardPath,
          ...source,
          strategy: oneOf(['merge', 'append', 'overwrite'], a.strategy, 'merge', 'strategy'),
          instruction: trimStr(a.instruction) || undefined,
          chapterRange: trimStr(a.chapterRange) || 'all',
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          options: { integrateCharacters: integrate },
        }),
      });
      const report = result?.report || null;
      return describeTask(job, {
        kind: 'augment',
        counts: report
          ? { entries: report.after?.entries, characters: report.after?.characters, worldbookEntries: report.after?.worldbook, events: report.after?.events }
          : null,
        augment: report
          ? {
            matched: report.matched?.length ?? 0,
            added: report.added?.length ?? 0,
            updated: report.updated?.length ?? 0,
            integrated: Array.isArray(report.integrated) ? report.integrated : [],
            before: report.before || null,
            after: report.after || null,
          }
          : null,
      });
    },
  };
}

function imageCardTool(baseDir) {
  return {
    name: 'novel2card_image_card',
    description: '把一组图片（漫画 / 人设图）生成 SillyTavern 角色卡：先看图画事实，再总结成角色与世界观设定。'
      + '模型必须支持视觉。会真实调用模型接口，耗时几分钟。',
    parameters: {
      type: 'object',
      properties: {
        imagePaths: { type: 'array', items: { type: 'string' }, description: '图片文件绝对路径数组（与 imageDir 二选一，最多 60 张）' },
        imageDir: { type: 'string', description: '图片目录绝对路径（按文件名排序取全部图片，与 imagePaths 二选一）' },
        title: { type: 'string', description: '角色卡名称；省略时由模型总结' },
        hint: { type: 'string', description: '给模型的提示，如「这是漫画里的角色，做成人设卡」' },
        wantWorldbook: { type: 'boolean', description: '是否产出世界书条目（默认 true）' },
        detailLevel: { type: 'string', enum: ['basic', 'full'], description: '生成档位：basic 省 token（默认）/ full 更细' },
        contentMode: { type: 'string', enum: ['general', 'adult'], description: '角色卡版本：general 普通（默认）/ adult 成人' },
        cardFormat: { type: 'string', enum: ['enhanced', 'plain'], description: '完整卡（默认）/ 普通卡（无美化与变量）' },
        ...LLM_PARAMS,
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => renderTaskResult(value),
    },
    async execute(args, exec) {
      const a = args || {};
      const imagePaths = await imageSource(a);
      const llm = resolveLLMConfig(a, await readToolConfig(baseDir));
      const title = trimStr(a.title) || '图片生成的角色卡';
      const { job } = await runTask({
        baseDir, kind: 'image-card', title, exec,
        input: { images: imagePaths.length },
        run: (j) => startImageCard(j, {
          imagePaths,
          title,
          hint: trimStr(a.hint),
          wantWorldbook: a.wantWorldbook !== false,
          baseUrl: llm.baseUrl,
          apiKey: llm.apiKey,
          model: llm.model,
          detailLevel: oneOf(['basic', 'full'], a.detailLevel, 'basic', 'detailLevel'),
          contentMode: oneOf(['general', 'adult'], a.contentMode, 'general', 'contentMode'),
          cardFormat: oneOf(['enhanced', 'plain'], a.cardFormat, 'enhanced', 'cardFormat'),
        }),
      });
      return describeTask(job, { kind: 'image-card', images: imagePaths.length });
    },
  };
}

function listResultsTool(baseDir) {
  return {
    name: 'novel2card_list_results',
    description: '列出本插件生成过的角色卡任务（新的在前）。用于找回上次生成的产物目录 / taskId。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '最多返回几条（默认 10，上限 50）' },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        if (!value?.tasks?.length) return [{ type: 'text', text: '还没有生成过的任务。' }];
        const lines = [`📚 最近 ${value.tasks.length} 个任务：`];
        for (const t of value.tasks) {
          lines.push(`- ${t.taskId}  ${t.kind || ''}  ${t.title || ''}  ${t.hasCard ? '（有卡片）' : ''}\n  ${t.outDir}`);
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 10));
      const outRoot = path.join(baseDir, 'output');
      const names = (await readdir(outRoot).catch(() => []))
        .filter(n => /^task_\d{6,}$/.test(n))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, limit);
      const tasks = [];
      for (const id of names) {
        const dir = path.join(outRoot, id);
        let kind = '';
        let title = '';
        try {
          const pj = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf-8'));
          kind = pj.mode === 'augment' ? 'augment' : pj.mode === 'image-card' ? 'image-card' : 'generate';
          title = pj.title || pj.sourceCard || '';
        } catch { /* 没有 project.json 的旧任务 */ }
        if (!title) {
          try {
            const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
            title = meta.title || '';
            kind = meta.outputMode === 'preset' ? 'preset' : (kind || 'generate');
          } catch { /* 忽略 */ }
        }
        const hasCard = existsSync(path.join(dir, CARD_FILE));
        if (!kind && !title && !hasCard) continue;
        tasks.push({ taskId: id, kind, title, outDir: dir, hasCard });
      }
      return { ok: true, outDir: outRoot, tasks };
    },
  };
}

function readResultTool(baseDir) {
  return {
    name: 'novel2card_read_result',
    description: '读取某个任务的产物：给 file 时读该文件（文本）；不给时列出产物清单。'
      + '适合查看 character_card.json、summary.json、SUMMARY.md、meta.json。单次最多回 20000 字符。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 id，形如 task_1794240480911' },
        file: { type: 'string', description: '产物文件名（如 character_card.json、SUMMARY.md）；省略时列清单' },
        maxChars: { type: 'integer', description: '最多返回多少字符（默认 12000，上限 20000）' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        if (value?.file) {
          return [{ type: 'text', text: `📄 ${value.file}（${value.size} 字节${value.truncated ? `，已截断到 ${value.content.length} 字符` : ''}）\n\n${value.content}` }];
        }
        const lines = [`📁 ${value.taskId} 的产物（${value.outDir}）：`];
        for (const f of value.files) lines.push(`- ${f.name}（${f.size} 字节）`);
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args) {
      const taskId = trimStr(args?.taskId);
      const dir = resolveTaskDir(baseDir, taskId);
      if (!dir) throw new Error(`找不到任务产物目录：${taskId || '(空)'}`);
      const files = await listArtifacts(dir);
      const file = trimStr(args?.file);
      if (!file) return { ok: true, taskId, outDir: dir, files };
      const maxChars = Math.max(500, Math.min(20_000, Number(args?.maxChars) || DEFAULT_READ_CHARS));
      const buf = await readArtifact(dir, file);
      const text = buf.toString('utf-8');
      return {
        ok: true,
        taskId,
        outDir: dir,
        file,
        size: buf.length,
        truncated: text.length > maxChars,
        content: text.slice(0, maxChars),
      };
    },
  };
}

/**
 * 创建全部工具定义（纯函数，便于测试直接拿定义检查 schema / 调用 execute）。
 * @param {{baseDir:string}} opts
 */
export function createToolDefinitions({ baseDir }) {
  if (!baseDir) throw new Error('createToolDefinitions 需要 baseDir');
  return [
    generateTool(baseDir),
    augmentTool(baseDir),
    imageCardTool(baseDir),
    listResultsTool(baseDir),
    readResultTool(baseDir),
  ];
}

/**
 * 注册到 DSH 工具表（在 `apply` 的 `ctx.effect` 里调用，卸载即移除）。
 * @param {object} ctx Cordis context（需已注入 `tools` 服务）
 * @param {{baseDir:string}} opts
 * @returns {() => void} disposer
 */
export function registerTools(ctx, { baseDir }) {
  const offs = [];
  for (const def of createToolDefinitions({ baseDir })) {
    const off = ctx.tools.register(def);
    if (typeof off === 'function') offs.push(off);
  }
  return () => {
    for (const off of offs) {
      try { off(); } catch { /* 已释放 */ }
    }
  };
}
