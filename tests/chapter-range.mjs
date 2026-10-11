/**
 * 章节范围测试（需求第十四节）。
 *
 * parseRange 与 chunkText 的 chapterRange 是**两个模式共用**的基础设施：
 * 从零生成与完善角色卡都靠它决定"处理哪些章"，所以边界必须钉死。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const { parseRange, chunkText, listChapters } = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ============================================================
console.log('【1】parseRange 基本用例');
{
  ok('parseRange(\'all\', 10) → [1..10]', eq(parseRange('all', 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    JSON.stringify(parseRange('all', 10)));
  ok('parseRange(\'1-5\', 10) → [1..5]', eq(parseRange('1-5', 10), [1, 2, 3, 4, 5]),
    JSON.stringify(parseRange('1-5', 10)));
  ok('parseRange(\'1,3,5-8\', 10) → [1,3,5,6,7,8]',
    eq(parseRange('1,3,5-8', 10), [1, 3, 5, 6, 7, 8]), JSON.stringify(parseRange('1,3,5-8', 10)));
  ok('parseRange(\'999\', 10) → []（越界忽略，不报错）', eq(parseRange('999', 10), []),
    JSON.stringify(parseRange('999', 10)));
}

// ============================================================
console.log('\n【2】parseRange 边界与容错');
{
  ok('空串 → 全部', eq(parseRange('', 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  ok('null → 全部', eq(parseRange(null, 10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  ok('undefined → 全部', eq(parseRange(undefined, 10).length, 10));
  ok('单个章号', eq(parseRange('3', 10), [3]));
  ok('写反的范围能自动纠正', eq(parseRange('5-1', 10), [1, 2, 3, 4, 5]));
  ok('纯字母 → 空', eq(parseRange('abc', 10), []));
  ok('重复章号去重并排序', eq(parseRange('3,1,3,2', 10), [1, 2, 3]));
  ok('0 与负数被忽略', eq(parseRange('0-3', 10), [1, 2, 3]));
  ok('范围超上限被截断', eq(parseRange('8-99', 10), [8, 9, 10]));
  ok('混合片段里的非法项不影响合法项', eq(parseRange('abc,2,xyz', 10), [2]));
  ok('空白容错', eq(parseRange(' 1 , 3 - 5 ', 10), [1, 3, 4, 5]));
  ok('total=0 时返回空', eq(parseRange('all', 0), []));
  ok('多余分隔符不炸', eq(parseRange('1,,2,', 10), [1, 2]));
}

// ============================================================
console.log('\n【3】chunkText 按 chapterRange 过滤');
{
  const novel = Array.from({ length: 10 }, (_, i) =>
    `第${i + 1}章 标题${i + 1}\n` + `第 ${i + 1} 章正文。`.repeat(60)).join('\n\n');

  const all = chunkText(novel, { chapterRange: 'all' });
  ok('all → 10 块', all.length === 10, String(all.length));

  const none = chunkText(novel, {});
  ok('不传 chapterRange → 10 块（等价 all）', none.length === 10, String(none.length));

  const r1 = chunkText(novel, { chapterRange: '1-5' });
  ok('1-5 → 5 块', r1.length === 5, String(r1.length));
  ok('1-5 拿到的是前 5 章', r1.every((c, i) => c.text.includes(`第 ${i + 1} 章正文`)));

  const pick = chunkText(novel, { chapterRange: '1,3,5-8' });
  ok('1,3,5-8 → 6 块', pick.length === 6, String(pick.length));
  ok('选中的章号正确',
    eq(pick.map(c => c.index + 1), [1, 3, 5, 6, 7, 8]), JSON.stringify(pick.map(c => c.index + 1)));

  let err = null;
  try { chunkText(novel, { chapterRange: '999' }); } catch (e) { err = e; }
  ok('选中为空时抛错（明确报错，不静默）', !!err, err ? '' : '没有抛错');
  ok('错误信息说明了章数与范围',
    /共 10 章/.test(err?.message || '') && /999/.test(err?.message || ''), err?.message);

  ok('每块都保留 index 与 title', pick.every(c => Number.isInteger(c.index) && typeof c.title === 'string'));
}

// ============================================================
console.log('\n【4】无章节标记的文本也能按范围选');
{
  const plain = 'A'.repeat(25000);
  const all = chunkText(plain, { maxLen: 6000 });
  ok('退化成分块', all.length === 5, String(all.length));
  ok('分块合计无丢失', all.reduce((s, c) => s + c.text.length, 0) === plain.length);

  const r = chunkText(plain, { maxLen: 6000, chapterRange: '2-3' });
  ok('按块号选择生效', r.length === 2, String(r.length));
  ok('选中的是第 2、3 块（index 0-based → 1、2）',
    eq(r.map(c => c.index), [1, 2]), JSON.stringify(r.map(c => c.index)));
}

// ============================================================
console.log('\n【5】listChapters（/api/chapters 的数据源）');
{
  const novel = Array.from({ length: 7 }, (_, i) =>
    `第${i + 1}章 标题${i + 1}\n` + `正文。`.repeat(80)).join('\n\n');
  const list = listChapters(novel);
  ok('章数正确', list.length === 7, String(list.length));
  ok('index 从 1 开始', list[0].index === 1, String(list[0].index));
  ok('index 连续', list.every((c, i) => c.index === i + 1));
  ok('每章都有 title 与 chars', list.every(c => typeof c.title === 'string' && c.chars > 0));
  ok('title 取首行（不含正文）', list.every(c => !c.title.includes('正文。')),
    JSON.stringify(list[0]));
  ok('chars 之和等于总字数',
    list.reduce((s, c) => s + c.chars, 0) === novel.trim().length
      || list.reduce((s, c) => s + c.chars, 0) > novel.length * 0.95,
    `${list.reduce((s, c) => s + c.chars, 0)} vs ${novel.length}`);
}

// ============================================================
console.log('\n【6】两个模式共用同一套语义（回归：口径必须一致）');
{
  // /api/generate 与 /api/augment 都调 chunkText({ chapterRange })，
  // 所以同一段文本 + 同一个 range 必须得到完全相同的块
  const novel = Array.from({ length: 6 }, (_, i) =>
    `第${i + 1}章\n` + `内容。`.repeat(50)).join('\n\n');
  const a = chunkText(novel, { chapterRange: '2-4' });
  const b = chunkText(novel, { chapterRange: '2-4' });
  ok('同一输入两次调用结果一致', eq(a.map(c => c.title), b.map(c => c.title)));
  ok("'all' 与不传参数一致",
    eq(chunkText(novel, { chapterRange: 'all' }).map(c => c.title),
      chunkText(novel, {}).map(c => c.title)));
}

// ============================================================
console.log('\n【7】超长章节必须按 maxLen 切开（回归：chunkMaxLen 曾完全失效）');
{
  /**
   * 真实故障：原实现只要文本里有 2 个以上章节标记就 `return parts.map(...)`，
   * **完全不看 maxLen**。实测一篇小说"前 13,000 字没有章节标记、后面才出现 第16章"，
   * 于是产生一个 15,630 字的巨型块，连锁导致章序全错、分批失效、提及塌陷。
   * 而且无论 chunkMaxLen 设成 6000/3000/1500 结果都一样 —— 这个设置项等于摆设。
   */
  // 造一篇"前面一大段无章节标记 + 后面才有章节号"的小说（整篇挤一行，模拟真实文件）
  const bigPart = '很长的正文内容，'.repeat(1200);            // 约 9600 字
  const novel = `书名标签#测试\n\n${bigPart}第16章 后半段，${bigPart}`;

  for (const maxLen of [1500, 3000, 6000]) {
    const chunks = chunkText(novel, { maxLen });
    const maxGot = Math.max(...chunks.map(c => c.text.length));
    ok(`maxLen=${maxLen}：每块都不超限`, maxGot <= maxLen, `最大 ${maxGot}`);
    ok(`maxLen=${maxLen}：切出多块（不再是一个巨型块）`, chunks.length > 1, String(chunks.length));
  }

  // 不同 maxLen 必须给出不同结果（否则说明设置没生效）
  const a = chunkText(novel, { maxLen: 1500 }).length;
  const b = chunkText(novel, { maxLen: 6000 }).length;
  ok('不同 maxLen 切出不同块数（设置真的生效）', a > b, `${a} vs ${b}`);

  // 内容不能丢
  const chunks = chunkText(novel, { maxLen: 3000 });
  const total = chunks.reduce((s, c) => s + c.text.length, 0);
  ok('切分后正文不丢（允许续块前言带来的少量重复）',
    total >= novel.length * 0.98 && total <= novel.length * 1.2,
    `${total} vs ${novel.length}`);

  // 标题不能是书名行（实测第 1 行是文件名时，标题曾变成整个文件名）
  ok('标题不是书名/文件名行',
    chunks.every(c => !/#测试/.test(c.title)),
    JSON.stringify(chunks.slice(0, 3).map(c => c.title)));
  ok('标题非空且不太长',
    chunks.every(c => c.title.length >= 1 && c.title.length <= 64),
    JSON.stringify(chunks.slice(0, 3).map(c => c.title)));

  // 正常格式的小说：首行标题必须原样保留（不能被"书名行"判据误伤）
  const normal = Array.from({ length: 5 }, (_, i) =>
    `第${i + 1}章 标题${i + 1}\n` + `正文。`.repeat(200)).join('\n\n');
  const nc = chunkText(normal, { maxLen: 3000 });
  ok('正常章节标题原样保留',
    nc.some(c => c.title === '第1章 标题1'), JSON.stringify(nc.map(c => c.title).slice(0, 3)));

  /**
   * 标题必须块块唯一。
   *
   * 踩过的坑：续块的前言都取自"本章第一句"，同一章的多个续块标题完全相同；
   * 而 `solveTimeline` 用 `Map<标题, 章序>` 建索引、同名只留第一个 ——
   * 5 个块塌成 2 个章序，时间线锚定错乱（实测把时间线清成了 0 条）。
   */
  {
    const oneLine = `书名标签#测试\n\n${'很长的正文，'.repeat(1500)}`;
    const cs = chunkText(oneLine, { maxLen: 1500 });
    const titles = cs.map(c => c.title);
    ok('块标题两两不同（否则章序映射会塌）',
      new Set(titles).size === titles.length,
      JSON.stringify(titles.slice(0, 6)));
  }
}

// ============================================================
console.log('\n【8】章节标记的多种真实格式');
{
  /**
   * 实测第二本小说用的是 `☆、001` 到 `☆、021`（21 章），
   * 而旧实现只认识 `第N章` —— 47,743 字里只切出 1 处"章节"，
   * 而且还是正文对话里「第一回到求道谷的？」的误命中，21 章结构全丢。
   */
  const body = '正文内容，'.repeat(60);
  const mk = (marks) => marks.map(m => `${m}\n${body}`).join('\n');

  const formats = {
    '☆、001（顿号）': ['☆、001', '☆、002', '☆、003'],
    '☆001（无分隔）': ['☆001', '☆002', '☆003'],
    '☆.001（点号）': ['☆.001', '☆.002', '☆.003'],
    '第1章（带标题）': ['第1章 标题1', '第2章 标题2', '第3章 标题3'],
    '第1章（无标题）': ['第1章', '第2章', '第3章'],
    '第一章（中文数字）': ['第一章 起始', '第二章 继续', '第三章 结束'],
    '第一回': ['第一回 入山', '第二回 出山', '第三回 归山'],
    '001.（纯编号）': ['001.', '002.', '003.'],
  };
  for (const [name, marks] of Object.entries(formats)) {
    const ch = listChapters(mk(marks));
    ok(`识别 ${name}`, ch.length === 3, `${ch.length} 章 ${JSON.stringify(ch.map(c => c.title))}`);
  }

  // 标题不能只剩标记残缺：`☆、` 就是 `☆、001` 被顿号截断的结果
  const star = listChapters(mk(['☆、001', '☆、002', '☆、003']));
  ok('☆、001 的标题完整（不被顿号截断）',
    star.every(c => /^☆、\d{3}$/.test(c.title)), JSON.stringify(star.map(c => c.title)));

  /**
   * 标记行必须限长。
   *
   * "整篇挤一行"的文件里，那一整行是几百上千字正文，天然以行首开头、
   * 且可能一个句号都没有 —— 会被误判成"章节标记行"。
   * 实测后果严重：前言无限叠加，产出 6000 万字的块。
   */
  const oneLine = `书名标签#测试\n\n${'很长的正文内容，'.repeat(1200)}`;
  const cs = chunkText(oneLine, { maxLen: 3000 });
  ok('整篇挤一行时块数正常（不被误判成海量章节）',
    cs.length > 1 && cs.length < 60, String(cs.length));
  ok('整篇挤一行时每块不超限',
    cs.every(c => c.text.length <= 3000), String(Math.max(...cs.map(c => c.text.length))));
  ok('整篇挤一行时前言叠加可控',
    cs.reduce((s, c) => s + c.text.length, 0) <= oneLine.length * 1.5,
    `${cs.reduce((s, c) => s + c.text.length, 0)} vs ${oneLine.length}`);

  /**
   * 正文对话里的「第一回」**不能**被当成章节分隔。
   *
   * 关键构造：对话要嵌在**段落中间**（真实形态），不能单独占一行 ——
   * 单独占一行时它看起来就是个章节行，那属于下面记录的已知取舍。
   */
  const dialogue = `第一回 开头\n${body}他愣了一下，问道“这位同门，可是第一回到求道谷的？”${body}`;
  ok('段落中间的对话「第一回」不算章节标记',
    listChapters(dialogue).length === 1, String(listChapters(dialogue).length));

  /**
   * 单行文本里的行内「第一回」也要排除。
   *
   * 这条曾经是"已知取舍"（只能切出 2 章），后来发现一个**结构性**判据：
   * `第一回到求道谷` 里的「第一回」后面紧跟续接虚词 `到`，
   * 是句中成分；真正的章节标记后面跟的是标题或句读。
   * 加上这条否定前瞻后，单行文本也能正确排除。
   */
  const oneLineDialogue = `第一回 开头${body}“可是第一回到求道谷的？”${body}`;
  ok('单行文本里，行内「第一回」也不算章节标记',
    listChapters(oneLineDialogue).length === 1,
    String(listChapters(oneLineDialogue).length));

  // 但真正的行内开新章必须仍能识别（整篇挤一行的文件靠它）
  const inlineChapters = `序章内容。第16章 荒唐的赌约${body}第17章 心照不宣${body}`;
  ok('单行文本里的行内真章节仍能识别',
    listChapters(inlineChapters).length === 2,
    String(listChapters(inlineChapters).length));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  章节范围测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
