/**
 * 超长图片切片。
 *
 * 要解决的问题（实测）：
 *   用户上传 `720x6269` 的手机长截图（宽高比 1:8.7），视觉模型**只读到了
 *   帖子的小头像，正文一个字没读到** —— 因为整图被按比例缩到模型的视觉
 *   尺寸上限，字号被压得无法辨认。
 *
 * 做法：把超长图**按竖直方向切成若干片**，每片保持接近原分辨率，
 * 于是模型看到的是"几张正常比例的图"，而不是"一张被压扁的长条"。
 *
 * 关于视觉 token 的一点事实：OpenAI 兼容的视觉接口会把图缩放到适合模型
 * 的尺寸再计算 token。切片的**总 token 不会比原图少**（片间重叠还会略多），
 * 但**每片的可用分辨率和面积比**都大幅改善 —— 这才是"能不能读到字"的关键。
 * 所以这个功能是拿 token 换可读性，默认只在图片**确实过长**时才启用。
 */
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 默认参数 */
export const SLICE_DEFAULTS = {
  /**
   * 长边/短边 超过这个比例才切。
   * 1:3 的图（1080x3240）还算正常截图，1:8 那种必切。
   */
  maxAspect: 3,
  /**
   * 每片的目标宽高比（高度/宽度）。1.6 接近常见截图一屏的比例，
   * 比这更高就又走向"被压扁"的老路了。
   */
  targetAspect: 1.6,
  /** 相邻片的重叠比例：防止正好切在文字行中间 */
  overlap: 0.08,
  /** 单片高度上限（像素）：超过就再多切几刀 */
  maxSliceHeight: 2600,
  /** 一个文件最多切几片（防止极端长图把请求撑爆） */
  maxSlices: 8,
  /** 输出格式与质量（切片是中间产物，不必无损） */
  quality: 90,
};

/**
 * 加载 sharp。
 *
 * 单独包一层的原因：sharp 是**可选依赖**（带平台二进制），
 * 没装时不能让整个功能炸掉 —— 而是回落到"不切片"并在日志里说明。
 */
let sharpMod = null;
let sharpTried = false;
export function loadSharp() {
  if (sharpTried) return sharpMod;
  sharpTried = true;
  try {
    sharpMod = require('sharp');
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

/** 测试用：注入一个假的 sharp */
export function __setSharpForTest(fake) {
  sharpMod = fake;
  sharpTried = true;
}

/**
 * 计算某张图该切成几片、每片多高。
 *
 * 抽成纯函数（不碰文件系统）是为了可测：切法算错的表现是
 * "图切了但还是读不到字"，很难从日志看出来。
 *
 * @param {{width:number, height:number}} size
 * @param {object} [opts] 见 SLICE_DEFAULTS
 * @returns {{slices:Array<{top:number,height:number}>, reason:string}}
 *          不需要切时 `slices` 为空数组，`reason` 说明原因
 */
export function planSlices(size, opts = {}) {
  const o = { ...SLICE_DEFAULTS, ...opts };
  const width = Math.max(1, Math.floor(Number(size?.width) || 0));
  const height = Math.max(1, Math.floor(Number(size?.height) || 0));
  if (!width || !height) return { slices: [], reason: '尺寸无效' };
  if (width > height * o.maxAspect) return { slices: [], reason: '横向长图，竖切无意义' };

  const aspect = height / width;
  if (aspect <= o.maxAspect) {
    return { slices: [], reason: `宽高比 1:${aspect.toFixed(1)} 未超过 ${o.maxAspect}` };
  }

  // 目标片高：由"目标宽高比"与"单片高度上限"共同决定，取更小的那个
  const byAspect = Math.round(width * o.targetAspect);
  const target = Math.max(1, Math.min(byAspect, o.maxSliceHeight));

  // 重叠：相邻片各多覆盖这么多像素，避免切在文字行中间
  const overlapPx = Math.round(target * o.overlap);
  const step = Math.max(1, target - overlapPx);

  const slices = [];
  let top = 0;
  while (top < height && slices.length < o.maxSlices) {
    // 最后一片尽量吃掉剩余的，避免留一条很窄的尾巴
    const remain = height - top;
    const h = remain <= target + overlapPx ? remain : target;
    slices.push({ top, height: h });
    if (top + h >= height) break;
    top += step;
  }

  // 只剩一片就不用切了（切了也没收益，还多一次请求）
  if (slices.length <= 1) return { slices: [], reason: `宽高比 1:${aspect.toFixed(1)} 无需切` };

  return { slices, reason: `宽高比 1:${aspect.toFixed(1)} → 切 ${slices.length} 片` };
}

/**
 * 按计划切图并写到 `outDir`。
 *
 * @param {string} srcPath 原图
 * @param {string} outDir  切片输出目录（会被创建）
 * @param {object} [opts]  见 SLICE_DEFAULTS，另可传 `namePrefix`
 * @returns {Promise<{sliced:boolean, reason:string, pieces:Array, width:number, height:number}>}
 *   `pieces` 每项 `{path, width, height, top, sliceIndex}`
 */
export async function sliceTallImage(srcPath, outDir, opts = {}) {
  const sharp = loadSharp();
  if (!sharp) {
    return { sliced: false, reason: 'sharp 未安装：跳过切片（长截图里的文字可能读不到）', pieces: [] };
  }

  let meta;
  try {
    meta = await sharp(srcPath).metadata();
  } catch (e) {
    return { sliced: false, reason: `读取图片元信息失败：${e.message}`, pieces: [] };
  }
  const width = Number(meta.width) || 0;
  const height = Number(meta.height) || 0;

  const plan = planSlices({ width, height }, opts);
  if (!plan.slices.length) {
    return { sliced: false, reason: plan.reason, pieces: [], width, height };
  }

  await mkdir(outDir, { recursive: true });
  const prefix = opts.namePrefix || path.basename(srcPath, path.extname(srcPath));
  const pieces = [];
  try {
    for (const [i, s] of plan.slices.entries()) {
      const out = path.join(outDir, `${prefix}_slice${String(i + 1).padStart(2, '0')}.jpg`);
      await sharp(srcPath)
        .extract({ left: 0, top: s.top, width, height: s.height })
        .jpeg({ quality: opts.quality ?? SLICE_DEFAULTS.quality, mozjpeg: true })
        .toFile(out);
      pieces.push({ path: out, width, height: s.height, top: s.top, sliceIndex: i });
    }
  } catch (e) {
    // 切片失败就退回原图 —— 不能因为一个优化手段把整个任务搞挂
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
    return { sliced: false, reason: `切片写入失败：${e.message}`, pieces: [], width, height };
  }

  return { sliced: true, reason: plan.reason, pieces, width, height };
}

/**
 * 批量切片。
 *
 * @param {Array<{index:number,path:string,label:string}>} images
 * @param {string} outDir
 * @param {object} [opts]
 * @returns {Promise<{files:Array, mapping:Array, slicedCount:number, notes:Array<string>}>}
 *   `files`   —— 实际要发给模型的图片路径（顺序 = 发送顺序）
 *   `mapping` —— 与 `files` 等长：每项是该文件对应的**原图下标**
 *   `notes`   —— 给日志的人类可读说明
 */
export async function sliceAllForVision(images, outDir, opts = {}) {
  const files = [];
  const mapping = [];
  const notes = [];
  let slicedCount = 0;

  for (const im of images) {
    const r = await sliceTallImage(im.path, path.join(outDir, im.label), opts);
    if (r.sliced) {
      slicedCount++;
      notes.push(`${im.label} ${r.width}x${r.height} ${r.reason}`);
      for (const p of r.pieces) {
        files.push(p.path);
        mapping.push(im.index);
      }
    } else {
      files.push(im.path);
      mapping.push(im.index);
      // 只把"本来该切但没切"的情况说出来，正常短图不打扰用户
      if (/sharp 未安装|失败/.test(r.reason)) notes.push(`${im.label}：${r.reason}`);
    }
  }

  return { files, mapping, slicedCount, notes };
}
