/**
 * 合并调用 vs 拆分调用：用量与产出对比（可长期保留的工具脚本）
 *
 * 用法：node scripts/compare-merge-usage.mjs
 *
 * 为什么要有它：
 *   "同一段正文只喂一次"这类优化，收益只能靠**同一条小说跑两遍**来量化。
 *   `llm.js` 的 usage 记账 + meta.json 的 usage 快照就是为此准备的。
 *   这个脚本把两遍跑完、并排打印，省得每次手工拼。
 *
 * 它同时充当**回退路径的回归测试**：三个合并开关全关时必须仍能跑通，
 * 且调用次数明显多于合并版 —— 否则说明回退分支已经烂掉了（那种问题
 * 平时跑不到，等真需要回退时才发现就晚了）。
 *
 * 用假 LLM（不发真实请求、不花钱），所以结论只关于**字符数与调用结构**，
 * 不能替代真实长篇上的质量对比。
 */
import http from 'node:http';
import path from 'node:path';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { runPipeline } from '../src/pipeline.js';

const MOCK_PORT = 3135;
const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const cn = (n) => (n <= 10 ? CN[n] : n < 20 ? `十${CN[n % 10] || ''}` : `${CN[Math.floor(n / 10)]}十${CN[n % 10] || ''}`);

/** 角色数刻意多一些，才能看出"每角色一份抽样"的差别 */
const CAST = ['林昭', '沈砚', '周管事', '苏九', '老陈', '阿福', '柳娘', '卖花老人', '黑衣人', '茶博士'];
const CHAPTERS = 30;

/**
 * 假 LLM 的应答表。
 *
 * ⚠️ 键必须是**能区分合并版与单任务版 prompt 的短语**：
 *   · 合并版的批量档案 prompt 开头也是"你是人物档案抽取器"，
 *     用这个短键会让单任务版应答命中合并版请求 → 每个角色都判为"缺失" →
 *     退化成逐个补抽，优化**静默失效**（这个坑踩过一次）。
 *   · 按 includes 逐键匹配，所以单任务版的键要放在合并版之后。
 */
const MERGED = {
  '章节级多任务抽取器': {
    mentions: [
      { scope: 'story', type: 'absolute', raw: '天启三年春', quote: 'q', event: '开篇入城', subject: null, anchor: null },
      { scope: 'history', type: 'absolute', raw: '百年前', quote: 'q', event: '天下大乱', subject: null, anchor: null },
    ],
    events: [
      { name: '开篇入城', storyline: '主线', chapter: 'C', quote: 'q', canon: 'c', pressure: 'core', prerequisites: {}, interventions: [] },
      { name: '初见沈砚', storyline: '主线', chapter: 'C', quote: 'q', canon: 'c', pressure: 'buffer', prerequisites: {}, interventions: [] },
    ],
  },
  '世界观与物品抽取器': {
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', dynamicHint: '' },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案。', dynamicHint: '' },
      { category: 'history', name: '十年前的火灾', keys: ['火灾'], content: 'name: 十年前的火灾\ntype: 历史事件\n层级或构成: 烧掉半条长街。', dynamicHint: '' },
    ],
    items: [
      { category: 'system_item', name: '密信', keys: ['密信'], content: 'name: 密信\ntype: 物品\n外观: 半张残图。', dynamicHint: '' },
    ],
  },
  '你是人物档案抽取器。给定**同一份原文节选**': {
    profiles: CAST.map(n => ({
      name: n, keys: [n],
      content_yaml: `name: ${n}\ntitle: 某人\nage: 二十\nappearance: |\n  素衣少女，眉目清淡。\npersonality: |\n  沉静果决。\nbackground: |\n  出身寒微。`,
    })),
  },
};

const SPLIT = {
  '你是人物档案抽取器。对给定角色': {
    name: 'x', keys: ['x'],
    content_yaml: 'name: x\ntitle: 某人\nage: 二十\nappearance: |\n  素衣少女。\npersonality: |\n  沉静果决。',
  },
  '时间线抽取器': [
    { scope: 'story', type: 'absolute', raw: '天启三年春', quote: 'q', event: '开篇入城', subject: null, anchor: null },
    { scope: 'history', type: 'absolute', raw: '百年前', quote: 'q', event: '天下大乱', subject: null, anchor: null },
  ],
  '小说事件抽取器': [
    { name: '开篇入城', storyline: '主线', chapter: 'C', quote: 'q', canon: 'c', pressure: 'core', prerequisites: {}, interventions: [] },
    { name: '初见沈砚', storyline: '主线', chapter: 'C', quote: 'q', canon: 'c', pressure: 'buffer', prerequisites: {}, interventions: [] },
  ],
  '从给定小说中抽取世界观设定条目': [
    { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', dynamicHint: '' },
    { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案。', dynamicHint: '' },
    { category: 'history', name: '十年前的火灾', keys: ['火灾'], content: 'name: 十年前的火灾\ntype: 历史事件\n层级或构成: 烧掉半条长街。', dynamicHint: '' },
  ],
  '物品条目抽取器': [
    { category: 'system_item', name: '密信', keys: ['密信'], content: 'name: 密信\ntype: 物品\n外观: 半张残图。', dynamicHint: '' },
  ],
};

const COMMON = {
  '叙事结构': { hasSingleProtagonist: true, protagonistName: '林昭', protagonistGender: 'female', reason: 'r' },
  '时间线锚点识别器': { base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城', reason: 'r' } },
  '阶段划分器': { phases: [{ name: '入城立足', startEvent: '开篇入城', endEvent: '初见沈砚', coreChange: '从孤身寻亲到获得助力' }] },
  '人设变化抽取器': { phase: 'x', deltas: [{ character: '林昭', change: '转向主动' }] },
  '热门作品': { wellKnown: false, reason: 'r' },
  '人物名单抽取器': CAST.map((n, i) => ({ name: n, aliases: [], role: i === 0 ? '主角' : i < 4 ? '主要NPC' : '次要NPC' })),
  '分批阅读助手': { summary: '本批推进。', phase: '入城', newCharacters: ['林昭'] },
  '事件条目抽取器': [
    { name: '开篇入城', keys: ['开篇入城'], content_yaml: '起因: a\n经过: b\n结果: c\n影响: d\n干预分支: e' },
  ],
};

const reqLog = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const system = p.messages?.find(m => m.role === 'system')?.content || '';
    const user = p.messages?.find(m => m.role === 'user')?.content || '';
    let key = '(none)';
    let out = { ok: true };
    for (const table of [MERGED, SPLIT, COMMON]) {
      let hit = false;
      for (const k of Object.keys(table)) {
        if (system.includes(k)) { key = k; out = table[k]; hit = true; break; }
      }
      if (hit) break;
    }
    reqLog.push({ key, chars: system.length + user.length });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }] }));
  });
});

const sentence = '林昭沿着长街慢慢走，心里想着兄长留下的那句话，街市两侧的灯笼刚刚点亮。';
const pad = sentence.repeat(Math.ceil(1200 / sentence.length));
const NOVEL = Array.from({ length: CHAPTERS }, (_, i) => {
  const n = i + 1;
  return `第${cn(n)}章 标题${n}\n\n${CAST.join('、')}都在场。${pad}`;
}).join('\n\n');

async function run(label, opts) {
  const outDir = path.resolve('output', `task_usage-${label}`);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const novelPath = path.join(outDir, '_novel.txt');
  await writeFile(novelPath, NOVEL, 'utf-8');
  const before = reqLog.length;
  try {
    const r = await runPipeline({
      outDir, novelPath, imagePaths: [],
      baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: 'k', model: 'mock-large',
      title: `usage ${label}`, userMode: 'auto', outputMode: 'both', chapterRange: 'all',
      concurrency: 1, ...opts,
    }, () => {});
    // 顺带核对产物：两条路径都要能交出完整的卡与世界书
    const wb = JSON.parse(await readFile(path.join(outDir, 'worldbook.json'), 'utf-8'));
    const cc = JSON.parse(await readFile(path.join(outDir, 'character_card.json'), 'utf-8'));
    const charEntries = wb.entries.filter(e => String(e.comment).startsWith('[character'));
    const varKeys = Object.keys(JSON.parse(await readFile(path.join(outDir, 'variables.json'), 'utf-8')).characters || {});
    return {
      label, usage: r.meta?.usage, calls: reqLog.length - before, log: reqLog.slice(before),
      products: {
        wbEntries: wb.entries.length,
        charEntries: charEntries.length,
        cardEntries: cc.data.character_book.entries.length,
        varChars: varKeys.length,
      },
    };
  } catch (e) {
    console.log(`  ${label} 报错：${e.message}`);
    return { label, usage: null, calls: reqLog.length - before, log: reqLog.slice(before), products: null };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

// ============================================================
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
console.log(`假 LLM 对比：小说 ${NOVEL.length} 字 / ${CHAPTERS} 章 / ${CAST.length} 个角色\n`);

const split = await run('split', { mergeChapterCalls: false, mergeWorldCalls: false, mergeCharCalls: false, charBatchSize: 1 });
const merged = await run('merged', { mergeChapterCalls: true, mergeWorldCalls: true, mergeCharCalls: true, charBatchSize: 6 });

const fmt = (n) => Number(n).toLocaleString().padStart(11);
console.log('='.repeat(72));
console.log(`${'指标'.padEnd(20)}${'拆分（关掉合并）'.padStart(16)}${'合并（默认）'.padStart(15)}${'变化'.padStart(13)}`);
console.log('-'.repeat(72));
const row = (name, a, b) => {
  const diff = a ? `${((b - a) / a * 100).toFixed(1)}%` : '—';
  console.log(`${name.padEnd(20)}${String(a).padStart(16)}${String(b).padStart(15)}${diff.padStart(13)}`);
};
if (split.usage && merged.usage) {
  row('请求次数', split.usage.calls, merged.usage.calls);
  row('输入字符', split.usage.inputChars, merged.usage.inputChars);
  row('输出字符', split.usage.outputChars, merged.usage.outputChars);
  row('失败调用', split.usage.failedCalls, merged.usage.failedCalls);
  row('输入/正文字符', split.usage.inputPerNovelChar, merged.usage.inputPerNovelChar);
  console.log('-'.repeat(72));
  const save = split.usage.inputChars - merged.usage.inputChars;
  console.log(`输入节省 ${save.toLocaleString()} 字符 = ${(save / split.usage.inputChars * 100).toFixed(1)}%`
    + `；请求减少 ${split.usage.calls - merged.usage.calls} 次`);
}

console.log('\n【产物核对：两条路径都必须交出完整的卡】');
for (const r of [split, merged]) {
  const p = r.products;
  console.log(`  ${r.label.padEnd(7)} 世界书 ${p?.wbEntries} 条 / 人物条目 ${p?.charEntries} / 卡内条目 ${p?.cardEntries} / 变量树人物 ${p?.varChars}`);
}

console.log('\n【按 Step —— 拆分版】');
for (const [k, v] of Object.entries(split.usage?.byStep || {}).sort((a, b) => (b[1].systemChars + b[1].userChars) - (a[1].systemChars + a[1].userChars))) {
  const t = v.systemChars + v.userChars;
  console.log(`  ${String((t / split.usage.inputChars * 100).toFixed(1)).padStart(5)}%  ${String(v.calls).padStart(3)} 次  ${fmt(t)}  ${k}`);
}
console.log('\n【按 Step —— 合并版】');
for (const [k, v] of Object.entries(merged.usage?.byStep || {}).sort((a, b) => (b[1].systemChars + b[1].userChars) - (a[1].systemChars + a[1].userChars))) {
  const t = v.systemChars + v.userChars;
  console.log(`  ${String((t / merged.usage.inputChars * 100).toFixed(1)).padStart(5)}%  ${String(v.calls).padStart(3)} 次  ${fmt(t)}  ${k}`);
}

// ============================================================
// 断言：回退路径没烂、合并路径确实更省、两条路径产物等价
// ============================================================
console.log('\n【断言】');
let bad = 0;
const check = (name, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : ` —— ${extra}`}`);
  if (!cond) bad++;
};
check('拆分路径跑通且无失败调用', split.usage && split.usage.failedCalls === 0, JSON.stringify(split.usage?.failedCalls));
check('合并路径跑通且无失败调用', merged.usage && merged.usage.failedCalls === 0, JSON.stringify(merged.usage?.failedCalls));
if (split.usage && merged.usage) {
  check('合并后请求数明显减少（至少 30%）',
    merged.usage.calls <= split.usage.calls * 0.7,
    `${split.usage.calls} → ${merged.usage.calls}`);
  check('合并后输入字符明显减少（至少 25%）',
    merged.usage.inputChars <= split.usage.inputChars * 0.75,
    `${split.usage.inputChars} → ${merged.usage.inputChars}`);
  check('逐章合并生效（step1+step2 出现）', 'step1+step2' in (merged.usage.byStep || {}),
    Object.keys(merged.usage.byStep || {}).join(','));
  check('拆分路径没有合成 step 键', !Object.keys(split.usage.byStep || {}).some(k => k.includes('+')),
    Object.keys(split.usage.byStep || {}).join(','));
}
for (const key of ['wbEntries', 'charEntries', 'cardEntries', 'varChars']) {
  check(`两条路径产物一致（${key}）`,
    split.products?.[key] === merged.products?.[key],
    `拆分 ${split.products?.[key]} vs 合并 ${merged.products?.[key]}`);
}
check('人物档案批量确实减少了调用（拆分=角色数，合并<角色数）',
  (split.usage?.byStep?.step5?.calls || 0) > (merged.usage?.byStep?.step5?.calls || 0),
  `step5 调用 拆分 ${split.usage?.byStep?.step5?.calls} vs 合并 ${merged.usage?.byStep?.step5?.calls}`);

mock.close();
console.log(bad ? `\n❌ ${bad} 条断言失败` : '\n✅ 全部断言通过');
process.exit(bad ? 1 : 0);
