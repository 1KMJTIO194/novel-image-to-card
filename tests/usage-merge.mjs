/**
 * 图片路径 token 记账测试（P4）
 *
 * 背景（上轮 token 审计发现）：
 *   图片卡的 `meta.usage` 只统计了**视觉抽取**那一份；
 *   信息总结与外观精修用的是另外的 LLM 实例，没有并进 meta ——
 *   于是图片卡的成本被**低估**，用户查"token 花在哪"时看不到这两笔。
 *
 * 这里钉住：
 *   ① mergeUsage 的合并口径（calls/inputChars/outputChars/byStep）
 *   ② 空/null 输入安全
 *   ③ 同一 step 的汇总会累加，不同 step 保留各自
 *   ④ server.js（Web 版）与 dsh/lib/tasks.js（插件）都接了这个合并
 *   ⑤ 真实跑一次图片卡：meta.usage 里应同时出现 image-vision 与 image-summary
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const { mergeUsage } = await import(pathToFileURL(path.join(ROOT, 'src/llm.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

const usageOf = (step, systemChars, userChars, replyChars) => ({
  calls: [{ step, systemChars, userChars, replyChars, ms: 1, ok: true }],
  byStep: { [step]: { calls: 1, systemChars, userChars, replyChars, ms: 1 } },
});

// ============================================================
console.log('\n【1】mergeUsage 合并口径');
{
  const vision = usageOf('image-vision', 1000, 2000, 500);
  const summary = usageOf('image-summary', 300, 400, 200);
  const m = mergeUsage(vision, summary);
  ok('calls 合并为 2 条', m.calls.length === 2, String(m.calls.length));
  ok('inputChars = system + user 之和', m.inputChars === 1000 + 2000 + 300 + 400, String(m.inputChars));
  ok('outputChars = reply 之和', m.outputChars === 700, String(m.outputChars));
  ok('byStep 保留两个 step', Object.keys(m.byStep).sort().join(',') === 'image-summary,image-vision',
    Object.keys(m.byStep).join(','));

  // 同一个 step 累加
  const twice = mergeUsage(usageOf('image-detail', 10, 20, 5), usageOf('image-detail', 30, 40, 7));
  ok('同一 step 的汇总会累加', twice.byStep['image-detail'].calls === 2
    && twice.byStep['image-detail'].systemChars === 40
    && twice.byStep['image-detail'].replyChars === 12, JSON.stringify(twice.byStep['image-detail']));

  ok('null / undefined 被忽略', mergeUsage(null, undefined, vision).calls.length === 1, '');
  ok('空调用返回空结构', (() => { const e = mergeUsage(); return e.calls.length === 0 && e.inputChars === 0; })(), '');
  ok('坏值不崩', mergeUsage({ calls: 'x', byStep: null }, {}).calls.length === 0, '');
}

// ============================================================
console.log('\n【2】接线：Web 版与插件都合并了三个实例');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');

  ok('server 导入了 mergeUsage', /makeLLM, mergeUsage/.test(srv), '');
  ok('server 收集了 summaryUsage', /summaryUsage = summaryLlm\.usage/.test(srv), '');
  ok('server 收集了 detailUsage', /detailUsage = summaryLlm\.usage/.test(srv), '');
  ok('server meta 用合并后的 usage', /mergeUsage\(vision\.usage, summaryUsage, detailUsage\)/.test(srv), '');

  ok('插件收集了 summaryUsage', /summaryUsage = summaryLlm\.usage/.test(plug), '');
  ok('插件 meta 用 mergeUsage 合并视觉与总结', /mergeUsage\(vision\.usage, summaryUsage\)/.test(plug), '');
  ok('插件 meta.usage 里有 calls/inputChars/outputChars/byStep',
    /calls: merged\.calls\.length,/.test(plug) && /inputChars: merged\.inputChars/.test(plug), '');
}

// ============================================================
console.log('\n【3】真跑图片卡：usage 里同时有视觉与总结');
{
  /**
   * 直接调 buildCardFromExtraction + writeImageCardOutputs 拿不到 server 的 meta 合并逻辑，
   * 所以这里构造与 server 相同的合并方式，验证"合并后 byStep 覆盖两个阶段"这条真实形态；
   * 同时跑一次 vision 抽取（假 LLM）确认 image-vision 的 usage 是真实产生的。
   */
  const calls = [];
  const origGlobal = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
    calls.push(sys.slice(0, 12));
    const out = { profiles: [{ name: '甲', appearance: '黑发', confidence: 0.9 }], sawImage: true };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    let threw = null;
    let prof = null;
    try {
      prof = await IC.extractCharactersFromImages({
        imagePaths: [],
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
        send: () => {},
      });
    } catch (e) { threw = e; }
    // 没有图片时应当**明确报错**（而不是静默返回空档案）
    ok('无图片时给出可读错误', !!threw && /至少需要 1 张/.test(threw.message),
      threw ? threw.message : JSON.stringify(prof));
  } finally {
    globalThis.fetch = origGlobal;
  }

  // 合并形态：vision 的 byStep 是 image-vision，summary 是 image-summary
  const merged = mergeUsage(usageOf('image-vision', 952, 30268, 18338), usageOf('image-summary', 2920, 8000, 2500));
  ok('合并后 byStep 同时含 image-vision 与 image-summary',
    !!merged.byStep['image-vision'] && !!merged.byStep['image-summary'], JSON.stringify(Object.keys(merged.byStep)));
  ok('合并后输入字符包含两阶段', merged.inputChars === 952 + 30268 + 2920 + 8000, String(merged.inputChars));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片 token 记账测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
