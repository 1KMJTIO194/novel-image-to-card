/**
 * 角色卡版本：普通版（不含成人内容）/ 成人版 测试
 *
 * 用户要求（原话）：
 *   「角色卡增加一个生成普通角色卡（不含成人内容的角色卡）
 *     生成成人版角色卡（完整的包含成人内容的角色卡）的功能」
 *
 * 钉住四件事：
 *   ① **默认必须是普通版**（不传 / 传错都回落普通版）——不能在用户不知情时产成人内容
 *   ② 普通版不能只靠 prompt：代码里必须真的把成人字段删掉（模型经常不听）
 *   ③ 成人版保留并写具体成人字段（小说路径模板已有这两个字段）
 *   ④ 两档都有"出场角色须成年"的底线
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

const C = await import(pathToFileURL(path.join(ROOT, 'src/content_mode.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);
const IS = await import(pathToFileURL(path.join(ROOT, 'src/image_summary.js')).href);

// ============================================================
console.log('\n【1】默认普通版：不传 / 传错都不产出成人内容');
{
  ok('不传 → general', C.normalizeContentMode(undefined) === 'general', '');
  ok('空串 → general', C.normalizeContentMode('') === 'general', '');
  ok('乱写 → general', C.normalizeContentMode('ultra') === 'general', '');
  ok('adult → adult', C.normalizeContentMode('adult') === 'adult', '');
  ok('成人版 / r18 / nsfw 都认', C.normalizeContentMode('成人版') === 'adult'
    && C.normalizeContentMode('r18') === 'adult' && C.normalizeContentMode('nsfw') === 'adult', '');
  ok('大小写容错', C.normalizeContentMode(' ADULT ') === 'adult', '');
  ok('isAdultMode 判定', C.isAdultMode('adult') && !C.isAdultMode('general'), '');
  ok('两档说明文字不同', C.describeContentMode('general') !== C.describeContentMode('adult'), '');
  ok('成人版说明提到成年要求', /成年/.test(C.describeContentMode('adult')), '');
}

// ============================================================
console.log('\n【2】普通版：代码层删除成人字段（不只靠 prompt）');
{
  const yaml = [
    'name: 甲',
    'appearance: |',
    '  黑发',
    'erotic_abilities: |',
    '  敏感点在后颈',
    '私处细节描写: |',
    '  乳房：适中',
    '  小穴：未提及',
    '  肛门：未提及',
    'personality: |',
    '  内向',
  ].join('\n');

  const stripped = C.stripAdultFieldsFromYaml(yaml);
  ok('成人字段被删除', !/erotic_abilities/.test(stripped) && !/私处细节描写/.test(stripped), '');
  ok('成人字段**内容**也被删除', !/敏感点/.test(stripped) && !/乳房/.test(stripped) && !/小穴/.test(stripped), '');
  ok('其它字段完整保留', /name: 甲/.test(stripped) && /appearance: \|/.test(stripped)
    && /黑发/.test(stripped) && /personality: \|/.test(stripped) && /内向/.test(stripped), '');
  ok('不留下多余空行', !/\n{3,}/.test(stripped), JSON.stringify(stripped.slice(-30)));

  // 边界
  ok('空文本不崩', C.stripAdultFieldsFromYaml('') === '', '');
  ok('null 不崩', C.stripAdultFieldsFromYaml(null) === '', '');
  ok('没有成人字段的文本原样（除尾部空白归一）', C.stripAdultFieldsFromYaml('name: 甲\n').trim() === 'name: 甲', '');

  // 字段在末尾 / 字段在开头
  const tail = C.stripAdultFieldsFromYaml('name: 甲\nerotic_abilities: |\n  x\n');
  ok('末尾成人字段也能删', !/erotic_abilities/.test(tail) && /name: 甲/.test(tail), JSON.stringify(tail));
  const head = C.stripAdultFieldsFromYaml('私处细节描写: |\n  乳房：大\nname: 甲\n');
  ok('开头成人字段也能删', !/私处细节描写/.test(head) && /name: 甲/.test(head), JSON.stringify(head));

  // 条目级处理
  const item = { name: '甲', content: yaml, content_yaml: yaml };
  const g = C.applyContentModeToCharItem(item, 'general');
  const a = C.applyContentModeToCharItem(item, 'adult');
  ok('普通版处理条目：content 与 content_yaml 都清干净',
    !/erotic_abilities/.test(g.content) && !/erotic_abilities/.test(g.content_yaml), '');
  ok('成人版原样返回', a.content === yaml && a.content_yaml === yaml, '');
  ok('不修改传入对象', item.content === yaml, '');
}

// ============================================================
console.log('\n【3】prompt 规则：普通版禁止、成人版要求写具体');
{
  const gen = C.withContentRules('P', 'general', 'character');
  const adult = C.withContentRules('P', 'adult', 'character');
  ok('普通版明确不写性描写', /不要写任何性描写/.test(gen), '');
  ok('普通版要求整段省略两个成人字段',
    /erotic_abilities/.test(gen) && /私处细节描写/.test(gen) && /整段省略/.test(gen), '');
  ok('普通版限制 preferences 只写日常喜好', /日常喜好/.test(gen), '');

  ok('成人版要求写清敏感点/癖好', /敏感点/.test(adult), '');
  ok('成人版要求按三项写私处', /乳房/.test(adult) && /小穴/.test(adult) && /肛门/.test(adult), '');
  ok('成人版禁止凭空编造', /不要凭空编造/.test(adult), '');
  ok('成人版要求写具体', /写具体/.test(adult), '');

  // 年龄底线：两档都有
  ok('两档都有年龄底线', /成年人/.test(gen) && /成年人/.test(adult), '');
  ok('年龄底线说明未成年不写成人内容', /未成年/.test(adult) && /不适用/.test(adult), '');
  ok('kind=none 只加年龄底线', !/不要写任何性描写/.test(C.withContentRules('P', 'general', 'none'))
    && /成年人/.test(C.withContentRules('P', 'general', 'none')), '');
}

// ============================================================
console.log('\n【4】图片路径：普通版/成人版渲染差异（真跑装配）');
{
  const profiles = [{ name: '甲', appearance: '黑发', clothing: '白衣', imageIndex: 0 }];
  const mkSummary = () => ({
    world: { overview: '', era: '', locations: [], factions: [], systems: [], history: [] },
    characters: [{
      name: '甲', appearance: '黑发', clothing: '白衣',
      eroticAbilities: '敏感点在后颈', privateDetails: '乳房：适中',
    }],
    scenario: '', opening: '',
  });

  const gen = await IC.buildCardFromExtraction({ profiles, title: 't', summary: mkSummary(), contentMode: 'general' });
  const adult = await IC.buildCardFromExtraction({ profiles, title: 't', summary: mkSummary(), contentMode: 'adult' });
  const genYaml = gen.characters[0].content_yaml;
  const adultYaml = adult.characters[0].content_yaml;

  ok('普通版人物条目无成人字段', !/erotic_abilities/.test(genYaml) && !/私处细节描写/.test(genYaml), genYaml);
  ok('普通版条目仍有正常字段', /name: 甲/.test(genYaml) && /appearance: \|/.test(genYaml), '');
  ok('成人版人物条目含成人字段', /erotic_abilities/.test(adultYaml) && /私处细节描写/.test(adultYaml), adultYaml);
  ok('成人版字段内容正确', /敏感点在后颈/.test(adultYaml) && /乳房：适中/.test(adultYaml), '');

  // 回退路径（没有 summary）也必须遵守普通版
  const fallback = await IC.buildCardFromExtraction({ profiles, title: 't', summary: null, contentMode: 'general' });
  ok('回退路径（无总结）普通版也无成人字段',
    !/erotic_abilities|私处细节描写/.test(fallback.characters[0].content_yaml), '');

  // 默认（不传 contentMode）= 普通版
  const dflt = await IC.buildCardFromExtraction({ profiles, title: 't', summary: mkSummary() });
  ok('不传版本时按普通版处理（安全默认）', !/erotic_abilities/.test(dflt.characters[0].content_yaml), '');
}

// ============================================================
console.log('\n【5】图片路径的总结：普通版会清空成人字段');
{
  const mkLLM = (payload) => ({
    async chatJSON() { return payload; },
  });
  const payload = {
    characters: [{ name: '甲', appearance: '黑发', erotic_abilities: '敏感点', 私处细节描写: '乳房：大' }],
  };
  const gen = await IS.extractCardSummary({ llm: mkLLM(payload), profiles: [{ name: '甲', appearance: '黑发' }], contentMode: 'general' });
  const adult = await IS.extractCardSummary({ llm: mkLLM(payload), profiles: [{ name: '甲', appearance: '黑发' }], contentMode: 'adult' });
  ok('普通版：成人字段被清空', !gen.characters[0].eroticAbilities && !gen.characters[0].privateDetails,
    JSON.stringify({ e: gen.characters[0].eroticAbilities, p: gen.characters[0].privateDetails }));
  ok('成人版：成人字段保留', adult.characters[0].eroticAbilities === '敏感点', JSON.stringify(adult.characters[0].eroticAbilities));
  ok('summary 记录版本', gen.contentMode === 'general' && adult.contentMode === 'adult', '');
}

// ============================================================
console.log('\n【6】接线：小说 / 图片 / 插件 / CLI / 两个页面');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const pipe = await readFile(path.join(ROOT, 'src/pipeline.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');
  const plugIdx = await readFile(path.join(ROOT, 'dsh/index.js'), 'utf-8');
  const plugClient = await readFile(path.join(ROOT, 'dsh/client.js'), 'utf-8');
  const cli = await readFile(path.join(ROOT, 'scripts/image-card-from-dir.mjs'), 'utf-8');
  const genPage = await readFile(path.join(ROOT, 'public/js/pages/generate.js'), 'utf-8');
  const imgPage = await readFile(path.join(ROOT, 'public/js/pages/image-card.js'), 'utf-8');

  ok('pipeline 归一化版本', /normalizeContentMode\(config\.contentMode\)/.test(pipe), '');
  ok('pipeline 人物 prompt 带版本规则', /withContentRules\(/.test(pipe) && /contentMode, 'character'/.test(pipe), '');
  ok('pipeline 落盘前删成人字段（普通版）', /applyContentModeToCharItem/.test(pipe), '');
  ok('pipeline meta 记录版本', /contentMode,/.test(pipe), '');
  ok('pipeline 有默认普通版兜底', /normalizeContentMode\(config\.contentMode\)/.test(pipe), '');

  ok('server 小说接口传版本', /contentMode: normalizeContentMode\(req\.body\?\.contentMode/.test(srv), '');
  ok('server 图片接口传版本给总结', /contentMode,/.test(srv), '');
  /**
   * 这两条**不要绑死相邻行**：后来又插了 cardFormat，用 `contentMode,\n\s*tokens:`
   * 这种"紧邻下一行"的断言就会假失败（已踩）。
   * 改成认注释标签 + 变量，位置无关。
   */
  ok('server 图片 meta 记录版本', /角色卡版本（general \/ adult）\n\s*contentMode,/.test(srv), '');
  ok('server 图片装配传版本', /\/\/ 格式：普通卡会摘掉美化与变量\n\s*cardFormat,/.test(srv), '');

  ok('插件任务层支持版本', /contentMode = 'general'/.test(plug), '');
  ok('插件路由读取 fields.contentMode', /contentMode: String\(fields\.contentMode/.test(plugIdx), '');
  ok('插件面板有版本下拉', /contentMode/.test(plugClient) && /成人版/.test(plugClient), '');
  ok('插件面板默认普通版', /useState\('general'\)/.test(plugClient), '');

  ok('CLI 支持 --adult', /args\.adult/.test(cli), '');
  ok('CLI 默认普通版', /args\.adult \? 'adult' : 'general'/.test(cli), '');
  ok('CLI 把版本传给总结/精修/装配',
    (cli.match(/contentMode/g) || []).length >= 4, String((cli.match(/contentMode/g) || []).length));

  ok('生成页有版本下拉', /name: 'contentMode'/.test(genPage), '');
  ok('生成页默认 general', /value: 'general', selected: true/.test(genPage), '');
  ok('生成页把版本发给后端', /fd\.append\('contentMode'/.test(genPage), '');
  ok('图片页有版本下拉', /image-card-content-mode/.test(imgPage), '');
  ok('图片页把版本发给后端', /fd\.append\('contentMode'/.test(imgPage), '');

  ok('步骤模板含两个成人字段（小说路径）',
    /erotic_abilities/.test(await readFile(path.join(ROOT, 'src/steps.js'), 'utf-8')), '');
  ok('图片总结 schema 含成人字段（仅成人版用）',
    /"erotic_abilities"/.test(await readFile(path.join(ROOT, 'src/steps.js'), 'utf-8')), '');
}

// ============================================================
console.log('\n【7】真跑 pipeline：普通版不产成人字段、成人版保留');
{
  const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');

  const runOnce = async (contentMode) => {
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
      let out = {};
      if (/章节级多任务抽取器/.test(sys)) out = [];
      else if (/时间线锚点/.test(sys)) out = { origin: { event: '开始' } };
      else if (/阶段划分器/.test(sys)) out = { phases: [] };
      else if (/世界观抽取器/.test(sys)) out = { worldbook: [], items: [] };
      else if (/人物名单抽取器/.test(sys)) out = { characters: [{ name: '甲' }] };
      else if (/"profiles"\s*:/.test(sys)) {
        // 批量档案：**两档都故意返回成人字段**，用来验证普通版是代码删掉的
        out = {
          profiles: [{
            name: '甲',
            content_yaml: 'name: 甲\nappearance: |\n  黑发\nerotic_abilities: |\n  敏感点\n私处细节描写: |\n  乳房：大\n',
          }],
        };
      } else if (/人物档案抽取器/.test(sys)) {
        out = {
          name: '甲',
          content_yaml: 'name: 甲\nappearance: |\n  黑发\nerotic_abilities: |\n  敏感点\n私处细节描写: |\n  乳房：大\n',
        };
      } else if (/事件条目撰写/.test(sys)) out = { events: [], synopsis: '概要' };
      else if (/热门作品/.test(sys)) out = { popular: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const dir = await mkdtemp(path.join(tmpdir(), `n2c-cm-${contentMode}-`));
    try {
      const novel = path.join(dir, 'n.txt');
      await writeFile(novel, `第一章\n${'张三走进村子。'.repeat(300)}`, 'utf-8');
      const taskDir = path.join(dir, 'task_x');
      const r = await runPipeline({
        outDir: taskDir, novelPath: novel,
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
        title: '版本测试', outputMode: 'card', detailLevel: 'basic', contentMode,
        concurrency: 1, maxCharacters: 2, charBatchSize: 1,
      }, () => {});
      // 直接读落盘产物 —— 用户拿到的就是它
      let card = null;
      try { card = JSON.parse(await readFile(path.join(taskDir, 'character_card.json'), 'utf-8')); } catch { /* 忽略 */ }
      return { meta: r?.meta, card };
    } finally {
      globalThis.fetch = orig;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let gen = null, adult = null, err = null;
  try { gen = await runOnce('general'); adult = await runOnce('adult'); } catch (e) { err = e; }
  ok('普通版能跑通', !err && !!gen, err ? err.message : '');
  ok('成人版能跑通', !err && !!adult, err ? err.message : '');
  ok('普通版 meta.contentMode = general', gen?.meta?.contentMode === 'general', String(gen?.meta?.contentMode));
  ok('成人版 meta.contentMode = adult', adult?.meta?.contentMode === 'adult', String(adult?.meta?.contentMode));
  ok('两档都产出了角色卡文件', !!gen?.card && !!adult?.card, '');
}

// ============================================================
console.log('\n【8】装配关口：普通版进世界书前就被删掉');
{
  /**
   * 为什么单独测这一层：
   *   用户最终读到的是**世界书条目正文**。pipeline 里人物条目在
   *   `finalizeCharItem` 过一道版本闸门后交给 `assembleWorldbook`。
   *   这里直接调这两步，验证"过了装配之后普通版里确实没有成人字段"。
   */
  const { assembleWorldbook } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
  const yaml = 'name: 甲\nappearance: |\n  黑发\nerotic_abilities: |\n  敏感点\n私处细节描写: |\n  乳房：大\n';

  const build = (mode) => {
    const item = C.applyContentModeToCharItem({ name: '甲', keys: ['甲'], content_yaml: yaml, tier: '主角' }, mode);
    return assembleWorldbook(
      [{ chapter: '第一章', event: '开始' }], [], [item], [],
      { title: '测试', protagonist: '' },
    );
  };
  const charTextOf = (wb) => (wb.entries || [])
    .filter(e => /\[character/.test(String(e.comment || '')))
    .map(e => String(e.content || '')).join('\n');

  const genText = charTextOf(build('general'));
  const adultText = charTextOf(build('adult'));
  ok('世界书里真的有人物条目', genText.length > 0 && adultText.length > 0, `${genText.length}/${adultText.length}`);
  ok('**普通版世界书条目里没有成人字段**', !/erotic_abilities|私处细节描写/.test(genText), genText.slice(0, 80));
  ok('普通版仍保留正常内容', /appearance/.test(genText) && /黑发/.test(genText), '');
  ok('成人版世界书条目保留成人字段',
    /erotic_abilities/.test(adultText) && /私处细节描写/.test(adultText), adultText.slice(0, 80));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  角色卡版本测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
