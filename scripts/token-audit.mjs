#!/usr/bin/env node
/**
 * Token 消耗审计 CLI。
 *
 * 两种模式：
 *
 *   1) 默认（审计真实任务）
 *      node scripts/token-audit.mjs [--max-tasks 10]
 *      扫 `output/` 与 DSH 插件数据目录里的 meta.json，汇总每个成功任务的
 *      调用次数 / 输入输出字符 / 估算 Token / 按步骤占比 / 失败浪费。
 *
 *   2) 确定性模拟（不需要 API Key、不花钱）
 *      node scripts/token-audit.mjs --simulate [--chapters 25] [--chars-per-chapter 2300]
 *      用假 LLM 跑完整流水线，输入字符与真模型完全一致（输出是假的）。
 *      用来对比各配置档位的成本：基础版 / 完整版 / 关掉按段剧情 / 关掉定向档案 / 逐个档案。
 *
 * 换算是经验值：中文约 1.6 字符 / Token（见 src/token_audit.js）。
 */
import path from 'node:path';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { estimateTokens, auditTasks, formatAuditReport } = await import(
  pathToFileURL(path.join(ROOT, 'src/token_audit.js')).href
);
const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

const argv = process.argv.slice(2);
const argValue = (...names) => {
  for (const n of names) {
    const i = argv.indexOf(n);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    const eq = argv.find(a => a.startsWith(`${n}=`));
    if (eq) return eq.split('=').slice(1).join('=');
  }
  return undefined;
};
const has = (...names) => names.some(n => argv.includes(n) || argv.some(a => a.startsWith(`${n}=`)));

const SIMULATE = has('--simulate', '--sim', '-s');
const AS_JSON = has('--json');
const MAX_TASKS = Number(argValue('--max-tasks')) || 8;
const CHAPTERS = Number(argValue('--chapters')) || 25;
const CHARS_PER_CHAPTER = Number(argValue('--chars-per-chapter', '--cpc')) || 2300;

const OUTPUT_ROOTS = [
  { dir: path.join(ROOT, 'output'), source: 'web' },
  { dir: path.join(process.env.USERPROFILE || process.env.HOME || tmpdir(), '.dsh', 'novel2card', 'output'), source: 'plugin' },
];

// ============================================================
// 模式 1：审计真实任务
// ============================================================
async function scanRealTasks() {
  const tasks = [];
  for (const { dir, source } of OUTPUT_ROOTS) {
    let subs = [];
    try { subs = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of subs) {
      if (!ent.isDirectory()) continue;
      try {
        const meta = JSON.parse(await readFile(path.join(dir, ent.name, 'meta.json'), 'utf-8'));
        tasks.push({ id: ent.name, source, meta });
      } catch { /* 没有 meta 的目录跳过 */ }
    }
  }
  return tasks;
}

// ============================================================
// 模式 2：确定性模拟（假 LLM）
// ============================================================
const PARA = '修仙界灵气复苏，张三与李四结伴，王五、赵六同行，宗门弟子在云京城试炼大会上各显神通。';
const NAMES = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九'];
const MAJOR_AT = new Set([0, 1, 3, 4, 6, 7, 9, 10, 12, 13, 15, 16, 18, 19, 21, 22, 24]);

function makeFakeFetch(calls) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
    const user = (body.messages || []).find(m => m.role === 'user')?.content || '';
    calls.push({ sys, user });
    const kind = classify(sys);

    let out = {};
    if (kind === 'chapter') {
      const title = (user.match(/章节：([^\n]+)/) || [])[1] || '';
      const n = (title.match(/第(\d+)章/) || [])[1] || '0';
      out = { mentions: [], events: [{ name: `事件${n}`, canon: `第 ${n} 段剧情`, pressure: 'buffer' }] };
    } else if (kind === 'event+synopsis') {
      const names = [...user.matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
      out = {
        events: names.map(n => ({ name: n, keys: [n], content_yaml: '起因: |\n  x\n经过: |\n  y' })),
        synopsis: '梗概'.repeat(80),
      };
    } else if (kind === 'event') {
      const names = [...user.matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
      out = names.map(n => ({ name: n, keys: [n], content_yaml: '起因: |\n  x\n经过: |\n  y' }));
    } else if (kind === 'synopsis') out = { synopsis: '梗概'.repeat(80) };
    else if (kind === 'origin') out = { origin: { event: '开场' } };
    else if (kind === 'worldbook') {
      // 给 3 条：少于 2 条会触发「宽松版重试」，模拟会多算调用
      out = {
        worldbook: [1, 2, 3].map(i => ({
          category: 'map_world', name: `设定${i}`, keys: [`设定${i}`], content: '设定内容'.repeat(20),
        })),
        items: [],
      };
    }
    else if (kind === 'roster') out = { characters: NAMES.map(n => ({ name: n, aliases: [], role: '主要NPC' })) };
    else if (kind === 'profile-batch') out = { profiles: NAMES.map(n => ({ name: n, content_yaml: `name: ${n}\nappearance: |\n  描述` })) };
    else if (kind === 'profile-single') {
      const m = /角色名：([^\n]+)/.exec(user);
      out = { name: m ? m[1].trim() : 'x', content_yaml: 'name: x\nappearance: |\n  描述' };
    } else if (kind === 'phases') out = { phases: [] };
    else if (kind === 'popular') out = { popular: false };
    else if (kind === 'batch-summary') out = { summary: '摘要' };
    else if (kind === 'card-fields') out = { name: '测试卡', description: 'x', personality: 'x', scenario: 'x', first_mes: '你好' };

    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function classify(sys) {
  if (/章节级多任务抽取器/.test(sys)) return 'chapter';
  if (/事件条目撰写器与剧情梗概撰写器/.test(sys)) return 'event+synopsis';
  if (/事件条目抽取器/.test(sys)) return 'event';
  if (/剧情梗概撰写器/.test(sys)) return 'synopsis';
  if (/时间线锚点/.test(sys)) return 'origin';
  if (/判断其叙事结构/.test(sys)) return 'step0.5-probe';
  if (/世界观与物品抽取器|世界观抽取器|世界观设定条目/.test(sys)) return 'worldbook';
  if (/人物名单抽取器/.test(sys)) return 'roster';
  if (/"profiles"\s*:/.test(sys)) return 'profile-batch';
  if (/人物档案抽取器/.test(sys)) return 'profile-single';
  if (/阶段划分器/.test(sys)) return 'phases';
  if (/热门作品/.test(sys)) return 'popular';
  if (/分批阅读助手/.test(sys)) return 'batch-summary';
  if (/基于以下信息，生成 SillyTavern|角色卡基础字段/.test(sys)) return 'card-fields';
  return 'other';
}

async function simulate(scenario, opts = {}) {
  const chapters = Number(opts.chapters) || CHAPTERS;
  const charsPerChapter = Number(opts.charsPerChapter) || CHARS_PER_CHAPTER;
  const titles = Array.from({ length: chapters }, (_, i) => `第${i + 1}章 段${i + 1}`);
  const texts = titles.map((_, i) => {
    const parts = [`【CH${i + 1}】`];
    if (MAJOR_AT.has(i)) parts.push('张三在场行动。');
    parts.push('李四旁观。');
    parts.push(PARA.repeat(Math.ceil(charsPerChapter / PARA.length)).slice(0, charsPerChapter));
    return parts.join('');
  });
  const novel = titles.map((t, i) => `${t}\n${texts[i]}`).join('\n');

  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = makeFakeFetch(calls);
  const dir = await mkdtemp(path.join(tmpdir(), 'n2c-audit-'));
  /** 静音流水线自身的 console.log：CLI 只输出审计表格 */
  const origLog = console.log;
  console.log = () => {};
  try {
    await writeFile(path.join(dir, 'novel.txt'), novel, 'utf-8');
    const events = [];
    await runPipeline({
      outDir: path.join(dir, 'task_x'), novelPath: path.join(dir, 'novel.txt'),
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
      title: 'token 审计', outputMode: 'card',
      concurrency: 3, maxCharacters: 7, charBatchSize: 6,
      ...scenario.config,
    }, (ev, data) => { if (ev === 'progress') events.push(data); });

    const byKind = {};
    for (const c of calls) {
      const k = classify(c.sys);
      const acc = byKind[k] || (byKind[k] = { calls: 0, chars: 0 });
      acc.calls++;
      acc.chars += c.sys.length + c.user.length;
    }
    const inputChars = calls.reduce((s, c) => s + c.sys.length + c.user.length, 0);
    return {
      name: scenario.name,
      calls: calls.length,
      inputChars,
      tokens: estimateTokens(inputChars),
      charsPerNovelChar: Number((inputChars / novel.length).toFixed(2)),
      byKind,
    };
  } finally {
    console.log = origLog;
    globalThis.fetch = orig;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function formatSimulation(rows, novelChars) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const lines = [];
  lines.push(`===== 确定性模拟（原文 ${n(novelChars)} 字符）=====`);
  lines.push('（输入字符与真模型一致；输出是假回复，只影响输出字数不影响输入结构）');
  lines.push('');
  lines.push('配置'.padEnd(34) + '调用'.padStart(6) + '输入字符'.padStart(12) + '≈Token'.padStart(11) + '倍数'.padStart(8));
  for (const r of rows) {
    lines.push(r.name.padEnd(34)
      + String(r.calls).padStart(6)
      + n(r.inputChars).padStart(12)
      + n(r.tokens).padStart(11)
      + `${r.charsPerNovelChar}×`.padStart(8));
  }
  const base = rows[0];
  if (base && rows.length > 1) {
    lines.push('');
    lines.push('相对基础版：');
    for (const r of rows.slice(1)) {
      const delta = ((r.inputChars / base.inputChars - 1) * 100).toFixed(1);
      lines.push(`  ${r.name.padEnd(34)} ${delta >= 0 ? '+' : ''}${delta}%`);
    }
  }
  const detail = rows[rows.length - 1];
  if (detail) {
    lines.push('');
    lines.push(`最后一行（${detail.name}）按调用类型的输入字符：`);
    for (const [k, v] of Object.entries(detail.byKind).sort((a, b) => b[1].chars - a[1].chars)) {
      lines.push(`  ${k.padEnd(16)} calls=${String(v.calls).padStart(3)}  chars=${String(n(v.chars)).padStart(10)}`
        + `  ≈${String(n(estimateTokens(v.chars))).padStart(9)} Token`);
    }
  }
  return lines.join('\n');
}

// ============================================================
// main
// ============================================================
const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) await main();

async function main() {
  if (SIMULATE) {
    const scenarios = [
      { name: '基础版（默认配置）', config: { detailLevel: 'basic' } },
      { name: '完整版（默认：按段剧情+定向档案）', config: { detailLevel: 'full' } },
      { name: '完整版 · 关掉按段剧情（P0）', config: { detailLevel: 'full', eventEntriesPerBatch: false } },
      { name: '完整版 · 关掉定向档案（P1）', config: { detailLevel: 'full', charMajorTargeted: false } },
      { name: '完整版 · 两者都关', config: { detailLevel: 'full', eventEntriesPerBatch: false, charMajorTargeted: false } },
      { name: '基础版 · 逐个生成人物档案', config: { detailLevel: 'basic', charBatchSize: 1 } },
      { name: '基础版 · 按段剧情 + 定向档案', config: { detailLevel: 'basic', eventEntriesPerBatch: true, charMajorTargeted: true } },
    ];
    const rows = [];
    for (const s of scenarios) rows.push(await simulate(s));
    const novelChars = CHAPTERS * CHARS_PER_CHAPTER;
    if (AS_JSON) console.log(JSON.stringify({ novelChars, rows }, null, 2));
    else console.log(formatSimulation(rows, novelChars));
    return;
  }

  const tasks = await scanRealTasks();
  const audit = auditTasks(tasks);
  if (AS_JSON) {
    console.log(JSON.stringify({ ...audit, top: audit.top.slice(0, MAX_TASKS) }, null, 2));
  } else {
    console.log(formatAuditReport({ ...audit, top: audit.top.slice(0, MAX_TASKS) }));
    console.log('');
    console.log('说明：Token 为估算（1.6 字符/Token）。逐步骤占比看"钱花在哪一步"；'
      + '失败任务的输入是纯浪费。');
    console.log('想对比配置成本（不花钱）：node scripts/token-audit.mjs --simulate');
  }
}

// 供测试复用
export { simulate, formatSimulation, classify, makeFakeFetch };
