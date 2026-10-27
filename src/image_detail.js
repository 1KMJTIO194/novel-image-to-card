/**
 * 主要角色的**外貌 / 服装精修**。
 *
 * 用户反馈（原话）：
 *   「主要NPC的外貌服装注意力不足描写的不够详细有遗漏，
 *     我觉得可以在区分主要NPC和次要NPC之后重点观察描写NPC的外貌和服装」
 *
 * 为什么确实需要单独一轮：
 *   总结那一步要同时产出人物 + 世界观 + 舞台设定，注意力被摊薄，
 *   外貌/服装通常只剩一句"黑色长发、深色外套"。而这两项恰恰是**图片独有的信息**
 *   —— 文字资料里通常没有。所以这里只做一件事：拿着图，专门把这个角色的
 *   外观写细。
 *
 * 设计取舍：
 *   · **只精修主要角色**（默认主角 + 主要NPC，最多 3 个）——
 *     每个角色一次带图请求，全量精修会把成本翻几倍，而路人本来就该略写。
 *   · **找不到对应图片就跳过**，不要空跑一次请求。
 *   · 精修结果**只在更详细时覆盖**原文；模型返回 found:false 时保留原样。
 *   · 仍然遵守"不指涉图片"的规则（复用 stripImageFraming）。
 */
import { stripImageFraming } from './image_summary.js';
import { NPC_TIERS } from './tiers.js';
import { detailPreset } from './detail_level.js';
import { withContentRules } from './content_mode.js';
import * as S from './steps.js';

/** 默认最多精修几个角色 */
export const DEFAULT_DETAIL_MAX = 3;
/** 每个角色最多看几张图 */
export const DEFAULT_DETAIL_IMAGES = 6;

/**
 * 哪些角色值得精修。
 *
 * 判据优先级：
 *   ① `importance`（总结时标注的 主角 / 主要NPC / 次要NPC / 路人NPC）
 *   ② 没有 importance 的老数据 → 按顺序取前 N 个（第一个通常是主角）
 *
 * @param {{characters?:Array}} summary
 * @param {{max?:number}} [opts]
 * @returns {Array<{index:number, character:object}>}
 */
export function pickDetailTargets(summary, { max = DEFAULT_DETAIL_MAX } = {}) {
  const list = Array.isArray(summary?.characters) ? summary.characters : [];
  const ranked = list.map((c, index) => {
    const imp = String(c?.importance || '').trim();
    const rank = NPC_TIERS.includes(imp) ? NPC_TIERS.indexOf(imp)
      // 没有标注时：第 1 个当主角，其余当主要NPC（都算值得精修）
      : (index === 0 ? 0 : 1);
    return { index, character: c, rank };
  });
  return ranked
    .filter(x => x.rank <= 1)                     // 只要 主角 / 主要NPC
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .slice(0, Math.max(0, Number(max) || 0));
}

/** 名字归一化（与 image_card 的匹配逻辑一致，避免两处判据不同） */
function normName(s) {
  return String(s || '')
    .replace(/[（(]\s*图\s*\d+\s*[)）]/g, '')
    .replace(/[\s·・.、,，。!！?？"'“”‘’\[\]【】]+/g, '')
    .toLowerCase();
}

/**
 * 找这个角色可能出现在哪些图里。
 *
 * 先用**视觉档案**里记录的 `imageIndex`（视觉抽取是逐图做的，模型当时就标了
 * 「这个人出现在第几张」）；名字对不上时（视觉起的名字和总结起的名字可能不同），
 * 退化成**均匀采样**几张图交给模型自己找 —— 比直接跳过有用得多。
 *
 * @param {object} character summary 里的角色
 * @param {Array} profiles 视觉档案（含 imageIndex / namesFromText）
 * @param {number} imageCount 原图总数
 * @param {number} max 最多给几张
 * @returns {number[]} 图下标（升序）
 */
export function pickImagesForCharacter(character, profiles = [], imageCount = 0, max = DEFAULT_DETAIL_IMAGES) {
  const cap = Math.max(1, Number(max) || 1);
  const names = [character?.name, ...(character?.aliases || [])].map(normName).filter(Boolean);

  /** 视觉档案能对上这个人 → 收下它标过的图 */
  const matched = new Set();
  for (const p of profiles) {
    if (!p || !Number.isInteger(p.imageIndex)) continue;
    const pnames = [p.name, ...(p.namesFromText || []), ...(p.aliases || [])].map(normName).filter(Boolean);
    const hit = names.some(a => pnames.some(b => a && b && (a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b)))));
    if (hit) matched.add(p.imageIndex);
  }

  /**
   * "全部图"的范围。
   *
   * ⚠️ 优先用调用方给的 `imageCount`（真实张数），**不要**拿视觉档案的下标去推：
   * 视觉档案只覆盖"被识别人物"的那几张，用它当全集会把采样范围缩到那几张，
   * 于是"均匀采样"退化成了"只在那几张里打转"（实测就踩了这个）。
   */
  const all = Number(imageCount) > 0
    ? Array.from({ length: Number(imageCount) }, (_, i) => i)
    : (Array.isArray(profiles) ? profiles.map(p => p?.imageIndex).filter(Number.isInteger) : []);

  if (matched.size) {
    return [...matched].sort((a, b) => a - b).slice(0, cap);
  }

  /**
   * 对不上名字时的退路：**均匀采样**。
   *
   * 为什么值得试：画集/漫画里视觉模型给的名字（"黑发兽耳少女"）和总结给的名字
   * （"オスガキさん"）很可能不同，硬跳过等于这次精修白做。采样几页交给模型，
   * 它自己能认出目标角色；认不出它会返回 found:false，我们保留原样，不会写坏。
   */
  const sorted = [...new Set(all)].sort((a, b) => a - b);
  if (!sorted.length) return [];
  if (sorted.length <= cap) return sorted;
  const step = (sorted.length - 1) / (cap - 1 || 1);
  const picked = new Set();
  for (let i = 0; i < cap; i++) picked.add(sorted[Math.round(i * step)]);
  return [...picked].sort((a, b) => a - b);
}

/** 归一化精修结果（模型返回可能是 `{found:true,...}` 或直接对象） */
export function normalizeDetail(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const clean = (v) => stripImageFraming(String(v ?? '').trim());
  return {
    found: o.found === false ? false : true,
    reason: clean(o.reason),
    name: clean(o.name),
    appearance: clean(o.appearance),
    clothing: clean(o.clothing),
    build: clean(o.build),
    accessories: Array.isArray(o.accessories) ? o.accessories.map(x => clean(x)).filter(Boolean) : [],
    distinctive: clean(o.distinctive),
    uncertain: clean(o.uncertain),
  };
}

/**
 * 精修结果合并进原设定。
 *
 * 规则：**只在更详细时覆盖**，别把原来那句话换成更短的一句。
 * 另外：
 *   · distinctive 追加到外貌末尾（那是"最显眼的辨识特征"，正好补遗漏）
 *   · uncertain 单独存进 notes，让用户知道哪些部位看不清
 *   · accessories 取并集
 */
export function mergeDetailIntoCharacter(character, detail) {
  if (!detail || detail.found === false) return character;
  const longer = (oldV, newV) => (String(newV || '').length > String(oldV || '').length ? newV : oldV);

  const next = { ...character };
  next.appearance = longer(character.appearance, detail.appearance);
  next.clothing = longer(character.clothing, detail.clothing);
  next.build = longer(character.build, detail.build);

  if (detail.distinctive && !String(next.appearance || '').includes(detail.distinctive)) {
    next.appearance = [next.appearance, `显著特征：${detail.distinctive}`].filter(Boolean).join('\n');
  }
  if (detail.accessories?.length) {
    next.accessories = [...new Set([...(character.accessories || []), ...detail.accessories])];
  }
  if (detail.uncertain) {
    next.notes = [character.notes, `外观待补：${detail.uncertain}`].filter(Boolean).join('\n');
  }
  next.appearanceRefined = true;
  return next;
}

/**
 * 对主要角色跑一轮外观精修。
 *
 * @param {object} cfg
 * @param {object} cfg.llm
 * @param {object} cfg.summary extractCardSummary 的产出（会被**原地更新** characters）
 * @param {Array<{index:number,path:string}>} cfg.images 原图（下标与视觉档案的 imageIndex 对应）
 * @param {Array} cfg.profiles 视觉档案（提供 imageIndex 线索）
 * @param {Function} [cfg.send]
 * @param {number} [cfg.max] 最多精修几个角色
 * @param {number} [cfg.imagesPerChar] 每个角色看几张图
 * @returns {Promise<{refined:Array, skipped:Array}>}
 */
export async function refineMainAppearance(cfg = {}) {
  const {
    llm, summary, images = [], profiles = [], send = () => {},
    detailLevel = 'basic',
    contentMode = 'general',
  } = cfg;

  /**
   * 数字参数随档位走：完整版给更多主要角色做精修、每人多看几张图。
   * 调用方显式传了 max / imagesPerChar 时以调用方为准（CLI 的 --detail-max）。
   */
  const preset = detailPreset(detailLevel);
  const max = cfg.max === undefined ? preset.refineMax : cfg.max;
  const imagesPerChar = cfg.imagesPerChar === undefined ? preset.imagesPerChar : cfg.imagesPerChar;
  /**
   * 版本规则也要带给这一个请求：普通版不许写成成人内容，
   * 成人版允许更直白的身体描写（但仍只能写画面能支持的）。
   */
  const detailPrompt = withContentRules(S.STEP_IMAGE_DETAIL, contentMode, 'summary');

  const result = { refined: [], skipped: [] };
  if (!summary || !Array.isArray(summary.characters) || !summary.characters.length) return result;
  if (!llm || typeof llm.chatJSON !== 'function') return result;
  if (!images.length) return result;

  const targets = pickDetailTargets(summary, { max });
  if (!targets.length) return result;

  /** 按 imageIndex 取原图路径 */
  const pathAt = (idx) => {
    const byIndex = images.find(im => im && im.index === idx);
    if (byIndex) return byIndex.path;
    return images[idx]?.path;
  };

  for (const t of targets) {
    const c = t.character;
    const idxs = pickImagesForCharacter(c, profiles, images.length, imagesPerChar);
    const paths = idxs.map(pathAt).filter(Boolean);
    if (!paths.length) {
      result.skipped.push({ name: c.name, reason: '没有可用的图片' });
      send({ step: 'WARN', msg: `主要角色「${c.name}」找不到对应图片，跳过外观精修`, ts: Date.now() });
      continue;
    }

    const userText = [
      `角色名：${c.name}`,
      (c.aliases || []).length ? `已知称呼：${[c.name, ...c.aliases].join('、')}` : '',
      c.identity ? `身份：${c.identity}` : '',
      c.appearance ? `已有一句外貌描述（可参考，但请写得更细）：${c.appearance}` : '',
      '',
      `下面是 ${paths.length} 张图片。请在其中找到这个角色，按系统要求写出**详尽的外貌与服装设定**。`,
      '如果这些图里确实找不到 TA，就返回 {"found": false, "reason": "..."}。',
    ].filter(Boolean).join('\n');

    try {
      send({ step: 'Detail', msg: `精修主要角色外观：${c.name}（${paths.length} 张图）`, ts: Date.now() });
      const raw = await llm.chatJSON(detailPrompt, userText, 'image-detail', {
        images: paths,
        temperature: 0.4,
        retries: 2,
      });
      const detail = normalizeDetail(raw);
      if (!detail.found) {
        result.skipped.push({ name: c.name, reason: detail.reason || '图里没找到' });
        send({ step: 'Detail', msg: `  · 「${c.name}」在这几张图里没找到，保留原描述`, ts: Date.now() });
        continue;
      }
      summary.characters[t.index] = mergeDetailIntoCharacter(c, detail);
      result.refined.push({
        name: c.name,
        appearanceLen: String(detail.appearance || '').length,
        clothingLen: String(detail.clothing || '').length,
      });
      send({
        step: 'Detail',
        msg: `  · 「${c.name}」外观已补全：外貌 ${String(detail.appearance || '').length} 字 / `
          + `服装 ${String(detail.clothing || '').length} 字`
          + (detail.accessories?.length ? ` / 配饰 ${detail.accessories.length} 件` : ''),
        ts: Date.now(),
      });
    } catch (e) {
      // 精修失败不影响主流程 —— 原描述仍然可用
      result.skipped.push({ name: c.name, reason: e.message });
      send({ step: 'WARN', msg: `「${c.name}」外观精修失败（保留原描述）：${e.message}`, ts: Date.now() });
    }
  }

  return result;
}
