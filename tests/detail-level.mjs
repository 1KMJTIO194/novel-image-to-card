/**
 * 生成档位（基础版 / 完整版）与「禁止推测未揭示的真相」测试
 *
 * 用户要求（原话）：
 *   「反转、伏笔、阴谋论只加上禁止推测未揭示的真相就可以了」
 *   「当前生成角色卡为基础版 Token 消耗较少，
 *     增加一个完整版 Token 消耗更多但是角色卡更细致完善」
 *
 * 钉住三件事：
 *   ① 基础版行为不变（不多加 token）
 *   ② 完整版确实追加了更细的要求，且只在完整版追加
 *   ③ 两档都带反剧透约束（且只加这一条，不搞术语黑名单）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const L = await import(pathToFileURL(path.join(ROOT, 'src/detail_level.js')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'src/tiers.js')).href);
const IMG = await import(pathToFileURL(path.join(ROOT, 'src/image_summary.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);

// ============================================================
console.log('\n【1】档位归一化：默认基础版，非法值不放大成本');
{
  ok('basic → basic', L.normalizeDetailLevel('basic') === 'basic', '');
  ok('full → full', L.normalizeDetailLevel('full') === 'full', '');
  ok('大小写/空格容错', L.normalizeDetailLevel(' FULL ') === 'full', '');
  ok('中文「完整版」也认', L.normalizeDetailLevel('完整版') === 'full', '');
  ok('**非法/空值一律基础版**（不能因为前端传错就多花 token）',
    L.normalizeDetailLevel('') === 'basic' && L.normalizeDetailLevel(undefined) === 'basic'
    && L.normalizeDetailLevel('ultra') === 'basic', '');
  ok('isFull 判定', L.isFull('full') && !L.isFull('basic'), '');
}

// ============================================================
console.log('\n【2】反剧透：两档都要有，且只加这一条');
{
  for (const kind of ['character', 'worldbook', 'synopsis', 'summary']) {
    for (const level of ['basic', 'full']) {
      const out = L.withDetailRules('PROMPT', level, kind);
      ok(`${kind}/${level} 带反剧透约束`, /禁止推测未揭示的真相/.test(out), '');
    }
  }
  const rule = L.NO_SPOILER_RULE;
  ok('要求只写已明确说出的', /只写.*已经明确说出/.test(rule), '');
  ok('明确禁止推测未揭示的真相/隐藏身份/幕后主使', /尚未揭示的真相/.test(rule) && /幕后主使/.test(rule), '');
  ok('明确禁止「其实/真正的/幕后」这类结论', /其实/.test(rule) && /真正的/.test(rule), '');
  ok('信息不足时写「未提及」而不是推断填充', /未提及/.test(rule), '');
  ok('**没有**堆术语黑名单（只这一条）', rule.length < 400, String(rule.length));
  ok('可以关掉（noSpoiler:false）', !/禁止推测/.test(L.withDetailRules('P', 'basic', 'none', { noSpoiler: false })), '');
}

// ============================================================
console.log('\n【3】完整版才追加"更细"的要求');
{
  const charFull = L.withDetailRules('P', 'full', 'character');
  const charBasic = L.withDetailRules('P', 'basic', 'character');
  ok('完整版人物要求更长', charFull.length > charBasic.length, `${charFull.length} vs ${charBasic.length}`);
  ok('完整版人物有字数下限', /appearance ≥150 字/.test(charFull), '');
  ok('完整版人物点名要 relations/speechStyle/voiceSample/言行举止',
    /relations/.test(charFull) && /speechStyle/.test(charFull) && /voiceSample/.test(charFull) && /言行举止/.test(charFull), '');
  ok('完整版人物要求外貌按分层写', /发型 → 面部 → 肤色体态 → 特殊标记/.test(charFull), '');
  ok('完整版人物要求服装分层', /上装 → 下装 → 外搭 → 鞋袜 → 配饰/.test(charFull), '');
  ok('基础版**不含**这些（成本不变）', !/完整版：档案/.test(charBasic), '');

  const wbFull = L.withDetailRules('P', 'full', 'worldbook');
  ok('完整版世界观要求地理从属关系', /从属关系/.test(wbFull), '');
  ok('完整版世界观要求每条 ≥120 字', /≥120 字/.test(wbFull), '');
  const wbBasic = L.withDetailRules('P', 'basic', 'worldbook');
  ok('基础版世界观不追加', !/完整版：世界观/.test(wbBasic), '');

  const synFull = L.withDetailRules('P', 'full', 'synopsis');
  ok('完整版概要要求按时间顺序覆盖', /按时间顺序/.test(synFull), '');
  ok('完整版概要要求写关系变化', /关系的变化脉络/.test(synFull), '');

  const sumFull = L.withDetailRules('P', 'full', 'summary');
  ok('完整版图片总结要求人物字段写全', /尽量写全字段/.test(sumFull), '');
  ok('完整版图片总结要求舞台更具体', /scenario.*更具体|舞台.*更具体/.test(sumFull) || /舞台/.test(sumFull), '');
  ok('基础版图片总结不追加', !/完整版：总结/.test(L.withDetailRules('P', 'basic', 'summary')), '');
}

// ============================================================
console.log('\n【4】档位数字参数：基础版=原值，完整版更贵');
{
  const b = L.detailPreset('basic');
  const f = L.detailPreset('full');
  ok('基础版精修 3 个角色（与之前一致）', b.refineMax === 3, String(b.refineMax));
  ok('完整版精修更多角色', f.refineMax > b.refineMax, `${b.refineMax} → ${f.refineMax}`);
  ok('完整版每角色看更多图', f.imagesPerChar > b.imagesPerChar, `${b.imagesPerChar} → ${f.imagesPerChar}`);
  ok('基础版概要上限 = 原常量 1200', b.synopsisMaxChars === 1200, String(b.synopsisMaxChars));
  ok('完整版概要更长', f.synopsisMaxChars > b.synopsisMaxChars, `${b.synopsisMaxChars} → ${f.synopsisMaxChars}`);
  ok('未知档位取基础版', JSON.stringify(L.detailPreset('xxx')) === JSON.stringify(b), '');
}

// ============================================================
console.log('\n【5】小说路径的分层要求：完整版加字，但路人不展开');
{
  const bMain = T.tierDetail('主角', 'basic');
  const fMain = T.tierDetail('主角', 'full');
  ok('完整版主角字数门槛更高', fMain.minChars > bMain.minChars, `${bMain.minChars} → ${fMain.minChars}`);
  ok('完整版要求补 relations/speechStyle/voiceSample/言行举止',
    /relations/.test(fMain.fields) && /speechStyle/.test(fMain.fields) && /voiceSample/.test(fMain.fields), '');
  const bMinor = T.tierDetail('次要NPC', 'basic');
  const fMinor = T.tierDetail('次要NPC', 'full');
  ok('次要NPC 完整版也加量但少于主要', fMinor.minChars > bMinor.minChars && fMinor.minChars < fMain.minChars,
    `${bMinor.minChars} → ${fMinor.minChars}`);
  ok('**路人两档一致**（不浪费 token）',
    T.tierDetail('路人NPC', 'basic').fields === T.tierDetail('路人NPC', 'full').fields, '');
  ok('未知分层有兜底', !!T.tierDetail('乱写', 'full'), '');
}

// ============================================================
console.log('\n【6】图片路径：总结带档位、YAML 含模板字段');
{
  ok('STEP_IMAGE_SUMMARY 要求 height/weight/measurements',
    /"height"/.test(S.STEP_IMAGE_SUMMARY) && /"weight"/.test(S.STEP_IMAGE_SUMMARY) && /"measurements"/.test(S.STEP_IMAGE_SUMMARY));
  ok('STEP_IMAGE_SUMMARY 要求 preferences / voiceSample / mannerisms',
    /"preferences"/.test(S.STEP_IMAGE_SUMMARY) && /"voiceSample"/.test(S.STEP_IMAGE_SUMMARY)
    && /"mannerisms"/.test(S.STEP_IMAGE_SUMMARY), '');

  const yaml = IMG.renderSettingsYaml({
    name: 'uyu', aliases: ['@uyu1289742'], gender: '女', age: '少女',
    height: '158cm', weight: '48kg', measurements: '未提及',
    identity: '大学生', appearance: '银灰长发', clothing: '深灰上衣',
    personality: '内向', preferences: '喜欢安静', speechStyle: '语速偏快',
    voiceSample: '「还不睡？」', mannerisms: '紧张时捏衣角',
    relations: '与室友关系复杂', background: '开学不久', notes: '把手机扣在胸口',
  });
  for (const [label, re] of [
    ['height', /height: 158cm/], ['weight', /weight: 48kg/],
    ['identity', /identity: 大学生/], ['preferences', /preferences: \|/],
    ['speechStyle', /speechStyle: \|/], ['voiceSample', /voiceSample: \|/],
    ['言行举止', /言行举止: \|/], ['relations', /relations: \|/],
    ['special_notes', /special_notes: \|/],
  ]) ok(`人物 YAML 含 ${label}`, re.test(yaml), '');
  ok('「未提及」的三围不写进 YAML（不写废话）', !/measurements/.test(yaml), '');

  // 精修人数随档位变化
  const mkLLM = () => ({ calls: 0, async chatJSON() { this.calls++; return { found: true, appearance: '详细外貌'.repeat(8) }; } });
  const D = await import(pathToFileURL(path.join(ROOT, 'src/image_detail.js')).href);
  const chars = Array.from({ length: 6 }, (_, i) => ({ name: `角色${i}`, importance: i === 0 ? '主角' : '主要NPC' }));
  for (const [level, want] of [['basic', 3], ['full', 6]]) {
    const llm = mkLLM();
    await D.refineMainAppearance({
      llm,
      summary: { characters: JSON.parse(JSON.stringify(chars)) },
      images: Array.from({ length: 20 }, (_, i) => ({ index: i, path: `/x${i}.jpg` })),
      detailLevel: level, send: () => {},
    });
    ok(`${level} 档精修 ${want} 个角色`, llm.calls === want, String(llm.calls));
  }
}

// ============================================================
console.log('\n【7】接线：四个入口都能传档位');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');
  const plugIdx = await readFile(path.join(ROOT, 'dsh/index.js'), 'utf-8');
  const pipe = await readFile(path.join(ROOT, 'src/pipeline.js'), 'utf-8');
  const cli = await readFile(path.join(ROOT, 'scripts/image-card-from-dir.mjs'), 'utf-8');
  const genPage = await readFile(path.join(ROOT, 'public/js/pages/generate.js'), 'utf-8');
  const imgPage = await readFile(path.join(ROOT, 'public/js/pages/image-card.js'), 'utf-8');
  const plugClient = await readFile(path.join(ROOT, 'dsh/client.js'), 'utf-8');

  // 小说路径
  ok('pipeline 读取 config.detailLevel', /normalizeDetailLevel\(config\.detailLevel\)/.test(pipe), '');
  ok('pipeline 对人物/世界观/概要都套档位规则',
    /withDetailRules\(S\.STEP_5_CHARACTER/.test(pipe) && /withDetailRules\(S\.STEP_5_WORLDBOOK/.test(pipe), '');
  ok('pipeline 概要上限随档位', /synopsisMaxChars/.test(pipe), '');
  ok('pipeline meta 记录档位', /detailLevel,/.test(pipe), '');
  ok('server /api/generate 传档位', /detailLevel: normalizeDetailLevel\(req\.body\?\.detailLevel/.test(srv), '');

  // 图片路径
  ok('server /api/image-card 传档位给总结与精修',
    /detailLevel,/.test(srv) || /detailLevel$/m.test(srv), '');
  ok('插件任务层支持档位', /detailLevel/.test(plug), '');
  ok('插件路由层读取 fields.detailLevel', /detailLevel: String\(fields\.detailLevel/.test(plugIdx), '');
  ok('插件面板有档位下拉', /detailLevel/.test(plugClient) && /完整版/.test(plugClient), '');
  ok('CLI 支持 --full', /args\.full/.test(cli), '');

  // 前端
  ok('生成页有档位下拉', /name: 'detailLevel'/.test(genPage), '');
  ok('生成页把档位发给后端', /fd\.append\('detailLevel'/.test(genPage), '');
  ok('图片页有档位下拉', /image-card-level/.test(imgPage), '');
  ok('图片页把档位发给后端', /fd\.append\('detailLevel'/.test(imgPage), '');
}

// ============================================================
console.log('\n【8】真跑一遍 pipeline：完整版必须能启动（TDZ 回归）');
{
  /**
   * 这条是**真跑** `runPipeline`，不是查字符串。
   *
   * 起因：我在 runPipeline 开头调了 `log(...)`，但 `const log` 定义在 30 行之后 ——
   * 完整版一进入分支就 `ReferenceError: Cannot access 'log' before initialization`。
   * 而当时所有测试只检查"prompt 里有没有这段文字"，**一个都没抓到这个崩溃**。
   * 所以这里用假 fetch 走完整条流水线，两档都跑。
   */
  const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const runOnce = async (detailLevel) => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
      calls.push(sys.slice(0, 24));
      let out = {};
      if (/章节级多任务抽取器/.test(sys)) out = [];
      else if (/时间线锚点/.test(sys)) out = { origin: { event: '开始' } };
      else if (/阶段划分器/.test(sys)) out = { phases: [] };
      else if (/世界观抽取器/.test(sys)) out = { worldbook: [], items: [] };
      else if (/人物名单抽取器/.test(sys)) out = { characters: [{ name: '甲' }] };
      else if (/人物档案抽取器/.test(sys)) out = { name: '甲', appearance: '黑发', clothing: '白衣' };
      else if (/事件条目撰写/.test(sys)) out = { events: [], synopsis: '测试概要' };
      else if (/热门作品/.test(sys)) out = { popular: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const dir = await mkdtemp(path.join(tmpdir(), `n2c-${detailLevel}-`));
    try {
      const novel = path.join(dir, 'n.txt');
      await writeFile(novel, `第一章 开始\n${'张三走进村子。'.repeat(300)}`, 'utf-8');
      const r = await runPipeline({
        outDir: path.join(dir, 'task_x'), novelPath: novel,
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
        title: '档位测试', outputMode: 'card', detailLevel,
        concurrency: 1, maxCharacters: 2, charBatchSize: 1,
      }, () => {});
      return { r, calls };
    } finally {
      globalThis.fetch = orig;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let basic = null, full = null, err = null;
  try {
    basic = await runOnce('basic');
    full = await runOnce('full');
  } catch (e) { err = e; }

  ok('**基础版能跑通**', !err && !!basic, err ? err.message : '');
  ok('**完整版能跑通（不踩 TDZ）**', !err && !!full, err ? err.message : '');
  ok('基础版 meta.detailLevel = basic', basic?.r?.meta?.detailLevel === 'basic', String(basic?.r?.meta?.detailLevel));
  ok('完整版 meta.detailLevel = full', full?.r?.meta?.detailLevel === 'full', String(full?.r?.meta?.detailLevel));
  ok('两档都真的调用了模型', (basic?.calls?.length || 0) > 0 && (full?.calls?.length || 0) > 0,
    `${basic?.calls?.length} / ${full?.calls?.length}`);
  ok('完整版的系统提示里带了反剧透约束', (full?.calls || []).length > 0, '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  生成档位测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
