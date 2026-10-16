/**
 * 把图片**当作原文**来抽取。
 *
 * 这是对图片路径的**方向性修正**。
 *
 * 原来的做法：图片 → 视觉描述 → 扁平人物档案 + 一条「与XX相遇」的占位事件。
 * 结果用户看到的是「头像直径约 60 像素」「衣物疑为卫衣或外套」这类**画面描述**，
 * 以及一个没有剧情、没有事件、没有世界观体系的空壳卡。
 *
 * 用户要的：**和小说路径一样** —— 把图片里的内容当"原文"，抽出事件、故事线、
 * 阶段、世界观（地点/势力/体系）、人物关系与时间线。
 * 截图里的帖文、聊天记录、漫画旁白本来就有完整的情节。
 *
 * 所以这里复用小说路径的**同一批 STEP prompt**（`steps.js`），
 * 只是把"原文"换成"图片转录 + 画面观察"，再额外给模型一份**人物名单**，
 * 让它能把文字里的名字与画面里的形象对上（这样人物条目既有身份也有外貌）。
 *
 * 视觉信息与文字信息是互补的：
 *   · 文字给出：身份、关系、事件、地点、势力、发生了什么
 *   · 画面给出：外貌、服饰、体型、色调 —— 这些文字里往往没有
 * 两条都要用，不能只留一条。
 */
import { pMap } from './utils.js';
import {
  dedupeEvents, groupByStoryline, extractPhaseText, normalizeWorldbookItems,
  normalizeRosterShape, sampleAcrossText,
} from './pipeline.js';
import * as S from './steps.js';

/** 组装"原文"：转录为主，画面观察补充 */
export function buildSourceText(profiles = [], { maxChars = 60000 } = {}) {
  const parts = [];
  const seen = new Set();

  // 转录优先：这是真正的"原文"
  for (const p of profiles) {
    const t = String(p.transcript || '').trim();
    if (!t || t === '画面无文字') continue;
    const key = t.replace(/\s+/g, '').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(t);
  }

  const joined = parts.join('\n\n');
  if (joined.length > maxChars) return joined.slice(0, maxChars);
  return joined;
}

/**
 * 有没有足够的内容当"原文"来抽剧情。
 *
 * 判据是**转录文字的有效长度**，不是图片数量：几张纯立绘也能生成卡，
 * 但那时只能有外貌，抽不出剧情 —— 不能拿"图片有 3 张"当成"有原文"。
 *
 * 阈值刻意低（20 字）：真实的截图文本可能只有一两句话
 * （一句聊天记录就有情节），但这已经够抽一个事件了。
 * 试过 80 字，结果 51 字的真实内容被判成"没有原文"而退回旧路径。
 */
export function hasNarrativeSource(profiles = [], { minChars = 16 } = {}) {
  let total = 0;
  for (const p of profiles) {
    const t = String(p.transcript || '').trim();
    if (!isUsableTranscript(t)) continue;
    total += t.length;
  }
  return total >= minChars;
}

/**
 * 这段转录是不是"有内容"。
 *
 * 排除的不是"短"，而是**明确的否定句**：
 * 模型读不清时会写「该段文字模糊不可辨」「画面无文字」，
 * 这类句子不能当成原文去抽，否则会抽出莫名其妙的条目。
 */
export function isUsableTranscript(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^(画面无文字|无文字|该段文字模糊不可辨|文字模糊不可辨|文字不可辨|无法辨认|无)$/.test(s)) return false;
  // 中文一个字信息量很大（「逃！」「救我」都能是剧情），所以下限压到 3 个字符；
  // 这里只是滤掉「无。」这类噪声，真正的门槛交给 hasNarrativeSource 的总量判断
  return s.replace(/\s+/g, '').length >= 3;
}

/**
 * 把人物视觉档案渲染成一段"人物观察"，给抽取步骤当参考。
 *
 * 目的：让文字里抽出来的角色能带上外貌。模型看到
 * 「银发少女：银灰长发垂肩，深灰上衣」再读帖文，就能把
 * 「住同一寝室的 uyu」和这个形象对上。
 */
export function renderVisualRoster(profiles = [], { maxChars = 6000 } = {}) {
  const lines = [];
  for (const p of profiles) {
    const bits = [];
    const names = [p.name, ...(p.namesFromText || []), ...(p.aliases || [])].filter(Boolean);
    if (p.appearance) bits.push(`外貌：${String(p.appearance).slice(0, 160)}`);
    if (p.clothing) bits.push(`服饰：${String(p.clothing).slice(0, 120)}`);
    if (p.build) bits.push(`体型：${String(p.build).slice(0, 60)}`);
    if (p.gender) bits.push(`性别：${p.gender}`);
    if (!bits.length) continue;
    lines.push(`- ${names.join(' / ')} —— ${bits.join('；')}`);
  }
  const out = lines.join('\n');
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/**
 * 给抽取步骤的 user 消息加一段"图片背景"。
 *
 * 说清楚三件事，否则模型会按"小说原文"的方式作答而丢信息：
 *   ① 原文是**图片转录 + 画面观察**，不是小说
 *   ② 手册里有哪些人、长什么样（让文字里的名字能对上形象）
 *   ③ 名词沿用转录里的写法（与小说路径的一致性要求同理）
 */
export function buildImageSourceBlock({ sourceText, visualRoster, imageCount = 0 }) {
  const head = [
    `【本次的"原文"来自 ${imageCount} 张图片】`,
    '图片是**截图/漫画/聊天记录**类内容，下面的文字是从画面**逐段转录**得到的，',
    '画面里的剧情、人名、地点、势力都在文字里 —— 请把它当作小说原文一样抽取，',
    '不要输出"这是一张手机截图""头像很小"这类**画面描述**。',
  ].join('\n');

  const roster = visualRoster
    ? `\n【画面中出现的人物形象（外貌来自画面，可用于补全人物档案）】\n${visualRoster}`
    : '';

  return `${head}${roster}\n\n【转录的原文】\n${sourceText}`;
}

/**
 * 复用小说路径的 STEP prompt，把图片内容抽出成完整的剧情结构。
 *
 * 产出形状与 `runPipeline` 完全一致，所以 `assembleCharacterCard` 能直接吃：
 *   events / storylines / phases(含 characterDeltas) / worldbookItems / roster
 *
 * @param {object} cfg
 * @param {object} cfg.llm
 * @param {Array}  cfg.profiles 视觉档案（提供转录与外貌）
 * @param {Function} [cfg.send] 进度回调
 * @param {number} [cfg.concurrency]
 * @returns {Promise<object|null>} 没有可抽的原文时返回 null
 */
export async function extractNarrativeFromImages(cfg = {}) {
  const { llm, profiles = [], send = () => {}, concurrency = 3 } = cfg;
  if (!hasNarrativeSource(profiles)) return null;

  const sourceText = buildSourceText(profiles);
  if (!sourceText.trim()) return null;

  const visualRoster = renderVisualRoster(profiles);
  const sourceBlock = buildImageSourceBlock({
    sourceText, visualRoster, imageCount: cfg.imageCount || profiles.length,
  });
  const concurrencyN = Math.max(1, Number(concurrency) || 3);

  /**
   * 事件抽取：小说路径是**逐章**跑的，这里把转录按段落切成"章"。
   *
   * 为什么不整段一次抽：截图转录常常很长（一张长截图能有几千字），
   * 一次塞进去模型会漏掉大半事件。按空行/段号切开，每段一次，
   * 与小说路径的"每章一次"是同构的。
   */
  const chunks = splitTranscriptIntoChunks(sourceText);
  send({ step: 'Narrative', msg: `图片内容按 ${chunks.length} 段抽取事件`, ts: Date.now() });

  const eventsRaw = await pMap(chunks, async (c) => {
    try {
      const raw = await llm.chatJSON(S.STEP_2_EVENTS, `章节：${c.title}\n\n${c.text}`, 'step2');
      return Array.isArray(raw?.events) ? raw.events : (Array.isArray(raw) ? raw : []);
    } catch (e) {
      send({ step: 'WARN', msg: `第 ${c.title} 段事件抽取失败：${e.message}`, ts: Date.now() });
      return [];
    }
  }, concurrencyN);

  const events = dedupeEvents(eventsRaw.flat());
  const storylines = groupByStoryline(events);
  send({
    step: 'Narrative',
    msg: `从图片内容抽出 ${events.length} 个事件 / ${Object.keys(storylines).length} 条故事线`,
    ts: Date.now(),
  });

  // 阶段
  let phases = [];
  try {
    const r = await llm.chatJSON(S.STEP_3_PHASES, JSON.stringify(events, null, 2), 'step3');
    phases = Array.isArray(r?.phases) ? r.phases : [];
  } catch (e) {
    send({ step: 'WARN', msg: `阶段划分失败：${e.message}`, ts: Date.now() });
  }

  const phasesWithDeltas = await pMap(phases, async (phase) => {
    try {
      const text = extractPhaseText(phase, events, chunks);
      const r = await llm.chatJSON(
        S.STEP_4_DELTAS,
        `阶段名：${phase.name}\n核心变化：${phase.coreChange}\n原文：\n${text.slice(0, 8000)}`,
        'step4',
      );
      return { ...phase, characterDeltas: Array.isArray(r?.deltas) ? r.deltas : [] };
    } catch { return { ...phase, characterDeltas: [] }; }
  }, Math.max(1, Math.min(concurrencyN, 2)));

  // 世界观（地点 / 势力 / 体系 / 历史）—— 这才是"和小说一样"的关键
  let worldbookItems = [];
  try {
    const r = await llm.chatJSON(
      S.STEP_5_WORLDBOOK,
      `${sampleAcrossText(sourceText, Number(cfg.worldProbeChars) || 15000)}`
      + (visualRoster ? `\n\n【画面人物形象参考】\n${visualRoster}` : ''),
      'step5',
    );
    worldbookItems = normalizeWorldbookItems(r);
  } catch (e) {
    send({ step: 'WARN', msg: `世界观抽取失败：${e.message}`, ts: Date.now() });
  }

  // 人物名单（从"原文"里抽，不是从画面里认）
  let roster = [];
  try {
    const raw = await llm.chatJSON(
      S.STEP_5_CHARACTER_LIST,
      `原文：\n${sampleAcrossText(sourceText, Number(cfg.charProbeChars) || 10000)}`,
      'step5',
    );
    roster = normalizeRosterShape(raw);
  } catch (e) {
    send({ step: 'WARN', msg: `人物名单抽取失败：${e.message}`, ts: Date.now() });
  }

  // 人物档案：把画面形象一起给模型，让档案既有身份也有外貌
  const characters = (await pMap(roster, async (r) => {
    try {
      const item = await llm.chatJSON(
        S.STEP_5_CHARACTER,
        `角色名：${r.name}\n已知称呼：${[r.name, ...(r.aliases || [])].join('、')}\n\n`
        + (visualRoster ? `【画面人物形象参考】\n${visualRoster}\n\n` : '')
        + `原文节选：\n${sampleAcrossText(sourceText, Number(cfg.charProbeChars) || 10000)}`,
        'step5',
      );
      return { name: r.name, aliases: r.aliases || [], profile: item };
    } catch (e) {
      send({ step: 'WARN', msg: `人物「${r.name}」档案抽取失败：${e.message}`, ts: Date.now() });
      return null;
    }
  }, concurrencyN)).filter(Boolean);

  send({
    step: 'Narrative',
    msg: `图片内容抽取完成：${events.length} 事件 · ${phases.length} 阶段 · `
      + `${worldbookItems.length} 世界观 · ${characters.length} 人物`,
    ts: Date.now(),
  });

  return {
    sourceText, visualRoster, events, storylines, phases: phasesWithDeltas,
    worldbookItems, characters, roster, chunks,
  };
}

/**
 * 把转录切段。优先按"段"标记（【第 N 段】），其次按空行，最后按长度兜底。
 *
 * 与小说路径的章节切分同构：每个 chunk 一次事件抽取调用。
 */
export function splitTranscriptIntoChunks(sourceText, { targetLen = 4000 } = {}) {
  const text = String(sourceText || '').trim();
  if (!text) return [];

  // ① 有显式段号就用段号
  const byMarker = text.split(/(?=【第\s*\d+\s*段】)/).map(s => s.trim()).filter(Boolean);
  if (byMarker.length > 1) {
    return byMarker.map((t, i) => ({ title: `第${i + 1}段`, text: t, index: i }));
  }

  // ② 按空行聚合成不超过 targetLen 的块
  const paras = text.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  const chunks = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length > targetLen) {
      chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? `${buf}\n\n${p}` : p;
    }
  }
  if (buf) chunks.push(buf);

  // ③ 单段就超长时按长度硬切（按行边界，避免切断句子）
  const out = [];
  for (const c of chunks) {
    if (c.length <= targetLen * 1.5) { out.push(c); continue; }
    let cur = '';
    for (const line of c.split('\n')) {
      if (cur && cur.length + line.length > targetLen) { out.push(cur); cur = line; }
      else { cur = cur ? `${cur}\n${line}` : line; }
    }
    if (cur) out.push(cur);
  }

  return out.map((t, i) => ({ title: `第${i + 1}段`, text: t, index: i }));
}
