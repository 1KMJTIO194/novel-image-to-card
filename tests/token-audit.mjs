/**
 * Token 消耗审计工具测试。
 *
 * 覆盖两部分：
 *   ① 纯逻辑（src/token_audit.js）：估算换算、按步骤汇总、真实任务审计、报告渲染
 *   ② CLI（scripts/token-audit.mjs）的确定性模拟：各配置档位的相对成本关系
 *      —— 这是"改动后 token 花得更多还是更少"的回归防线
 *
 * 模拟不花钱：用假 LLM，输入字符与真模型完全一致（只有输出是假的）。
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

const TA = await import(pathToFileURL(path.join(ROOT, 'src/token_audit.js')).href);
const AUDIT = await import(pathToFileURL(path.join(ROOT, 'scripts/token-audit.mjs')).href);

// ============================================================
console.log('\n【1】字符 → Token 估算');
{
  ok('1600 字符 ≈ 1000 Token', TA.estimateTokens(1600) === 1000, String(TA.estimateTokens(1600)));
  ok('0 / 负数 / NaN → 0', TA.estimateTokens(0) === 0 && TA.estimateTokens(-5) === 0 && TA.estimateTokens(NaN) === 0, '');
  ok('1.6 字符/Token 常量', TA.CHARS_PER_TOKEN === 1.6, String(TA.CHARS_PER_TOKEN));
}

// ============================================================
console.log('\n【2】按步骤汇总');
{
  const rows = TA.breakdownByStep({
    step5: { calls: 2, systemChars: 100, userChars: 300, replyChars: 50, ms: 10 },
    'step1+step2': { calls: 5, systemChars: 10, userChars: 20, replyChars: 5, ms: 20 },
  });
  ok('按总字符降序', rows[0].step === 'step5', rows.map(r => r.step).join(','));
  ok('总字符 = system + user + reply', rows[0].totalChars === 450, String(rows[0].totalChars));
  ok('空输入返回空数组', TA.breakdownByStep({}).length === 0 && TA.breakdownByStep(null).length === 0, '');
}

// ============================================================
console.log('\n【3】真实任务审计');
{
  const tasks = [
    {
      id: 'ok-1', source: 'web',
      meta: {
        kind: 'generate', title: 't1', model: 'm', counts: { chars: 10000 },
        usage: {
          inputChars: 100000, outputChars: 20000, calls: 30, failedCalls: 1,
          byStep: {
            'step1+step2': { calls: 10, systemChars: 10000, userChars: 40000, replyChars: 8000, ms: 1 },
            step5: { calls: 5, systemChars: 5000, userChars: 30000, replyChars: 7000, ms: 1 },
          },
        },
      },
    },
    {
      id: 'fail-1', source: 'plugin',
      meta: {
        kind: 'generate', title: 't2', model: 'm', counts: { chars: 5000 },
        usage: { inputChars: 40000, outputChars: 0, calls: 9, failedCalls: 9, byStep: {} },
      },
    },
    { id: 'no-meta', meta: null },
  ];
  const a = TA.auditTasks(tasks);
  ok('任务数 / 成功 / 失败', a.count === 2 && a.okCount === 1 && a.failedCount === 1,
    `${a.count}/${a.okCount}/${a.failedCount}`);
  ok('失败率', Math.abs(a.failedRate - 0.5) < 1e-9, String(a.failedRate));
  ok('成功任务合计 Token', a.totals.tokens === TA.estimateTokens(120000), String(a.totals.tokens));
  ok('失败任务的输入算浪费', a.wasted.tasks === 1 && a.wasted.inputChars === 40000,
    JSON.stringify(a.wasted));
  ok('总字符 / 原文字符 倍数', a.charsPerNovelChar === 12, String(a.charsPerNovelChar));
  ok('byStep 百分比合计 ≈ 100', Math.abs(a.byStep.reduce((s, r) => s + r.percent, 0) - 100) < 0.5,
    String(a.byStep.reduce((s, r) => s + r.percent, 0)));
  ok('top 按总字符降序', a.top[0].id === 'ok-1', a.top.map(t => t.id).join(','));

  const empty = TA.auditTasks([]);
  ok('空任务列表不崩', empty.count === 0 && empty.byStep.length === 0 && empty.top.length === 0, '');
}

// ============================================================
console.log('\n【4】报告渲染');
{
  const a = TA.auditTasks([{
    id: 'x', meta: {
      counts: { chars: 1000 }, usage: {
        inputChars: 5000, outputChars: 500, calls: 3, failedCalls: 0,
        byStep: { step5: { calls: 3, systemChars: 100, userChars: 4900, replyChars: 500, ms: 1 } },
      },
    },
  }]);
  const text = TA.formatAuditReport(a);
  ok('包含标题', /真实任务 Token 消耗/.test(text), '');
  ok('包含合计与占比', /≈/.test(text) && /\(100%\)/.test(text), '');
  ok('空审计不崩', typeof TA.formatAuditReport(TA.auditTasks([])) === 'string', '');
}

// ============================================================
console.log('\n【5】确定性模拟：配置之间的相对成本');
{
  const SIZE = { chapters: 4, charsPerChapter: 600 };
  const basic = await AUDIT.simulate({ name: 'basic', config: { detailLevel: 'basic' } }, SIZE);
  const full = await AUDIT.simulate({ name: 'full', config: { detailLevel: 'full' } }, SIZE);
  const fullNoP0 = await AUDIT.simulate({ name: 'full-noP0', config: { detailLevel: 'full', eventEntriesPerBatch: false } }, SIZE);
  const fullNoP1 = await AUDIT.simulate({ name: 'full-noP1', config: { detailLevel: 'full', charMajorTargeted: false } }, SIZE);
  const perChar = await AUDIT.simulate({ name: 'per-char', config: { detailLevel: 'basic', charBatchSize: 1 } }, SIZE);

  ok('完整版比基础版贵（P0+P1 都开）', full.inputChars > basic.inputChars,
    `${full.inputChars} vs ${basic.inputChars}`);
  ok('关掉按段剧情（P0）能省', fullNoP0.inputChars < full.inputChars,
    `${fullNoP0.inputChars} vs ${full.inputChars}`);
  ok('关掉定向档案（P1）能省', fullNoP1.inputChars < full.inputChars,
    `${fullNoP1.inputChars} vs ${full.inputChars}`);
  ok('**逐个生成人物档案比批量贵**', perChar.inputChars > basic.inputChars,
    `${perChar.inputChars} vs ${basic.inputChars}`);
  ok('倍数 = 总输入 / 原文字符，完整版更高',
    Number.isFinite(full.charsPerNovelChar) && full.charsPerNovelChar > basic.charsPerNovelChar,
    `${full.charsPerNovelChar} vs ${basic.charsPerNovelChar}`);
  ok('按调用类型有明细', Object.keys(basic.byKind).length >= 5, Object.keys(basic.byKind).join(','));
  ok('基础版确实走章节抽取', (basic.byKind.chapter?.calls || 0) === SIZE.chapters, JSON.stringify(basic.byKind.chapter));
}

// ============================================================
console.log('\n【6】prompt 分类');
{
  ok('章节抽取', AUDIT.classify('你是一个章节级多任务抽取器。对给定的') === 'chapter', '');
  ok('事件合并', AUDIT.classify('你是事件条目撰写器与剧情梗概撰写器。') === 'event+synopsis', '');
  ok('剧情简介', AUDIT.classify('你是剧情梗概撰写器。') === 'synopsis', '');
  ok('人物名单', AUDIT.classify('你是人物名单抽取器。') === 'roster', '');
  ok('人物档案（单个）', AUDIT.classify('你是人物档案抽取器。给定') === 'profile-single', '');
  ok('世界观+物品合并', AUDIT.classify('你是世界观与物品抽取器。对给定的**同一段原文**') === 'worldbook', '');
  ok('未知 prompt 归 other', AUDIT.classify('随便一段话') === 'other', '');
}

// ============================================================
console.log('\n【7】CLI 文件与参数');
{
  const fs = await import('node:fs/promises');
  const script = await fs.readFile(path.join(ROOT, 'scripts/token-audit.mjs'), 'utf-8');
  ok('CLI 存在 --simulate 模式', /--simulate/.test(script), '');
  ok('CLI 支持 --json', /--json/.test(script), '');
  ok('CLI 支持调整模拟规模', /--chapters/.test(script) && /--chars-per-chapter/.test(script), '');
  ok('CLI 扫真实任务（web + 插件）', /output/.test(script) && /novel2card/.test(script), '');
  ok('模拟不会请求外部网络（假 fetch）', /makeFakeFetch/.test(script), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  Token 审计测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
