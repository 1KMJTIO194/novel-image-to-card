/**
 * 人物分层测试（按剧情占比划分 主角 / 主要NPC / 次要NPC / 路人NPC）
 *
 * 覆盖：占比度量、阈值边界、主角优先级、旧档位兼容、变量树取舍、条目详略、跨批求和。
 * 运行：node tests/character-tiers.mjs
 */
import {
  NPC_TIERS, TIER_THRESHOLDS, TIER_RANK, LEGACY_ROLE_MAP, TIER_DETAIL,
  normalizeTier, tierGetsVariables,
} from '../src/tiers.js';
import {
  countChaptersPresent, classifyByStoryShare, formatShareHint,
  sanitizeRoster, buildVariables,
} from '../src/pipeline.js';
import { mergeRosters } from '../src/merge_batches.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}

/** 造章节：每章正文里带上指定的名字 */
const chapter = (title, names = []) => ({
  title,
  text: `这是${title}的正文。${names.join('，')}都在这章里出现了。`,
});

/**
 * ⚠️ 测试里不要用「甲」「乙」这种单字名：
 * appearsInTextLoose 对单字有最短长度保护（单字命中率太低，全是假阳性），
 * 单字名一律匹配不上，分层就会全落到"0 章"。
 * 真人名最少两个字，测试也应该用两个字以上的名字。
 */
const A = '林昭';
const B = '沈砚';
const C = '周管事';
const D = '卖花老人';

// ============================================================
console.log('\n【1】分层档位与兼容');
{
  ok('四档齐全', NPC_TIERS.join(',') === '主角,主要NPC,次要NPC,路人NPC', NPC_TIERS.join(','));
  ok('排序权重递增',
    TIER_RANK['主角'] < TIER_RANK['主要NPC']
    && TIER_RANK['主要NPC'] < TIER_RANK['次要NPC']
    && TIER_RANK['次要NPC'] < TIER_RANK['路人NPC'],
    JSON.stringify(TIER_RANK));
  // 旧档位必须映射，否则老批次文件/老预设读进来会全被当成未知
  ok('旧「主要配角」→ 主要NPC', normalizeTier('主要配角') === '主要NPC');
  ok('旧「次要配角」→ 次要NPC', normalizeTier('次要配角') === '次要NPC');
  ok('旧「提及」→ 路人NPC', normalizeTier('提及') === '路人NPC');
  ok('新档位原样保留', normalizeTier('主要NPC') === '主要NPC');
  ok('未知值用 fallback', normalizeTier('某某', '路人NPC') === '路人NPC');
  ok('空值用 fallback', normalizeTier('', '次要NPC') === '次要NPC');
  ok('LEGACY_ROLE_MAP 覆盖四个旧档', Object.keys(LEGACY_ROLE_MAP).length === 4);
  ok('只有路人NPC 不建变量',
    tierGetsVariables('主角') && tierGetsVariables('主要NPC')
    && tierGetsVariables('次要NPC') && !tierGetsVariables('路人NPC'));
  ok('每档都有详略定义', NPC_TIERS.every(t => TIER_DETAIL[t]?.label && TIER_DETAIL[t]?.fields));
  ok('主角要求的字数最多',
    TIER_DETAIL['主角'].minChars > TIER_DETAIL['主要NPC'].minChars
    && TIER_DETAIL['主要NPC'].minChars > TIER_DETAIL['次要NPC'].minChars);
  ok('阈值是 30% / 10%', TIER_THRESHOLDS.major === 0.3 && TIER_THRESHOLDS.minor === 0.1);
}

// ============================================================
console.log('\n【2】章节占比度量');
{
  const chunks = [
    chapter('第一章', ['林昭', '沈砚']),
    chapter('第二章', ['林昭']),
    chapter('第三章', ['林昭', '沈砚', '周管事']),
    chapter('第四章', ['林昭']),
  ];
  ok('贯穿全书 = 4 章', countChaptersPresent('林昭', [], chunks).chapters === 4);
  ok('两章 = 2', countChaptersPresent('沈砚', [], chunks).chapters === 2);
  ok('一章 = 1', countChaptersPresent('周管事', [], chunks).chapters === 1);
  ok('查无此人 = 0', countChaptersPresent('不存在的人', [], chunks).chapters === 0);
  ok('别名也能算到', countChaptersPresent('沈公子', ['沈砚'], chunks).chapters === 2);
  ok('空输入不崩', countChaptersPresent('', [], chunks).chapters === 0);
  ok('空章节列表不崩', countChaptersPresent('林昭', [], []).chapters === 0);
  ok('给出示例章节', countChaptersPresent('林昭', [], chunks).examples.length === 3);

  // 关键性质：**按章去重** —— 一章里出现 100 次也只算 1 章
  const spam = [{ title: '第一章', text: '林昭'.repeat(100) }, chapter('第二章', [])];
  ok('同一章内重复出现只算 1 章', countChaptersPresent('林昭', [], spam).chapters === 1);
}

// ============================================================
console.log('\n【3】阈值分层');
{
  // 10 章里各人的出场章节**互不重叠**：
  //   A → 第 1-5 章(50%)、B → 第 6-7 章(20%)、C → 第 8 章(10%)、D → 都不出现(0%)
  const chunks = Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return chapter(`第${n}章`, n <= 5 ? [A] : n <= 7 ? [B] : n === 8 ? [C] : []);
  });
  const r = classifyByStoryShare([
    { name: A },   // 5/10 = 50%
    { name: B },   // 2/10 = 20%
    { name: C },   // 1/10 = 10%
  ], chunks);
  const byName = Object.fromEntries(r.map(x => [x.name, x]));
  ok('50% → 主要NPC', byName[A].tier === '主要NPC', byName[A].tier);
  ok('20% → 次要NPC', byName[B].tier === '次要NPC', byName[B].tier);
  ok('10%（正好等于阈值）→ 次要NPC', byName[C].tier === '次要NPC', byName[C].tier);
  ok('占比算对', byName[A].storyRatio === 0.5, String(byName[A].storyRatio));
  ok('章节数带出来了', byName[A].storyChapters === 5);

  // 1/12 ≈ 8.3% → 低于 10% → 路人
  const low = classifyByStoryShare([{ name: D }],
    Array.from({ length: 12 }, (_, i) => chapter(`第${i}章`, i === 0 ? [D] : [])));
  ok('8.3% → 路人NPC', low[0].tier === '路人NPC', `${low[0].tier} / ${low[0].storyRatio}`);

  // 30% 边界（10 章里 3 章 = 30%）与 29%
  const at30 = classifyByStoryShare([{ name: A }],
    Array.from({ length: 10 }, (_, i) => chapter(`第${i}章`, i < 3 ? [A] : [])));
  ok('30%（正好等于阈值）→ 主要NPC', at30[0].tier === '主要NPC', `${at30[0].tier} / ${at30[0].storyRatio}`);
  const at29 = classifyByStoryShare([{ name: A }],
    Array.from({ length: 100 }, (_, i) => chapter(`第${i}章`, i < 29 ? [A] : [])));
  ok('29% → 次要NPC', at29[0].tier === '次要NPC', `${at29[0].tier} / ${at29[0].storyRatio}`);
}

// ============================================================
console.log('\n【4】主角优先级最高');
{
  const chunks = Array.from({ length: 100 }, (_, i) => chapter(`第${i}章`, i === 0 ? [A] : []));
  const r = classifyByStoryShare([{ name: A }], chunks, { protagonistName: A });
  // 群像作品里主角可能只占 1%，那份占比不该把它降级成路人NPC
  ok('主角哪怕只占 1% 也仍是主角', r[0].tier === '主角', `${r[0].tier} / ${r[0].storyRatio}`);
  ok('占比照实记录', r[0].storyChapters === 1);

  const noProto = classifyByStoryShare([{ name: A }], chunks, { protagonistName: '' });
  ok('没有主角名时按占比走', noProto[0].tier === '路人NPC', noProto[0].tier);

  // 主角名对不上任何人时不影响其它人
  const other = classifyByStoryShare([{ name: A }, { name: B }],
    Array.from({ length: 10 }, (_, i) => chapter(`第${i}章`, i < 5 ? [A] : [B])),
    { protagonistName: '不存在的名字' });
  ok('主角名对不上时其它人照常分层',
    other.every(x => x.tier === '主要NPC'), JSON.stringify(other.map(x => [x.name, x.tier])));
}

// ============================================================
console.log('\n【5】没有章节可统计时退回模型提示');
{
  const r = classifyByStoryShare([
    { name: A, role: '主角' },
    { name: B, role: '路人NPC' },
    { name: C, role: '主要配角' },   // 旧档位名
  ], []);
  const byName = Object.fromEntries(r.map(x => [x.name, x]));
  ok('无章节时保留主角', byName[A].tier === '主角', byName[A].tier);
  ok('无章节时保留路人', byName[B].tier === '路人NPC', byName[B].tier);
  ok('无章节时旧档位被映射', byName[C].tier === '主要NPC', byName[C].tier);
  ok('无章节时占比为 0', r.every(x => x.storyRatio === 0));

  // 全是空文本的章节也算"没有章节"
  const blank = classifyByStoryShare([{ name: A, role: '主角' }],
    [{ title: '空', text: '   ' }, { title: '也空', text: '' }]);
  ok('全空章节也退回提示', blank[0].tier === '主角', blank[0].tier);

  ok('空名单不崩', classifyByStoryShare([], []).length === 0);
  ok('null 不崩', classifyByStoryShare(null, null).length === 0);
}

// ============================================================
console.log('\n【6】共享提示文本');
{
  const chunks = [chapter('第一章', [A]), chapter('第二章', [A, B])];
  const r = classifyByStoryShare([{ name: A }, { name: B }], chunks);
  const hint = formatShareHint(r);
  ok('含角色名', hint.includes(A) && hint.includes(B), hint);
  ok('含章节数', new RegExp(`出现在 2 章`).test(hint), hint);
  ok('含百分比', /100%/.test(hint), hint);
  ok('按占比降序', hint.indexOf(A) < hint.indexOf(B), hint);
  ok('空输入返回空串', formatShareHint([]) === '');
  ok('无占比数据时返回空串', formatShareHint([{ name: A }]) === '');
}

// ============================================================
console.log('\n【7】sanitizeRoster 兼容新旧档位');
{
  const text = `${A}与${B}同行，${C}在后。`;
  const { roster } = sanitizeRoster([
    { name: A, aliases: [], role: '主要NPC' },
    { name: B, aliases: [], role: '主要配角' },   // 旧档位
    { name: C, aliases: [], role: '乱写的值' },
  ], text, { max: 5 });
  const byName = Object.fromEntries(roster.map(x => [x.name, x]));
  ok('新档位原样保留', byName[A].role === '主要NPC', byName[A].role);
  ok('旧档位保留原值（归并阶段还要靠它排序）', byName[B].role === '主要配角', byName[B].role);
  ok('无法识别的值兜底成次要NPC', byName[C].role === '次要NPC', byName[C].role);
  ok('排序按档位：主要NPC 在最前', roster[0].name === A, roster.map(r => r.name).join(','));
}

// ============================================================
console.log('\n【8】跨批归并：章节数必须求和');
{
  /**
   * ⚠️ 必须显式给出 `batchIndex`：归并靠它区分
   *   · 同一批里的同名重复条目 → 取最大值（同一批被抽两次不该算两份）
   *   · 不同批次 → 求和（各批章节互不相交）
   * 生产的 perBatch 每条记录都带批号，所以这里也必须带，否则测的是另一种输入。
   */
  const three = mergeRosters([
    [{ name: A, aliases: [], role: '主角', storyChapters: 10, batchIndex: 0 }],
    [{ name: A, aliases: [], role: '主角', storyChapters: 8, batchIndex: 1 }],
    [{ name: A, aliases: [], role: '主角', storyChapters: 5, batchIndex: 2 }],
  ]);
  ok('跨批章节数求和 = 23', three.roster[0].storyChapters === 23, String(three.roster[0].storyChapters));

  // 同一批里被抽两次：只算一次该批的量，不能重复累加
  const dup = mergeRosters([[
    { name: A, aliases: [], role: '主角', storyChapters: 10, batchIndex: 0 },
    { name: A, aliases: [], role: '主角', storyChapters: 10, batchIndex: 0 },
  ]]);
  ok('同一批内重复条目不重复计数', dup.roster[0].storyChapters === 10, String(dup.roster[0].storyChapters));

  // 别名归并后：两批分别记了 10 章与 3 章 → 求和
  const alias = mergeRosters([
    [{ name: A, aliases: [B], role: '主角', storyChapters: 10, batchIndex: 0 }],
    [{ name: B, aliases: [], role: '次要NPC', storyChapters: 3, batchIndex: 1 }],
  ]);
  ok('别名归并后章节数求和',
    alias.roster.length === 1 && alias.roster[0].storyChapters === 13,
    JSON.stringify(alias.roster.map(x => [x.name, x.storyChapters])));
  ok('归并后主名随等级高的那条', alias.roster[0].name === A, alias.roster[0].name);

  // 缺字段时不该产生 NaN
  const missing = mergeRosters([[{ name: A, aliases: [], role: '次要NPC', batchIndex: 0 }]]);
  ok('缺 storyChapters 时为 0 而不是 NaN',
    missing.roster[0].storyChapters === 0, String(missing.roster[0].storyChapters));
}

// ============================================================
console.log('\n【9】变量树只给非路人建变量');
{
  const mk = (tier, name, chapters) => ({ name, keys: [name], content: '档案', tier, storyChapters: chapters, storyRatio: chapters / 10 });
  const vars = buildVariables(
    { events: [], characters: [] }, [], {}, [
      mk('主角', '林昭', 10),
      mk('主要NPC', '沈砚', 8),
      mk('次要NPC', '周管事', 2),
      mk('路人NPC', '卖花老人', 1),
    ], [],
  );
  const keys = Object.keys(vars.characters);
  ok('主角建了变量', keys.includes('林昭'), keys.join(','));
  ok('主要NPC 建了变量', keys.includes('沈砚'), keys.join(','));
  ok('次要NPC 建了变量', keys.includes('周管事'), keys.join(','));
  ok('路人NPC 不建变量', !keys.includes('卖花老人'), keys.join(','));

  // 只有 role（没有 tier）的调用方也要能正确取舍 —— 旧档位映射
  const legacy = buildVariables(
    { events: [], characters: [] }, [], {}, [
      { name: '甲', keys: ['甲'], content: 'x', role: '主角' },
      { name: '乙', keys: ['乙'], content: 'x', role: '提及' },
    ], [],
  );
  ok('旧档位「提及」不建变量', !Object.keys(legacy.characters).includes('乙'),
    Object.keys(legacy.characters).join(','));
  ok('旧档位「主角」建变量', Object.keys(legacy.characters).includes('甲'));

  // 上限仍然生效
  const many = Array.from({ length: 30 }, (_, i) => mk('主要NPC', `角色${i}`, 5));
  const capped = buildVariables({ events: [], characters: [] }, [], {}, many, []);
  ok('变量树人物数有上限（12）', Object.keys(capped.characters).length === 12,
    String(Object.keys(capped.characters).length));
}

// ============================================================
console.log('\n【10】分层与条目详略');
{
  ok('路人NPC 的最低字数为 0（不要求展开）', TIER_DETAIL['路人NPC'].minChars === 0);
  ok('四档的字段要求各不相同',
    new Set(NPC_TIERS.map(t => TIER_DETAIL[t].fields)).size === 4);
  ok('次要NPC 明说"不确定的填未提及"', /未提及/.test(TIER_DETAIL['次要NPC'].fields));
  ok('路人NPC 明说只写身份与出处', /身份/.test(TIER_DETAIL['路人NPC'].fields));
}

// ============================================================
console.log('\n==============================================');
console.log(`  人物分层测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
