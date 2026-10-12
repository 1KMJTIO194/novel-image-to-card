/**
 * 定位仓库的 `src/`（核心流程所在）。
 *
 * 为什么需要这个：插件要复用 `src/pipeline.js` 等核心模块，
 * 但**插件被安装到哪里是不确定的**：
 *   · pnpm 用 `link:` 时 → `node_modules/dsh-plugin-novel2card` 是软链，
 *     真实路径仍在仓库里，`../../src/` 正常
 *   · 若被**复制**进 profile → `../../src/` 会指到不知道哪里去
 *   · 开发时直接在仓库里 → 就是 `dsh/../src`
 *
 * 所以这里按优先级试多个候选路径，找到就用，并把结果缓存下来
 *（`import()` 本身也有模块缓存，但路径探测会做文件存在性检查，缓存一下省事）。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));   // <plugin>/lib

/**
 * 缓存：`rel` → 解析到的 src 目录（或 null）。
 * 按文件分别缓存，因为它们可能落在不同候选里。
 */
const cache = new Map();

/**
 * 找到**包含指定文件**的 `src/` 目录。
 *
 * ⚠️ 判据是"要 import 的那个文件存在"，**不是一个固定哨兵**。
 * 踩过的坑：原来写死用 `pipeline.js` 当哨兵，于是
 *   · 测试里放一个只有 `probe.js` 的 src → 明明能找到，却被判为找不到
 *   · 更要紧的是语义错了：要找的不是"某个特定的 src"，
 *     而是"import 这个文件时该从哪个目录算"
 *
 * @param {string} rel 相对于 `src/` 的文件名，如 `'pipeline.js'`
 * @returns {string|null}
 */
export function resolveSrcDir(rel = 'pipeline.js') {
  if (cache.has(rel)) return cache.get(rel);

  const candidates = [
    // ① 插件在仓库里（开发时、或 pnpm 用 link: 软链回仓库）
    path.resolve(HERE, '..', '..', 'src'),
    // ② 插件被复制到 profile 的 node_modules 下，但 src/ 就放在插件旁边
    path.resolve(HERE, '..', 'src'),
    // ③ 环境变量兜底：用户显式指定仓库位置
    process.env.NOVEL2CARD_SRC ? path.resolve(process.env.NOVEL2CARD_SRC) : null,
  ].filter(Boolean);

  /**
   * ⚠️ **刻意不做 `process.cwd()/src` 兜底。**
   *
   * 试过，然后去掉了：开发时 cwd 恰好是仓库根，于是"复制安装"的场景
   * 也会被误判成成功 —— 测试里看起来一切正常，到了真实宿主里
   *（DSH 的工作目录与仓库无关）就找不到。
   * 宁可在这里明确失败，也不要给出一个碰巧能用的假象。
   */

  let found = null;
  for (const c of candidates) {
    try {
      if (existsSync(path.join(c, rel))) { found = c; break; }
    } catch { /* 权限问题就跳过这个候选 */ }
  }
  cache.set(rel, found);
  return found;
}

/**
 * 动态 import 一个核心模块。
 *
 * @param {string} rel 相对于 `src/` 的路径，如 `'pipeline.js'`
 * @throws 找不到 src 时给出**可操作**的错误，而不是一个看不懂的 ENOENT
 */
export async function importCore(rel) {
  const srcDir = resolveSrcDir(rel);
  if (!srcDir) {
    throw new Error(
      '找不到本插件的核心目录 src/。\n'
      + '本插件复用仓库的 src/pipeline.js 等模块，但安装后它可能被复制到了别处。\n'
      + '解决办法（任选其一）：\n'
      + '  1) 用软链安装（pnpm 默认对本地目录用 link:），保持插件目录在仓库内；\n'
      + '  2) 设置环境变量 NOVEL2CARD_SRC 指向仓库的 src 目录；\n'
      + `  3) 把仓库的 src/ 一起复制到插件目录旁（期望位置：${path.resolve(HERE, '..', 'src')}）`,
    );
  }
  const target = path.join(srcDir, rel);
  try {
    /**
     * ⚠️ 必须用 `pathToFileURL`，**不能**手工拼 `file://${path}`。
     *
     * 踩过的坑：手工拼出来的 URL 在含非 ASCII 字符或反斜杠的 Windows 路径上
     * 直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
     * 而本项目的典型路径就是 `D:\角色卡生成器` —— 中文目录，必踩。
     */
    return await import(pathToFileURL(target).href);
  } catch (e) {
    // 把「哪条路径、哪个文件」说清楚，否则只能在栈里猜
    throw new Error(`加载核心模块失败：${target}\n原因：${e.message}`);
  }
}

/** 供诊断用：当前解析到的 src 目录 */
export function describeResolution() {
  return {
    pluginDir: path.resolve(HERE, '..'),
    srcDir: resolveSrcDir(),
    fromEnv: !!process.env.NOVEL2CARD_SRC,
  };
}
