/**
 * 图片 → 角色卡：**总结信息成设定** 的测试
 *
 * 用户对这条路径的最终要求（原话）：
 *   「我认为通过图片生成角色卡应该是**总结图片里的内容信息**生成角色卡，
 *     而不是**图片里面怎么怎么样**，**图片里发生了什么剧情**等。」
 *
 * 所以这里钉住四件事：
 *   ① 卡里**不能**出现指涉图片本身的措辞（"图片中/画面里/截图中/头像/像素"）
 *   ② 卡里**不能**把经过写成剧情事件列表（不产出 event 条目）
 *   ③ 人物/世界设定要真的从信息里来（身份、关系、地点、势力）
 *   ④ 信息不足时**省略字段**，而不是写"图片未提供"占位
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const M = await import(pathToFileURL(path.join(ROOT, 'src/image_summary.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);

/** 指涉图片的措辞（卡里出现这些就说明它在描述图，而不是写设定） */
const IMAGE_RE = /图片|画面|截图|图中|本图|该图|头像中|像素|分辨率|构图/;

/** 假 LLM：返回一份"总结好的设定" */
function makeMockLLM(overrides = {}) {
  const calls = [];
  return {
    calls, usage: {},
    async chatJSON(system, user) {
      calls.push({ system, user });
      if (/设定撰写器/.test(system)) {
        return {
          world: {
            overview: '一所位于城市边缘的大学，作息松散、人际紧密。',
            era: '当代',
            locations: [{ name: '四人寝室', keys: ['寝室', '宿舍'], content: '上下铺，夜间熄灯，走廊尽头有公共洗漱间。' }],
            factions: [{ name: '室友圈', keys: ['室友'], content: '同寝室成员之间形成的紧密小圈子，彼此照顾也彼此试探。' }],
            systems: [],
            history: [],
          },
          characters: [
            {
              name: 'uyu', aliases: ['@uyu1289742'], gender: '女', age: '少女',
              identity: '住同一寝室的大学生',
              appearance: '银灰长发垂至肩前，肤色白皙，眼型细长。',
              clothing: '深灰上衣，领口包覆感强。',
              personality: '内向、容易紧张；对亲密关系既抗拒又动摇',
              speechStyle: '语速偏快，情绪激动时会重复词句',
              relations: '与同寝室室友关系复杂：从抗拒到逐渐接受',
              background: '开学不久，入住四人寝室',
            },
            {
              name: '室友', gender: '女',
              identity: '同寝室室友',
              personality: '主动、大胆，说话直接',
              relations: '对 uyu 主动示好',
            },
          ],
          scenario: '夜深，寝室只剩两人，走廊灯已熄。',
          opening: '「还不睡？」她把手机屏幕扣在胸口。',
          ...overrides,
        };
      }
      return {};
    },
  };
}

const PROFILES = [
  {
    name: '银发少女', imageIndex: 0, namesFromText: ['uyu'],
    transcript: '寝室里住着一个想扣你逼的女人。\n我知道你听到我玩小玩具了，要不要和我一起',
    appearance: '银灰长发垂肩', clothing: '深灰上衣', scene: '日式室内',
  },
  {
    name: '另一人', imageIndex: 1, transcript: '她说我们以后就以老婆相称啦',
    appearance: '黑色短发', clothing: '', scene: '日式室内',
  },
];

// ============================================================
console.log('\n【1】清洗：卡里不能出现指涉图片的措辞');
{
  ok('去掉句首"图片中是"', !/图片/.test(M.stripImageFraming('图片中是一位银发少女。')), M.stripImageFraming('图片中是一位银发少女。'));
  ok('去掉"画面中可见"', !/画面/.test(M.stripImageFraming('画面中可见深色上衣。')), M.stripImageFraming('画面中可见深色上衣。'));
  ok('去掉"截图中显示："', !/截图/.test(M.stripImageFraming('截图中显示：四人寝室，上下铺。')), M.stripImageFraming('截图中显示：四人寝室，上下铺。'));
  ok('去掉句中"画面里她"', M.stripImageFraming('姓名：uyu。画面里她穿着深灰上衣。') === '姓名：uyu。她穿着深灰上衣。',
    M.stripImageFraming('姓名：uyu。画面里她穿着深灰上衣。'));
  ok('把「（据画面推断）」收成「（推断）」',
    M.stripImageFraming('可能是大学生（据画面推断）。') === '可能是大学生（推断）。',
    M.stripImageFraming('可能是大学生（据画面推断）。'));
  ok('不破坏正常内容', M.stripImageFraming('她住同寝室，性格内向。') === '她住同寝室，性格内向。', '');
  ok('不把"图片"两字误伤成空串之外的东西（内容保留）',
    M.stripImageFraming('图片中是少女，长发及腰。').includes('长发及腰'), '');
  ok('hasImageFraming 能识别残留', M.hasImageFraming('图片中有一位少女') && !M.hasImageFraming('她是一位少女'), '');
  ok('空输入不崩', M.stripImageFraming('') === '' && M.stripImageFraming(null) === '', '');
}

// ============================================================
console.log('\n【2】资料汇总：转录 + 画面事实都要用到');
{
  const src = M.buildSummarySource(PROFILES);
  ok('含转录文字', src.includes('寝室里住着一个'), '');
  ok('含画面事实（外貌）', src.includes('银灰长发'), '');
  ok('含文字里的称呼', src.includes('uyu'), '');
  ok('重复转录会去重', (() => {
    const d = M.buildSummarySource([{ transcript: '同一段话内容不变' }, { transcript: '同一段话内容不变' }]);
    return d.split('同一段话内容不变').length === 2;
  })(), '');
  ok('没有资料时返回空串', M.buildSummarySource([]) === '', '');
  ok('hasSummarySource: 有文字为 true', M.hasSummarySource(PROFILES), '');
  ok('hasSummarySource: 纯立绘也为 true（画面事实也算资料）',
    M.hasSummarySource([{ appearance: '银发' }]), '');
  ok('hasSummarySource: 空档案为 false', !M.hasSummarySource([{}]), '');
}

// ============================================================
console.log('\n【3】prompt：明确禁止"图片里…"与"剧情事件"');
{
  const p = S.STEP_IMAGE_SUMMARY;
  ok('存在图片总结 prompt', typeof p === 'string' && p.length > 500, String(p && p.length));
  ok('要求总结成设定', /总结/.test(p) && /设定/.test(p), '');
  ok('明确禁止指涉图片本身', /不要指涉图片本身/.test(p), '');
  ok('列出禁止词（图片/画面/截图/头像/像素…）', /头像/.test(p) && /像素/.test(p) && /截图/.test(p), '');
  ok('明确禁止写剧情经过', /不要写剧情经过/.test(p), '');
  ok('要求省略而非写"图片未提供"', /不要写「图片未提供」|省略该字段/.test(p), '');
  ok('输出结构含 world / characters / scenario / opening',
    /"world"/.test(p) && /"characters"/.test(p) && /"scenario"/.test(p) && /"opening"/.test(p), '');
  ok('world 覆盖地点/势力/体系/历史',
    /locations/.test(p) && /factions/.test(p) && /systems/.test(p) && /history/.test(p), '');
  ok('人物字段含身份/性格/关系/说话方式',
    /"identity"/.test(p) && /"personality"/.test(p) && /"relations"/.test(p) && /"speechStyle"/.test(p), '');
}

// ============================================================
console.log('\n【4】归一化：清洗 + 缺字段安全默认');
{
  const s = M.normalizeSummary({
    world: {
      overview: '图片中是一所大学寝室。',
      locations: [{ name: '寝室', keys: ['寝室'], content: '四人寝，上下铺，夜间熄灯。' }],
      factions: [{ name: '室友圈', keys: ['室友'], content: '同寝室成员之间形成的小圈子。' }],
      systems: [{ name: '空', keys: [], content: '太短' }],   // content < 10 → 丢
    },
    characters: [
      { name: 'uyu', identity: '大学生', appearance: '图片中她留着银灰长发。', personality: '内向' },
      { name: '', appearance: 'x' },                          // 无名字 → 丢
      { name: '空壳' },                                       // 全无内容 → 丢
    ],
    scenario: '画面中：夜深，寝室只剩两人。',
    opening: '「还不睡？」',
  });
  ok('世界概览被清洗', !/图片/.test(s.world.overview), s.world.overview);
  ok('地点条目保留', s.world.locations.length === 1, String(s.world.locations.length));
  ok('过短的世界书条目被丢', s.world.systems.length === 0, String(s.world.systems.length));
  ok('人物只保留有内容的', s.characters.length === 1, JSON.stringify(s.characters.map(c => c.name)));
  ok('人物外貌被清洗', !/图片/.test(s.characters[0].appearance), s.characters[0].appearance);
  ok('scenario 被清洗', !/画面/.test(s.scenario), s.scenario);
  ok('缺字段给空串而不是 undefined',
    typeof s.characters[0].clothing === 'string' && s.characters[0].clothing === '', '');
  ok('null 不崩', (() => { const r = M.normalizeSummary(null); return r.characters.length === 0 && typeof r.world === 'object'; })(), '');
  ok('数组输入不崩', M.normalizeSummary([]).characters.length === 0, '');
}

// ============================================================
console.log('\n【5】设定 YAML：不写"图片未提供"占位');
{
  const yaml = M.renderSettingsYaml({
    name: 'uyu', aliases: ['@uyu1289742'], gender: '女', age: '少女',
    identity: '住同一寝室的大学生', appearance: '银灰长发', clothing: '深灰上衣',
    personality: '内向、容易紧张', speechStyle: '语速偏快', relations: '与室友关系复杂',
    background: '开学不久', notes: '习惯把手机扣在胸口',
  });
  ok('含 name/identity/personality', /name: uyu/.test(yaml) && /identity:/.test(yaml) && /personality: \|/.test(yaml), yaml.slice(0, 200));
  ok('外貌缺失时用画面事实补', (() => {
    const y = M.renderSettingsYaml({ name: 'x', identity: 'id' }, { appearance: '黑发', clothing: '白衣' });
    return /appearance: \|/.test(y) && /黑发/.test(y) && /白衣/.test(y);
  })(), '');
  ok('**不出现"图片未提供"**', !/图片未提供/.test(yaml), '');
  ok('**不出现"据画面推断"**', !/据画面推断/.test(yaml), '');
  ok('缺的字段直接省略（不留占位行）', !/abilities:/.test(M.renderSettingsYaml({ name: 'x', identity: 'y' })), '');
}

// ============================================================
console.log('\n【6】世界书与卡字段：来自总结的设定');
{
  const summary = M.normalizeSummary(await makeMockLLM().chatJSON(S.STEP_IMAGE_SUMMARY, 'x'));
  const items = M.worldbookFromSummary(summary);
  ok('生成了世界概览', items.some(i => i.category === 'map_world'), JSON.stringify(items.map(i => i.category)));
  ok('生成了地点条目', items.some(i => i.category === 'map_location' && i.name === '四人寝室'), '');
  ok('生成了势力条目', items.some(i => i.category === 'system_faction' && i.name === '室友圈'), '');
  ok('条目都带 keys（能被触发）', items.every(i => Array.isArray(i.keys) && i.keys.length > 0), '');

  const fields = M.cardFieldsFromSummary(summary, { title: '测试卡' });
  ok('description 写了身份与关系',
    /大学生/.test(fields.description) && /关系复杂/.test(fields.description), fields.description.slice(0, 120));
  ok('personality 写了性格', /内向/.test(fields.personality), fields.personality);
  ok('scenario 用总结的舞台设定', /夜深/.test(fields.scenario), fields.scenario);
  ok('first_mes 用总结的开场白', /还不睡/.test(fields.first_mes), fields.first_mes);
  ok('卡字段里没有指涉图片的措辞',
    !IMAGE_RE.test([fields.description, fields.personality, fields.scenario, fields.first_mes].join('\n')), '');
  ok('没有"图片未提供"占位',
    !/图片未提供/.test([fields.description, fields.personality, fields.scenario].join('\n')), '');
}

// ============================================================
console.log('\n【7】装配：不抽剧情，只留一个开场处境');
{
  const llm = makeMockLLM();
  const summary = await M.extractCardSummary({ llm, profiles: PROFILES });
  ok('总结成功返回对象', !!summary && summary.characters.length === 2, JSON.stringify(summary?.characters?.map(c => c.name)));

  const out = await IC.buildCardFromExtraction({
    profiles: PROFILES, title: '测试卡', summary, wantStatusbar: false,
  });
  const entries = out.card.data.character_book.entries;

  // ① 不产出剧情事件
  /**
   * `assembleWorldbook` 会为"事件"生成一条 `[event]` 条目 —— 这里只允许那**一条开场**，
   * 因为它不是"图片里发生了什么"，而是给角色扮演用的初始处境（状态栏/导演指令要落点）。
   * 真正的剧情事件（如"寝室夜谈""关系确认"）一条都不许有。
   */
  const eventEntries = entries.filter(e => /^\[event/.test(String(e.comment)));
  ok('没有剧情事件条目（只保留一个开场落点）',
    eventEntries.length <= 1 && eventEntries.every(e => /开场/.test(String(e.comment))),
    JSON.stringify(eventEntries.map(e => e.comment)));
  ok('没有剧情事件（不是"图片里发生了什么"）',
    !eventEntries.some(e => /夜谈|相遇|关系确认|随后/.test(String(e.comment))),
    JSON.stringify(eventEntries.map(e => e.comment)));
  ok('只有 1 个"开场"作为落点', out.events.length === 1 && /开场/.test(out.events[0].name),
    JSON.stringify(out.events.map(e => e.name)));
  ok('开场不叫"与XX相遇"（那种占位措辞）', !/相遇/.test(out.events[0].name), out.events[0].name);

  // ② 世界书来自总结（条目名在 comment 里，正文里不一定重复名字）
  const comments = entries.map(e => String(e.comment));
  ok('世界书含地点条目', comments.some(c => /四人寝室/.test(c)), JSON.stringify(comments.slice(-10)));
  ok('世界书含势力条目', comments.some(c => /室友圈/.test(c)), JSON.stringify(comments.slice(-10)));

  // ③ 人物设定来自总结，且带画面外貌
  const chars = out.characters;
  ok('人物来自总结', chars.some(c => c.name === 'uyu') && chars.some(c => c.name === '室友'),
    JSON.stringify(chars.map(c => c.name)));
  const uyu = chars.find(c => c.name === 'uyu');
  ok('人物 YAML 含身份（来自信息）', /identity:.*大学生/.test(uyu.content_yaml), uyu.content_yaml.slice(0, 160));
  ok('人物 YAML 不含"图片未提供"', !/图片未提供/.test(uyu.content_yaml), '');
  ok('人物 YAML 不含"据画面推断"', !/据画面推断/.test(uyu.content_yaml), '');
  ok('人物 YAML 不含指涉图片的措辞', !IMAGE_RE.test(uyu.content_yaml), uyu.content_yaml.slice(0, 160));

  // ④ 卡主字段
  const d = out.card.data;
  ok('description 不是"图片未提供…"', !/^图片未提供/.test(d.description.trim()), d.description.slice(0, 80));
  ok('description 写出了人物与关系', /uyu/.test(d.description) && /室友/.test(d.description), '');
  ok('personality 有内容', d.personality !== '待补充' && d.personality.length > 5, d.personality);
  ok('scenario 来自总结', /夜深/.test(d.scenario), d.scenario);
  ok('first_mes 来自总结开场白', /还不睡/.test(d.first_mes), d.first_mes);
  ok('卡里全部主字段都不指涉图片',
    !IMAGE_RE.test([d.description, d.personality, d.scenario, d.first_mes].join('\n')), '');
  ok('时间线标注未做日期推断', out.timeline.approximate === true, '');
  ok('返回 cardSummary 便于落盘核对', !!out.cardSummary, '');
}

// ============================================================
console.log('\n【8】总结失败时回退，但不崩');
{
  const out = await IC.buildCardFromExtraction({
    profiles: PROFILES, title: '回退卡', wantStatusbar: false,
  });
  const entries = out.card.data.character_book.entries;
  ok('无 summary 时仍能出卡', !!out.card, '');
  ok('回退时用占位开场', /相遇/.test(out.events[0].name), out.events[0].name);
  ok('回退时仍有人物条目', out.characters.length === PROFILES.length, String(out.characters.length));
  ok('回退时 cardSummary 为 null', out.cardSummary === null, String(out.cardSummary));

  const none = await M.extractCardSummary({ llm: makeMockLLM(), profiles: [{}] });
  ok('没有可用资料时返回 null', none === null, JSON.stringify(none));
}

// ============================================================
console.log('\n【9】接线：两个入口一致，且不再有"抽剧情"');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');
  const core = await readFile(path.join(ROOT, 'src/image_card.js'), 'utf-8');

  ok('Web 版 import 了 image_summary', /from '\.\/src\/image_summary\.js'/.test(srv), '');
  ok('Web 版调用 extractCardSummary', /extractCardSummary\(/.test(srv), '');
  ok('Web 版把 summary 传给装配', /summary: settingSummary/.test(srv), '');
  ok('Web 版总结失败不中断', /总结图片信息失败/.test(srv), '');
  ok('Web 版落盘 card_summary.json', /cardSummary: settingSummary/.test(srv), '');

  ok('插件 importCore 了 image_summary.js', /importCore\('image_summary\.js'\)/.test(plug), '');
  ok('插件调用 extractCardSummary', /extractCardSummary\(/.test(plug), '');
  ok('插件把 summary 传给装配', /summary: settingSummary/.test(plug), '');
  ok('插件总结失败不中断', /总结图片信息失败/.test(plug), '');

  ok('装配段支持 summary', /cfg\.summary/.test(core), '');
  ok('装配段不再有 narrative 分支', !/useNarrative|nar\.events/.test(core), '');
  ok('已删除旧的剧情抽取模块',
    !(await readFile(path.join(ROOT, 'src/image_narrative.js'), 'utf-8').then(() => true, () => false)), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片信息总结测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
