/**
 * 文本编码检测与转码
 *
 * 背景：中文小说常见 GBK / GB2312 / Big5 编码，直接按 UTF-8 读取会整篇乱码，
 * 导致 LLM 抽取把人物名读成"无法辨认"、事件数量骤降。
 *
 * 优先级：
 *   1. BOM（UTF-8 / UTF-16LE / UTF-16BE）—— 最可靠，直接据此解码并剥除 BOM
 *   2. UTF-8 严格校验 —— 合法即 UTF-8（中文 UTF-8 很容易被误判成别的编码）
 *   3. jschardet 检测 + iconv-lite 解码 —— 覆盖 GBK/GB2312/Big5/Shift_JIS 等
 *   4. 都不行 → 回退 UTF-8 并给出警告（不抛错，让流程继续）
 */
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------- 可选依赖：缺失时降级，不影响服务启动 ----------
let jschardet = null;
let iconv = null;
let depsError = null;
try {
  jschardet = require('jschardet');
  iconv = require('iconv-lite');
} catch (e) {
  depsError = e;
}

export const hasEncodingDeps = !!jschardet && !!iconv;

/** 置信度低于此值就提示用户，但仍然解码 */
export const CONFIDENCE_WARN = 0.7;

// ---------- BOM ----------
const BOMS = [
  { name: 'UTF-8', bytes: [0xEF, 0xBB, 0xBF], encoding: 'utf-8', strip: 3 },
  { name: 'UTF-16LE', bytes: [0xFF, 0xFE], encoding: 'utf-16le', strip: 2 },
  { name: 'UTF-16BE', bytes: [0xFE, 0xFF], encoding: 'utf-16be', strip: 2 },
];

/** 检测 BOM；返回 { name, encoding, strip } 或 null */
export function detectBOM(buffer) {
  const buf = toBuffer(buffer);
  for (const bom of BOMS) {
    if (buf.length < bom.bytes.length) continue;
    if (bom.bytes.every((b, i) => buf[i] === b)) return bom;
  }
  return null;
}

/** 该 Buffer 是否是合法 UTF-8（用严格模式解码，失败即非 UTF-8） */
export function isValidUTF8(buffer) {
  const buf = toBuffer(buffer);
  try {
    // Node 18+ 的 TextDecoder 支持 fatal，遇到非法序列会抛错
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把各种编码名归一化到 iconv-lite 认识的名字。
 * jschardet 会返回 GB2312 / Big5 / Shift_JIS / windows-1252 等写法。
 */
export function normalizeEncoding(name) {
  if (!name) return 'utf-8';
  const n = String(name).trim().toLowerCase().replace(/[_\s]/g, '-');
  const map = {
    'utf8': 'utf-8',
    'utf-8': 'utf-8',
    'ascii': 'utf-8',            // 纯 ASCII 用 UTF-8 读也一样
    'us-ascii': 'utf-8',
    'gb2312': 'gbk',             // GBK 是 GB2312 的超集，用 gbk 解码更安全
    'gb-2312': 'gbk',
    'gbk': 'gbk',
    'gb18030': 'gb18030',
    'big5': 'big5',
    'big-5': 'big5',
    'big5-hkscs': 'big5',
    'shift-jis': 'shift_jis',
    'shiftjis': 'shift_jis',
    'sjis': 'shift_jis',
    'euc-jp': 'euc-jp',
    'euc-kr': 'euc-kr',
    'windows-1252': 'windows-1252',
    'iso-8859-1': 'latin1',
    'latin1': 'latin1',
    'utf-16le': 'utf-16le',
    'utf-16be': 'utf-16be',
    'utf-16': 'utf-16le',
  };
  return map[n] || n;
}

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input);
  if (typeof input === 'string') return Buffer.from(input, 'utf-8');
  throw new TypeError('detectAndDecode 需要 Buffer / Uint8Array');
}

/**
 * 检测并解码文本。
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {{sampleSize?:number, fallback?:string}} [opts]
 * @returns {{text:string, encoding:string, originalEncoding:string, confidence:number,
 *            source:'bom'|'utf8'|'detected'|'fallback', bomStripped:boolean,
 *            transcoded:boolean, warnings:string[]}}
 */
export function detectAndDecode(buffer, { sampleSize = 65536, fallback = 'utf-8' } = {}) {
  const buf = toBuffer(buffer);
  const warnings = [];

  // ---------- 空内容 ----------
  if (!buf.length) {
    return result('', 'utf-8', 'utf-8', 1, 'utf8', false, false, warnings);
  }

  // ---------- 1. BOM ----------
  const bom = detectBOM(buf);
  if (bom) {
    const body = buf.subarray(bom.strip);
    let text;
    try {
      text = iconv ? iconv.decode(body, bom.encoding) : body.toString('utf8');
    } catch {
      text = body.toString('utf8');
      warnings.push(`BOM 指示 ${bom.name}，但解码失败，已按 UTF-8 处理`);
    }
    const canonical = bom.encoding === 'utf-8' ? 'utf-8' : bom.encoding;
    return result(text, canonical, bom.name, 1, 'bom', true, canonical !== 'utf-8', warnings);
  }

  // ---------- 2. 合法 UTF-8 直接用 ----------
  if (isValidUTF8(buf)) {
    return result(buf.toString('utf8'), 'utf-8', 'UTF-8', 1, 'utf8', false, false, warnings);
  }

  // ---------- 3. 交给 jschardet ----------
  if (!jschardet || !iconv) {
    warnings.push(
      `无法检测编码（缺少 iconv-lite / jschardet 依赖）：${depsError?.message || ''}。` +
      `已按 UTF-8 读取，若出现乱码请运行 npm install`
    );
    return result(buf.toString('utf8'), 'utf-8', 'unknown', 0, 'fallback', false, false, warnings);
  }

  const sample = buf.length > sampleSize ? buf.subarray(0, sampleSize) : buf;
  let detected = { encoding: null, confidence: 0 };
  try {
    detected = jschardet.detect(sample) || detected;
  } catch (e) {
    warnings.push(`编码检测失败：${e.message}`);
  }

  const rawName = detected.encoding;
  const confidence = Number(detected.confidence) || 0;

  // 检测不出结果，或结果本身就是 UTF-8
  if (!rawName) {
    warnings.push('未能识别编码，已按 UTF-8 读取；若出现乱码请手动转成 UTF-8 后重试');
    return result(buf.toString('utf8'), 'utf-8', 'unknown', confidence, 'fallback', false, false, warnings);
  }

  const enc = normalizeEncoding(rawName);
  if (enc === 'utf-8') {
    // jschardet 说是 UTF-8 但严格校验没过：可能有少量坏字节，仍按 UTF-8 读
    if (confidence < CONFIDENCE_WARN) {
      warnings.push(`编码判定为 UTF-8 但置信度较低（${confidence.toFixed(2)}），如出现乱码请检查文件`);
    }
    return result(buf.toString('utf8'), 'utf-8', rawName, confidence, 'detected', false, false, warnings);
  }

  if (confidence < CONFIDENCE_WARN) {
    warnings.push(
      `编码检测置信度较低（${rawName} ${confidence.toFixed(2)}），已按该编码转码；` +
      `若正文出现乱码，请把文件转成 UTF-8 后重试`
    );
  }

  let text;
  try {
    if (!iconv.encodingExists(enc)) {
      warnings.push(`不支持的编码 ${rawName}（归一化为 ${enc}），已按 UTF-8 读取`);
      return result(buf.toString('utf8'), 'utf-8', rawName, confidence, 'fallback', false, false, warnings);
    }
    text = iconv.decode(buf, enc);
  } catch (e) {
    warnings.push(`按 ${enc} 转码失败（${e.message}），已按 UTF-8 读取`);
    return result(buf.toString('utf8'), 'utf-8', rawName, confidence, 'fallback', false, false, warnings);
  }

  // 转码后自检：如果结果里替换字符异常多，说明选错了编码
  const badRatio = countReplacementChars(text) / Math.max(1, text.length);
  if (badRatio > 0.02) {
    warnings.push(
      `按 ${rawName} 转码后出现较多无法识别的字符（${(badRatio * 100).toFixed(1)}%），` +
      `编码可能判断有误，建议检查原文`
    );
  }

  return result(text, enc, rawName, confidence, 'detected', false, true, warnings);
}

function countReplacementChars(text) {
  let n = 0;
  for (const ch of text) if (ch === '\uFFFD') n++;
  return n;
}

function result(text, encoding, originalEncoding, confidence, source, bomStripped, transcoded, warnings) {
  return {
    text,
    encoding,
    originalEncoding,
    confidence: Math.round(confidence * 1000) / 1000,
    source,
    bomStripped,
    transcoded,
    warnings,
  };
}

/**
 * 读取小说文本（自动检测编码）。
 * 供 pipeline 使用，替代裸的 readFile(path, 'utf-8')。
 *
 * @param {string} filePath
 * @returns {Promise<{text:string, encoding:string, originalEncoding:string, confidence:number,
 *                    source:string, bomStripped:boolean, transcoded:boolean,
 *                    warnings:string[], bytes:number}>}
 */
export async function readNovelText(filePath, opts = {}) {
  const buf = await readFile(filePath);
  const r = detectAndDecode(buf, opts);
  return { ...r, bytes: buf.length };
}
