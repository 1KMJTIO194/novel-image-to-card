#!/usr/bin/env node
/**
 * 命令行：从一个图片目录直接生成角色卡。
 *
 * 用途（用户请求的场景）：
 *   「用这个漫画目录生成一个角色卡看看效果」
 *   —— 不想在网页里一张张选图，也不想把 API Key 贴给别人。
 *
 * 用法：
 *   set N2C_API_KEY=sk-xxxx
 *   set N2C_BASE_URL=https://api.deepseek.com/v1
 *   set N2C_MODEL=deepseek-flash
 *   node scripts/image-card-from-dir.mjs "F:\某漫画\第1话" --title "第1话"
 *
 * 也可以不带 key 跑 `--dry-run`：只检查图片、给出批次与切片计划，不调用模型。
 *
 * 安全：key 只从环境变量读，**不写进任何文件**，也不打印。
 */
import path from 'node:path';
import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  extractCharactersFromImages, buildCardFromExtraction, writeImageCardOutputs, summarizeCard,
  listImagesInDir, MAX_IMAGES, DEFAULT_VISION_BATCH,
} = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);
const { extractCardSummary } = await import(pathToFileURL(path.join(ROOT, 'src/image_summary.js')).href);
const { planSlices, loadSharp } = await import(pathToFileURL(path.join(ROOT, 'src/image_slice.js')).href);

/** 极简参数解析 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dir = args._[0];
if (!dir) {
  console.error('用法: node scripts/image-card-from-dir.mjs <图片目录> [--title 名称] [--hint 补充设定] [--batch 6] [--dry-run]');
  process.exit(2);
}

const absDir = path.resolve(dir);
/**
 * 扫目录用和网页版**同一个函数**（`listImagesInDir`）——
 * 排序规则、扩展名白名单、数量上限三处逻辑只写一份，
 * 否则"网页认 60 张、命令行认 40 张"这类偏差迟早出现。
 */
const listed = await listImagesInDir(absDir);
if (!listed.ok) {
  console.error(listed.errors.join('；'));
  process.exit(2);
}
for (const w of listed.warnings) console.warn('⚠ ' + w);
const images = listed.images;

const title = String(args.title || path.basename(absDir)).trim();
const hint = String(args.hint || '').trim();
const batchSize = Number(args.batch) || DEFAULT_VISION_BATCH;
const dryRun = !!args['dry-run'];
/** 生成档位：默认基础版；--full 更细但更耗 token */
const detailLevel = args.full ? 'full' : 'basic';
/**
 * 角色卡版本：默认普通版（不含成人内容）；--adult 生成完整成人版。
 * 默认必须是普通版 —— 不能让用户不知情就产出成人内容。
 */
const contentMode = args.adult ? 'adult' : 'general';

console.log(`目录: ${absDir}`);
console.log(`图片: ${images.length} 张（前 3 张：${images.slice(0, 3).map(p => path.basename(p)).join(', ')}）`);
console.log(`档位: ${detailLevel === 'full' ? '完整版（更细，token 更高）' : '基础版'}`);
console.log(`版本: ${contentMode === 'adult' ? '成人版（完整包含成人内容；出场角色须成年）' : '普通版（不含成人内容）'}`);
console.log(`标题: ${title}`);

// ---- dry-run：只报告批数与切片计划 ----
if (dryRun) {
  const sharp = loadSharp();
  console.log(`\n[DRY RUN] 不调用模型。`);
  console.log(`sharp 可用: ${!!sharp}（不可用则不做长图切片）`);
  const batches = Math.ceil(images.length / batchSize);
  console.log(`视觉批次: ${batches} 批（每批 ${batchSize} 张）`);
  if (sharp) {
    let needSlice = 0;
    for (const [i, p] of images.entries()) {
      try {
        const meta = await sharp(p).metadata();
        const plan = planSlices({ width: meta.width, height: meta.height });
        if (plan.slices.length) {
          needSlice++;
          console.log(`  图${i + 1} ${meta.width}x${meta.height} → ${plan.slices.length} 片（${plan.reason}）`);
        }
      } catch { /* 忽略坏图 */ }
    }
    console.log(`需要切片的图: ${needSlice} 张`);
  }
  for (const p of images) {
    const s = await stat(p);
    if (s.size > 8 * 1024 * 1024) console.log(`  ⚠ ${path.basename(p)} 体积 ${(s.size / 1024 / 1024).toFixed(1)}MB 超过 8MB 上限`);
  }
  process.exit(0);
}

// ---- 真实生成 ----
const baseUrl = String(process.env.N2C_BASE_URL || '').replace(/\/+$/, '');
const apiKey = String(process.env.N2C_API_KEY || '');
const model = String(process.env.N2C_MODEL || '');
if (!baseUrl || !model) {
  console.error('缺少配置：请设置环境变量 N2C_BASE_URL / N2C_MODEL（本地模型可不设 N2C_API_KEY）');
  process.exit(2);
}
if (!apiKey && !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl)) {
  console.error('缺少 N2C_API_KEY（远程接口需要）');
  process.exit(2);
}

const taskId = `task_${Date.now()}`;
const outBase = process.env.N2C_OUT_DIR
  ? path.resolve(process.env.N2C_OUT_DIR)
  : path.join(ROOT, 'output');
const outDir = path.join(outBase, taskId);
await mkdir(outDir, { recursive: true });

const t0 = Date.now();
const onProgress = (ev) => {
  const msg = ev?.msg || ev?.data?.msg;
  if (msg) console.log(`  [${ev?.step || ev?.data?.step || '-'}] ${msg}`);
};

console.log('\n=== 1/3 视觉抽取 ===');
const vision = await extractCharactersFromImages({
  imagePaths: images,
  hint,
  baseUrl, apiKey, model,
  batchSize,
  send: onProgress,
});
if (!vision.quality?.usable) {
  console.error(`\n视觉抽取不可用：${vision.quality?.detail || '未识别出角色'}`);
  console.error('请确认模型支持图片理解（如 deepseek-flash、gpt-4o、gemini、qwen-vl）。');
  process.exit(1);
}

console.log('\n=== 2/3 总结信息成设定 ===');
let summary = null;
let llm = null;
try {
  const { makeLLM } = await import(pathToFileURL(path.join(ROOT, 'src/llm.js')).href);
  llm = makeLLM({ baseUrl, apiKey, model }, null);
  summary = await extractCardSummary({ llm, profiles: vision.profiles, hint: hint || undefined, detailLevel, contentMode, send: onProgress });
} catch (e) {
  console.warn(`  总结失败（会回退到画面事实）：${e.message}`);
}
console.log(summary
  ? `  人物 ${summary.characters.length} · 地点 ${summary.world.locations.length} · 势力 ${summary.world.factions.length}`
  : '  没有总结出设定，按画面事实生成');

/**
 * 主要角色外观精修（第三个入口也必须接，否则同一个功能在各入口行为不一致
 * —— 上一轮"叙事抽取只接了 Web 版"就是这么漏的）。
 */
if (summary && llm && !args['no-refine']) {
  try {
    const { refineMainAppearance } = await import(pathToFileURL(path.join(ROOT, 'src/image_detail.js')).href);
    const r = await refineMainAppearance({
      llm,
      summary,
      images: images.map((p, i) => ({ index: i, path: p })),
      profiles: vision.profiles,
      detailLevel,
      contentMode,
      ...(args['detail-max'] === undefined ? {} : { max: Math.max(0, Math.min(8, Number(args['detail-max']) || 0)) }),
      send: onProgress,
    });
    console.log(r.refined.length
      ? `  主要角色外观精修：${r.refined.map(x => `${x.name}(${x.appearanceLen}字)`).join('、')}`
      : `  主要角色外观精修：无（跳过 ${r.skipped.length}）`);
  } catch (e) {
    console.warn(`  外观精修失败（保留原描述）：${e.message}`);
  }
}

console.log('\n=== 3/3 装配 + 落盘 ===');
const result = await buildCardFromExtraction({ profiles: vision.profiles, title, summary, wantWorldbook: true, contentMode });
const sum = summarizeCard(result);
const written = await writeImageCardOutputs(outDir, result, {
  imagePaths: images,
  vision: { raw: vision.raw, profiles: vision.profiles },
  cardSummary: summary,
  meta: {
    taskId, kind: 'image-card', title,
    createdAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    model, baseUrl,
    imageCount: images.length,
    detailLevel,
    contentMode,
    hint: hint || null,
    counts: {
      images: images.length, characters: sum.characters,
      worldbook: sum.worldbook, entries: sum.entries,
    },
    visionVerified: !!vision.quality?.verified,
    sawImage: vision.sawImage,
    slicing: vision.slicing,
  },
});

console.log(`\n完成：${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`角色 ${sum.characters} 人 / 世界书 ${sum.worldbook} 条 / ${sum.entries} 条条目`);
console.log(`产物目录：${outDir}`);
console.log(`角色卡：${path.join(outDir, 'character_card.json')}`);
if (written?.includes?.('card_summary.json')) console.log(`设定总结：${path.join(outDir, 'card_summary.json')}`);
