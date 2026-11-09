/**
 * 事件条目「按剧情段落生成」测试（P0）
 *
 * 背景（实测缺陷）：
 *   旧实现全书只调一次写所有事件条目，原文节选是 `chunks.slice(0, 4)`。
 *   25 章的书，第 5 章以后的事件正文模型根本没看过对应原文。
 *
 * 新实现：事件按批次（剧情段落）分组，每段一次调用、只喂该段原文；
 *   剧情简介单独一次调用（输入只用事件清单 + 分批摘要）。
 *
 * 这里钉住：
 *   ① 分组逻辑（章节标题 / 中文数字 / 归不进批次的兜底）
 *   ② 完整版默认按段写、基础版默认全书一次
 *   ③ 每段调用**只带自己那段的原文**（不能混入别段）
 *   ④ 最后一段（旧实现永远看不到的第 5 章之后）也真的被喂到了
 *   ⑤ 简介在按段模式下单独生成，且事件一条都不丢
 *   ⑥ eventEntriesPerBatch 可强制开/关
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const ES = await import(pathToFileURL(path.join(ROOT, 'src/event_segments.js')).href);
const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);

// ============================================================
console.log('\n【1】事件打章节标记');
{
  const src = [{ name: 'e1' }, { name: 'e2', chapter: '已有章节' }];
  const out = ES.stampChapter(src, '第1章 雪原');
  ok('没有 chapter 的事件补上章节', out[0].chapter === '第1章 雪原', '');
  ok('已有 chapter 的不覆盖', out[1].chapter === '已有章节', '');
  ok('不修改原数组对象', src[0].chapter === undefined, '');
  ok('非数组输入返回空数组', ES.stampChapter(null, 'x').length === 0, '');
}

// ============================================================
console.log('\n【2】事件按剧情段落分组');
{
  const batches = [
    { chapters: [{ title: '第1章 雪原', text: 'A1' }, { title: '第2章 石屋', text: 'A2' }] },
    { chapters: [{ title: '第3章 出山', text: 'B1' }, { title: '第4章 进城', text: 'B2' }] },
    { chapters: [{ title: '第5章 试炼', text: 'C1' }] },
  ];
  const ev = ES.stampChapter([{ name: 'e1' }, { name: 'e2' }, { name: 'e3' }, { name: 'e4' }], '第1章 雪原');
  ev[1].chapter = '第3章 出山';
  ev[2].chapter = '第三章 出山';       // 中文数字
  ev[3].chapter = '';                  // 无章节 → 兜底
  const g = ES.groupEventsBySegment(ev, batches);

  ok('分成 2 段（第3段没有事件）', g.segments.length === 2, String(g.segments.length));
  ok('段按批次顺序排列', g.segments[0].batchIndex === 0 && g.segments[1].batchIndex === 1, '');
  ok('第1段含 e1', g.segments[0].events.map(e => e.name).join(',') === 'e1', '');
  ok('第2段含 e2/e3（精确 + 中文数字匹配）',
    g.segments[1].events.map(e => e.name).join(',') === 'e2,e3', g.segments[1].events.map(e => e.name).join(','));
  ok('无章节的事件进兜底', g.unmatched.map(e => e.name).join(',') === 'e4', '');
  ok('段文本只含本段章节',
    g.segments[0].text.includes('A1') && g.segments[0].text.includes('A2')
    && !g.segments[0].text.includes('B1'), '');
  ok('段标签可读', /第 1 段/.test(g.segments[0].label), g.segments[0].label);
  ok('统计正确', g.stats.inputEvents === 4 && g.stats.matchedEvents === 3 && g.stats.unmatchedEvents === 1,
    JSON.stringify(g.stats));

  ok('空事件不崩', ES.groupEventsBySegment([], batches).segments.length === 0, '');
  ok('空批次不崩', ES.groupEventsBySegment(ev, []).unmatched.length === 4, '');
  ok('批次没有章节时不崩', ES.groupEventsBySegment(ev, [{ chapters: [] }]).segments.length === 0, '');
}

// ============================================================
console.log('\n【3】兜底原文：按章节取，而不是永远前 4 章');
{
  const chunks = [
    { title: '第1章 a', text: 'A' }, { title: '第2章 b', text: 'B' },
    { title: '第3章 c', text: 'C' }, { title: '第4章 d', text: 'D' },
    { title: '第5章 e', text: 'E' },
  ];
  const ex = ES.fallbackExcerpt(chunks, ['第5章 e'], 1000);
  ok('只取指定章节', ex.includes('E') && !ex.includes('A'), ex.slice(0, 40));
  const all = ES.fallbackExcerpt(chunks, [], 1000);
  ok('没指定章节时取全部', all.includes('A') && all.includes('E'), '');
  ok('超过上限会截断', ES.fallbackExcerpt(chunks, [], 10).length <= 10, '');
}

// ============================================================
/** 假 LLM 跑一次流水线，记录每次调用的 system / user */
async function runOnce({ detailLevel, eventEntriesPerBatch, chapters = 12, batchChapters = 3 }) {
  const chapterTitles = Array.from({ length: chapters }, (_, i) => `第${i + 1}章 剧情段${i + 1}`);
  const chapterTexts = chapterTitles.map((t, i) => `【唯一标记CH${i + 1}】` + '剧情推进，人物行动。'.repeat(40));

  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
    const user = (body.messages || []).find(m => m.role === 'user')?.content || '';
    const kind = /章节级多任务抽取器/.test(sys) ? 'chapter'
      // 合并路径的 prompt 同时提到"事件条目撰写器"和"剧情梗概撰写器"，要单独归类
      : /事件条目撰写器与剧情梗概撰写器/.test(sys) ? 'event+synopsis'
        : /事件条目抽取器|事件条目撰写器/.test(sys) ? 'event'
          : /剧情梗概撰写器/.test(sys) ? 'synopsis'
            : 'other';
    calls.push({ kind, sys, user });

    let out = {};
    if (kind === 'chapter') {
      const title = (user.match(/章节：([^\n]+)/) || [])[1] || '';
      const n = (title.match(/第(\d+)章/) || [])[1] || '0';
      out = {
        mentions: [],
        events: [{ name: `事件${n}`, canon: `第 ${n} 段剧情`, pressure: 'buffer' }],
      };
    } else if (kind === 'event') {
      const names = [...user.matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
      out = names.map(n => ({
        name: n,
        keys: [n],
        content_yaml: `name: ${n}\n起因: |\n  ${'起因描述。'.repeat(20)}\n经过: |\n  ${'经过描述。'.repeat(20)}`,
      }));
    } else if (kind === 'synopsis') {
      out = { synopsis: '整部作品的剧情梗概。'.repeat(20) };
    } else if (/时间线锚点/.test(sys)) out = { origin: { event: '开场' } };
    else if (/世界观抽取器/.test(sys)) out = { worldbook: [], items: [] };
    else if (/人物名单抽取器/.test(sys)) out = { characters: [] };
    else if (/阶段划分器/.test(sys)) out = { phases: [] };
    else if (/热门作品/.test(sys)) out = { popular: false };
    else if (/分批阅读助手/.test(sys)) out = { summary: `第 ${chapters} 段摘要` };
    else out = {};

    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const dir = await mkdtemp(path.join(tmpdir(), 'n2c-seg-'));
  try {
    const novel = path.join(dir, 'n.txt');
    await writeFile(novel, chapterTitles.map((t, i) => `${t}\n${chapterTexts[i]}`).join('\n'), 'utf-8');
    const taskDir = path.join(dir, 'task_x');
    await runPipeline({
      outDir: taskDir, novelPath: novel,
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
      title: '分段测试', outputMode: 'card', detailLevel, batchChapters,
      ...(eventEntriesPerBatch === undefined ? {} : { eventEntriesPerBatch }),
    }, () => {});
    let card = null;
    try {
      const fs = await import('node:fs/promises');
      card = JSON.parse(await fs.readFile(path.join(taskDir, 'character_card.json'), 'utf-8'));
    } catch { /* 忽略 */ }
    return { calls, card, chapters };
  } finally {
    globalThis.fetch = orig;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const markersOf = (text) => [...new Set([...String(text).matchAll(/CH(\d+)/g)].map(m => Number(m[1])))];

// ============================================================
console.log('\n【4】完整版：每段一次调用，只喂本段原文');
{
  const { calls, card } = await runOnce({ detailLevel: 'full' });
  const evCalls = calls.filter(c => c.kind === 'event');
  ok('每段一次事件调用（12 章 / 每批 3 章 = 4 段）', evCalls.length === 4, String(evCalls.length));

  const perCall = evCalls.map(c => markersOf(c.user));
  ok('每次调用只含本段章节（各 3 个标记）', perCall.every(m => m.length === 3), JSON.stringify(perCall));
  const allMarkers = [...new Set(perCall.flat())].sort((a, b) => a - b);
  ok('**12 章原文全部被喂到了**', allMarkers.join(',') === Array.from({ length: 12 }, (_, i) => i + 1).join(','),
    allMarkers.join(','));
  ok('**最后一段（第 10–12 章）确实被喂到**（旧实现永远看不到）',
    perCall.some(m => m.includes(12)), JSON.stringify(perCall));

  const synCalls = calls.filter(c => c.kind === 'synopsis');
  ok('剧情简介单独调用 1 次', synCalls.length === 1, String(synCalls.length));
  ok('简介调用不塞原文（只给事件清单+摘要）', markersOf(synCalls[0].user).length === 0, '');
  ok('简介调用带上了分批摘要', /分批摘要/.test(synCalls[0].user), '');

  const evEntries = (card?.data?.character_book?.entries || []).filter(e => /\[event\]/.test(e.comment || ''));
  ok('**事件条目一条不丢（12 个）**', evEntries.length === 12, String(evEntries.length));
  ok('事件条目正文是完整模板', evEntries.every(e => /经过/.test(e.content)), '');
}

// ============================================================
console.log('\n【5】基础版：保持旧行为（全书一次调用）');
{
  const { calls, card } = await runOnce({ detailLevel: 'basic' });
  // 旧路径用的是合并 prompt（事件 + 简介一次拿回），单独归类
  const evCalls = calls.filter(c => c.kind === 'event+synopsis' || c.kind === 'event');
  ok('全书只 1 次事件调用（与旧行为一致）', evCalls.length === 1, String(evCalls.length));
  ok('旧路径的原文节选仍只有前 4 章',
    markersOf(evCalls[0].user).join(',') === '1,2,3,4', markersOf(evCalls[0].user).join(','));
  ok('旧路径不单独调用简介（合并调用里顺带）',
    calls.filter(c => c.kind === 'synopsis').length === 0, '');
  ok('旧路径确实用了合并 prompt', /剧情梗概撰写器/.test(evCalls[0].sys), '');
  const evEntries = (card?.data?.character_book?.entries || []).filter(e => /\[event\]/.test(e.comment || ''));
  ok('事件条目依旧齐全（12 个）', evEntries.length === 12, String(evEntries.length));
}

// ============================================================
console.log('\n【6】用 eventEntriesPerBatch 强制开/关');
{
  const forcedOn = await runOnce({ detailLevel: 'basic', eventEntriesPerBatch: true });
  ok('基础版 + 强制开 → 按段写（4 次调用）',
    forcedOn.calls.filter(c => c.kind === 'event').length === 4,
    String(forcedOn.calls.filter(c => c.kind === 'event').length));

  const forcedOff = await runOnce({ detailLevel: 'full', eventEntriesPerBatch: false });
  ok('完整版 + 强制关 → 全书一次（1 次调用）',
    forcedOff.calls.filter(c => c.kind === 'event+synopsis' || c.kind === 'event').length === 1,
    String(forcedOff.calls.filter(c => c.kind === 'event+synopsis' || c.kind === 'event').length));
}

// ============================================================
console.log('\n【7】prompt 接线');
{
  ok('新增剧情梗概 prompt', typeof S.STEP_5_SYNOPSIS === 'string' && S.STEP_5_SYNOPSIS.length > 150,
    String(S.STEP_5_SYNOPSIS?.length));
  ok('简介 prompt 要求只写已发生的事', /不要推测未揭示的真相/.test(S.STEP_5_SYNOPSIS), '');
  ok('简介 prompt 要求按时间顺序', /时间顺序/.test(S.STEP_5_SYNOPSIS), '');
  ok('简介 prompt 要求输出 {synopsis}', /"synopsis"/.test(S.STEP_5_SYNOPSIS), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  事件按段落生成测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
