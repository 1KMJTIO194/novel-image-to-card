/**
 * 图片内容 → **设定总结**。
 *
 * 这是图片路径的正确方向（用户两次澄清后的结论）：
 *   「通过图片生成角色卡应该是**总结图片里的内容信息**生成角色卡，
 *     而不是**图片里面怎么怎么样**，**图片里发生了什么剧情**等。」
 *
 * 所以这里做的是"**信息 → 设定**"的归纳，不是两条会跑偏的路：
 *   ❌ 描述画面（"图中是一位银发少女，头像 60 像素"）—— 卡里不该出现对图的描述
 *   ❌ 抽取剧情（"事件1：寝室夜谈 → 事件2：关系确认"）—— 卡给的是舞台，不是剧本
 *   ✅ 归纳设定（"银发少女，住同寝室，性格内向，与室友关系从抗拒到接受"）
 *
 * 三层处理，每层都可测：
 *   ① 汇总资料（转录文字 + 画面事实）→ 交给 summary prompt
 *   ② 归一化模型返回（缺字段补安全默认，不编内容）
 *   ③ **清洗指涉图片的措辞**（"图片中/画面里/截图中…"）—— prompt 说了不许，
 *      但模型经常不听；与其指望它，不如代码兜一道
 */
import { pMap } from './utils.js';
import * as S from './steps.js';

/** 指涉图片本身的词 —— 出现在卡里就说明模型在描述图，而不是写设定 */
const IMAGE_WORDS = /(图片|画面中|画面里|画面为|截图中|截图的|图中|本图|该图|此图|头像中|头像的|像素|分辨率|构图|封面排版|界面截图)/;

/**
 * 汇总给模型看的"资料"。
 *
 * 两条信息源都要：
 *   · 转录文字 —— 给出身份、关系、处境（信息的主体）
 *   · 画面事实 —— 给出外貌、服饰、场景（文字里往往没有）
 */
export function buildSummarySource(profiles = []) {
  const parts = [];
  const seen = new Set();

  const transcripts = [];
  for (const p of profiles) {
    const t = String(p.transcript || '').trim();
    if (!t || !isUsableTranscript(t)) continue;
    const key = t.replace(/\s+/g, '').slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    transcripts.push(t);
  }
  if (transcripts.length) {
    parts.push(`【图片中的文字（转录）】\n${transcripts.join('\n\n')}`);
  }

  const facts = [];
  for (const p of profiles) {
    const bits = [];
    const names = [p.name, ...(p.namesFromText || []), ...(p.aliases || [])].filter(Boolean);
    if (p.appearance) bits.push(`外貌：${p.appearance}`);
    if (p.clothing) bits.push(`服饰：${p.clothing}`);
    if (p.build) bits.push(`体型：${p.build}`);
    if (p.scene) bits.push(`场景：${p.scene}`);
    if (p.gender) bits.push(`性别：${p.gender}`);
    if (p.personalityHints?.length) bits.push(`神态给人的印象：${p.personalityHints.join('、')}`);
    if (p.worldHints?.length) bits.push(`题材线索：${p.worldHints.join('、')}`);
    if (p.inferredRelations) bits.push(`可见的关系线索：${p.inferredRelations}`);
    if (!bits.length) continue;
    facts.push(`- ${names.join(' / ') || '（未命名人物）'}\n  ${bits.join('\n  ')}`);
  }
  if (facts.length) {
    parts.push(`【画面上看到的事实】\n${facts.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * 这段转录是不是"有内容"。
 *
 * 排除的不是"短"，而是**明确的否定句**：模型读不清时会写
 * 「该段文字模糊不可辨」「画面无文字」，这些不能当资料用。
 */
export function isUsableTranscript(t) {
  const s = String(t || '').trim();
  if (!s) return false;
  if (/^(画面无文字|无文字|该段文字模糊不可辨|文字模糊不可辨|文字不可辨|无法辨认|无)$/.test(s)) return false;
  return s.replace(/\s+/g, '').length >= 3;
}

/**
 * 有没有任何可用资料。
 *
 * 只要有画面事实（立绘也算）就能总结出"外貌 + 可推测的题材"，
 * 所以这里不要求必须有文字 —— 没有文字时产出的设定会更薄，仅此而已。
 */
export function hasSummarySource(profiles = []) {
  return profiles.some(p => p && (
    isUsableTranscript(p.transcript)
    || String(p.appearance || '').trim()
    || String(p.clothing || '').trim()
    || String(p.scene || '').trim()
  ));
}

/**
 * 清洗指涉图片的措辞。
 *
 * prompt 里已经明令禁止，但实测模型经常忍不住写「画面中可见」「图中是一位…」。
 * 这里做**保守**清洗：只处理句首/分句首的引导语，不重写内容 ——
 * 盲目替换会把"图片里说的那个游戏"这种正常引用也改坏。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripImageFraming(text) {
  let s = String(text || '');
  if (!s) return '';

  // ① 句首/分句首的"XX中/里可见/显示/是"引导语整段删掉
  s = s.replace(
    /(^|[。；;！!\n])\s*(?:从)?(?:图片|画面|截图|图中|本图|该图|此图)(?:中|里|上|内)?\s*(?:可以)?\s*(?:看到|可见|显示|展示|表明|是|为)?\s*[，,：:]?\s*/g,
    '$1',
  );

  // ② 括号里的来源标注（"（据画面推断）"这类）—— 保留"推断"语义，去掉"画面"
  s = s.replace(/[（(]\s*据?(?:图片|画面|截图)(?:推断|判断|观察|可见)?\s*[)）]/g, '（推断）');
  s = s.replace(/[（(]\s*(?:依据|根据)(?:图片|画面|截图)\s*[)）]/g, '（推断）');

  // ③ 剩下的零散指涉词改成中性表达（避免卡里出现"图片"两个字）
  s = s.replace(/画面中|图片中|截图中|图中/g, '')
    .replace(/画面里/g, '')
    .replace(/本图|该图|此图/g, '');

  // ④ 收拾空格/标点
  s = s.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。；：,;:])/g, '$1').trim();
  return s;
}

/** 字段是否还残留指涉图片的措辞（用于测试与告警） */
export function hasImageFraming(text) {
  return IMAGE_WORDS.test(String(text || ''));
}

/**
 * 归一化模型返回的设定总结。
 *
 * **不抛错**：缺什么补什么，认不出的丢掉 —— 一条坏数据不该让整张卡报废。
 *
 * @param {*} raw 模型返回
 * @returns {{world:object, characters:Array, scenario:string, opening:string}}
 */
export function normalizeSummary(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const world = (obj.world && typeof obj.world === 'object') ? obj.world : {};

  /** 世界书条目：只要 name/content 都有就收 */
  const items = (list) => (Array.isArray(list) ? list : [])
    .filter(x => x && typeof x === 'object')
    .map(x => ({
      name: stripImageFraming(String(x.name ?? x['名称'] ?? '').trim()),
      keys: (Array.isArray(x.keys) ? x.keys : (typeof x.keys === 'string' ? x.keys.split(/[、,，]/) : []))
        .map(k => String(k).trim()).filter(Boolean),
      content: stripImageFraming(String(x.content ?? x['内容'] ?? x['正文'] ?? '').trim()),
    }))
    .filter(x => x.name && x.content.length >= 10);

  const characters = (Array.isArray(obj.characters) ? obj.characters : [])
    .filter(c => c && typeof c === 'object')
    .map(c => {
      const g = (k, alt) => stripImageFraming(String(c[k] ?? (alt ? c[alt] : '') ?? '').trim());
      return {
        name: g('name', '姓名'),
        aliases: (Array.isArray(c.aliases) ? c.aliases : []).map(String).map(x => x.trim()).filter(Boolean),
        /**
         * 重要性：主角 / 主要NPC / 次要NPC / 路人NPC。
         *
         * ⚠️ 必须保留 —— 它决定**谁值得做外观精修**。
         * 踩过的坑：一开始漏了这个字段，归一化后 everybody 都没有 importance，
         * 精修步骤退回"前 N 个都当主要角色"，于是路人也被单独精修，
         * 白白多花请求（而且把次要角色写得过详，焦点反而错了）。
         */
        importance: g('importance'),
        gender: g('gender'),
        age: g('age'),
        identity: g('identity'),
        appearance: g('appearance'),
        clothing: g('clothing'),
        personality: g('personality'),
        speechStyle: g('speechStyle'),
        relations: g('relations'),
        background: g('background'),
        abilities: g('abilities'),
        notes: g('notes'),
      };
    })
    .filter(c => c.name && (c.appearance || c.personality || c.identity || c.relations || c.background));

  return {
    world: {
      overview: stripImageFraming(String(world.overview ?? world['概述'] ?? '').trim()),
      era: stripImageFraming(String(world.era ?? '').trim()),
      locations: items(world.locations),
      factions: items(world.factions),
      systems: items(world.systems),
      history: items(world.history),
    },
    characters,
    scenario: stripImageFraming(String(obj.scenario ?? '').trim()),
    opening: stripImageFraming(String(obj.opening ?? '').trim()),
  };
}

/**
 * 让模型把资料总结成设定。
 *
 * @param {object} cfg
 * @param {object} cfg.llm
 * @param {Array}  cfg.profiles 视觉档案（转录 + 画面事实）
 * @param {Function} [cfg.send]
 * @returns {Promise<object|null>} 没有可用资料时返回 null
 */
export async function extractCardSummary(cfg = {}) {
  const { llm, profiles = [], send = () => {} } = cfg;
  if (!hasSummarySource(profiles)) return null;

  const source = buildSummarySource(profiles);
  if (!source.trim()) return null;

  const hint = String(cfg.hint || '').trim();
  const userText = [
    '下面是从图片里整理出来的资料。请把它们总结成角色卡设定。',
    hint ? `\n【用户补充设定（优先采纳，与资料冲突时以用户为准）】\n${hint}` : '',
    `\n${source}`,
    '\n再提醒一次：写**设定**，不要写"图片中/画面里"，也不要把经过写成剧情事件列表。',
  ].filter(Boolean).join('\n');

  const raw = await llm.chatJSON(S.STEP_IMAGE_SUMMARY, userText, 'image-summary');
  const summary = normalizeSummary(raw);

  if (!summary.characters.length) return null;
  send({
    step: 'Summary',
    msg: `信息总结完成：人物 ${summary.characters.length} 人 · `
      + `地点 ${summary.world.locations.length} · 势力 ${summary.world.factions.length} · `
      + `体系 ${summary.world.systems.length}`,
    ts: Date.now(),
  });
  return summary;
}

/**
 * 把一条人物设定渲染成世界书条目的 content（YAML）。
 *
 * 与 `renderContentYaml` 的区别（那个是"看图"路径的）：这里写的是**设定**，
 * 没有「图片未提供」「据画面推断」这类占位与来源标注 —— 缺的字段直接不写。
 * 用户明确不要"图片里怎么怎么样"，所以那套措辞不能进这张卡。
 *
 * @param {object} c 归一化后的 character
 * @param {object} [visual] 对应的视觉档案（补外貌用）
 */
export function renderSettingsYaml(c, visual = null) {
  const v = visual || {};
  const line = (k, val) => {
    const s = String(val || '').trim();
    return s ? `${k}: ${s.replace(/\n+/g, ' ')}` : '';
  };
  const block = (k, val) => {
    const s = String(val || '').trim();
    if (!s) return '';
    const indented = s.split('\n').map(x => `  ${x.trim()}`).filter(x => x.trim()).join('\n');
    return `${k}: |\n${indented}`;
  };

  const out = [];
  out.push(`name: ${String(c.name || '').trim() || '未命名'}`);
  if (c.aliases?.length) out.push(`aliases: [${c.aliases.join('、')}]`);
  if (c.gender) out.push(`gender: ${c.gender}`);
  if (c.age) out.push(`age: ${c.age}`);

  out.push(line('identity', c.identity));
  // 外貌：优先用总结里的，没有就用画面事实补（画面事实是"看得见的"，不是"图片里"）
  const appearance = String(c.appearance || '').trim()
    || [v.appearance, v.build ? `体型：${v.build}` : ''].filter(Boolean).join(' ').trim();
  out.push(block('appearance', appearance));
  const clothing = String(c.clothing || '').trim() || String(v.clothing || '').trim();
  out.push(block('clothing', clothing));
  out.push(block('personality', c.personality));
  if (v.personalityHints?.length && !c.personality) {
    out.push(block('personality', v.personalityHints.join('；')));
  }
  out.push(block('speechStyle', c.speechStyle));
  out.push(block('relations', c.relations));
  out.push(block('background', c.background));
  out.push(block('abilities', c.abilities));
  out.push(block('special_notes', c.notes));

  return out.filter(Boolean).join('\n');
}

/**
 * 把总结的世界设定渲染成世界书条目（交给我们自己的 `assembleWorldbook`）。
 *
 * 分类沿用项目既有的那一套，保证世界书结构与小说路径一致。
 */
export function worldbookFromSummary(summary = {}) {
  const w = summary.world || {};
  const items = [];

  if (w.overview) {
    items.push({
      category: 'map_world',
      name: '世界概览',
      keys: ['世界', '背景', '设定'],
      content: [w.overview, w.era ? `时代：${w.era}` : ''].filter(Boolean).join('\n'),
    });
  }
  const push = (list, category) => {
    for (const it of list || []) {
      items.push({ category, name: it.name, keys: it.keys?.length ? it.keys : [it.name], content: it.content });
    }
  };
  push(w.locations, 'map_location');
  push(w.factions, 'system_faction');
  push(w.systems, 'system_realm');
  push(w.history, 'history');

  return items;
}

/**
 * 由总结拼出卡的主字段。
 *
 * description 写"有谁、是谁、什么关系"；personality 写性格；scenario 用总结的舞台设定；
 * first_mes 用开场白。都拿不到时才用中性兜底 —— 不写"图片未提供"。
 */
export function cardFieldsFromSummary(summary = {}, { title = '', tags = [] } = {}) {
  const cs = Array.isArray(summary.characters) ? summary.characters : [];
  const w = summary.world || {};

  const descLines = [];
  for (const c of cs) {
    const bits = [c.identity, c.relations].map(x => String(x || '').trim()).filter(Boolean);
    const head = `【${c.name}】${c.age ? `（${c.age}）` : ''}`;
    descLines.push(bits.length ? `${head} ${bits.join(' ｜ ')}` : head);
  }
  if (w.overview) descLines.push('', w.overview);

  const personalityLines = cs
    .map(c => (c.personality ? `${c.name}：${c.personality}` : ''))
    .filter(Boolean);
  if (!personalityLines.length) {
    for (const c of cs) {
      if (c.speechStyle) personalityLines.push(`${c.name}：${c.speechStyle}`);
    }
  }

  return {
    name: title || cs[0]?.name || '角色卡',
    description: descLines.join('\n').trim() || '待补充',
    personality: personalityLines.join('\n').trim() || '待补充',
    scenario: String(summary.scenario || '').trim() || '待补充：请补充故事发生的舞台与处境。',
    first_mes: String(summary.opening || '').trim() || '',
    tags: tags || [],
  };
}

/**
 * 由总结构建"开场"事件。
 *
 * 图片路径**不抽剧情**（用户明确不要"图片里发生了什么"），
 * 但状态栏 / 导演指令 / 变量树需要一个落点，所以只造一个**开场处境**，
 * 内容来自总结的 scenario —— 它是"舞台"，不是"剧本"。
 */
export function openerFromSummary(summary = {}, characters = []) {
  const scenario = String(summary.scenario || '').trim();
  const location = String(summary.world?.locations?.[0]?.name || '').trim();
  const names = characters.map(c => c.name).filter(Boolean);
  return {
    name: '开场',
    pressure: 'core',
    chapter: '初始处境',
    time: '',
    storyline: '开场',
    participants: names,
    location,
    // 处境描述（一句话即可，不要写成剧情推进）
    note: scenario.split(/[。\n]/).filter(Boolean).slice(0, 2).join('。'),
  };
}
