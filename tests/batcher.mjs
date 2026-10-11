/**
 * 分批评析 · 切批测试
 *
 * 覆盖：章数先到 / 字数先到 / 单章超大 / 不满一批 / 边界 / 摘要链。
 * 运行：node tests/batcher.mjs
 */
import {
  splitIntoBatches, buildDigest, formatDigest, createContextChain,
  describeBatches, DEFAULT_BATCH,
} from '../src/batcher.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}

/** 造章节：len 可以是数字，也可以是数组（逐章指定） */
const mk = (len, title) => ({ index: 0, title: title || `第${(mk.n = (mk.n || 0) + 1)}章`, text: 'x'.repeat(len) });
function chapterList(lengths) {
  return lengths.map((len, i) => ({ index: i, title: `第${i + 1}章`, text: 'x'.repeat(len) }));
}

// ============================================================
console.log('\n【1】默认参数');
{
  ok('默认每批 10 章', DEFAULT_BATCH.chapters === 10, String(DEFAULT_BATCH.chapters));
  ok('默认每批 3 万字', DEFAULT_BATCH.chars === 30000, String(DEFAULT_BATCH.chars));
}

// ============================================================
console.log('\n【2】章数先到');
{
  // 25 章 × 1000 字 → 10 章 = 10000 字，远小于 30000，所以章数先到
  const r = splitIntoBatches(chapterList(Array(25).fill(1000)));
  ok('切成 3 批', r.batches.length === 3, String(r.batches.length));
  ok('每批章数为 10/10/5',
    r.batches.map(b => b.chapters.length).join(',') === '10,10,5',
    r.batches.map(b => b.chapters.length).join(','));
  ok('不满一批的用剩余章节', r.batches[2].chapters.length === 5);
  ok('总章数守恒', r.totalChapters === 25);
  ok('批次 index 从 0 连续', r.batches.every((b, i) => b.index === i));
  ok('每批有章节标题范围', r.batches.every(b => b.firstTitle && b.lastTitle));
  ok('每批有 token 估算', r.batches.every(b => b.tokens > 0));
  ok('每批有字数', r.batches.every(b => b.chars > 0));
  ok('批次间不重叠',
    new Set(r.batches.flatMap(b => b.chapters.map(c => c.title))).size === 25);
}

// ============================================================
console.log('\n【3】字数先到');
{
  // 10 章 × 15000 字 = 15 万字；每批上限 3 万字 → 每批 2 章
  const r = splitIntoBatches(chapterList(Array(10).fill(15000)));
  ok('每批 2 章', r.batches.every(b => b.chapters.length === 2),
    r.batches.map(b => b.chapters.length).join(','));
  ok('切成 5 批', r.batches.length === 5, String(r.batches.length));
  ok('每批字数 ≤ 上限', r.batches.every(b => b.chars <= 30000), r.batches.map(b => b.chars).join(','));
}

// ============================================================
console.log('\n【4】单章超过字数上限 → 独占一批');
{
  const r = splitIntoBatches(chapterList([100, 50000, 100]));
  ok('切成 3 批', r.batches.length === 3, String(r.batches.length));
  ok('超大章独占一批', r.batches[1].chapters.length === 1 && r.batches[1].oversized === true,
    JSON.stringify(r.batches.map(b => ({ n: b.chapters.length, o: b.oversized }))));
  ok('给出 warning', r.warnings.length === 1, JSON.stringify(r.warnings));
  ok('warning 指明章节与字数', /50000/.test(r.warnings[0]) && /第2章/.test(r.warnings[0]), r.warnings[0]);
  ok('超大章没有被硬切（文本长度不变）', r.batches[1].chapters[0].text.length === 50000);
  ok('总字数守恒', r.batches.reduce((s, b) => s + b.chars, 0) === 50200);
}

// ============================================================
console.log('\n【5】边界');
{
  ok('空数组 → 0 批', splitIntoBatches([]).batches.length === 0);
  ok('null → 0 批', splitIntoBatches(null).batches.length === 0);
  ok('1 章 → 1 批', splitIntoBatches(chapterList([500])).batches.length === 1);
  ok('恰好 10 章 → 1 批', splitIntoBatches(chapterList(Array(10).fill(100))).batches.length === 1);
  ok('恰好 11 章 → 2 批', splitIntoBatches(chapterList(Array(11).fill(100))).batches.length === 2);
  ok('恰好 3 万字 → 1 批（不超限不切）',
    splitIntoBatches(chapterList([15000, 15000])).batches.length === 1);
  ok('3 万字 + 1 字 → 2 批',
    splitIntoBatches(chapterList([15000, 15001])).batches.length === 2);
  // 自定义参数
  const custom = splitIntoBatches(chapterList(Array(10).fill(100)), { chapters: 3, chars: 999999 });
  ok('自定义每批 3 章', custom.batches.map(b => b.chapters.length).join(',') === '3,3,3,1',
    custom.batches.map(b => b.chapters.length).join(','));
  const customChars = splitIntoBatches(chapterList(Array(10).fill(1000)), { chapters: 99, chars: 2500 });
  ok('自定义每批 2500 字', customChars.batches.every(b => b.chars <= 2500),
    customChars.batches.map(b => b.chars).join(','));
  // 非法参数回退默认
  ok('chapters=0 回退默认', splitIntoBatches(chapterList(Array(11).fill(100)), { chapters: 0 })
    .batches[0].chapters.length === 10);
  ok('chars=NaN 回退默认', splitIntoBatches(chapterList(Array(11).fill(100)), { chars: NaN })
    .batches[0].chapters.length === 10);
  // 章节顺序必须保持
  const ordered = splitIntoBatches(chapterList(Array(25).fill(100)));
  const titles = ordered.batches.flatMap(b => b.chapters.map(c => c.title));
  ok('章节顺序与原顺序一致', titles.join(',') === Array.from({ length: 25 }, (_, i) => `第${i + 1}章`).join(','));
  // 原始 chapters 不被修改
  const src = chapterList([100, 200]);
  const before = JSON.stringify(src);
  splitIntoBatches(src, { chapters: 1 });
  ok('不修改传入的 chapters', JSON.stringify(src) === before);
}

// ============================================================
console.log('\n【6】token 统计');
{
  const r = splitIntoBatches(chapterList(Array(25).fill(1000)));
  ok('totalTokens 等于各批之和',
    r.totalTokens === r.batches.reduce((s, b) => s + b.tokens, 0));
  ok('totalChars 等于全文',
    r.totalChars === 25000, String(r.totalChars));
  const d = describeBatches(r.batches);
  ok('describeBatches 汇总批数', d.total === 3);
  ok('describeBatches 汇总章数', d.chapters === 25);
  ok('describeBatches 每批明细长度一致', d.sizes.length === 3);
}

// ============================================================
console.log('\n【7】确定性摘要');
{
  const d = buildDigest({
    mentions: [{ chapter: '第一章' }, { chapter: '第二章' }],
    events: [{ name: '云京之变' }],
    roster: [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈砚' }],
    worldbook: [{ name: '云京' }],
  });
  ok('含章节', d.chapters.length === 2);
  ok('人物带别名', d.characters[0] === '林昭（阿昭）', d.characters[0]);
  ok('人物无别名时不加括号', d.characters[1] === '沈砚', d.characters[1]);
  ok('含事件名', d.events[0] === '云京之变');
  ok('含世界观名', d.worldbook[0] === '云京');
  ok('空输入不崩', !!buildDigest({}));
  ok('空输入各字段为空数组', buildDigest({}).characters.length === 0);

  // 截断要如实报告
  const many = buildDigest({ roster: Array.from({ length: 50 }, (_, i) => ({ name: `人${i}` })) }, { maxNames: 10 });
  ok('主名截断到 maxNames', many.characters.length === 10);
  ok('截断数被记下', many.charactersTruncated === 40, String(many.charactersTruncated));
}

// ============================================================
console.log('\n【8】摘要进 prompt 的格式');
{
  const d = buildDigest({ roster: [{ name: '林昭', aliases: ['阿昭'] }], events: [{ name: '云京之变' }] });
  const text = formatDigest({ ...d, summary: '前情提要' });
  ok('含前情摘要', text.includes('前情提要'));
  ok('含已出场人物', text.includes('已出场人物') && text.includes('林昭'));
  ok('含已抽取事件', text.includes('已抽取事件') && text.includes('云京之变'));
  ok('提示不要另起新名', text.includes('不要另起新名'));
  ok('空 digest → 空串', formatDigest(null) === '');
  ok('无内容 → 空串', formatDigest(buildDigest({})) === '');
}

// ============================================================
console.log('\n【9】上下文链');
{
  const chain = createContextChain();
  ok('初始为空', chain.size.characters === 0 && chain.size.events === 0);
  ok('初始 format 为空串', chain.format() === '');

  chain.add({ roster: [{ name: '林昭', aliases: ['阿昭'] }], events: [{ name: 'E1' }], summary: 'S1' });
  ok('累积 1 人', chain.size.characters === 1);
  ok('摘要已存', chain.summary === 'S1');
  ok('format 含摘要', chain.format().includes('S1'));

  // 重复人物不重复累积
  chain.add({ roster: [{ name: '林昭' }], events: [{ name: 'E1' }], summary: 'S2' });
  ok('重复人物只算一次', chain.size.characters === 1);
  ok('重复事件只算一次', chain.size.events === 1);
  ok('摘要被最新覆盖', chain.summary === 'S2');

  // 摘要为空 → 沿用旧的（摘要链断裂兜底）
  chain.add({ roster: [{ name: '沈砚' }], events: [{ name: 'E2' }], summary: '' });
  ok('摘要有新值才覆盖', chain.summary === 'S2', chain.summary);
  ok('人物继续累积', chain.size.characters === 2);
  ok('旧人物仍在新上下文里（隔多章再出场也能对上）',
    chain.format().includes('林昭') && chain.format().includes('沈砚'));

  // 纯空白摘要也算空
  chain.add({ roster: [], events: [], summary: '   ' });
  ok('空白摘要不覆盖', chain.summary === 'S2');

  // state / restore
  const st = chain.state();
  ok('state 含 roster/events/summary', Array.isArray(st.roster) && Array.isArray(st.events) && st.summary === 'S2');
  const c2 = createContextChain();
  c2.restore(st);
  ok('restore 后人物数一致', c2.size.characters === 2, String(c2.size.characters));
  ok('restore 后摘要一致', c2.summary === 'S2');
  ok('restore(null) 不崩', createContextChain().restore(null).size.characters === 0);
}

// ============================================================
console.log('\n【10】与 pipeline 的契约');
{
  // pipeline 依赖这些字段名，改名会让整条链路静默失效
  const r = splitIntoBatches(chapterList(Array(12).fill(1000)));
  const b = r.batches[0];
  for (const key of ['index', 'chapters', 'chars', 'tokens', 'firstTitle', 'lastTitle', 'oversized']) {
    ok(`批次含字段 ${key}`, key in b);
  }
  ok('章节保留 index/title/text 三字段',
    ['index', 'title', 'text'].every(k => k in b.chapters[0]));
  ok('chapter.title 原样保留（时间线靠它对齐）', b.chapters[0].title === '第1章');
}

// ============================================================
console.log('\n==============================================');
console.log(`  切批测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
