/**
 * 图片内容当"原文"抽取剧情 —— 测试
 *
 * 这是对图片路径的**方向性修正**（用户原话）：
 *   「就是根据图片内容像根据小说内容生成的一样，不是什么根据图片描述啥的」
 *
 * 原来的图片路径只做「视觉描述 → 扁平人物档案 + 一条『与XX相遇』占位事件」，
 * 于是卡里全是「头像直径约 60 像素」这类画面描述，没有事件、没有世界观体系。
 * 现在把截图里的帖文/聊天记录/旁白当**原文**，复用小说路径的 STEP prompt
 * 抽事件、故事线、阶段、世界观；抽不到（纯立绘）才回退旧行为。
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

const N = await import(pathToFileURL(path.join(ROOT, 'src/image_narrative.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

/** 假 LLM：记录调用，按 system prompt 返回对应形状 */
function makeMockLLM() {
  const calls = [];
  return {
    calls, usage: {},
    async chatJSON(system, user) {
      calls.push({ system, user });
      if (/小说事件抽取器/.test(system)) {
        return [
          { name: '寝室夜谈', storyline: '寝室日常', chapter: '第1段', pressure: 'core', participants: ['uyu', '室友'], interventions: [] },
          { name: '关系确认', storyline: '寝室日常', chapter: '第1段', pressure: 'normal', participants: ['uyu'], interventions: [] },
        ];
      }
      if (/阶段划分器/.test(system)) return { phases: [{ name: '初识', coreChange: '两人关系确立', chapter: '第1段' }] };
      if (/人设变化抽取器/.test(system)) return { deltas: [{ character: 'uyu', change: '开始接受这段关系' }] };
      if (/世界观抽取器/.test(system)) {
        return { worldbook: [
          { category: 'map_location', name: '大学寝室', keys: ['寝室', '宿舍'], content: 'name: 大学寝室\ntype: 地点\n地理概况: 四人寝，上下铺，夜间熄灯。' },
          { category: 'system_faction', name: '室友关系', keys: ['室友'], content: 'name: 室友关系\ntype: 势力\n运作原理: 同寝室成员之间的日常关系网。' },
        ] };
      }
      if (/人物名单抽取器/.test(system)) return { characters: [{ name: 'uyu', aliases: ['@uyu1289742'] }, { name: '室友', aliases: [] }] };
      if (/人物档案抽取器/.test(system)) return { content_yaml: 'name: X\n身份: 同一寝室的大学生' };
      return {};
    },
  };
}

const PROFILES = [
  {
    name: '银发少女', imageIndex: 0, transcript: '寝室里住着一个想扣你逼的女人。\n我知道你听到我玩小玩具了，要不要和我一起',
    appearance: '银灰长发垂肩，肤色白皙', clothing: '深灰上衣', namesFromText: ['uyu'],
  },
  {
    name: '另一人', imageIndex: 0, transcript: '她说我们以后就以老婆相称啦，老婆我爱你！',
    appearance: '黑色短发', clothing: '', namesFromText: [],
  },
];

// ============================================================
console.log('\n【1】"原文"的构建与可用性判断');
{
  ok('有文字时判定为可抽取', N.hasNarrativeSource(PROFILES), '');
  ok('纯立绘判定为不可抽取（要回退旧路径）',
    !N.hasNarrativeSource([{ name: 'A', transcript: '', appearance: 'x' }]), '');
  ok('读不清的否定句不算内容',
    !N.hasNarrativeSource([{ transcript: '该段文字模糊不可辨' }]), '');
  ok('「画面无文字」不算内容', !N.hasNarrativeSource([{ transcript: '画面无文字' }]), '');

  const src = N.buildSourceText(PROFILES);
  ok('原文由转录组成', src.includes('寝室里住着'), '');
  ok('多张图的转录都进去', src.includes('老婆我爱你'), '');
  ok('重复转录会去重', (() => {
    const dup = [{ transcript: '同一段文字内容不变' }, { transcript: '同一段文字内容不变' }];
    return N.buildSourceText(dup).split('同一段文字内容不变').length === 2;
  })(), '');

  const roster = N.renderVisualRoster(PROFILES);
  ok('人物形象参考含外貌', roster.includes('银灰长发'), '');
  ok('人物形象参考含文字里的称呼', roster.includes('uyu'), '');

  const block = N.buildImageSourceBlock({ sourceText: src, visualRoster: roster, imageCount: 3 });
  ok('背景块说明"原文来自图片"', /原文.*来自 3 张图片/.test(block), '');
  ok('背景块明确"不要输出画面描述"', /不要输出.*画面描述/.test(block), '');
  ok('背景块带上人物形象', block.includes('银灰长发'), '');
}

// ============================================================
console.log('\n【2】转录切段（决定事件抽取跑几次）');
{
  const one = N.splitTranscriptIntoChunks('只有一段文字');
  ok('单段 → 1 个 chunk', one.length === 1, String(one.length));
  ok('chunk 带 title 与 index', one[0].title === '第1段' && one[0].index === 0, JSON.stringify(one[0].title));

  const marked = N.splitTranscriptIntoChunks('【第 1 段】\n甲内容\n\n【第 2 段】\n乙内容');
  ok('有显式段号时按段号切', marked.length === 2, String(marked.length));

  const long = Array.from({ length: 12 }, (_, i) => `第${i}段正文${'字'.repeat(400)}`).join('\n\n');
  const chunks = N.splitTranscriptIntoChunks(long, { targetLen: 1000 });
  ok('超长文本被切成多块', chunks.length > 1, String(chunks.length));
  ok('每块不超过目标上限的 1.5 倍',
    chunks.every(c => c.text.length <= 1500), JSON.stringify(chunks.map(c => c.text.length)));
  ok('原文不丢（拼接后长度接近）',
    chunks.reduce((s, c) => s + c.text.length, 0) >= long.length * 0.95, '');

  ok('空文本 → 0 块', N.splitTranscriptIntoChunks('').length === 0, '');
  ok('null 不崩', N.splitTranscriptIntoChunks(null).length === 0, '');
}

// ============================================================
console.log('\n【3】抽取：复用小说路径的 STEP，产出完整剧情结构');
{
  const llm = makeMockLLM();
  const nar = await N.extractNarrativeFromImages({ llm, profiles: PROFILES, imageCount: 2 });

  ok('抽出了事件', nar.events.length === 2, String(nar.events.length));
  ok('事件名来自剧情而非"与XX相遇"',
    nar.events.some(e => e.name === '寝室夜谈') && !nar.events.some(e => /相遇/.test(e.name)),
    JSON.stringify(nar.events.map(e => e.name)));
  ok('按故事线分组', Object.keys(nar.storylines).includes('寝室日常'), JSON.stringify(Object.keys(nar.storylines)));
  ok('抽出了阶段', nar.phases.length === 1, String(nar.phases.length));
  ok('阶段带人设增量', (nar.phases[0].characterDeltas || []).length === 1, JSON.stringify(nar.phases[0].characterDeltas));
  ok('抽出了世界观条目（地点 / 势力）', nar.worldbookItems.length === 2,
    JSON.stringify(nar.worldbookItems.map(w => w.name)));
  ok('世界观分类正确',
    nar.worldbookItems.some(w => w.category === 'map_location')
    && nar.worldbookItems.some(w => w.category === 'system_faction'),
    JSON.stringify(nar.worldbookItems.map(w => w.category)));
  ok('抽出了人物名单', nar.characters.length === 2, JSON.stringify(nar.characters.map(c => c.name)));

  // 复用小说 STEP 的证据：调用里出现了那几步的 prompt
  const used = llm.calls.map(c => c.system).join('\n');
  ok('用了小说的事件抽取 STEP', /小说事件抽取器/.test(used), '');
  ok('用了小说的阶段划分 STEP', /阶段划分器/.test(used), '');
  ok('用了小说的世界观抽取 STEP', /世界观抽取器/.test(used), '');
  ok('用了小说的人物名单 STEP', /人物名单抽取器/.test(used), '');
  ok('用了小说的人物档案 STEP', /人物档案抽取器/.test(used), '');

  // 人物档案那一步要带上画面形象，否则抽出来的角色没外貌
  const charCall = llm.calls.find(c => /人物档案抽取器/.test(c.system));
  ok('人物档案步骤带上了画面形象（文字身份 + 画面外貌）',
    /银灰长发/.test(charCall.user), charCall.user.slice(0, 200));

  ok('没有原文时返回 null（触发回退）',
    await N.extractNarrativeFromImages({ llm: makeMockLLM(), profiles: [{ transcript: '' }] }) === null, '');
}

// ============================================================
console.log('\n【4】装配：有叙事时用剧情结构，没有时回退');
{
  const llm = makeMockLLM();
  const nar = await N.extractNarrativeFromImages({ llm, profiles: PROFILES, imageCount: 2 });

  const withNar = await IC.buildCardFromExtraction({
    profiles: PROFILES, title: '图片卡', narrative: nar, wantStatusbar: false,
  });
  const entries = withNar.card.data.character_book.entries;

  ok('事件条目来自剧情', entries.some(e => /寝室夜谈/.test(e.comment)),
    JSON.stringify(entries.map(e => e.comment).filter(c => /event/.test(c))));
  ok('没有"与XX相遇"的占位事件', !entries.some(e => /相遇/.test(e.comment)), '');
  ok('世界观条目来自剧情（大学寝室）', entries.some(e => /大学寝室/.test(String(e.content))), '');
  ok('世界书条目数多于旧路径', withNar.worldbook.length >= 2, String(withNar.worldbook.length));
  ok('阶段用的是抽出来的（初识）',
    JSON.stringify(withNar.phases).includes('初识'), JSON.stringify(withNar.phases.map(p => p.name)));
  ok('人物来自文字抽取（uyu / 室友）',
    withNar.characters.some(c => c.name === 'uyu') && withNar.characters.some(c => c.name === '室友'),
    JSON.stringify(withNar.characters.map(c => c.name)));
  ok('世界书里有「图中文字（转录）」条目', entries.some(e => /图中文字/.test(e.comment)), '');
  ok('时间线如实标注未做日期推断', withNar.card && withNar.timeline?.approximate === true,
    JSON.stringify(withNar.timeline?.approximate));

  // 回退路径：没有 narrative
  const withoutNar = await IC.buildCardFromExtraction({
    profiles: PROFILES, title: '图片卡', wantStatusbar: false,
  });
  const e2 = withoutNar.card.data.character_book.entries;
  ok('无叙事时仍产出开场占位事件', e2.some(x => /相遇/.test(x.comment)),
    JSON.stringify(e2.map(x => x.comment).filter(c => /event/.test(c))));
  ok('无叙事时不崩', !!withoutNar.card, '');
}

// ============================================================
console.log('\n【5】人物合并：文字身份 + 画面外貌都要保住');
{
  const narChars = [
    { name: 'uyu', aliases: ['@uyu1289742'], profile: { content_yaml: 'name: uyu\n身份: 大学生' } },
    { name: '只在文字里的人', aliases: [], profile: { content_yaml: 'name: 只在文字里的人' } },
  ];
  const profiles = [
    { name: 'uyu', imageIndex: 3, confidence: 'medium', appearance: '外貌', clothing: '', aliases: [], namesFromText: [] },
    { name: '只在画面里的人', imageIndex: 1, confidence: 'high', appearance: '外貌B', clothing: '', aliases: [], namesFromText: [] },
  ];
  const merged = IC.mergeNarrativeCharacters(narChars, profiles, '');

  ok('文字里的人都成条', merged.some(c => c.name === 'uyu') && merged.some(c => c.name === '只在文字里的人'),
    JSON.stringify(merged.map(c => c.name)));
  ok('只在画面里出现的人也不丢', merged.some(c => c.name === '只在画面里的人'),
    JSON.stringify(merged.map(c => c.name)));
  ok('两边都保留 → 共 3 条', merged.length === 3, String(merged.length));

  const uyu = merged.find(c => c.name === 'uyu');
  ok('配对上画面后带上 imageIndex', uyu.imageIndex === 3, String(uyu.imageIndex));
  ok('文字档案优先（身份来自文字）', /大学生/.test(uyu.content_yaml), uyu.content_yaml);
  ok('文字侧条目被标记 fromNarrative', uyu.fromNarrative === true, '');
  const visualOnly = merged.find(c => c.name === '只在画面里的人');
  ok('纯画面条目被标记 visualOnly', visualOnly.visualOnly === true, '');
  ok('第一个人是主角', merged[0].tier === '主角', merged[0].tier);

  // 名字模糊匹配：文字说「银发少女」，画面叫「银发少女（图1）」
  const m2 = IC.mergeNarrativeCharacters(
    [{ name: '银发少女', aliases: [], profile: { content_yaml: 'x' } }],
    [{ name: '银发少女（图1）', imageIndex: 0, appearance: 'a' }], '');
  ok('名字带（图N）也能配上', m2.length === 1 && m2[0].imageIndex === 0,
    `${m2.length} 条 ${JSON.stringify(m2.map(c => c.name))}`);

  // 别名匹配
  const m3 = IC.mergeNarrativeCharacters(
    [{ name: '主角', aliases: ['阿悠'], profile: { content_yaml: 'x' } }],
    [{ name: '阿悠', imageIndex: 2, appearance: 'a' }], '');
  ok('通过别名配上', m3.length === 1 && m3[0].imageIndex === 2, JSON.stringify(m3.map(c => c.name)));

  // 边界
  ok('空输入不崩', IC.mergeNarrativeCharacters([], [], '').length === 0, '');
  ok('只有文字时不崩', IC.mergeNarrativeCharacters([{ name: 'A', profile: {} }], [], '').length === 1, '');
  ok('只有画面时不崩', IC.mergeNarrativeCharacters([], [{ name: 'B', appearance: 'x' }], '').length === 1, '');
}

// ============================================================
console.log('\n【6】接线：server 真的调用了叙事抽取');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  ok('import 了 extractNarrativeFromImages', /import \{ extractNarrativeFromImages/.test(srv), '');
  ok('在装配前调用', srv.indexOf('extractNarrativeFromImages({') < srv.indexOf('buildCardFromExtraction({\n        profiles: vision.profiles'), '');
  ok('把 narrative 传给装配段', /narrative,/.test(srv), '');
  ok('抽取失败不中断任务（有 catch 回退）', /抽取剧情失败，将只按画面生成人物档案/.test(srv), '');
  ok('没有原文时说明会回退', /没有可读文字/.test(srv), '');
  ok('buildCardFromExtraction 支持 narrative 参数', /cfg\.narrative/.test(await readFile(path.join(ROOT, 'src/image_card.js'), 'utf-8')), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片当原文抽取测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
