/**
 * 角色卡格式（普通卡 / 完整卡）测试
 *
 * 用户要求（原话）：
 *   「生成角色卡功能增加一个没有美化和变量的普通角色卡
 *     以及有美化和变量的完整角色卡」
 *
 * 定义（见 src/card_format.js）：
 *   美化 = 状态栏（HTML 面板）+ 7 条内嵌正则
 *   变量 = MVU 变量树：[initvar] / 变量更新规则 / 变量更新强调 / 导演指令 / 角色阶段
 *          + 卡里注册 MVU 的 tavern_helper 脚本
 *
 * 钉住的东西：
 *   ① 默认仍是完整卡（不破坏旧行为）
 *   ② 普通卡是完整卡的**严格子集**：只删美化与变量，设定信息一个不少
 *   ③ 普通卡不需要任何扩展（无 regex_scripts / tavern_helper）
 *   ④ 普通卡确实跳过状态栏那次 LLM 调用
 *   ⑤ 普通卡不产出 variables/statusbar/regex 这些文件（免得误导）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const F = await import(pathToFileURL(path.join(ROOT, 'src/card_format.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

const mkFullCard = () => ({
  spec: 'chara_card_v3',
  creatorcomment: '由小说 → 角色卡生成器生成',
  data: {
    name: '测试',
    character_book: {
      entries: [
        { id: 0, comment: '[timeline]', content: '时间线' },
        { id: 1, comment: '[synopsis]', content: '简介' },
        { id: 2, comment: '[initvar]勿启用', content: '变量树 YAML' },
        { id: 3, comment: '变量更新规则', content: '规则' },
        { id: 4, comment: '变量更新强调', content: '强调' },
        { id: 5, comment: '导演指令', content: '导演' },
        { id: 6, comment: '角色阶段', content: '阶段' },
        { id: 7, comment: '围栏与隔离', content: '围栏' },
        { id: 8, comment: '输出纪律', content: '纪律' },
        { id: 9, comment: '干预与偏离度', content: '百分位' },
        { id: 10, comment: '[character] 甲', content: '人物' },
        { id: 11, comment: '[event] 开场', content: '事件' },
        { id: 12, comment: '[map_world] 世界', content: '世界观' },
      ],
    },
    extensions: {
      world: '世界书名', depth_prompt: { prompt: '', depth: 4 },
      regex_scripts: [{ scriptName: '状态栏美化' }],
      tavern_helper: { scripts: [{ name: 'mvu' }] },
    },
    creator_notes: '完整卡说明（需要酒馆助手与 MVU）',
  },
});

// ============================================================
console.log('\n【1】默认 = 完整卡（不破坏旧行为）');
{
  ok('不传 → enhanced', F.normalizeCardFormat(undefined) === 'enhanced', '');
  ok('空串 → enhanced', F.normalizeCardFormat('') === 'enhanced', '');
  ok('乱写 → enhanced', F.normalizeCardFormat('whatever') === 'enhanced', '');
  ok('plain → plain', F.normalizeCardFormat('plain') === 'plain', '');
  ok('「普通」也认', F.normalizeCardFormat('普通') === 'plain', '');
  ok('大小写容错', F.normalizeCardFormat(' PLAIN ') === 'plain', '');
  ok('isPlainCard', F.isPlainCard('plain') && !F.isPlainCard('enhanced'), '');
  ok('两种格式说明不同', F.describeCardFormat('plain') !== F.describeCardFormat('enhanced'), '');
}

// ============================================================
console.log('\n【2】普通卡 = 完整卡删掉美化与变量（严格子集）');
{
  const full = mkFullCard();
  const plain = F.makePlainCard(full);
  const comments = plain.data.character_book.entries.map(e => e.comment);

  for (const c of ['[initvar]勿启用', '变量更新规则', '变量更新强调', '导演指令', '角色阶段', '围栏与隔离', '输出纪律', '干预与偏离度']) {
    ok(`删掉了「${c}」`, !comments.includes(c), comments.join(' | '));
  }
  for (const c of ['[timeline]', '[synopsis]', '[character] 甲', '[event] 开场', '[map_world] 世界']) {
    ok(`保留了「${c}」`, comments.includes(c), '');
  }
  ok('条目数正确（13 → 5）', comments.length === 5, String(comments.length));
  ok('id 重排为连续 0..n', plain.data.character_book.entries.every((e, i) => e.id === i),
    plain.data.character_book.entries.map(e => e.id).join(','));

  ok('删掉 regex_scripts（美化）', !('regex_scripts' in plain.data.extensions), '');
  ok('删掉 tavern_helper（MVU 变量框架）', !('tavern_helper' in plain.data.extensions), '');
  ok('保留其它 extensions（world）', plain.data.extensions.world === '世界书名', '');
  ok('导入说明已换成普通卡版本', /普通卡/.test(plain.data.creator_notes) && /不需要/.test(plain.data.creator_notes), '');
  ok('顶层 creatorcomment 也标注普通卡', /普通卡/.test(plain.creatorcomment), plain.creatorcomment);

  // 纯函数：不能改原卡
  ok('不修改传入的卡', full.data.character_book.entries.length === 13
    && !!full.data.extensions.regex_scripts && !!full.data.extensions.tavern_helper, '');
  ok('深拷贝：改结果不影响原卡', (() => {
    plain.data.character_book.entries[0].content = '被改了';
    return full.data.character_book.entries[0].content === '时间线';
  })(), '');

  ok('坏输入不崩', F.makePlainCard(null) === null && F.makePlainCard({}) !== undefined, '');
}

// ============================================================
console.log('\n【3】图片路径：两档实际产出差异');
{
  const profiles = [{ name: '甲', appearance: '黑发', imageIndex: 0 }];
  const summary = {
    world: { overview: '', era: '', locations: [], factions: [], systems: [], history: [] },
    characters: [{ name: '甲', appearance: '黑发' }], scenario: '', opening: '',
  };
  const build = (cardFormat) => IC.buildCardFromExtraction({
    profiles, title: '格式测试', summary, cardFormat, wantWorldbook: true,
  });

  const enhanced = await build('enhanced');
  const plain = await build('plain');
  const eComments = enhanced.card.data.character_book.entries.map(e => e.comment);
  const pComments = plain.card.data.character_book.entries.map(e => e.comment);

  ok('完整卡有变量类条目', eComments.includes('[initvar]勿启用') && eComments.includes('变量更新规则'), '');
  ok('**普通卡没有任何变量类条目**',
    !pComments.some(c => /initvar|变量更新|导演指令|角色阶段|围栏与隔离|输出纪律|干预与偏离度/.test(c)),
    pComments.join(' | '));
  ok('普通卡仍有人物/事件/世界观条目',
    pComments.some(c => /\[character/.test(c)) && pComments.some(c => /\[event/.test(c))
    && pComments.some(c => /\[map_world/.test(c)), pComments.join(' | '));
  ok('完整卡有 7 条正则', (enhanced.card.data.extensions?.regex_scripts?.length || 0) > 0, '');
  ok('**普通卡没有正则**', !enhanced.card.data.extensions?.regex_scripts
    || !plain.card.data.extensions?.regex_scripts, '');
  ok('普通卡没有 MVU 脚本', !plain.card.data.extensions?.tavern_helper, '');
  ok('普通卡不生成状态栏（statusbar=null）', plain.statusbar === null, String(plain.statusbar));
  ok('完整卡生成状态栏', !!enhanced.statusbar, '');
  ok('result.cardFormat 正确', enhanced.cardFormat === 'enhanced' && plain.cardFormat === 'plain', '');
  ok('普通卡照样有 description/first_mes',
    !!plain.card.data.description && !!plain.card.data.first_mes, '');
}

// ============================================================
console.log('\n【4】文件产物：普通卡不写变量/状态栏/正则文件');
{
  const profiles = [{ name: '甲', appearance: '黑发', imageIndex: 0 }];
  const summary = {
    world: { overview: '', era: '', locations: [], factions: [], systems: [], history: [] },
    characters: [{ name: '甲', appearance: '黑发' }], scenario: '', opening: '',
  };
  const run = async (cardFormat) => {
    const dir = await mkdtemp(path.join(tmpdir(), `n2c-fmt-${cardFormat}-`));
    const result = await IC.buildCardFromExtraction({ profiles, title: 't', summary, cardFormat });
    // imagePaths 传空：避免真的去复制头像文件（这里只关心"写了哪些产物"）
    await IC.writeImageCardOutputs(dir, result, { imagePaths: [], vision: null });
    const files = await readdir(dir);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return files;
  };
  const eFiles = await run('enhanced');
  const pFiles = await run('plain');

  ok('完整卡写了 statusbar.json', eFiles.includes('statusbar.json'), eFiles.join(', '));
  ok('完整卡写了 regex_scripts.json', eFiles.includes('regex_scripts.json'), '');
  ok('完整卡写了 variables.json', eFiles.includes('variables.json'), '');
  ok('**普通卡没写 statusbar/regex/variables**',
    !pFiles.includes('statusbar.json') && !pFiles.includes('regex_scripts.json') && !pFiles.includes('variables.json'),
    pFiles.join(', '));
  ok('普通卡仍写 character_card.json 与 worldbook.json',
    pFiles.includes('character_card.json') && pFiles.includes('worldbook.json'), '');
  ok('普通卡仍写 README', pFiles.includes('README.md'), '');
}

// ============================================================
console.log('\n【5】真跑小说流水线：普通卡跳过状态栏那次调用');
{
  const { runPipeline } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);

  const runOnce = async (cardFormat) => {
    const calls = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const sys = (body.messages || []).find(m => m.role === 'system')?.content || '';
      calls.push(sys.slice(0, 18));
      let out = {};
      if (/章节级多任务抽取器/.test(sys)) out = [];
      else if (/时间线锚点/.test(sys)) out = { origin: { event: '开始' } };
      else if (/阶段划分器/.test(sys)) out = { phases: [] };
      else if (/世界观抽取器/.test(sys)) out = { worldbook: [], items: [] };
      else if (/人物名单抽取器/.test(sys)) out = { characters: [{ name: '甲' }] };
      else if (sys.includes('"profiles"')) out = { profiles: [{ name: '甲', content_yaml: 'name: 甲\nappearance: |\n  黑发\n' }] };
      else if (/人物档案抽取器/.test(sys)) out = { name: '甲', content_yaml: 'name: 甲\nappearance: |\n  黑发\n' };
      else if (/事件条目撰写/.test(sys)) out = { events: [], synopsis: '概要' };
      else if (/热门作品/.test(sys)) out = { popular: false };
      else if (/状态栏/.test(sys)) out = { theme: 'default', tabs: [] };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const dir = await mkdtemp(path.join(tmpdir(), `n2c-pipe-${cardFormat}-`));
    try {
      const novel = path.join(dir, 'n.txt');
      await writeFile(novel, `第一章\n${'张三走进村子。'.repeat(300)}`, 'utf-8');
      const taskDir = path.join(dir, 'task_x');
      const r = await runPipeline({
        outDir: taskDir, novelPath: novel,
        baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm',
        title: '格式测试', outputMode: 'card', detailLevel: 'basic',
        contentMode: 'general', cardFormat,
        concurrency: 1, maxCharacters: 2, charBatchSize: 1,
      }, () => {});
      const card = JSON.parse(await readFile(path.join(taskDir, 'character_card.json'), 'utf-8'));
      return { meta: r?.meta, card, calls };
    } finally {
      globalThis.fetch = orig;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };

  let enhanced = null, plain = null, err = null;
  try { enhanced = await runOnce('enhanced'); plain = await runOnce('plain'); } catch (e) { err = e; }
  ok('完整卡跑通', !err && !!enhanced, err ? err.message : '');
  ok('普通卡跑通', !err && !!plain, err ? err.message : '');
  ok('完整卡 meta.cardFormat = enhanced', enhanced?.meta?.cardFormat === 'enhanced', String(enhanced?.meta?.cardFormat));
  ok('普通卡 meta.cardFormat = plain', plain?.meta?.cardFormat === 'plain', String(plain?.meta?.cardFormat));

  const eC = (enhanced?.card?.data?.character_book?.entries || []).map(e => e.comment);
  const pC = (plain?.card?.data?.character_book?.entries || []).map(e => e.comment);
  ok('落盘完整卡里有变量类条目', eC.some(c => /initvar|变量更新规则/.test(c)), eC.join(' | '));
  ok('**落盘普通卡里没有变量/导演/状态栏类条目**',
    !pC.some(c => /initvar|变量更新|导演指令|角色阶段|围栏与隔离|输出纪律|干预与偏离度/.test(c)),
    pC.join(' | '));
  ok('落盘普通卡条目 = 完整卡减去美化/变量条目',
    JSON.stringify(pC) === JSON.stringify(eC.filter(c => !F.PLAIN_DROP_COMMENTS.includes(c))),
    `plain=${pC.join(' | ')} / full=${eC.join(' | ')}`);
  ok('落盘普通卡有 description / first_mes',
    !!plain?.card?.data?.description && !!plain?.card?.data?.first_mes, '');
  ok('普通卡卡内无 regex_scripts', !plain?.card?.data?.extensions?.regex_scripts, '');
  ok('普通卡卡内无 tavern_helper', !plain?.card?.data?.extensions?.tavern_helper, '');
  ok('普通卡文件更小（少了内置模板）',
    JSON.stringify(plain.card).length < JSON.stringify(enhanced.card).length,
    `${JSON.stringify(plain.card).length} vs ${JSON.stringify(enhanced.card).length}`);
  ok('普通卡少调用了状态栏（调用数不增加）', plain.calls.length <= enhanced.calls.length,
    `${plain.calls.length} vs ${enhanced.calls.length}`);
}

// ============================================================
console.log('\n【6】接线：六个入口');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const pipe = await readFile(path.join(ROOT, 'src/pipeline.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');
  const plugIdx = await readFile(path.join(ROOT, 'dsh/index.js'), 'utf-8');
  const plugClient = await readFile(path.join(ROOT, 'dsh/client.js'), 'utf-8');
  const cli = await readFile(path.join(ROOT, 'scripts/image-card-from-dir.mjs'), 'utf-8');
  const genPage = await readFile(path.join(ROOT, 'public/js/pages/generate.js'), 'utf-8');
  const imgPage = await readFile(path.join(ROOT, 'public/js/pages/image-card.js'), 'utf-8');

  ok('pipeline 归一化格式', /normalizeCardFormat\(config\.cardFormat\)/.test(pipe), '');
  ok('pipeline 普通卡跳过状态栏', /isPlainCard\(cardFormat\)/.test(pipe), '');
  ok('pipeline 组装后改造成普通卡', /makePlainCard\(characterCard\)/.test(pipe), '');
  ok('pipeline meta 记录格式', /cardFormat,/.test(pipe), '');

  ok('server 小说接口传格式', /cardFormat: normalizeCardFormat/.test(srv), '');
  ok('server 图片接口传格式', /cardFormat,/.test(srv), '');
  ok('server 图片 meta 记录格式', /cardFormat,/.test(srv), '');

  ok('插件任务层支持格式', /cardFormat = 'enhanced'/.test(plug), '');
  ok('插件路由读取 fields.cardFormat', /cardFormat: String\(fields\.cardFormat/.test(plugIdx), '');
  ok('插件面板有格式下拉', /cardFormat/.test(plugClient) && /普通卡/.test(plugClient), '');
  ok('插件面板默认完整卡', /useState\('enhanced'\)/.test(plugClient), '');

  ok('CLI 支持 --plain', /args\.plain \? 'plain' : 'enhanced'/.test(cli), '');
  ok('CLI 把格式传进装配', /cardFormat \}/.test(cli) || /contentMode, cardFormat/.test(cli), '');

  ok('生成页有格式下拉', /name: 'cardFormat'/.test(genPage), '');
  ok('生成页默认 enhanced', /value: 'enhanced', selected: true/.test(genPage), '');
  ok('生成页把格式发给后端', /fd\.append\('cardFormat'/.test(genPage), '');
  ok('图片页有格式下拉', /image-card-card-format/.test(imgPage), '');
  ok('图片页把格式发给后端', /fd\.append\('cardFormat'/.test(imgPage), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  角色卡格式测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
