/**
 * 主要角色定向档案测试（P1）
 *
 * 背景：原来所有角色共用一份「全书均匀随机抽样」，逐个生成只是把同一份抽样
 * 多发几遍。真正有收益的是：主要角色 → 单独一次调用 + **按出场章节取样**。
 *
 * 这里钉住：
 *   ① 章节检索：名字/别名命中、单字忽略、出场章过多时首尾+均匀取样
 *   ② 节选：只含出场章节、按预算切分、上限生效、没命中返回 matched:false
 *   ③ 完整版默认开启、基础版默认关闭、charMajorTargeted 可强制开关
 *   ④ 定向调用确实带上了「按出场章节取样」标签，且**包含后期章节原文**
 *   ⑤ 次要角色仍走批量；最终人物顺序仍与名单一致
 *   ⑥ majorTargetedLimit 限制人数
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

const CE = await import(pathToFileURL(path.join(ROOT, 'src/char_excerpt.js')).href);
const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

// ============================================================
console.log('\n【1】章节检索');
{
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    title: `第${i + 1}章`,
    text: (i === 2 || i === 7 ? '张三出场了。' : '路人剧情。') + 'x'.repeat(100),
  }));
  ok('按名字命中出场章', CE.findCharacterChapters(chunks, ['张三']).join(',') === '2,7',
    CE.findCharacterChapters(chunks, ['张三']).join(','));
  ok('别名也能命中', CE.findCharacterChapters(chunks, ['李四', '张三']).join(',') === '2,7', '');
  ok('单字名字被忽略（避免误命中）', CE.findCharacterChapters(chunks, ['张']).length === 0, '');
  ok('没有名字返回空', CE.findCharacterChapters(chunks, []).length === 0, '');
  ok('没有章节返回空', CE.findCharacterChapters([], ['张三']).length === 0, '');

  // 出场章多于上限 → 首尾 + 均匀
  const many = Array.from({ length: 30 }, (_, i) => ({ title: `第${i + 1}章`, text: '张三在场。' }));
  const picked = CE.findCharacterChapters(many, ['张三'], { maxChapters: 6 });
  ok('出场章过多时最多取 maxChapters 个', picked.length === 6, String(picked.length));
  ok('取样包含首章与尾章', picked[0] === 0 && picked[picked.length - 1] === 29, picked.join(','));
  ok('取样升序', picked.every((v, i) => i === 0 || v > picked[i - 1]), picked.join(','));
}

// ============================================================
console.log('\n【2】定向节选');
{
  const chunks = Array.from({ length: 10 }, (_, i) => ({
    title: `第${i + 1}章`,
    text: (i === 2 || i === 7 ? '【张三戏份】' : '【路人戏份】') + 'y'.repeat(200),
  }));
  const built = CE.buildCharacterExcerpt(chunks, ['张三'], { maxChars: 600, maxChapters: 2 });
  ok('命中时 matched=true', built.matched === true, '');
  ok('只含出场章节标题', built.chapters.join(',') === '第3章,第8章', built.chapters.join(','));
  ok('正文只含出场章节内容', built.text.includes('张三戏份') && !built.text.includes('路人戏份'), built.text.slice(0, 60));
  ok('包含标题标记', /【第3章】/.test(built.text), '');
  ok('长度不超过上限', built.text.length <= 600, String(built.text.length));
  const none = CE.buildCharacterExcerpt(chunks, ['查无此人']);
  ok('没命中时 matched=false 且文本为空', none.matched === false && none.text === '', JSON.stringify(none));
}

// ============================================================
/** 假 LLM 跑一次；返回调用记录与最终卡 */
async function runOnce({ detailLevel, charMajorTargeted, majorTargetedLimit, chapters = 8, batchChapters = 4 }) {
  const titles = Array.from({ length: chapters }, (_, i) => `第${i + 1}章 段${i + 1}`);
  /**
   * 出场分布要能触发分层：分层按"出场章节占比"算
   *   ≥30% → 主要NPC；≥10% → 次要NPC；否则路人。
   * 主角甲出现在 6/8 章（75%），路人乙只在第 3 章（12.5%）→ 次要NPC。
   */
  const MAJOR_AT = new Set([0, 1, 3, 4, 6, 7]);
  const MINOR_AT = new Set([2]);
  const texts = titles.map((_, i) => {
    const parts = [`【CH${i + 1}】`];
    if (MAJOR_AT.has(i)) parts.push('主角甲在此登场出手。');
    if (MINOR_AT.has(i)) parts.push('路人乙从旁经过。');
    parts.push('情节推进。'.repeat(30));
    return parts.join('');
  });

  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
    const user = (body.messages || []).find(m => m.role === 'user')?.content || '';
    calls.push({ sys, user });

    let out = {};
    if (/章节级多任务抽取器/.test(sys)) {
      const title = (user.match(/章节：([^\n]+)/) || [])[1] || '';
      const n = (title.match(/第(\d+)章/) || [])[1] || '0';
      out = { mentions: [], events: [{ name: `事件${n}`, canon: 'x' }] };
    } else if (/(事件条目抽取器|事件条目撰写器与剧情梗概撰写器)/.test(sys)) {
      const names = [...user.matchAll(/"name":\s*"([^"]+)"/g)].map(m => m[1]);
      out = names.map(n => ({ name: n, keys: [n], content_yaml: '起因: |\n  x\n经过: |\n  y' }));
      if (/剧情梗概撰写器/.test(sys)) out = { events: out, synopsis: '梗概'.repeat(80) };
    } else if (/剧情梗概撰写器/.test(sys)) out = { synopsis: '梗概'.repeat(80) };
    else if (/时间线锚点/.test(sys)) out = { origin: { event: '开场' } };
    else if (/世界观抽取器/.test(sys)) out = { worldbook: [], items: [] };
    else if (/人物名单抽取器/.test(sys)) {
      out = {
        characters: [
          { name: '主角甲', aliases: ['甲'], role: '主角' },
          { name: '路人乙', aliases: [], role: '次要NPC' },
        ],
      };
    } else if (/人物档案抽取器/.test(sys)) {
      const m = /角色名：([^\n]+)/.exec(user);
      const name = m ? m[1].trim() : 'x';
      out = { name, content_yaml: `name: ${name}\nappearance: |\n  描述` };
    } else if (/阶段划分器/.test(sys)) out = { phases: [] };
    else if (/热门作品/.test(sys)) out = { popular: false };
    else if (/分批阅读助手/.test(sys)) out = { summary: '摘要' };
    else out = {};

    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  const dir = await mkdtemp(path.join(tmpdir(), 'n2c-major-'));
  try {
    const novel = path.join(dir, 'n.txt');
    await writeFile(novel, titles.map((t, i) => `${t}\n${texts[i]}`).join('\n'), 'utf-8');
    const taskDir = path.join(dir, 'task_x');
    await runPipeline({
      outDir: taskDir, novelPath: novel,
      baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
      title: '主要角色测试', outputMode: 'card', detailLevel, batchChapters,
      ...(charMajorTargeted === undefined ? {} : { charMajorTargeted }),
      ...(majorTargetedLimit === undefined ? {} : { majorTargetedLimit }),
    }, () => {});
    let card = null;
    try {
      const fs = await import('node:fs/promises');
      card = JSON.parse(await fs.readFile(path.join(taskDir, 'character_card.json'), 'utf-8'));
    } catch { /* 忽略 */ }
    return { calls, card, titles };
  } finally {
    globalThis.fetch = orig;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const profileCalls = (calls) => calls.filter(c => /人物档案抽取器/.test(c.sys));
const markers = (text) => [...new Set([...String(text).matchAll(/CH(\d+)/g)].map(m => Number(m[1])))];
const charName = (call) => (/角色名：([^\n]+)/.exec(call.user) || [])[1]?.trim() || '';

// ============================================================
console.log('\n【3】完整版：主要角色定向、次要角色批量');
{
  const { calls, card } = await runOnce({ detailLevel: 'full' });
  const pc = profileCalls(calls);
  const targeted = pc.filter(c => /按出场章节取样/.test(c.user));
  ok('有 1 次定向调用（主角甲）', targeted.length === 1, String(targeted.length));
  ok('定向调用只针对主角甲', charName(targeted[0]) === '主角甲', charName(targeted[0]));
  const mk = markers(targeted[0].user);
  ok('**定向节选包含主角后期出场章节（第 8 章）**', mk.includes(8), JSON.stringify(mk));
  ok('定向节选只含主角出场章节（不含只在第 3 章出场的路人乙）', !mk.includes(3), JSON.stringify(mk));
  ok('次要角色仍走批量（不带定向标签）', pc.some(c => !/按出场章节取样/.test(c.user)), '');
  ok('批量调用用名单清单格式', pc.some(c => /角色清单|角色名：/.test(c.user)), '');

  // 卡片里两个人物都在，且顺序与名单一致（主要角色在前）
  const chars = (card?.data?.character_book?.entries || []).filter(e => /\[character/.test(e.comment || ''));
  ok('两个人物条目都在', chars.length === 2, String(chars.length));
  ok('人物顺序与名单一致（主要角色在前）', /主角甲/.test(chars[0]?.comment || ''),
    chars.map(c => c.comment).join(' | '));
  ok('主角甲被判为主要角色（≥30% 出场）', /主要NPC|主角/.test(chars[0]?.comment || ''),
    chars.map(c => c.comment).join(' | '));
}

// ============================================================
console.log('\n【4】基础版：不启用定向（保持旧行为）');
{
  const { calls } = await runOnce({ detailLevel: 'basic' });
  ok('基础版没有任何定向调用', profileCalls(calls).every(c => !/按出场章节取样/.test(c.user)), '');
}

// ============================================================
console.log('\n【5】强制开关与人数上限');
{
  const on = await runOnce({ detailLevel: 'basic', charMajorTargeted: true });
  ok('基础版 + 强制开 → 有定向调用', profileCalls(on.calls).some(c => /按出场章节取样/.test(c.user)), '');

  const off = await runOnce({ detailLevel: 'full', charMajorTargeted: false });
  ok('完整版 + 强制关 → 没有定向调用', profileCalls(off.calls).every(c => !/按出场章节取样/.test(c.user)), '');

  const lim = await runOnce({ detailLevel: 'full', majorTargetedLimit: 0 });
  ok('majorTargetedLimit=0 → 不定向', profileCalls(lim.calls).every(c => !/按出场章节取样/.test(c.user)), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  主要角色定向档案测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
