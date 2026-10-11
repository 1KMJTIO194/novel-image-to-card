/**
 * 变更总结测试
 *
 * 覆盖三种来源：
 *   · 完善已有角色卡（有 before/after，能做真实差异）
 *   · 从零生成（没有基线，列产出）
 *   · 图片生成
 *
 * 全部纯逻辑，不需要 LLM 或服务器。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const M = await import(pathToFileURL(path.join(ROOT, 'src/summary.js')).href);

// ============================================================
console.log('\n【1】完善路径：必须算出真实的前后差异');
{
  const report = {
    sourceCard: '示例小说 B',
    strategy: 'merge',
    processedChapters: 3,
    processedChapterTitles: ['第1章 归乡', '第2章 玉简', '第3章 本宗'],
    processedChars: 516,
    before: { entries: 44, characters: 11, events: 7, worldbook: 11 },
    after: { entries: 60, characters: 15, events: 13, worldbook: 27 },
    extracted: { events: 6, characters: 4, worldbook: 12, phases: 3 },
    matched: [],
    added: [
      { type: 'character', name: '叶诺' },
      { type: 'character', name: '谢讲师' },
      { type: 'worldbook', name: '西荒' },
      { type: 'worldbook', name: '太一宗本宗' },
      { type: 'event', name: '归乡' },
    ],
    updated: [{ type: 'character', name: '张婷婷' }],
    conflicts: [],
    skipped: [],
    alignDegraded: false,
    version: { from: '1.0', to: '1.1' },
  };
  const s = M.summarizeAugment(report);

  ok('kind 标记为 augment', s.kind === 'augment', s.kind);
  ok('算出条目差值 +16', s.delta.entries === 16, String(s.delta.entries));
  ok('算出人物差值 +4', s.delta.characters === 4, String(s.delta.characters));
  ok('算出事件差值 +6', s.delta.events === 6, String(s.delta.events));
  ok('算出世界观差值 +16', s.delta.worldbook === 16, String(s.delta.worldbook));
  ok('一句话变化含四项', s.highlights.length === 4, JSON.stringify(s.highlights));
  ok('改动前保留', s.before.entries === 44, String(s.before.entries));
  ok('改动后保留', s.after.entries === 60, String(s.after.entries));
  ok('新增清单保留', s.added.length === 5, String(s.added.length));
  ok('修改清单保留', s.updated.length === 1, String(s.updated.length));
  ok('版本变化保留', s.version.from === '1.0' && s.version.to === '1.1', JSON.stringify(s.version));
  ok('没有异常时不给 notes', s.notes.length === 0, JSON.stringify(s.notes));

  const md = M.renderSummaryMarkdown(s);
  ok('Markdown 含前后对照表', md.includes('| 改动前 |') && md.includes('| 改动后 |'));
  ok('Markdown 含差值 +16', /\|\s*\+16\s*\|/.test(md), '');
  ok('Markdown 列出新增人物', md.includes('叶诺') && md.includes('谢讲师'));
  ok('Markdown 按类型分组计数', md.includes('**人物（2）**'), md.split('\n').filter(l => l.includes('**')).join(' / '));
  ok('Markdown 含修改内容段', md.includes('## 修改内容'));
  ok('Markdown 含处理范围', md.includes('第1章 归乡'));
  ok('Markdown 含版本', md.includes('1.0 → 1.1'));
}

// ============================================================
console.log('\n【2】零变化的完善：必须说清"为什么没变"');
{
  // 场景 A：什么都没抽到
  const empty = M.summarizeAugment({
    sourceCard: 'X', strategy: 'merge',
    before: { entries: 44 }, after: { entries: 44 },
    extracted: { events: 0, characters: 0, worldbook: 0, phases: 0 },
    added: [], updated: [],
  });
  ok('零变化时 highlights 为空', empty.highlights.length === 0, JSON.stringify(empty.highlights));
  ok('零变化时给出"没抽到内容"的原因',
    empty.notes.some(n => /没有抽到任何可入库的内容/.test(n)), JSON.stringify(empty.notes));

  // 场景 B：抽到了但全是重复
  const dup = M.summarizeAugment({
    sourceCard: 'X', strategy: 'merge',
    before: { entries: 44 }, after: { entries: 44 },
    extracted: { events: 3, characters: 2, worldbook: 5, phases: 1 },
    added: [], updated: [],
  });
  ok('抽到但全重复时给出"与已有条目重复"的原因',
    dup.notes.some(n => /重复/.test(n)), JSON.stringify(dup.notes));

  // 场景 C：缺 after 统计（旧报告）
  const legacy = M.summarizeAugment({
    sourceCard: 'X', before: { entries: 44 }, extracted: { events: 1 },
    added: [{ type: 'character', name: 'A' }],
  });
  ok('缺 after 时提示无法算差值',
    legacy.notes.some(n => /改动后.*统计缺失|无法给出条目差值/.test(n)), JSON.stringify(legacy.notes));
  ok('缺 after 时不崩，仍能列出新增', legacy.added.length === 1, String(legacy.added.length));

  // 场景 D：对齐降级 / 冲突
  const degraded = M.summarizeAugment({
    sourceCard: 'X', before: { entries: 1 }, after: { entries: 3 },
    extracted: { events: 2 }, added: [{ type: 'event', name: 'E' }],
    alignDegraded: true,
    conflicts: [{ name: '沈砚', reason: '同名不同描述' }],
  });
  ok('对齐降级会提示', degraded.notes.some(n => /降级/.test(n)), JSON.stringify(degraded.notes));
  ok('冲突数量会提示', degraded.notes.some(n => /1 处冲突/.test(n)), JSON.stringify(degraded.notes));
  const mdD = M.renderSummaryMarkdown(degraded);
  ok('Markdown 含冲突段', mdD.includes('## 冲突（1 处'));
  ok('Markdown 含冲突原因', mdD.includes('同名不同描述'));
}

// ============================================================
console.log('\n【3】从零生成：没有基线，列产出而不是差异');
{
  const meta = { title: '示例小说 A', model: 'deepseek-flash', tokens: { a: 1800, b: 2400 } };
  const s = M.summarizeGenerate(meta, {
    characters: 13, events: 61, worldbookEntries: 156, storylines: 44, phases: 8,
    tiers: { 主角: 1, 主要NPC: 6, 次要NPC: 4, 路人NPC: 2 },
    chapters: 21, chars: 47743,
    kit: { entries: 165, regex: 7, cardBytes: 323000 },
  });

  ok('kind 标记为 generate', s.kind === 'generate', s.kind);
  ok('没有 before（从零生成）', Object.keys(s.before).length === 0, JSON.stringify(s.before));
  ok('baseline 说明从零生成', s.baseline === '从零生成', s.baseline);
  ok('产出清单含章数与字数',
    s.highlights.some(h => /21 章/.test(h)) && s.highlights.some(h => /47743 字/.test(h)),
    JSON.stringify(s.highlights));
  ok('产出清单含人物/事件/世界观',
    s.highlights.some(h => /人物 13 人/.test(h))
    && s.highlights.some(h => /事件 61 个/.test(h))
    && s.highlights.some(h => /世界观 156 条/.test(h)),
    JSON.stringify(s.highlights));
  ok('人物分层文本', /主角 1 人/.test(s.tierText || ''), s.tierText);
  ok('成品规格文本含条目与正则', /165 条/.test(s.kitText || '') && /7 条/.test(s.kitText || ''), s.kitText);

  const md = M.renderSummaryMarkdown(s);
  ok('Markdown 标题是"生成总结"', md.startsWith('# 生成总结：示例小说 A'), md.split('\n')[0]);
  ok('Markdown 含模型', md.includes('deepseek-flash'));
  ok('Markdown 不含前后对照表（没有基线）', !md.includes('| 改动前 |'), '');

  // 抽取统计不能漏出内部英文键名
  const statLines = md.split('\n').filter(l => /^- /.test(l) && l.includes('：'));
  ok('抽取统计只用中文标签',
    !statLines.some(l => /worldbookEntries|chapters|storylines|chars/.test(l)),
    JSON.stringify(statLines));

  // 空产出要给原因
  const bare = M.summarizeGenerate({ title: '空' }, { chapters: 1, chars: 100 });
  ok('没有人物时给提示', bare.notes.some(n => /没有产出人物/.test(n)), JSON.stringify(bare.notes));
  ok('没有事件时给提示', bare.notes.some(n => /没有产出剧情事件/.test(n)), JSON.stringify(bare.notes));

  // 图片路径：来源说明（"由 N 张图片生成"）必须出现在 Markdown 里
  const img = M.summarizeGenerate({ title: '图片卡' }, { characters: 20, events: 1, worldbookEntries: 5, phases: 1 });
  img.source = '由 20 张图片生成';
  const imgMd = M.renderSummaryMarkdown(img);
  ok('来源说明渲染进 Markdown', imgMd.includes('由 20 张图片生成'), imgMd.split('\n').slice(0, 5).join(' / '));
  ok('来源说明在列表项里', /^- 由 20 张图片生成$/m.test(imgMd), imgMd.split('\n').slice(0, 5).join(' / '));
}

// ============================================================
console.log('\n【4】渲染细节：分组、折叠、长度上限');
{
  // 大量条目要折叠成"等 N 项"
  const many = Array.from({ length: 30 }, (_, i) => ({ type: 'worldbook', name: `条目${i + 1}` }));
  const s = M.summarizeAugment({
    sourceCard: 'X', before: { entries: 0 }, after: { entries: 30 },
    extracted: { worldbook: 30 }, added: many,
  });
  const md = M.renderSummaryMarkdown(s);
  ok('超过 12 项的同类会折叠', /等 30 项/.test(md), md.split('\n').find(l => l.includes('世界观')) || '');
  ok('折叠后仍标明总数', /世界观（30）/.test(md), '');

  // 空总结不能崩
  ok('空对象不崩', typeof M.renderSummaryMarkdown({}) === 'string');
  ok('summarizeAugment(空) 不崩', typeof M.summarizeAugment({}).kind === 'string');
  ok('summarizeGenerate(空) 不崩', typeof M.summarizeGenerate().kind === 'string');

  // Markdown 结尾要有换行（拼接文件时不会黏在一起）
  ok('Markdown 以换行结尾', M.renderSummaryMarkdown(s).endsWith('\n'));

  // 未知类型要有兜底标签
  const unknown = M.summarizeAugment({
    sourceCard: 'X', before: {}, after: {},
    added: [{ type: 'weird_thing', name: 'W' }],
  });
  const mdU = M.renderSummaryMarkdown(unknown);
  ok('未知类型有兜底标签', mdU.includes('weird_thing'), mdU);
}

// ============================================================
console.log('\n【5】与 augment 报告的真实字段对齐（防字段名写错）');
{
  // 用一份真实 augment_report.json 的字段集合（来自实际产出）
  const real = {
    sourceCard: '示例小说 B', sourceCardFile: 'character_card.json',
    chapterRange: 'all', processedChapters: 3,
    processedChapterTitles: ['第1章 归乡', '第2章 玉简中的秘密', '第3章 本宗之路'],
    processedChars: 516, strategy: 'merge',
    before: { entries: 44, characters: 11, events: 7, worldbook: 11 },
    after: { entries: 60, characters: 15, events: 13, worldbook: 27 },
    extracted: { events: 6, characters: 4, worldbook: 12, phases: 3 },
    matched: [], added: [{ type: 'character', name: '叶诺' }],
    updated: [], conflicts: [], skipped: [],
    alignDegraded: false, version: { from: '1.0', to: '1.1' },
  };
  const keys = Object.keys(real);
  const unknownKeys = keys.filter(k => ![
    'sourceCard', 'sourceCardFile', 'chapterRange', 'processedChapters',
    'processedChapterTitles', 'processedChars', 'strategy', 'before', 'after',
    'extracted', 'matched', 'added', 'updated', 'conflicts', 'skipped',
    'alignDegraded', 'version',
  ].includes(k));
  ok('真实报告的字段都被认识', unknownKeys.length === 0, JSON.stringify(unknownKeys));

  const s = M.summarizeAugment(real);
  ok('真实报告能算出差值', s.delta.entries === 16, String(s.delta.entries));
  ok('真实报告的处理范围进了总结', s.chapters.length === 3, String(s.chapters.length));
  ok('baseline 含策略与字数', /merge/.test(s.baseline) && /516/.test(s.baseline), s.baseline);
}

console.log('\n【6】不用标准前缀的卡：分类计数不可用时不能显示"0"');
{
  /**
   * 真实故障：用户的卡条目叫「香织」「地下城」，不带 [character]/[map_*] 前缀，
   * `extractCardStructure` 数不出类型 → 报告里 before/after 只有 `entries`。
   * 若照常显示"人物 0 → 0"，会被读成"一个人物都没有"——那是口径失效，不是事实。
   */
  const r = {
    sourceCard: '示例小说 C',
    strategy: 'merge',
    processedChapters: 2,
    processedChapterTitles: ['第1章', '第2章'],
    processedChars: 324,
    usesStandardPrefix: false,
    before: { entries: 79 },                 // ← 只有总数
    after: { entries: 89 },
    extracted: { events: 6, characters: 3, worldbook: 8, phases: 3 },
    matched: [{}, {}, {}, {}, {}, {}, {}],   // 7 条
    added: [{ type: 'worldbook', name: '树冠圣域' }, { type: 'event', name: '深入地下城三层' }],
    updated: [{ type: 'character', name: '莉乃' }, { type: 'worldbook', name: '地下城' }],
    conflicts: [], skipped: [], alignDegraded: false,
    version: { from: '1.0', to: '1.1' },
  };
  const s = M.summarizeAugment(r);

  ok('kind 仍是 augment', s.kind === 'augment');
  ok('总条目差值正确 +10', s.delta.entries === 10, String(s.delta.entries));
  ok('一句话变化里没有"人物 +0"', !s.highlights.some(h => /人物/.test(h)),
    JSON.stringify(s.highlights));
  ok('一句话变化里有总条目 +10', s.highlights.some(h => /总条目 \+10/.test(h)),
    JSON.stringify(s.highlights));
  ok('提示分类计数不可用', s.notes.some(n => /不使用本工具的标准条目前缀/.test(n)),
    JSON.stringify(s.notes));

  const md = M.renderSummaryMarkdown(s);
  ok('表格里有总条目行', /\|\s*总条目\s*\|\s*79\s*\|\s*89\s*\|\s*\+10\s*\|/.test(md), md);
  ok('表格里**没有**"人物 0"这种误导行', !/\|\s*人物\s*\|\s*0\s*\|/.test(md), md);
  ok('Markdown 里没有 0 → 0 的人物行', !/人物.*\|\s*0\s*\|\s*0\s*\|/.test(md), md);
  ok('但 matched 与 updated 照常展示', md.includes('莉乃') && md.includes('地下城'));
  ok('对齐条数照常显示', md.includes('与已有条目对齐（7 项）'), md.split('\n').filter(l => l.includes('对齐')).join(' / '));

  // 对照：用标准前缀的卡，分类照常显示
  const r2 = { ...r, usesStandardPrefix: true, before: { entries: 44, characters: 11, events: 7, worldbook: 11 },
    after: { entries: 60, characters: 15, events: 13, worldbook: 27 } };
  const md2 = M.renderSummaryMarkdown(M.summarizeAugment(r2));
  ok('标准前缀卡照常显示人物行', /\|\s*人物\s*\|\s*11\s*\|\s*15\s*\|\s*\+4\s*\|/.test(md2), md2);
  ok('标准前缀卡不出现"分类不可用"提示',
    !M.summarizeAugment(r2).notes.some(n => /不使用本工具的标准条目前缀/.test(n)),
    JSON.stringify(M.summarizeAugment(r2).notes));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  变更总结测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
