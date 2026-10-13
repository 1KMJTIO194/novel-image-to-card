/**
 * 图片 → 角色卡
 *
 * 与「小说 → 角色卡」的关系：**共用后半段装配，只换输入来源**。
 *
 *     小说路径： 文本 → 切章 → 每批抽取 → 归并 → 人物/事件/世界观 → 变量树 → 状态栏 → 卡
 *     图片路径： 图片 → 视觉抽取 ────────────────────────→ 人物图像档 ──┘
 *
 * 结果是两条路径产出**同一种卡**（同样的变量树、状态栏、正则体系、世界书结构），
 * 所以在酒馆里的用法完全一致。
 *
 * ⚠️ 视觉抽取这一步**依赖模型真的能看图**。
 * 实测 api.deepseek.com 的 deepseek-flash 直接报错、deepseek-v4-pro 返回
 * "我无法查看这张图片" —— 即端点接受图片字段但不做视觉理解。
 * 因此本模块把装配段与视觉段彻底分开：
 *
 *     extractCharactersFromImages()  ← 需要真视觉模型
 *     buildCardFromExtraction()      ← 纯计算 + 已有 LLM 步骤，可独立测试
 *
 * 后者可以用注入的抽取结果完整验证（见 tests/image-card.mjs）。
 */
import { readFile, writeFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { makeLLM, inferImageMime } from './llm.js';
import * as S from './steps.js';
import { varKey } from './utils.js';
import { parseDateParts } from './dates.js';
import { generateStatusbar, THEMES } from './step75_statusbar.js';
import { summarizeGenerate, renderSummaryMarkdown } from './summary.js';
import { sliceAllForVision } from './image_slice.js';
import {
  assembleCharacterCard, assembleWorldbook, buildVariables, initializeUserNamespace,
  inspectContentYaml, isPlaceholderBody, makeStatusbarPreview,
} from './pipeline.js';

/** 单张图片允许的大小上限（字节）。上游对超大图会直接判定为 unsupported。 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 图片数量上限。
 *
 * 原来卡在 8 —— 但那是**一次请求**塞的图片数，不是能处理的总数。
 * 长一点的漫画一话就有 15-25 页，8 张根本不够。
 * 现在改成：总数放宽到 60，内部按 `DEFAULT_VISION_BATCH` 分批送模型，
 * 所以"能收多少张"与"一次送几张"解耦了。
 *
 * 60 这个数不是随意定的：按每张约 1000-1500 image token 估算，
 * 60 张≈ 6-9 万 token 的视觉输入，已经是单次生成任务的合理上限；
 * 再多就是"把整本漫画塞进一张卡"，README 会给出建议。
 */
export const MAX_IMAGES = 60;

/** 每批送模型的图片数（长漫画要分批，否则注意力被稀释、还可能超上下文） */
export const DEFAULT_VISION_BATCH = 6;

/**
 * 视觉抽取的默认并发批次。
 *
 * 刻意保持很低：一批就是一次带多张图的请求，图片 token 很贵，
 * 同时打太多次很容易触发上游限流，反而更慢。
 */
export const DEFAULT_VISION_CONCURRENCY = 2;

/**
 * 每个批次最多尝试几次。
 *
 * 与 `llm.chat` 内部的 retries 是**两层**：那一层是同一次调用内的退避重试，
 * 这一层在批与批之间再给机会 —— 实测遇到过整轮 4 批全失败（内部重试都用完了），
 * 长漫画 10 批时那种情况会让整轮报废。
 */
export const BATCH_ATTEMPTS = 3;

/** 允许的图片扩展名（上游只接受这几种格式） */
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * 校验图片清单。
 *
 * 为什么要在调用模型**之前**校验：上游的报错是
 * `You have uploaded an unsupported image. Please make sure ... one of the following formats`
 * —— 它不会告诉你是**哪一张**。多图时用户根本不知道该换哪张。
 *
 * @returns {{ok:boolean, errors:string[], warnings:string[], images:Array}}
 */
export function validateImages(imagePaths = []) {
  const errors = [];
  const warnings = [];
  const images = [];
  for (const [i, p] of imagePaths.entries()) {
    const label = `图片${i + 1}`;
    const ext = path.extname(String(p)).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      errors.push(`${label} 格式不支持（${ext || '无扩展名'}）：只接受 png / jpg / webp / gif`);
      continue;
    }
    images.push({ index: i, path: p, ext, label });
  }
  if (!images.length) errors.push('没有可用的图片（至少需要 1 张）');
  if (imagePaths.length > 0 && imagePaths.length !== images.length) {
    warnings.push(`共 ${imagePaths.length} 张，其中 ${imagePaths.length - images.length} 张被跳过`);
  }
  // 数量上限：超了要说清是"最多几张"，而不是让上游报一个看不懂的错
  if (imagePaths.length > MAX_IMAGES) {
    errors.push(`一次最多 ${MAX_IMAGES} 张（收到 ${imagePaths.length} 张）：`
      + '长漫画请按话分批生成；也可以先挑选主要角色出现的页面');
  }
  return { ok: errors.length === 0, errors, warnings, images };
}

/** 读图并检查体积上限（超限的图上游会当 unsupported，提前拦下来给可读原因） */
export async function loadImageInfo(p) {
  const buf = await readFile(p);
  return { bytes: buf.length, tooBig: buf.length > MAX_IMAGE_BYTES };
}

/**
 * 把视觉抽取结果的松散 JSON 归一化成内部结构。
 *
 * 模型返回的形状不保证（可能少字段、可能是字符串、可能英文键），
 * 所以这里做一层容错，**不抛错**：缺什么补空，认不出的丢掉。
 */
/**
 * 归一化视觉模型返回的人物档案。
 *
 * @param {*} raw 模型返回（对象 / 数组 / {characters:[...]}）
 * @param {{imageCount?:number, imageOffset?:number, imagePaths?:Array<number>}} [opts]
 *        imageCount —— **本批**的图片数（用于把越界的 imageIndex 夹回本批范围）
 *        imageOffset —— 本批第一张图在**全部图片**里的下标（无切片时用）。
 *        imagePaths —— **批内文件下标 → 全局原图下标**的映射表（切片后用）。
 *                       超长图切片后一个原图对应多个文件，模型按文件顺序报
 *                       imageIndex，必须查这张表映射回原图下标，
 *                       否则「（图5）」会指向一张不存在的图。
 *                       ⚠️ 它**已经包含** offset 的语义，两者不要叠加。
 */
export function normalizeCharacterProfiles(raw, { imageCount = 0, imageOffset = 0, imagePaths = null } = {}) {
  const list = Array.isArray(raw) ? raw
    : Array.isArray(raw?.characters) ? raw.characters
      : Array.isArray(raw?.profiles) ? raw.profiles
        : raw && typeof raw === 'object' ? [raw] : [];
  const hasMap = Array.isArray(imagePaths) && imagePaths.length > 0;
  const out = [];
  for (const [i, c] of list.entries()) {
    if (!c || typeof c !== 'object') continue;
    const name = String(c.name ?? c.名称 ?? c.character_name ?? '').trim();
    const appearance = String(c.appearance ?? c.外貌 ?? '').trim();
    const clothing = String(c.clothing ?? c.服饰 ?? '').trim();
    // 全空的条目没有价值（模型偶尔会返回空壳）
    if (!name && !appearance && !clothing) continue;
    // 本批内的局部下标：模型说 imageIndex 就用它，否则按输出顺序
    const localIdx = Number.isInteger(c.imageIndex) ? c.imageIndex : i;
    /** 局部下标 → 全局原图下标：有映射表就查表，否则退回 offset 平移 */
    const mappedIdx = hasMap
      ? (imagePaths[Math.max(0, Math.min(localIdx, imagePaths.length - 1))] ?? localIdx)
      : localIdx;    out.push({
      name: name || `角色${out.length + 1}`,
      imageIndex: mappedIdx,
      /**
       * 这个人出现在哪几段切片里（模型自报）。
       *
       * 切片场景下这是"是不是同一个人"的**主要线索** ——
       * 「同一张图的好几段里都有这个角色」和「同一张图里有两个不同的人」
       * 靠它区分。没切片时为空数组。
       */
      sliceIndexes: Array.isArray(c.sliceIndexes)
        ? c.sliceIndexes.map(Number).filter(n => Number.isInteger(n) && n >= 0)
        : [],
      /**
       * 截图里逐段转录的文字。
       *
       * 聊天记录 / 帖文类截图里，**文字往往比头像更有信息量** ——
       * 姓名、身份、关系、发生了什么都在文字里。之前完全没要这个字段，
       * 所以模型只能围着"头像直径只有 60 像素"打转。
       */
      transcript: String(c.transcript ?? '').trim(),
      /** 文字里出现过的称呼/账号名，比自起的名字更有辨识度 */
      namesFromText: Array.isArray(c.namesFromText) ? c.namesFromText.map(String).filter(Boolean) : [],
      aliases: Array.isArray(c.aliases) ? c.aliases.map(String).filter(Boolean) : [],
      gender: String(c.gender ?? '').trim(),
      ageRange: String(c.ageRange ?? '').trim(),
      confidence: ['high', 'medium', 'low'].includes(c.confidence) ? c.confidence : 'medium',
      appearance,
      clothing,
      build: String(c.build ?? '').trim(),
      accessories: Array.isArray(c.accessories) ? c.accessories.map(String).filter(Boolean) : [],
      palette: Array.isArray(c.palette) ? c.palette.map(String).filter(Boolean) : [],
      scene: String(c.scene ?? '').trim(),
      worldHints: Array.isArray(c.worldHints) ? c.worldHints.map(String).filter(Boolean) : [],
      personalityHints: Array.isArray(c.personalityHints) ? c.personalityHints.map(String).filter(Boolean) : [],
      inferredIdentity: String(c.inferredIdentity ?? '').trim(),
      inferredAbilities: String(c.inferredAbilities ?? '').trim(),
      inferredRelations: String(c.inferredRelations ?? '').trim(),
      notes: String(c.notes ?? '').trim(),
    });
  }
  /**
   * 把越界的 imageIndex 夹回**本批**范围，然后加上 offset 转成全局编号。
   *
   * ⚠️ 顺序很重要：先按本批夹取、再加 offset。
   * 反过来的话（先加 offset 再按本批 imageCount 夹）会把后面的批次全夹回 0。
   *
   * ⚠️ 有映射表（切片场景）时**不能**再叠加 offset：
   * `imagePaths` 里存的已经是**全局原图下标**（切片时由 sliceAllForVision 算好），
   * 再加一次 offset 会双重平移，把「（图N）」指到不存在的图上。
   */
  if (imageCount > 0 && !hasMap) {
    for (const c of out) {
      if (!Number.isInteger(c.imageIndex) || c.imageIndex < 0 || c.imageIndex >= imageCount) {
        c.imageIndex = Math.min(Math.max(0, c.imageIndex || 0), imageCount - 1);
      }
    }
  }
  if (imageOffset && !hasMap) {
    for (const c of out) c.imageIndex += imageOffset;
  }

  /**
   * **名字去重**：同名会让变量树互相覆盖。
   *
   * 踩过的坑：两张图是同一场景里的两个剪影，模型给了**同一个名字**
   * （都叫「左前景剪影行人」）。而变量树是 `characters.<varKey(名)>`，
   * 同名直接塌成一个键 —— **实测 2 个人物只剩 1 个**，
   * 状态栏少一页、AI 也永远更新不到第二个角色。
   *
   * 做法：重复的加上「（图N）」区分。这样两个角色都能保留，
   * 而且用户一眼能看出它们来自哪张图。
   * 不去猜测"到底是不是同一个人" —— 那是视觉判断，不该由代码硬猜；
   * 名字不同至少在卡里是完整的，用户可以自己合并。
   */
  {
    const seen = new Map();
    for (const c of out) {
      const key = String(c.name).trim();
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      if (n > 0) {
        const tag = `（图${c.imageIndex + 1}）`;
        // 避免新名字又与既有名字撞车
        c.name = `${key}${tag}`;
        while (seen.has(c.name)) c.name = `${c.name}·`;
        seen.set(c.name, 1);
      }
    }
  }
  return out;
}

/**
 * 同一张原图内的档案合并。
 *
 * 为什么必须有这一步（实测踩坑）：
 *   超长图被切成 6 段后，模型为**每一段**都输出了一条档案，名字分别是
 *   「银发头像少女 uyu」「…（图1）」「…（图1）·」…（去重逻辑加的点）。
 *   于是**一个人变成了 6 个角色**，每个都在变量树里占一个键，
 *   卡里多出 5 条纯重复的条目。
 *   我在 prompt 里要求"同一个人只输出一条"，但**不能只靠 prompt** ——
 *   模型不听时用户就会看到这种结果，而代码必须能兜住。
 *
 * 合并判据是**名字归一化后相同**（去掉「（图N）」/·后缀、空白、大小写）：
 *   · 归一化后同名 → 认为是同一个人的多段 → 合并
 *   · 名字不同 → **保持分开**（可能是同一张图里的两个人，代码不该硬猜）
 *
 * 这一点是刻意保守的：**错误合并会丢角色**（把两个不同的人并成一个，
 * 用户很难发现），而漏合并只是多一条重复条目（用户一眼能看出并手动删）。
 *
 * @param {Array<Array>} groups 按原图下标分组的档案
 * @returns {Array} 合并后的扁平档案列表
 */
export function mergeSameImageProfiles(groups = []) {
  const out = [];
  // groups 本身可能不是数组（调用方传 null / 单个对象）—— 不能让边界输入炸掉整轮抽取
  for (const group of (Array.isArray(groups) ? groups : [])) {
    if (!Array.isArray(group) || !group.length) continue;
    const merged = new Map();
    for (const p of group) {
      if (!p || typeof p !== 'object') continue;
      const key = normalizeProfileName(p.name);
      if (!key) { out.push(p); continue; }
      const prev = merged.get(key);
      if (!prev) { merged.set(key, { ...p }); continue; }
      merged.set(key, combineProfiles(prev, p));
    }
    out.push(...merged.values());
  }
  return out;
}

/** 归一化名字：去掉去重后缀与空白，用于判定"是不是同一个名字" */
export function normalizeProfileName(name) {
  return String(name || '')
    .replace(/[（(]\s*图\s*\d+\s*[)）]/g, '')   // 去掉「（图3）」
    .replace(/[·・.\s]+$/g, '')                  // 去掉尾部去重用的点/空格
    .replace(/\s+/g, '')
    .toLowerCase()
    .trim();
}

/**
 * 合并同一个人的两份档案：字段取"更长的那个"，数组取并集。
 *
 * 取更长而不是拼接：两段里的描述是**同一件事的重复叙述**（同一个人同一套衣服），
 * 拼起来会变成"长发…长发…"的复读。取信息量更大的那份更合适。
 */
function combineProfiles(a, b) {
  const longer = (x, y) => (String(y || '').length > String(x || '').length ? y : x);
  const union = (x, y) => [...new Set([...(x || []), ...(y || [])])];
  return {
    ...a,
    name: String(a.name).length >= String(b.name).length ? a.name : b.name,
    sliceIndexes: union(a.sliceIndexes, b.sliceIndexes).sort((x, y) => x - y),
    transcript: longer(a.transcript, b.transcript),
    namesFromText: union(a.namesFromText, b.namesFromText),
    aliases: union(a.aliases, b.aliases),
    gender: a.gender || b.gender,
    ageRange: longer(a.ageRange, b.ageRange),
    // 置信度取更高的（同一人多份档案里，只要有一份看得清就算看得清）
    confidence: rankConfidence(a.confidence) >= rankConfidence(b.confidence) ? a.confidence : b.confidence,
    appearance: longer(a.appearance, b.appearance),
    clothing: longer(a.clothing, b.clothing),
    build: longer(a.build, b.build),
    accessories: union(a.accessories, b.accessories),
    palette: union(a.palette, b.palette),
    scene: longer(a.scene, b.scene),
    worldHints: union(a.worldHints, b.worldHints),
    personalityHints: union(a.personalityHints, b.personalityHints),
    inferredIdentity: longer(a.inferredIdentity, b.inferredIdentity),
    inferredAbilities: longer(a.inferredAbilities, b.inferredAbilities),
    inferredRelations: longer(a.inferredRelations, b.inferredRelations),
    notes: longer(a.notes, b.notes),
  };
}

const CONF_RANK = { high: 3, medium: 2, low: 1 };
const rankConfidence = (c) => CONF_RANK[c] || 0;

/**
 * 判断视觉抽取结果是否**实质上不可用**。
 *
 * 判据分两层，**优先用第一层**：
 *
 * **① 模型的显式自述（最可靠）**：prompt 要求它先回答 `sawImage`。
 *    实测结论：靠启发式猜"它到底看没看到"是不可靠的 ——
 *    拒绝文本里**本身就含具体名词**（「无法辨认角色的发色发型、瞳色眼型、肤色」），
 *    而简短但真实的描述（「黑发少年／白衬衫／教室」）词数又很少，
 *    两者在"具体词计数"上完全重叠（拒绝 8-9 词 vs 简短真实 2 词）。
 *    试过阈值 30 / 8 / 按子句切分，两种错误都踩过。
 *    所以让模型自己声明，比任何后验启发式都准。
 *
 * **② 内容兜底（模型没给 sawImage 时）**：按子句统计具体描述词 ——
 *    否定子句整句不计，因为那是"我没看到什么"，不是"我看到了什么"。
 *    这层只在模型漏答 `sawImage` 时生效，宁可误拦也不放行空壳卡。
 *
 * @returns {{usable:boolean, reason:string, detail:string}}
 */
export function assessVisionQuality(profiles = [], { sawImage = null } = {}) {
  // ① 模型显式声明"没看到图" → 直接不可用（最可靠的信号）
  if (sawImage === false) {
    return { usable: false, reason: 'model-says-blind', verified: true, detail: '模型自述没能看到图片（sawImage=false）' };
  }
  /**
   * ② 模型漏答 `sawImage` → 只能靠内容判断，**并明确标记为"未确认"**。
   *
   * ⚠️ 这一层**分不干净**，实测两种错误都踩过：
   *   · 拒绝文本「无法辨认角色的发色发型、瞳色眼型、肤色」含 8-9 个具体词
   *   · 简短但真实的「黑发少年／白衬衫／教室」只有 2 个
   *   在"具体词计数"上完全重叠。阈值 30 会把简短真实误判为失败，
   *   阈值 8 又漏掉拒绝文本 —— 所以这里选择**放行 + 明确告知未确认**：
   *   误放行一张信息不全的卡（用户能看出来）比误判失败（用户以为功能坏了）代价小。
   *
   * 这个取舍写进 `verified` 字段，由调用方透到 meta 与 README，
   * 让用户知道"这次没验证成图片可见性"。
   */
  const verified = typeof sawImage === 'boolean';
  if (!profiles.length) {
    return { usable: false, reason: 'empty', verified, detail: '没有识别出任何角色' };
  }

  /**
   * 判据：按子句切分，**含否定词的子句整句不计**，只统计剩余子句里的具体描述词。
   * 真描述句（"银色长发垂至腰际，赤色瞳孔"）不含否定词，整句都算。
   */
  const NEGATION = /无法|未能|不能|未提供|缺失|不受支持|unsupported|cannot|unable|no .{0,6}available/i;
  const CONCRETE = /(色|发|瞳|眼|肤|脸|眉|唇|鼻|身材|体型|身形|高|矮|胖|瘦|衣|裙|袍|衫|裤|鞋|帽|披风|甲|饰|环|链|纹|材质|布|丝|革|金属|袖|领|扣|腰带|背景|场景|天气|光|影|建筑|街道|房间|山|水|树|天空)/;
  const countConcrete = (text) => {
    const clauses = String(text || '').split(/[，。；、\n]+/).map(s => s.trim()).filter(Boolean);
    let n = 0;
    for (const c of clauses) {
      if (NEGATION.test(c)) continue;          // 否定子句整句不计
      n += (c.match(new RegExp(CONCRETE, 'g')) || []).length;
    }
    return n;
  };

  const MIN_CONCRETE = 2;
  const scores = profiles.map(p => ({
    name: p.name,
    score: countConcrete(p.appearance) + countConcrete(p.clothing) + countConcrete(p.scene),
  }));
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]);

  if (best.score >= MIN_CONCRETE) {
    return { usable: true, reason: 'ok', detail: '', best, verified };
  }
  return {
    usable: false,
    reason: 'no-visual-content',
    verified,
    detail: `返回了 ${profiles.length} 条档案，但**非否定子句里**最多只有 ${best.score} 个具体描述词`
      + `（需要 ≥${MIN_CONCRETE}）—— 模型说的都是"无法辨认/图片未提供"这类话，等于没看图`,
    best,
  };
}

/**
 * 合并多个批次的档案并做**跨批去重**。
 *
 * 为什么必须跨批再去重一次：每批内部已经去过重，但**同一个角色出现在多批里**
 * 是长漫画的常态（主角贯穿全书）。同名档案会让变量树
 * `characters.<varKey(名)>` 塌成一个键 —— 实测 2 个人物只剩 1 个。
 *
 * 做法与批内一致：重复的加「（图N）」，N 用**全局** imageIndex + 1，
 * 用户一眼能看出它来自第几张图。不猜"是不是同一个人"（那是视觉判断）。
 *
 * @param {Array<Array>} batchProfiles 各批的档案（各自 imageIndex 已是全局编号）
 * @returns {Array} 合并去重、按来源图顺序排好的档案
 */
export function mergeBatchProfiles(batchProfiles = []) {
  const out = [];
  const seen = new Map();
  for (const batch of batchProfiles) {
    for (const p of batch || []) {
      const key = String(p.name).trim();
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      if (n > 0) {
        p.name = `${key}（图${p.imageIndex + 1}）`;
        // 避免新名字又撞上既有名字
        while (seen.has(p.name)) p.name = `${p.name}·`;
        seen.set(p.name, 1);
      }
      out.push(p);
    }
  }
  // 稳定排序：按来源图顺序，读起来与漫画顺序一致
  out.sort((a, b) => (a.imageIndex - b.imageIndex) || String(a.name).localeCompare(String(b.name)));
  return out;
}

/**
 * 单批图片的视觉抽取（内部用）。返回该批的档案（imageIndex 为本批局部下标）。
 */
async function extractOneBatch(llm, images, { hint, offset, batchNo, batchTotal, sliceOf = null }) {
  const n = images.length;
  /**
   * 超长图被切片时，模型看到的是"同一张图的好几段" —— 必须明确告诉它，
   * 否则它会为每段输出一个"新角色"，同一个人被登记好几遍。
   */
  const slicedNote = sliceOf?.some(x => x !== null)
    ? `\n【注意】其中有图片是从**同一张超长截图**按上到下切出来的多段`
      + `（以下标明的段号属于同一张图）。同一张图的多段请**合并成一个角色**，`
      + `不要因为分段就重复登记同一个人。\n`
      + sliceOf.map((orig, i) => (orig === null ? '' : `第 ${i + 1} 个文件 = 原图${orig + 1}的一段`)).filter(Boolean).join('\n')
    : '';
  const userText = [
    `以下是 ${n} 张图片，请为**每一张**图片中的人物各输出一条档案。`,
    batchTotal > 1 ? `（这是第 ${batchNo}/${batchTotal} 批，共 ${n} 张）` : '',
    slicedNote,
    hint ? `\n【用户补充的设定（优先采纳，与图片冲突时以用户设定为准）】\n${hint}` : '',
    `\n按图片顺序输出，共 ${n} 条。`,
  ].filter(Boolean).join('\n');

  const raw = await llm.chat(S.STEP_IMAGE_TO_CARD, userText, 'image-vision', {
    temperature: 0.4,
    images: images.map(i => i.path),
    json: true,
    retries: 2,
  });

  let parsed = null;
  let parseError = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 模型有时会在 JSON 外面包一层花括号说明文字，抠出花括号再试一次
    const m = /\{[\s\S]*\}|\[[\s\S]*\]/.exec(String(raw));
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { parseError = e2.message; } }
    else parseError = e.message;
  }
  // offset 让「（图N）」说的是**全局**第 N 张，而不是"本批第 N 张"
  // imagePaths 让切片段的局部下标映射回**原图**下标
  const profiles = normalizeCharacterProfiles(parsed, {
    imageCount: n, imageOffset: offset, imagePaths: sliceOf,
  });

  /**
   * 切片场景下，把**同一张原图**的档案按名字合并。
   *
   * prompt 里已经要求"同一个人只输出一条"，但实测模型会为每一段各出一条
   * （名字只差一个「（图N）」），于是一个人变成 6 个角色。
   * 这里按原图下标分组再合并，兜住这种情况。
   *
   * 只在真的发生切片时做 —— 没切片时一个文件就是一张图，
   * 同一张图里的两个不同人物**不该**被合并。
   */
  let finalProfiles = profiles;
  /** 合并提示（有重复被合并时才有），由调用方写进进度日志 */
  let dedupNote = null;
  if (Array.isArray(sliceOf) && sliceOf.length) {
    const byImage = new Map();
    for (const p of profiles) {
      const k = p.imageIndex;
      if (!byImage.has(k)) byImage.set(k, []);
      byImage.get(k).push(p);
    }
    const before = profiles.length;
    finalProfiles = mergeSameImageProfiles([...byImage.values()]);
    if (finalProfiles.length < before) {
      // 合并掉了重复 —— 这是好事，但要说出来，否则用户不知道"9 条档案"为何变少
      dedupNote = `同一张图的重复档案已合并：${before} → ${finalProfiles.length} 条`;
    }
  }

  // 模型自述是否看到图（prompt 要求它先回答这个）。缺字段时传 null，交给内容兜底判
  const sawImage = parsed && typeof parsed === 'object' && typeof parsed.sawImage === 'boolean'
    ? parsed.sawImage
    : null;
  return { profiles: finalProfiles, raw, parseError, sawImage, reason: parsed?.reason, dedupNote };
}

/**
 * 视觉抽取：让模型逐张看图并产出人物档案。
 *
 * **分批**（重要）：所有图片塞进一次请求在少量图时可行，但长漫画（几十页）会：
 *   · 超出模型的图片/上下文上限
 *   · 每张图分到的注意力被稀释，后面的页描述明显变差
 * 所以按 `batchSize` 切开、并发送模型，再把结果合并。
 *
 * @param {object} cfg
 * @param {string[]} cfg.imagePaths
 * @param {string} [cfg.hint] 用户补充的文字设定（可选，例如"这是修仙世界，她是我师姐"）
 * @param {string} cfg.baseUrl/apiKey/model
 * @param {number} [cfg.batchSize] 每批发多少张（默认 6）
 * @param {number} [cfg.concurrency] 并发批次数（默认 2，避免触发限流）
 * @param {Function} [cfg.send] 进度回调
 * @returns {Promise<{profiles:Array, raw:string, usage:object, batches:number}>}
 */
export async function extractCharactersFromImages(cfg = {}) {
  const send = typeof cfg.send === 'function' ? cfg.send : () => {};
  const llm = makeLLM({
    baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model,
    requestTimeout: cfg.requestTimeout,
  }, cfg.preset || null);

  const valid = validateImages(cfg.imagePaths || []);
  if (!valid.ok) throw new Error(valid.errors.join('；'));

  // 体积预检：把"哪一张太大"说清楚，而不是等上游回一句 unsupported
  for (const im of valid.images) {
    const info = await loadImageInfo(im.path);
    if (info.tooBig) {
      throw new Error(`${im.label} 体积 ${(info.bytes / 1024 / 1024).toFixed(1)}MB，`
        + `超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB 上限：请先压缩或缩小尺寸再重试`);
    }
    im.bytes = info.bytes;
    send('progress', { step: 'Vision', msg: `${im.label}：${(info.bytes / 1024).toFixed(0)}KB ${im.ext}`, ts: Date.now() });
  }

  const hint = String(cfg.hint || '').trim();
  const batchSize = Math.max(1, Number(cfg.batchSize) || DEFAULT_VISION_BATCH);
  const images = valid.images;
  const total = images.length;

  /**
   * 超长截图切片。
   *
   * 为什么要做（实测）：一张 720x6269 的手机长截图（宽高比 1:8.7）原样发给
   * 视觉模型时，**只读到了帖子的小头像，正文一个字没读到** —— 整图被按比例
   * 缩到模型的视觉尺寸上限，字号被压到无法辨认。
   *
   * 切完再送，模型看到的是"几张正常比例的图"，文字可读。
   * 代价是 token 变多（片间还有重叠），所以默认只在确实过长时才切。
   */
  let visionFiles = images.map(i => i.path);
  /** 批内文件下标 → 全局原图下标；仅在发生切片时非空 */
  let visionMap = null;
  const sliceDir = path.join(cfg.workDir || path.dirname(images[0].path), '_slices');
  if (cfg.sliceTallImages !== false) {
    try {
      const sl = await sliceAllForVision(images, sliceDir);
      if (sl.slicedCount > 0) {
        visionFiles = sl.files;
        visionMap = sl.mapping;
        send('progress', {
          step: 'Vision',
          msg: `超长图已切片：${sl.slicedCount} 张 → ${sl.files.length} 个片段（保持可读分辨率，否则长截图里的文字读不到）`,
          ts: Date.now(),
        });
        for (const n of sl.notes) send('progress', { step: 'Vision', msg: `  · ${n}`, ts: Date.now() });
      } else if (sl.notes.length) {
        for (const n of sl.notes) send('progress', { step: 'WARN', msg: n, ts: Date.now() });
      }
    } catch (e) {
      // 切片只是优化，不能因为它把整个任务搞挂
      send('progress', { step: 'WARN', msg: `长图切片失败，改用原图：${e.message}`, ts: Date.now() });
    }
  }

  // 切批：按**发送给模型的文件**切（切片会改变数量）
  const totalFiles = visionFiles.length;
  const batches = [];
  for (let i = 0; i < totalFiles; i += batchSize) {
    const files = visionFiles.slice(i, i + batchSize);
    batches.push({
      offset: i,
      images: files.map(p => ({ path: p })),
      /** 本批每个文件对应的**原图**下标；无切片时为 null（走 offset 平移） */
      sliceOf: visionMap ? visionMap.slice(i, i + batchSize) : null,
    });
  }

  send('progress', {
    step: 'Vision',
    msg: batches.length > 1
      ? `视觉抽取：${total} 张图${totalFiles !== total ? `（切片后 ${totalFiles} 个片段）` : ''}，`
        + `分 ${batches.length} 批（每批最多 ${batchSize} 张）${hint ? ' + 用户文字设定' : ''}`
      : `视觉抽取：${total} 张图${totalFiles !== total ? `（切片后 ${totalFiles} 个片段）` : ''}`
        + `${hint ? ' + 用户文字设定' : ''}`,
    ts: Date.now(),
  });

  /**
   * 并发处理各批。
   *
   * ⚠️ 并发**不宜高**：一批就是一次带多张图的请求，图片 token 很贵，
   * 同时打太多很容易触发上游限流，反而整体更慢。
   * 也**不静默吞掉失败**：某一批失败只丢那一批，但要在日志与结果里说出来 ——
   * 否则用户看到"人物少了几个"却不知道为什么。
   * 这里刻意不用 Promise.all 的"全成功才算成功"语义。
   */
  const concurrency = Math.max(1, Math.min(Number(cfg.concurrency) || DEFAULT_VISION_CONCURRENCY, batches.length));
  const results = new Array(batches.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= batches.length) return;
      const b = batches[i];
      try {
        results[i] = await extractOneBatch(llm, b.images, {
          hint, offset: b.offset, batchNo: i + 1, batchTotal: batches.length, sliceOf: b.sliceOf,
        });
        const got = results[i].profiles.length;
        send('progress', {
          step: 'Vision',
          msg: batches.length > 1
            ? `第 ${i + 1}/${batches.length} 批完成：${b.images.length} 张图 → ${got} 条档案`
            : `视觉抽取：${got} 条人物档案`,
          ts: Date.now(),
        });
        // 合并掉重复时说一声，否则用户不知道档案数为何比图段数少
        if (results[i].dedupNote) {
          send('progress', { step: 'Vision', msg: `  · ${results[i].dedupNote}`, ts: Date.now() });
        }
      } catch (e) {
        /**
         * 批次级再试一次。
         *
         * `llm.chat` 内部已经有 3 次重试（1s/2s/3s 退避），但那是**同一次调用**内；
         * 实测遇到过整轮视觉抽取因为上游瞬时故障 4 批全失败 ——
         * 每批内部都重试完了，仍然全挂。这里在批与批之间再给一次机会，
         * 成本是多一次请求，收益是长漫画（10 批）不至于整轮报废。
         */
        let lastErr = e;
        for (let attempt = 2; attempt <= BATCH_ATTEMPTS; attempt++) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
          try {
            results[i] = await extractOneBatch(llm, b.images, {
              hint, offset: b.offset, batchNo: i + 1, batchTotal: batches.length, sliceOf: b.sliceOf,
            });
            lastErr = null;
            send('progress', {
              step: 'Vision',
              msg: `第 ${i + 1}/${batches.length} 批第 ${attempt} 次尝试成功：${b.images.length} 张图 → ${results[i].profiles.length} 条档案`,
              ts: Date.now(),
            });
            break;
          } catch (e2) { lastErr = e2; }
        }
        if (lastErr) {
          results[i] = {
            error: lastErr.message, profiles: [], raw: '',
            parseError: lastErr.message, sawImage: null,
          };
          send('progress', {
            step: 'WARN',
            msg: `第 ${i + 1}/${batches.length} 批（图 ${b.offset + 1}-${b.offset + b.images.length}）`
              + `重试 ${BATCH_ATTEMPTS} 次仍失败：${lastErr.message}`,
            ts: Date.now(),
          });
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const failed = results.filter(r => r?.error).length;
  const okBatches = results.filter(r => r && !r.error);

  /**
   * 「批次成功但一条档案都没抽到」也要报出来。
   *
   * 踩过的坑：20 张图跑出 18 条人物，第 4 批（2 张）**没有报错**、返回了 0 条档案，
   * 于是那 2 张图的内容静默消失 —— 用户只会觉得"怎么少了几个人"。
   * 它不是"失败"（请求是成功的），所以不能靠 failed 分支发现。
   */
  const emptyBatches = okBatches.filter(r => (r.profiles || []).length === 0).length;

  // 跨批去重 + 按来源图排序（可测的纯函数，见 mergeBatchProfiles）
  const profiles = mergeBatchProfiles(okBatches.map(r => r.profiles));

  /**
   * `sawImage` 汇总：只有**所有**批都明确说看到了才算 true；
   * 任一批说 false → 整体 false（说明至少有一部分图没被读到）；
   * 有任何一批没给、或某批失败 → null（交给内容判据兜底）。
   */
  let sawImage;
  if (okBatches.length && okBatches.every(r => r.sawImage === true)) sawImage = true;
  else if (results.some(r => r?.sawImage === false)) sawImage = false;
  else sawImage = null;

  const raw = okBatches.map(r => r.raw).join('\n\n');
  const parseError = results.find(r => r?.error)?.error || null;

  const quality = assessVisionQuality(profiles, { sawImage });
  if (sawImage === false) {
    const why = results.find(r => r?.reason)?.reason;
    quality.detail += why ? `；模型给的原因：${String(why).slice(0, 120)}` : '';
  }
  // 有批次失败时必须让用户知道结果不完整
  if (failed) {
    quality.detail += `${quality.detail ? '；' : ''}有 ${failed}/${batches.length} 批失败，`
      + `人物档案**不完整**（${profiles.length} 条来自成功的 ${okBatches.length} 批）`;
    quality.partial = true;
  }
  // 批次成功但没抽到档案 —— 同样是"结果不完整"，只是原因不同
  if (emptyBatches) {
    quality.detail += `${quality.detail ? '；' : ''}有 ${emptyBatches}/${batches.length} 批`
      + `**没有抽出任何人物档案**（那几页图等于没被利用，可单独重试或换更强的视觉模型）`;
    quality.partial = true;
    send('progress', {
      step: 'WARN',
      msg: `有 ${emptyBatches}/${batches.length} 批没有抽出人物档案 —— 那几页图未被利用`,
      ts: Date.now(),
    });
  }

  send('progress', {
    step: 'Vision',
    msg: failed || emptyBatches
      ? `视觉抽取部分完成：${profiles.length} 条档案`
        + `（${[failed ? `${failed} 批失败` : '', emptyBatches ? `${emptyBatches} 批未抽出人物` : '']
          .filter(Boolean).join('、')}）`
      : quality.usable
        ? `视觉抽取：${profiles.length} 条人物档案`
        : `视觉抽取结果不可用：${quality.detail}`,
    ts: Date.now(),
  });
  // 切片是中间产物，任务结束就清掉 —— 否则每次生成都在产物目录里堆一堆图
  if (visionMap) {
    await rm(sliceDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    profiles, raw, usage: llm.usage, images: valid.images,
    parseError, quality, sawImage,
    batches: batches.length, failedBatches: failed, emptyBatches,
    /** 切片信息（无切片时为 null），便于事后核对"长图有没有被切开" */
    slicing: visionMap ? { original: total, files: totalFiles, slices: batches.length } : null,
  };
}

/**
 * 由人物档案渲染 `content_yaml`。
 *
 * 与小说路径的差异必须诚实标注 —— 图片能给的是**外貌、服饰、气质**，
 * 给不了姓名、经历、人际关系。凡是推断出来的都写「（据画面推断）」，
 * 凡是画面上看不到的直接写「图片未提供」，**绝不编造**。
 *
 * 这一点很重要：小说路径的档案有原文可依，图片路径没有。
 * 如果这里悄悄编出"她出身名门、父母双亡"，用户会以为那是从图里读出来的。
 */
export function renderContentYaml(profile, { protagonistName = '' } = {}) {
  const p = profile || {};
  const or = (v, fallback = '图片未提供') => (String(v || '').trim() || fallback);
  const infer = (v) => (String(v || '').trim() ? `${v}（据画面推断）` : '图片未提供（可后续补充）');
  const lines = [];
  lines.push(`name: ${or(p.name)}`);
  lines.push(`title: ${infer(p.inferredIdentity)}`);
  lines.push(`age: ${infer(p.ageRange)}`);
  lines.push('height: 图片未提供');
  lines.push('weight: 图片未提供');
  lines.push('measurements: 图片未提供');
  lines.push('appearance: |');
  for (const l of [
    or(p.appearance, '图片未提供'),
    p.build ? `体型：${p.build}` : '',
    p.palette?.length ? `主色调：${p.palette.join('、')}` : '',
    p.confidence === 'low' ? '（视觉信息有限，置信度低）' : '',
  ].filter(Boolean)) lines.push(`  ${l}`);
  lines.push('clothing: |');
  for (const l of [
    or(p.clothing, '图片未提供'),
    p.accessories?.length ? `配饰：${p.accessories.join('、')}` : '',
  ].filter(Boolean)) lines.push(`  ${l}`);
  lines.push('background: |');
  lines.push(`  ${infer(p.inferredIdentity)}`);
  if (p.scene) lines.push(`  所处场景：${p.scene}`);
  lines.push('personality: |');
  if (p.personalityHints?.length) {
    lines.push(`  从姿态、表情与着装推断：${p.personalityHints.join('；')}（据画面推断）`);
  } else {
    lines.push('  图片未提供（外貌无法可靠推断性格，需用户补充）');
  }
  lines.push('preferences: 图片未提供');
  lines.push('erotic_abilities: 图片未提供');
  lines.push('special_notes: |');
  lines.push(`  ${p.inferredAbilities ? `能力/身份线索：${infer(p.inferredAbilities)}` : '能力：图片未提供'}`);
  lines.push(`  ${p.inferredRelations ? `关系线索：${infer(p.inferredRelations)}` : '人际关系：图片未提供'}`);
  if (p.worldHints?.length) lines.push(`  世界设定线索：${p.worldHints.join('、')}（据画面推断）`);
  if (p.notes) lines.push(`  备注：${p.notes}`);
  lines.push('私处细节描写: 图片未提供');
  lines.push('言行举止: 图片未提供（可后续补充）');
  return lines.join('\n');
}

/**
 * 判断场景描述是不是**指回上一张图**，而不是一个新地点。
 *
 * 实测：模型会写「与上一张为同一处夜晚街景：高架混凝土巨构横跨头顶…」——
 * 那是在说"这和上一张是同一个地方"，不是新场景。
 * 若照单收下，世界书里会多出一条名为「与上一张为同一处夜间城市街道」的条目，
 * 触发词也是那句话 —— 明显是噪音。
 */
const SAME_AS_PREVIOUS = /^(与|和)?(上|前)[一]?[张景图]|同上|同一处|此处与|与前图|同一个地方|同一地点/;

/**
 * 从一段场景描述里取出**短地点名**。
 *
 * ⚠️ 踩过的坑：原来直接把 `profile.scene` 当条目名，而视觉模型给的 scene
 * 是一整段描写（「夜间城市街道，正中央是一条宽阔的沥青马路，路面湿润反光，
 * 横贯一条醒目的黄色斑马线…」100+ 字）—— 于是世界书条目的名字变成一整段话，
 * 触发词也变成那句话。条目名必须是短标签。
 *
 * 做法：取第一个子句，再按长度收口。取不到就返回空（调用方跳过该条）。
 */
export function shortPlaceName(scene) {
  const s = String(scene || '').trim();
  if (!s) return '';
  // 指回上一张图的描述不是新地点，直接返回空让调用方跳过
  if (SAME_AS_PREVIOUS.test(s)) return '';
  // 第一个子句（，。；、 断句）
  let head = s.split(/[，。；、\n]/)[0].trim();
  // 去掉常见的场景限定前缀，让名字更像地名
  head = head.replace(/^(夜间|白天|清晨|黄昏|傍晚|室内|室外|近景|远景|夜晚的|深夜的)+/, '').trim();
  if (head.length < 2) head = s.slice(0, 12).trim();
  // 条目名限长：超过 14 字就截断（宁可短，也不要一句话当名字）
  head = head.length > 14 ? head.slice(0, 14) : head;
  // 收口后仍然指向上一张图 → 也不是新地点
  return SAME_AS_PREVIOUS.test(head) ? '' : head;
}

/**
 * 由人物档案渲染世界观条目（可选）。
 *
 * 图片来源的世界观只能从**画面线索**推，可靠性远低于小说路径，
 * 所以这里：① 条目少而保守；② 每条都标明依据；③ 只做 map_world 一条 +
 * 明确出现的场景做 map_location，不硬凑体系和势力。
 *
 * 但**截图里的文字是实打实的信息**（帖文、聊天记录、旁白），
 * 所以额外单独出一条 `transcript` —— 它常常是整张卡里信息密度最高的部分：
 * 姓名、身份、关系、发生了什么都在里面。之前这些内容被完全丢掉了。
 */
export function renderWorldbookFromProfiles(profiles = [], { title = '' } = {}) {
  const items = [];
  // 场景：取短地名做条目名，完整描写放正文
  const sceneFull = new Map();
  for (const p of profiles) {
    const raw = String(p.scene || '').trim();
    if (!raw) continue;
    const short = shortPlaceName(raw);
    if (!short) continue;
    if (!sceneFull.has(short)) sceneFull.set(short, raw);
  }
  const hints = [...new Set(profiles.flatMap(p => p.worldHints || []))];
  const paletteNote = [...new Set(profiles.flatMap(p => p.palette || []))];

  /**
   * 汇总截图文字。
   *
   * 去重的判据是"归一化后相同"：同一张长截图的不同段常被模型转录出
   * 高度重叠的文本，直接拼起来会变成一份复读的文档。
   */
  const seenTranscript = new Set();
  const transcriptParts = [];
  for (const p of profiles) {
    const t = String(p.transcript || '').trim();
    if (!t || t === '画面无文字') continue;
    const key = t.replace(/\s+/g, '').slice(0, 120);
    if (seenTranscript.has(key)) continue;
    seenTranscript.add(key);
    transcriptParts.push(t);
  }

  const worldBody = [
    `本条目由**图片**推断，不是从文字设定读取的，可靠性低于小说路径。`,
    sceneFull.size
      ? `画面中出现的场景：${[...sceneFull.values()].join('；')}`
      : '画面中没有可辨识的具体场景。',
    hints.length ? `画面线索指向的设定：${hints.join('、')}。` : '',
    paletteNote.length ? `整体色调：${paletteNote.join('、')}。` : '',
    `据此可判断作品的整体氛围取向；具体地理、势力与历史需要用户补充。`,
  ].filter(Boolean).join('\n');
  items.push({
    category: 'map_world',
    name: title || '世界概览（据图片推断）',
    keys: [...new Set([title, ...hints].filter(Boolean))].slice(0, 5),
    content: worldBody,
  });

  for (const [short, full] of [...sceneFull.entries()].slice(0, 4)) {
    items.push({
      category: 'map_location',
      name: short,
      keys: [short].slice(0, 3),
      content: `${full}\n\n依据：图片视觉线索（非文字设定）。\n具体位置、归属势力与历史需用户补充。`,
    });
  }

  // 截图文字单独成条：这是唯一"来自文字而非推断"的内容，价值最高
  if (transcriptParts.length) {
    const body = [
      '以下文字**转录自图片画面**（帖文 / 聊天记录 / 旁白等），属于可靠信息，',
      '不是推断。涉及的人名、称呼、身份、关系、事件都应以此为准。',
      '',
      ...transcriptParts.map((t, i) => `【第 ${i + 1} 段】\n${t}`),
    ].join('\n');
    items.push({
      category: 'system_item',
      name: '图中文字（转录）',
      keys: ['帖文', '聊天记录', '对话', '原文'],
      content: body,
    });
  }

  return items;
}

/**
 * 装配段：由抽取结果生成完整的卡（变量树 + 状态栏 + 正则 + 世界书 + 完整卡）。
 *
 * **不调用模型** —— 状态栏与组装都是纯函数，所以这一整段可以用注入的
 * 抽取结果独立测试，不需要真视觉模型。
 *
 * @param {object} cfg
 * @param {Array} cfg.profiles 归一化后的人物档案
 * @param {string} [cfg.title]
 * @param {object} [cfg.userMode] { mode, protagonistName }
 * @param {boolean} [cfg.wantWorldbook]
 * @returns {Promise<object>}
 */
export async function buildCardFromExtraction(cfg = {}) {
  const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [];
  const title = String(cfg.title || '图片生成的角色卡').trim();
  const protagonistName = String(cfg.userMode?.protagonistName || profiles[0]?.name || '').trim();

  // ---------- 1. 人物条目：图片路径只产出「主角 + 其他角色」两层 ----------
  // 不套用小说路径的剧情占比分层 —— 图片没有"出场章节"这个概念，
  // 硬套会得到一堆"100%"的无意义分层。
  const characters = profiles.map((p, i) => ({
    name: p.name,
    tier: i === 0 || p.name === protagonistName ? '主角' : '主要NPC',
    role: i === 0 ? '主角' : '主要NPC',
    content_yaml: renderContentYaml(p, { protagonistName }),
    aliases: p.aliases || [],
    imageIndex: p.imageIndex,
    confidence: p.confidence,
  }));

  // ---------- 2. 事件：图片不给剧情，所以只造一个「开场」占位 ----------
  /**
   * 为什么必须造这个事件：`buildVariables` 在事件为空时会兜底一个「开场」，
   * 但那个兜底的语义是"小说没有事件"；这里的情况不同 —— 图片路径**本来就没有剧情**。
   * 明确地造一个"与这些角色相遇"的开场，让导演指令与状态栏有落点，
   * 而不是让 AI 在空事件表上猜。
   */
  const firstChar = characters[0]?.name || '角色';
  const openerName = `与${firstChar}相遇`;
  const events = [{
    name: openerName,
    pressure: 'core',
    chapter: '图片设定',
    time: '',
    storyline: '开场',
    // 在场角色 = 图片里识别出的所有人（用户以 {{user}} 身份进入，不列进来）
    participants: characters.map(c => c.name),
    location: profiles.find(p => p.scene)?.scene || '',
  }];
  const storylines = { 开场: { events: [openerName], core: true, line: '开场' } };
  const timeline = {
    base: '相对纪元',
    origin: { raw: '图片设定', event: openerName, reason: '图片来源没有时间信息，以开场为原点' },
    events: events.map(e => ({
      name: e.name, time: e.time, chapter: e.chapter,
      pressure: e.pressure, dateKey: null,
    })),
    characters: [],
    worldDate: null,
    history: [],
    relativeStats: { relative: 0, vague: 0, periodic: 0 },
    fromEvents: true,
  };
  const phasesWithDeltas = [{
    name: '开场',
    startEvent: openerName,
    endEvent: openerName,
    text: '图片生成的开场：用户与这些角色初次相遇。',
    characterDeltas: [],
  }];

  // ---------- 3. 变量树 ----------
  /**
   * ⚠️ 用户模式固定为 `participant`（用户是外来者），而不是 `protagonist`。
   *
   * 踩过的坑：一开始按小说路径默认 `protagonist`，于是 `initializeUserNamespace`
   * 把第一张图的角色从 `characters` **移进了 `user`** ——
   * 而图片路径里"第一张图的角色"其实就是**图里的人物**，不是用户化身。
   * 结果：这个角色的档案只能通过 `user.name` 看到一句名字，外貌/服饰被埋掉，
   * 状态栏的「角色档案」页也会少一个。
   *
   * 图片路径的用户是**看着这些图的人**，所以 `participant` 才是对的语义：
   * 所有图片角色都留在 characters 里，用户以 `{{user}}` 身份进入场景。
   */
  const userMode = {
    mode: 'participant',
    protagonistName: '',
  };
  const variables = buildVariables(timeline, events, storylines, characters, phasesWithDeltas);
  initializeUserNamespace(variables, userMode);

  // ---------- 4. 世界观（默认开，可从图片线索推） ----------
  const worldbookItems = cfg.wantWorldbook === false
    ? []
    : renderWorldbookFromProfiles(profiles, { title });
  const worldbook = assembleWorldbook(timeline, events, characters, worldbookItems, {
    title,
    protagonist: protagonistName,
    storylines,
  });

  // ---------- 5. 状态栏 + 正则体系 ----------
  // 主题挑选靠 genreHint（纯字符串匹配）。
  // 图片路径没有 tags，但世界线索与场景名就是最好的题材信号。
  const genreHint = [
    ...profiles.flatMap(p => p.worldHints || []),
    ...profiles.map(p => p.scene || ''),
    title,
  ].filter(Boolean).join(' ');
  const statusbar = await generateStatusbar({
    variables,
    genre: genreHint,
    worldName: title,
    characterName: protagonistName,
  });

  // ---------- 6. 完整卡字段 ----------
  const tags = [...new Set([
    ...profiles.flatMap(p => p.worldHints || []),
    ...profiles.map(p => p.gender).filter(Boolean),
  ])].slice(0, 6);
  const cardFields = {
    name: title,
    /**
     * description：把每个人的**可用信息**写在一起。
     *
     * 踩过的坑：原来是 `外貌.slice(0,60)`，于是 description 成了
     * 「图片未提供；该角色在 6 张截图里没有以任何形式出现：没有头像…」——
     * 全是"看不见什么"，用户看了不知道这张卡里到底有谁。
     * 现在按"身份 → 外貌 → 关系"取信息量最大的那个，并且**优先用文字里的信息**。
     */
    description: profiles.map(buildProfileSummary).filter(Boolean).join('\n') || '待补充',
    personality: profiles
      .map(p => {
        const hints = (p.personalityHints || []).join('、');
        return hints ? `${p.name}：${hints}` : '';
      }).filter(Boolean).join('\n') || '待补充',
    /**
     * scenario：优先用**文字里明确说的情境**（帖文/聊天记录里的地点与关系），
     * 其次是画面场景描述。都不行才留待补充。
     */
    scenario: buildScenario(profiles) || '由图片生成，场景与剧情待用户补充',
    first_mes: buildFirstMes(characters, profiles),
    tags,
  };

  // ---------- 7. 组装完整卡 ----------
  const card = assembleCharacterCard({
    timeline, events, characters, worldbook: worldbookItems,
    variables, phasesWithDeltas, userMode, cardFields,
    worldbookName: worldbook.name,
    statusbar,
    storylines,
    synopsis: '',
  });

  return {
    card,
    // ⚠️ 这里返回的是**传入的世界观条目原文**（图片推断出来的那几条），
    // 不是 `assembleWorldbook` 组装的全部条目 —— 后者还含 timeline / 人物 / 事件等。
    // 一开始我误取了 `.entries`，于是条目里 `content` 是 undefined（实测踩过）。
    worldbook: worldbookItems,
    // 组装后的完整条目（世界概览 + 人物 + 事件 + 时间线…），排查与落盘都用它
    assembledEntries: worldbook.entries,
    worldbookName: worldbook.name,
    variables, statusbar, characters, events, timeline, phases: phasesWithDeltas,
    cardFields, genreHint,
  };
}

/**
 * 一条人物档案的**可用摘要**（给 description 用）。
 *
 * 顺序刻意是"身份 → 关系 → 外貌"：用户看卡时最想知道的是**这人是谁**，
 * 外貌反而是细节。而身份/关系常常来自截图文字（如果有），比画面推断可靠。
 * 全都拿不到时才如实说明"图片未提供"，但不会拿这句话当摘要主体。
 */
function buildProfileSummary(p) {
  const pick = (s) => String(s || '').trim();
  const firstSentence = (s, max = 90) => {
    const t = pick(s).replace(/\s+/g, ' ');
    if (!t) return '';
    const cut = t.split(/[。；;\n]/).find(x => x.trim().length > 3) || t;
    return cut.length > max ? cut.slice(0, max) + '…' : cut;
  };
  // 「图片未提供」这类否定句不算信息
  const useful = (s) => {
    const t = pick(s);
    return t && !/^(图片未提供|未提供|图片未给出|无法辨认|不可辨|未见)/.test(t);
  };

  const parts = [];
  const identity = useful(p.inferredIdentity) ? firstSentence(p.inferredIdentity, 70) : '';
  const relation = useful(p.inferredRelations) ? firstSentence(p.inferredRelations, 70) : '';
  const appear = useful(p.appearance) ? firstSentence(p.appearance, 90) : '';
  const names = (p.namesFromText || []).filter(Boolean);

  if (identity) parts.push(identity);
  if (relation && relation !== identity) parts.push(relation);
  if (appear) parts.push(appear);

  const head = `【${p.name}】`
    + (names.length ? `（文字中的称呼：${names.slice(0, 3).join('、')}）` : '');
  if (!parts.length) {
    return `${head}\n  画面与文字都没有提供可用的人物信息（需要你自己补设定）。`;
  }
  return `${head}\n  ${parts.join(' ｜ ')}`;
}

/**
 * 场景 / 情境。
 *
 * 优先文字：截图里往往直接写着地点与关系（"住同一寝室""导员""开学不久"），
 * 这比"画面是深色模式的手机界面"有用得多 —— 后者描述的是**截图本身**，
 * 不是故事的场景。踩过的坑：scenario 原来就是一堆"这是一张手机截图"。
 */
function buildScenario(profiles = []) {
  const scenes = [...new Set(profiles.map(p => String(p.scene || '').trim()).filter(Boolean))];
  const relations = [...new Set(profiles
    .map(p => String(p.inferredRelations || '').trim())
    .filter(s => s && !/未提供|无法|不可辨/.test(s)))];
  const identities = [...new Set(profiles
    .map(p => String(p.inferredIdentity || '').trim())
    .filter(s => s && !/未提供|无法|不可辨/.test(s)))];

  const lines = [];
  if (relations.length) lines.push(`人物关系：${relations.slice(0, 4).join('；')}`);
  if (identities.length) lines.push(`身份线索：${identities.slice(0, 4).join('；')}`);
  if (scenes.length) lines.push(`画面场景：${scenes.slice(0, 3).join('；')}`);
  if (!lines.length) return '';
  // 提醒这是图片路径的固有限制，用户知道该补什么
  lines.push('（图片路径没有剧情文本，具体时间线与事件需要你补充。）');
  return lines.join('\n');
}

/**
 * 开场白：图片路径没有剧情可讲，所以开场白**引导用户自己开场**，
 * 而不是编一段假剧情（那会让用户以为卡里有剧情）。
 */
function buildFirstMes(characters = [], profiles = []) {
  const names = characters.map(c => c.name).filter(Boolean);
  const scene = profiles.find(p => p.scene)?.scene;
  const lines = [];
  lines.push('<!-- 本卡由图片生成：外貌与服饰来自图片，剧情与关系需要你补充 -->');
  lines.push('');
  // 文字里明确提到的情境比画面描述更接近"故事场景"，优先给用户看
  const scenario = buildScenario(profiles);
  lines.push(scenario ? scenario.split('\n')[0] : (scene ? `场景：${scene}` : '场景：（请补充）'));
  lines.push('');
  lines.push(`在场角色：${names.join('、') || '（未识别出角色）'}`);
  lines.push('');
  lines.push('（把上面这两行改成你要的开场情境，或直接开始叙述。）');
  return lines.join('\n');
}

/**
 * 产物落盘。目录结构与小说路径一致，所以「任务与产物」页与下载逻辑都能直接复用。
 */
export async function writeImageCardOutputs(outDir, result, extra = {}) {
  await mkdir(outDir, { recursive: true });
  const j = (o) => JSON.stringify(o, null, 2);
  const written = [];

  const put = async (name, content) => {
    await writeFile(path.join(outDir, name), content, 'utf-8');
    written.push(name);
  };

  await put('character_card.json', j(result.card));
  await put('characters.json', j(result.characters));
  await put('variables.json', j(result.variables));
  await put('worldbook.json', j({ entries: result.worldbook }));
  await put('statusbar.json', j(result.statusbar.statusbar));
  await put('regex_scripts.json', j(result.statusbar.regexScripts));
  await put('statusbar_preview.html', makeStatusbarPreview(result.statusbar));
  if (extra.vision) await put('vision.json', j(extra.vision));
  if (extra.meta) await put('meta.json', j(extra.meta));

  /**
   * 变更总结：与「小说生成」「完善角色卡」两条路径**共用同一个渲染器**，
   * 所以三种任务的总结长得一样、字段一样，前端只需要一套展示代码。
   */
  {
    const s = summarizeGenerate(
      { title: extra.meta?.title || '图片生成的角色卡', model: extra.meta?.model || '' },
      {
        characters: result.characters.length,
        events: result.events.length,
        worldbookEntries: result.worldbook.length,
        phases: result.phases.length,
        kit: {
          entries: result.card?.data?.character_book?.entries?.length || 0,
          regex: result.card?.data?.extensions?.regex_scripts?.length || 0,
          cardBytes: Buffer.byteLength(JSON.stringify(result.card, null, 2), 'utf8'),
        },
      },
    );
    // 图片路径的来源说明与文字路径不同，补上
    s.source = `由 ${extra.imagePaths?.length ?? 0} 张图片生成`;
    s.notes = [
      '外貌与服饰来自图片视觉分析；姓名、身份、经历是推断或占位（正文已标注）',
      '图片无法提供剧情，事件表只有一条「开场」，需要在使用中自己推进',
      ...(s.notes || []),
    ];
    await put('summary.json', j(s));
    await put('SUMMARY.md', renderSummaryMarkdown(s));
  }

  // 头像：第一张图复制成 avatar.*（与小说路径同一套命名，卡导入后能直接显示）
  if (extra.imagePaths?.[0]) {
    const ext = path.extname(extra.imagePaths[0]).toLowerCase();
    const target = `avatar${ALLOWED_EXT.has(ext) ? ext : '.png'}`;
    await copyFile(extra.imagePaths[0], path.join(outDir, target));
    written.push(target);
  }

  await put('README.md', buildReadme(result, extra));
  return written;
}

function buildReadme(result, extra = {}) {
  const lines = [];
  const verified = extra.meta?.visionVerified;
  lines.push('# 图片生成的角色卡');
  lines.push('');
  lines.push(`- 图片数量：${extra.imagePaths?.length ?? 0}`);
  lines.push(`- 识别角色：${result.characters.length} 人（${result.characters.map(c => c.name).join('、')}）`);
  lines.push(`- 世界书条目：${result.worldbook.length} 条`);
  lines.push(`- 状态栏主题：${result.statusbar.statusbar.theme}`);
  lines.push('');
  lines.push('## 重要说明');
  lines.push('');
  if (verified === false) {
    lines.push('> ⚠️ **图片可见性未经验证**：模型没有回答"是否看到图片"（sawImage 字段缺失）。');
    lines.push('> 本卡的外貌描述来自模型的回答，但无法确认它真的看到了你的图片。');
    lines.push('> 请自行核对内容是否与图片相符；若明显不符，请换用支持视觉的模型重试。');
    lines.push('');
  }
  lines.push('本卡的外貌、服饰、气质来自**图片视觉分析**；');
  lines.push('姓名、身份、经历、关系是**推断或占位**，正文里都标注了「（据画面推断）」或「图片未提供」。');
  lines.push('图片无法提供剧情，所以事件表只有一条「开场」，需要你在使用中自己推进。');
  lines.push('');
  lines.push('## 文件');
  lines.push('- `character_card.json` — 完整角色卡，直接导入 SillyTavern');
  lines.push('- `worldbook.json` — 世界书条目（A 包）');
  lines.push('- `characters.json` — 人物档案原文');
  lines.push('- `statusbar_preview.html` — 状态栏预览，浏览器直接打开');
  if (extra.vision?.raw) lines.push('- `vision.json` — 视觉模型的原始返回（排查用）');
  return lines.join('\n');
}

/** 汇总卡片统计，供 meta.json 与日志使用 */
export function summarizeCard(result) {
  const entries = result.card?.data?.character_book?.entries || [];
  const cardBytes = Buffer.byteLength(JSON.stringify(result.card, null, 2), 'utf8');
  const thin = result.characters.filter(c => inspectContentYaml(c.content_yaml).chars < 300);
  const placeholder = result.characters.filter(c => isPlaceholderBody(c.content_yaml));
  return {
    entries: entries.length,
    cardBytes,
    regexCount: result.card?.data?.extensions?.regex_scripts?.length || 0,
    characters: result.characters.length,
    worldbook: result.worldbook.length,
    thinProfiles: thin.map(c => c.name),
    placeholderProfiles: placeholder.map(c => c.name),
  };
}
