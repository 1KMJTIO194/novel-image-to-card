/**
 * 完整角色卡（chara_card_v3）测试
 *
 * 用纯逻辑方式直接调用 assembleCharacterCard()，不依赖服务器与 LLM。
 * 重点验证：
 *   - 结构合法且可被 JSON 往返
 *   - initvar 条目必须是关闭状态（否则会污染提示词）
 *   - EJS 未被转义（<%_ 原样保留），否则酒馆助手无法渲染
 *   - 正则脚本、tavern_helper、character_book 齐备
 *   - 顶层字段与 data.* 保持一致
 *   - 变量更新规则按实际变量树展开（不照抄模板）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const { assembleCharacterCard } = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const { varKey } = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);
const { extractMvuPaths, unreachablePaths } = await import('./_helpers.mjs');
// 真实流水线里 buildVariables / flattenVariables 都会把键名过一遍 varKey，
// 这里保持一致，避免测试夹具与生产数据形状不同
const vkObj = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [varKey(k), v]));
const T = await import(pathToFileURL(path.join(ROOT, 'src/templates.js')).href);
const { generateUUID } = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);

/** 造一份完整的流水线上下文 */
function makeContext(overrides = {}) {
  return {
    timeline: {
      base: '天启纪年',
      origin: { raw: '天启三年春', event: '开篇入城', reason: '最早绝对纪年' },
      events: [
        { name: '开篇入城', time: '天启三年春', precision: 'exact', chapter: '第一章' },
        { name: '夜探旧宅', time: '天启三年春 + 三日后', precision: 'inferred', chapter: '第三章' },
      ],
      characters: [{ name: '林昭', birth: '（线索：十七岁）', chapter: '第一章' }],
    },
    events: [
      {
        name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭踏进城门',
        canon: '林昭进入云京，寻找失踪的兄长。', pressure: 'core',
        prerequisites: { temporal: [], behavioral: '若已见过沈砚' }, interventions: [],
      },
      {
        name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '旧宅的门虚掩着',
        canon: '林昭夜探旧宅，发现密信。', pressure: 'buffer',
        prerequisites: { temporal: ['开篇入城'], behavioral: '' }, interventions: [],
      },
    ],
    characters: [
      { name: '林昭', keys: ['林昭'], content: '林昭，十七岁，为寻兄长独自入京。' },
      { name: '沈砚', keys: ['沈砚', '沈公子'], content: '沈砚，茶楼常客，知道玉佩来历。' },
    ],
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: '云京为王朝都城。', constant: true },
      { category: 'system_realm', name: '淬体九境', keys: ['淬体', '境界'], content: '共九境。', constant: true },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: '掌查密案。', constant: false },
      { category: 'map_location', name: '城南茶楼', keys: ['茶楼'], content: '城南茶楼。', constant: false },
    ],
    variables: {
      world: { time: '天启三年春', phase: '入城立足' },
      events: { 开篇入城: { status: 'pending', deviation: 0, pressure: 'core' } },
      characters: { 沈砚: { affinity: 0, state: '正常' } },
      user: { name: '林昭' },
      custom: { storylines: { 入城立足: { events: ['开篇入城'], stage: '起点', deviation: 0, core: true } } },
    },
    phasesWithDeltas: [
      { name: '入城立足', startEvent: '开篇入城', endEvent: '开篇入城', coreChange: '从孤身寻亲到获得助力', characterDeltas: [] },
      { name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: '从被动等待到主动追查',
        characterDeltas: [{ character: '林昭', change: '从谨慎观望变为主动出击', quote: '她握紧了那封信' }] },
    ],
    userMode: { mode: 'protagonist', protagonistName: '林昭' },
    cardFields: {
      name: '云京旧案',
      description: '天启三年，云京。林昭为寻失踪的兄长入京……',
      personality: '林昭沉静果决，说话简短。',
      scenario: '你站在云京城门下，袖中揣着半块玉佩。',
      first_mes: '城门在身后合拢。你抬起头，看见满城灯火——从这一刻起，你只能靠自己了。',
      alternate_greetings: ['你在茶楼里坐下，对面的人推来一盏茶。', '夜里的旧宅门虚掩着，你伸手推开了它。'],
      mes_example: '<START>\n{{user}}: 你认识这块玉佩吗？\n{{char}}: 沈砚的手指顿了一下。',
      tags: ['古风', '悬疑', '女性主角'],
    },
    worldbookName: '生成的世界设定集',
    ...overrides,
  };
}

const card = assembleCharacterCard(makeContext());
const entries = card.data.character_book.entries;
const byComment = (c) => entries.find(e => e.comment === c);
/** 人物条目注释形如 `[character] 名` 或 `[character·主要NPC] 名`，按前缀+结尾匹配 */
const byCommentPrefix = (prefix, name) =>
  entries.find(e => (e.comment || '').startsWith(prefix) && (e.comment || '').endsWith(` ${name}`));

// ============================================================
console.log('\n【1】JSON 结构合法性');
{
  let parsed = null;
  let json = '';
  try {
    json = JSON.stringify(card, null, 2);
    parsed = JSON.parse(json);
  } catch (e) {
    console.log('     JSON 往返失败：', e.message);
  }
  ok('可被 JSON.stringify + parse 往返', !!parsed, 'parse 失败');
  ok('spec 为 chara_card_v3', card.spec === 'chara_card_v3', card.spec);
  ok('spec_version 为 3.0', card.spec_version === '3.0', card.spec_version);
  ok('顶层 name 与 data.name 一致', card.name === card.data.name,
    `${card.name} vs ${card.data.name}`);
  ok('顶层 description 与 data.description 一致', card.description === card.data.description);
  ok('顶层 first_mes 与 data.first_mes 一致', card.first_mes === card.data.first_mes);
  ok('顶层 tags 与 data.tags 一致', JSON.stringify(card.tags) === JSON.stringify(card.data.tags));
  ok('存在 create_date', typeof card.create_date === 'string' && !Number.isNaN(Date.parse(card.create_date)));
  // CCv3 规范在 data 下定义 creation_date（Unix 秒）；顶层那个 create_date 是 ST 惯例
  ok('data.creation_date 是 Unix 秒（规范要求）',
    Number.isInteger(card.data.creation_date) && card.data.creation_date > 1_600_000_000
    && card.data.creation_date < 4_000_000_000,
    String(card.data.creation_date));
  ok('creation_date 与 create_date 表示同一时刻（误差 < 5 秒）',
    Math.abs(card.data.creation_date * 1000 - Date.parse(card.create_date)) < 5000,
    `${card.data.creation_date} vs ${card.create_date}`);
  ok('avatar / talkativeness / fav 字段齐备',
    card.avatar === 'none' && card.talkativeness === 0.5 && card.fav === false,
    JSON.stringify({ avatar: card.avatar, talkativeness: card.talkativeness, fav: card.fav }));
  // ST 的类型契约是 number（char-data.js：@property {number} talkativeness），
  // 缺失时它补的默认值也是数字 0.5 —— 写字符串虽然不会崩，但属于类型违约
  ok('talkativeness 是数字而非字符串', typeof card.talkativeness === 'number',
    typeof card.talkativeness);
  ok('data.extensions.talkativeness 也是数字',
    typeof card.data.extensions.talkativeness === 'number',
    typeof card.data.extensions.talkativeness);
  ok('创建时间与 date 都在 card 上', 'creatorcomment' in card && 'data' in card);
}

// ============================================================
console.log('\n【2】character_book 条目');
{
  ok('data.character_book 存在且有 name', card.data.character_book?.name === '生成的世界设定集',
    JSON.stringify(card.data.character_book?.name));
  ok('entries 是数组', Array.isArray(entries));

  const expected = [
    '[timeline]', '[initvar]勿启用', '变量更新规则', '变量更新强调',
    '导演指令', '角色阶段', '围栏与隔离', '输出纪律', '干预与偏离度',
  ];
  for (const c of expected) ok(`含内置条目「${c}」`, !!byComment(c));

  ok('含世界观常驻条目', !!byComment('[map_world] 云京') && !!byComment('[system_realm] 淬体九境'));
  ok('含世界观 key 触发条目', !!byComment('[system_faction] 缉影司') && !!byComment('[map_location] 城南茶楼'));
  // 人物条目注释带剧情分层后缀（`[character·主要NPC] 名`），主角不带后缀
  ok('含人物条目', !!byCommentPrefix('[character', '林昭') && !!byCommentPrefix('[character', '沈砚'));
  ok('含事件条目', !!byComment('[event] 开篇入城') && !!byComment('[event] 夜探旧宅'));

  // 数量：9 内置 + 2 常驻世界观 + 2 人物 + 2 事件 + 2 key 世界 = 17
  ok('条目总数符合预期（17）', entries.length === 17, `实际 ${entries.length}`);

  ok('id 连续且唯一',
    entries.every((e, i) => e.id === i) && new Set(entries.map(e => e.id)).size === entries.length);

  // 字段完整性
  const need = ['id', 'comment', 'content', 'constant', 'enabled', 'insertion_order',
    'keys', 'secondary_keys', 'selective', 'use_regex', 'position', 'extensions'];
  const missing = [];
  entries.forEach((e, i) => {
    for (const k of need) if (!(k in e)) missing.push(`#${i}.${k}`);
  });
  ok('每个条目字段齐备', missing.length === 0, missing.slice(0, 6).join(', '));

  ok('所有 position 都是 after_char / before_char',
    entries.every(e => ['after_char', 'before_char'].includes(e.position)),
    JSON.stringify([...new Set(entries.map(e => e.position))]));

  ok('key 触发条目都有 keys',
    entries.filter(e => !e.constant).every(e => Array.isArray(e.keys) && e.keys.length > 0),
    JSON.stringify(entries.filter(e => !e.constant && !e.keys?.length).map(e => e.comment)));

  ok('timeline 条目不是 selective / use_regex',
    byComment('[timeline]').selective === false && byComment('[timeline]').use_regex === false);
}

// ============================================================
console.log('\n【3】initvar 必须关闭（关键）');
{
  const initvar = byComment('[initvar]勿启用');
  ok('条目存在', !!initvar);
  ok('enabled === false（导入后是关闭状态）', initvar?.enabled === false, String(initvar?.enabled));
  ok('constant === true（内容是常驻配置）', initvar?.constant === true);
  ok('position 为 before_char', initvar?.position === 'before_char', initvar?.position);
  ok('depth 为 4', initvar?.extensions?.depth === 4, String(initvar?.extensions?.depth));
  ok('prevent_recursion 为 true', initvar?.extensions?.prevent_recursion === true);
  ok('内容是合法 YAML 且等于变量树', (() => {
    try {
      const parsed = YAML.parse(initvar.content);
      return parsed?.world?.time === '天启三年春' && !!parsed?.events?.['开篇入城'];
    } catch { return false; }
  })());
}

// ============================================================
console.log('\n【4】EJS 未被转义（关键）');
{
  const dir = byComment('导演指令');
  const phase = byComment('角色阶段');
  ok('导演指令含 <%_ （未被转义）', dir.content.includes('<%_'), dir.content.slice(0, 60));
  ok('导演指令含 <%= ', dir.content.includes('<%='));
  ok('导演指令含 _%>', dir.content.includes('_%>'));
  ok('角色阶段含 <%_ ', phase.content.includes('<%_'));
  ok('EJS 中不含 HTML 转义残留',
    !dir.content.includes('&lt;%') && !phase.content.includes('&lt;%'),
    '出现了 &lt;% —— 说明被转义了');
  ok('EJS 能取到阶段变量', /getvar\('stat_data\.world\.phase'/.test(phase.content));
  // 只有带 characterDeltas 的阶段才会进表（第一阶段是基线，不需要增量）
  ok('阶段表包含有增量的阶段', phase.content.includes('旧案浮现'), phase.content.slice(0, 120));
  ok('阶段表含起始基线项', phase.content.includes('起始'));
  ok('阶段表用 <%= 输出增量', phase.content.includes('<%= 人设增量表[阶段] %>'));
  ok('导演指令按 userMode 选择变体（protagonist）',
    /stat_data\.events/.test(dir.content) && /推进原则|正在发生/.test(dir.content));

  // JSON 序列化后仍然是原始字符（不转义 < >）
  const json = JSON.stringify(card);
  ok('JSON 字符串里保留字面 <%_', json.includes('<%_'));
  ok('JSON 字符串里没有 \\u003c 形式的转义', !json.includes('\\u003c'));
}

// ============================================================
console.log('\n【5】正则脚本与 tavern_helper');
{
  const rs = card.data.extensions.regex_scripts;
  ok('regex_scripts 至少有 1 条', Array.isArray(rs) && rs.length >= 1, String(rs?.length));
  const r = rs[0];
  ok('有 id 且形如 UUID', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id), r.id);
  ok('scriptName 标明隐藏', /隐藏|不发送/.test(r.scriptName), r.scriptName);
  ok('findRegex 匹配 <update> 标签', r.findRegex.includes('<update'), r.findRegex.slice(0, 50));
  ok('replaceString 为空（只做隐藏）', r.replaceString === '');
  ok('markdownOnly 与 promptOnly 都为 true', r.markdownOnly === true && r.promptOnly === true);
  ok('placement 为 [1,2]', JSON.stringify(r.placement) === '[1,2]', JSON.stringify(r.placement));
  ok('disabled 为 false', r.disabled === false);
  ok('runOnEdit 为 false', r.runOnEdit === false);
  ok('trimStrings 为空数组', Array.isArray(r.trimStrings) && r.trimStrings.length === 0);
  ok('substituteRegex 为 0', r.substituteRegex === 0);
  ok('minDepth / maxDepth 为 null', r.minDepth === null && r.maxDepth === null);

  // 说明：makeContext() 不带 statusbar，走的是**未跑 Step 7.5 的兜底分支** ——
  // 只写一条隐藏 <update> 的正则。带 Step 7.5 的 7 条正则场景见 tests/statusbar.mjs 第 12 节。
  ok('tavern_helper 有 scripts 数组（MVU 注册）',
    Array.isArray(card.data.extensions.tavern_helper?.scripts));
  ok('tavern_helper 注册了 mvu 脚本',
    card.data.extensions.tavern_helper.scripts.some(s => s.name === 'mvu' && s.enabled === true));
  ok('world 指向世界书名', card.data.extensions.world === '生成的世界设定集');
  ok('depth_prompt 结构正确',
    card.data.extensions.depth_prompt?.depth === 4 && card.data.extensions.depth_prompt?.role === 'system');

  // 两次生成 id 不同
  const card2 = assembleCharacterCard(makeContext());
  ok('每次生成的正则 id 都不同',
    card2.data.extensions.regex_scripts[0].id !== r.id);

  // 带 Step 7.5 的 statusbar 时，7 条正则原样写入（顺序即 ST 执行顺序）
  const sb = {
    regexScripts: [
      { id: 'a', scriptName: 'A', findRegex: '/a/gsi', replaceString: '', trimStrings: [], placement: [2] },
      { id: 'b', scriptName: 'B', findRegex: '/b/gsi', replaceString: '', trimStrings: [], placement: [2] },
    ],
    placeholder: '<StatusPlaceHolderImpl/>',
    bodyWrapper: { open: '<zhengwen>', close: '</zhengwen>' },
  };
  const cardSb = assembleCharacterCard({ ...makeContext(), statusbar: sb });
  ok('带 statusbar 时正则条数一致',
    cardSb.data.extensions.regex_scripts.length === 2);
  ok('带 statusbar 时正则原样写入（顺序不变）',
    cardSb.data.extensions.regex_scripts[0].id === 'a'
    && cardSb.data.extensions.regex_scripts[1].id === 'b');
  ok('带 statusbar 时输出纪律写入占位符',
    cardSb.data.character_book.entries.find(e => e.comment === '输出纪律')
      .content.includes('<StatusPlaceHolderImpl/>'));
}

// ============================================================
console.log('\n【6】变量更新规则按实际变量树展开');
{
  const rule = byComment('变量更新规则').content;
  ok('含 <status_current_variables> 块', rule.includes('<status_current_variables>'));
  ok('world.time 展开为 get_message_variable',
    rule.includes('{{get_message_variable::stat_data.world.time}}'), rule.slice(0, 200));
  ok('world.phase 展开', rule.includes('stat_data.world.phase'));
  ok('事件路径按实际事件名展开', rule.includes('stat_data.events.开篇入城.status'), '');
  ok('人物路径按实际人名展开', rule.includes('stat_data.characters.沈砚.affinity'));
  ok('user 命名空间展开', rule.includes('stat_data.user.name'));
  ok('故事线路径展开', rule.includes('stat_data.custom.storylines.入城立足'));
  ok('含 check list', /check list:/.test(rule));
  ok('含 update_analysis 要求', rule.includes('<update_analysis>'));
  ok('含 _.set 格式说明', rule.includes('_.set(stat_data.'));
  ok('指明了阶段名来源为「角色阶段」条目', /角色阶段/.test(rule));

  const emphasis = byComment('变量更新强调').content;
  ok('强调条目含 rule 与 format', /rule:/.test(emphasis) && /format:/.test(emphasis));
  ok('强调条目含 <update> 占位', emphasis.includes('<update>'));
}

// ============================================================
console.log('\n【7】三种 userMode 的导演指令都可用');
{
  for (const mode of ['protagonist', 'participant', 'observer']) {
    const c = assembleCharacterCard(makeContext({ userMode: { mode } }));
    const dir = c.data.character_book.entries.find(e => e.comment === '导演指令');
    ok(`${mode}：导演指令含 EJS`, dir.content.includes('<%_'));
    ok(`${mode}：含推进原则说明`, /推进原则/.test(dir.content));
    ok(`${mode}：含事件清单`, dir.content.includes('开篇入城'));
  }
  const obs = assembleCharacterCard(makeContext({ userMode: { mode: 'observer' } }));
  const iv = obs.data.character_book.entries.find(e => e.comment === '干预与偏离度');
  ok('observer 模式用观测版干预规则', /观测模式|视角切换/.test(iv.content), iv.content.slice(0, 60));
}

// ============================================================
console.log('\n【8】缺字段时的兜底（LLM 失败也不能崩）');
{
  const empty = assembleCharacterCard({});
  ok('空上下文也能生成', empty.spec === 'chara_card_v3');
  ok('仍有 character_book 与 regex_scripts',
    Array.isArray(empty.data.character_book.entries) && empty.data.extensions.regex_scripts.length >= 1);
  ok('first_mes 有兜底文案', typeof empty.first_mes === 'string' && empty.first_mes.length > 0);
  ok('name 有兜底', empty.name === '生成的角色卡', empty.name);
  ok('initvar 依然是关闭的',
    empty.data.character_book.entries.find(e => e.comment?.includes('initvar'))?.enabled === false);
  const eg = empty.data.character_book.entries.length;
  ok('空上下文条目数合理（>=9 个内置）', eg >= 9, String(eg));

  const partial = assembleCharacterCard(makeContext({
    cardFields: { name: '只有名字' },
  }));
  ok('cardFields 缺字段时用兜底内容', partial.first_mes.length > 0 && partial.tags.length > 0);
  ok('缺失的 alternate_greetings 归一化为数组', Array.isArray(partial.alternate_greetings));
}

// ============================================================
console.log('\n【9】条目正文无转义问题');
{
  const all = entries.map(e => e.content).join('\n');
  ok('正文没有被 HTML 转义（无 &lt; &gt; &amp;）',
    !/&lt;|&gt;|&amp;/.test(all), all.match(/&(?:lt|gt|amp);/)?.[0] || '');
  ok('正文保留 Markdown 结构（--- 分隔）', all.includes('---'));
  const json = JSON.stringify(card, null, 2);
  ok('序列化后文件体积合理（>5KB）', Buffer.byteLength(json, 'utf8') > 5000,
    `${Buffer.byteLength(json, 'utf8')} B`);
}

// ============================================================
console.log('\n【10】重复数据去重');
{
  // 人物抽取按名字并发调用，同名重复返回时不应产生两条同名条目
  const dup = assembleCharacterCard(makeContext({
    characters: [
      { name: '林昭', keys: ['林昭'], content: '短档案。' },
      { name: '林昭', keys: ['林昭'], content: '这是一份更完整的人物档案，包含身份、外貌与性格。' },
      { name: '沈砚', keys: ['沈砚'], content: '沈砚的档案。' },
    ],
  }));
  // 注释形如 `[character] 名` 或 `[character·主要NPC] 名`（带分层后缀）
  const names = dup.data.character_book.entries
    .filter(e => /^\[character(\u00b7[^\]]+)?\]/.test(e.comment || ''))
    .map(e => e.comment);
  ok('同名人物只保留一条', names.length === 2, JSON.stringify(names));
  const kept = dup.data.character_book.entries.find(e => /^\[character(\u00b7[^\]]+)?\] 林昭$/.test(e.comment || ''));
  ok('保留的是内容更完整的那条', /更完整/.test(kept.content), kept.content.slice(0, 30));

  // 事件同名也不应重复
  const dupEv = assembleCharacterCard(makeContext({
    events: [
      { name: '开篇入城', canon: 'A', pressure: 'core' },
      { name: '开篇入城', canon: 'B', pressure: 'core' },
    ],
  }));
  const evNames = dupEv.data.character_book.entries
    .filter(e => e.comment?.startsWith('[event]')).map(e => e.comment);
  ok('同名事件只保留一条', evNames.length === 1, JSON.stringify(evNames));

  // 空名字的人物要被跳过
  const noName = assembleCharacterCard(makeContext({
    characters: [{ name: '', content: 'x' }, { name: null, content: 'y' }, { name: '有效', content: 'z' }],
  }));
  const okNames = noName.data.character_book.entries
    .filter(e => e.comment?.startsWith('[character')).map(e => e.comment);
  ok('无名字的人物被跳过',
    okNames.length === 1 && /^\[character(\u00b7[^\]]+)?\] 有效$/.test(okNames[0]),
    JSON.stringify(okNames));
}

// ============================================================
// 【11】与真实 MVU / 酒馆约定的对齐（依据 StageDog 官方教程）
//   https://stagedog.github.io/络络/教程/手写mvu变量卡/设置和初始化变量/
//   https://stagedog.github.io/络络/教程/手写mvu变量卡/手写变量结构/
console.log('\n【11】MVU 约定对齐（initvar 根节点 / 取值前缀）');
{
  const initvar = byComment('[initvar]勿启用');
  const yaml = initvar.content;

  // 官方教程：条目名必须含 [initvar] 且必须禁用
  ok('条目名含 [initvar]', /\[initvar\]/.test(initvar.comment), initvar.comment);
  ok('条目禁用（教程明确要求"必须处于禁用状态"）', initvar.enabled === false);

  // 官方教程：initvar 的 YAML 顶层直接就是变量名，不写 stat_data 包裹层。
  // 例：`白娅:\n  依存度: 0`
  const parsed = YAML.parse(yaml);
  ok('顶层直接是变量名，没有 stat_data 包裹层',
    !Object.prototype.hasOwnProperty.call(parsed, 'stat_data'),
    `顶层键：${JSON.stringify(Object.keys(parsed))}`);
  const lines = yaml.split('\n');
  ok('YAML 里没有出现字面量 stat_data', !yaml.includes('stat_data'));
  ok('顶层键无缩进（真正的根层）',
    lines.filter(l => /^\S/.test(l)).every(l => /^[^\s#].*:$/.test(l)),
    JSON.stringify(lines.filter(l => /^\S/.test(l)).slice(0, 3)));

  // 而取值侧（EJS / MVU 宏）必须带 stat_data. 前缀 —— MVU 运行时把变量树挂在 stat_data 下
  const dir = byComment('导演指令');
  ok('EJS 取值带 stat_data. 前缀', /getvar\('stat_data\./.test(dir.content));
  const rule = byComment('变量更新规则');
  ok('MVU 宏取值带 stat_data. 前缀',
    /get_message_variable::stat_data\./.test(rule.content),
    (rule.content.match(/get_message_variable::[^\s}]*/) || [])[0]);

  // 变量更新规则展开的路径必须与 initvar 的真实键一一对应（去掉 stat_data. 后能取到）
  const paths = [...rule.content.matchAll(/get_message_variable::stat_data\.([^\s}]+)/g)].map(m => m[1]);
  const missing = paths.filter(p => {
    let cur = parsed;
    for (const seg of p.split('.')) {
      if (cur === null || typeof cur !== 'object' || !(seg in cur)) return true;
      cur = cur[seg];
    }
    return false;
  });
  ok('更新规则里的每条路径都能在 initvar 里取到', missing.length === 0,
    `取不到：${missing.slice(0, 5).join(', ')}`);
}

// ============================================================
console.log('\n【12】ST 世界书容器字段与条目顺序');
{
  const book = card.data.character_book;
  // ST 内嵌世界书走与独立世界书 JSON 相同的字段约定
  ok('有 description', typeof book.description === 'string');
  ok('有 scan_depth（数字）', typeof book.scan_depth === 'number', String(book.scan_depth));
  ok('有 token_budget（数字）', typeof book.token_budget === 'number', String(book.token_budget));
  ok('有 recursive_scanning（布尔）', typeof book.recursive_scanning === 'boolean');
  // ST 的 TavernCardValidator 要求 world book 同时具备 extensions 与 entries
  ok('有 extensions 对象', book.extensions !== null && typeof book.extensions === 'object',
    JSON.stringify(book.extensions));
  // v3 规范把 group_only_greetings 标注为 MUST be present（群聊专用开场）
  ok('data 有 group_only_greetings（v3 必填，空数组即可）',
    Array.isArray(card.data.group_only_greetings), JSON.stringify(card.data.group_only_greetings));
  // 放进 shared 就是为了两层一致 —— 两层不一致会让 ST 打 mismatch 警告
  ok('顶层与 data 的 group_only_greetings 一致',
    JSON.stringify(card.group_only_greetings) === JSON.stringify(card.data.group_only_greetings),
    JSON.stringify([card.group_only_greetings, card.data.group_only_greetings]));

  // 回归：CATEGORY_ORDER 的 5~30 曾与内置条目 1~10 撞车
  //（map_world=5 撞「导演指令」、system_realm=6 撞「角色阶段」、system_faction=8 撞「输出纪律」）
  const orders = entries.map(e => e.insertion_order);
  const dups = orders.filter((v, i) => orders.indexOf(v) !== i);
  ok('insertion_order 全局唯一（无同序号撞车）', dups.length === 0, `重复：${JSON.stringify([...new Set(dups)])}`);

  // 内置 9 条必须是 1..9，且世界观的 key 触发条目必须整体排在它们之后
  const builtin = ['[timeline]', '[initvar]勿启用', '变量更新规则', '变量更新强调',
    '导演指令', '角色阶段', '围栏与隔离', '输出纪律', '干预与偏离度'];
  ok('内置条目顺序为 1..9',
    builtin.every((c, i) => byComment(c).insertion_order === i + 1),
    JSON.stringify(builtin.map(c => byComment(c).insertion_order)));
  const catOrders = entries
    .filter(e => e.comment?.startsWith('[') && !/^\[(timeline|initvar|character|event)\]/.test(e.comment))
    .map(e => e.insertion_order);
  ok('世界观条目全部排在内置条目之后（> 9）',
    catOrders.every(o => o > 9), JSON.stringify(catOrders));

  // 分类之间的相对顺序不能被基数破坏
  const order = (name) => byComment(name)?.insertion_order;
  ok('分类相对顺序保持：map_world < system_realm < system_faction < map_location',
    order('[map_world] 云京') < order('[system_realm] 淬体九境') &&
    order('[system_realm] 淬体九境') < order('[system_faction] 缉影司') &&
    order('[system_faction] 缉影司') < order('[map_location] 城南茶楼'),
    JSON.stringify([order('[map_world] 云京'), order('[system_realm] 淬体九境'),
      order('[system_faction] 缉影司'), order('[map_location] 城南茶楼')]));
}

// ============================================================
console.log('\n【13】导入说明写在 creator_notes 里（ST 会在角色信息面板展示）');
{
  const notes = card.data.creator_notes;
  ok('creator_notes 非空', typeof notes === 'string' && notes.length > 40, `${notes?.length} 字`);
  ok('说明了需要酒馆助手', /酒馆助手/.test(notes));
  ok('说明了需要 MVU', /MVU/.test(notes));
  ok('提醒 initvar 保持关闭', /initvar/.test(notes) && /关闭/.test(notes));
  // 这三件事漏掉都会"静默失效"（不报错但效果明显不对），必须在卡里就写清楚
  ok('提醒导入内嵌世界书（漏了则世界书一条都不进提示词）',
    /embedded World\/Lorebook/i.test(notes) && /Import Card Lore/i.test(notes));
  ok('提醒放行内嵌正则（漏了则 <update> 会进上下文）',
    /embedded regex script/i.test(notes) && /Scoped/.test(notes));
  ok('说明了漏掉的后果，而不只是"请点是"',
    /不会进提示词|静默失效/.test(notes), '只说了要做什么，没说漏了会怎样');
  ok('提醒群聊不执行卡内正则', /群聊/.test(notes));
  ok('提醒别装错 EJS 扩展', /Prompt Template/.test(notes));
  ok('creatorcomment 仍保留简短署名', card.creatorcomment === '由小说 → 角色卡生成器生成', card.creatorcomment);
}

// ============================================================
// 【14】initvar 的 YAML 必须扛得住来自小说的特殊字符
//   依据 MVU 源码 variable_init.ts：内容先 substitudeMacros 再 parseString，
//   解析失败会 toastr.error + throw，且 throw 被外层 catch 吞掉 →
//   结果是"变量初始化失败"，整卡静默失效。所以这里必须逐字符安全。
console.log('\n【14】initvar YAML 抗特殊字符（键与值都来自小说）');
{
  const hostile = {
    world: {
      time: '天启三年春',
      phase: '入城: 立足',              // 值里含冒号
      note: '第一行\n第二行',            // 值里含换行
      score: 12,
      truthy: true,
      empty: '',
    },
    // 故意用点号与空格做键：路径靠 `.` 拼，这两类字符会切错层
    events: {
      '开篇: 入城': { status: 'pending', deviation: 0, pressure: 'core' },
      '剑圣.尤莉': { status: 'pending', deviation: 0, pressure: 'core' },   // 点号
      '艾莉': { status: 'pending', deviation: 0, pressure: 'core' },
      '夜探 #旧宅': { status: 'pending', deviation: 0, pressure: 'core' },  // #
      '他说"走"': { status: 'pending', deviation: 0, pressure: 'core' },    // 引号
      '- 破折号开头': { status: 'pending', deviation: 0, pressure: 'core' }, // 像列表项
      '  前后空格  ': { status: 'pending', deviation: 0, pressure: 'core' },
      'on': { status: 'pending', deviation: 0, pressure: 'core' },          // YAML 保留字
      '123': { status: 'pending', deviation: 0, pressure: 'core' },         // 纯数字键
      'true': { status: 'pending', deviation: 0, pressure: 'core' },        // 布尔字面量键
    },
    characters: {
      '沈砚': { affinity: 0, state: '正常' },
      '剑圣.尤莉': { affinity: 0, state: '正常' },   // 同一个点号名字，人物侧也要安全
      '{大括号}': { affinity: 0, state: '正常' },
      '[方括号]': { affinity: 0, state: '正常' },
      '|管道': { affinity: 0, state: '正常' },
      '>大于': { affinity: 0, state: '正常' },
      '%百分号': { affinity: 0, state: '正常' },
      '@at': { affinity: 0, state: '正常' },
      '`反引号`': { affinity: 0, state: '正常' },
      '\\反斜杠': { affinity: 0, state: '正常' },
      '制表\t符': { affinity: 0, state: '正常' },
    },
    custom: {
      storylines: {
        '线: 一': { events: ['开篇: 入城', '剑圣.尤莉'], stage: '起点', deviation: 0, core: true },
      },
    },
    user: { name: '{{user}}', watching: '主角' },   // 宏：MVU 会先替换再解析
  };
  // 钉住"路径生成侧必须规范化"这个不变量：
  // buildVariableUpdateRule 会对未规范化的键名兜底规范化（这正是它存在的意义）
  {
    const rawCard = assembleCharacterCard(makeContext({ variables: hostile }));
    const rawRule = rawCard.data.character_book.entries.find(e => e.comment === '变量更新规则').content;
    /**
     * 注意：`events` 现在只展开**当前剧情**（ongoing + 下一个），其余折叠成名单，
     * 所以"某个人物的路径出现"不能作为判据了。改用两条更稳的判据：
     *   ① 宏路径里绝不允许出现"裸点号键"造成的错层（没有 .尤莉. 或 .入城. ）
     *   ② 规范化后的键（剑圣-尤莉 / 开篇-入城）至少出现在名单或路径里
     */
    ok('路径生成侧会兜底规范化（裸点号键不会切成错层路径）',
      !/stat_data\.events\.剑圣\.尤莉/.test(rawRule)
      && !/stat_data\.events\.开篇\.入城/.test(rawRule),
      rawRule.split('\n').filter(l => /剑圣|开篇/.test(l)).slice(0, 4).join(' | '));
    ok('规范化后的键名出现在规则里',
      rawRule.includes('剑圣-尤莉') || rawRule.includes('开篇-入城'),
      rawRule.split('\n').filter(l => /剑圣|开篇/.test(l)).slice(0, 4).join(' | '));
  }  // 模拟 buildVariables：键名先过 varKey，再交给 assembleCharacterCard
  hostile.events = vkObj(hostile.events);
  hostile.characters = vkObj(hostile.characters);
  // 故事线：键名与 events 数组里的名字都要过 varKey（buildVariables 就是这么做的）
  hostile.custom.storylines = Object.fromEntries(
    Object.entries(hostile.custom.storylines).map(([name, line]) => [
      varKey(name),
      { ...line, events: line.events.map(varKey) },
    ]),
  );

  const hostileCard = assembleCharacterCard(makeContext({ variables: hostile }));
  const yaml = hostileCard.data.character_book.entries.find(e => e.comment === '[initvar]勿启用').content;

  let parsed = null, err = null;
  try { parsed = YAML.parse(yaml); } catch (e) { err = e; }
  ok('含特殊字符的变量树仍能 YAML.parse', !err, err ? String(err.message).slice(0, 120) : '');

  if (parsed) {
    ok('键含冒号不丢失', parsed.events['开篇:-入城']?.status === 'pending',
      JSON.stringify(Object.keys(parsed.events || {})).slice(0, 140));
    ok('点号键被规范化（不再是 剑圣.尤莉）',
      !Object.prototype.hasOwnProperty.call(parsed.events, '剑圣.尤莉')
      && parsed.events['剑圣-尤莉']?.status === 'pending',
      JSON.stringify(Object.keys(parsed.events || {})).slice(0, 140));
    ok('键含 # 不丢失', parsed.events['夜探-#旧宅']?.status === 'pending');
    ok('键含引号不丢失', parsed.events['他说"走"']?.status === 'pending');
    ok('键以 - 开头不丢失', parsed.events['--破折号开头']?.status === 'pending');
    ok('键含前后空格被规范化', parsed.events['前后空格']?.status === 'pending');
    ok('YAML 保留字键 on 未被解析成布尔', Object.prototype.hasOwnProperty.call(parsed.events, 'on'));
    ok('纯数字键 123 未被解析成数字', Object.prototype.hasOwnProperty.call(parsed.events, '123'));
    ok('布尔字面量键 true 未被解析成布尔', Object.prototype.hasOwnProperty.call(parsed.events, 'true'));

    ok('点号键在人物侧也被规范化', parsed.characters['剑圣-尤莉']?.state === '正常');
    ok('方括号键不丢失', parsed.characters['[方括号]']?.state === '正常');
    ok('大括号键不丢失', parsed.characters['{大括号}']?.state === '正常');
    ok('管道符键不丢失', parsed.characters['|管道']?.state === '正常');
    ok('大于号键不丢失', parsed.characters['>大于']?.state === '正常');
    ok('百分号键不丢失', parsed.characters['%百分号']?.state === '正常');
    ok('反引号键不丢失', parsed.characters['`反引号`']?.state === '正常');
    ok('反斜杠键不丢失', parsed.characters['\\反斜杠']?.state === '正常');
    ok('制表符键被规范化', parsed.characters['制表-符']?.state === '正常');

    ok('值含冒号保持原样', parsed.world.phase === '入城: 立足', JSON.stringify(parsed.world.phase));
    ok('值含换行保持原样', parsed.world.note === '第一行\n第二行', JSON.stringify(parsed.world.note));
    ok('数值类型未被字符串化', parsed.world.score === 12, typeof parsed.world.score);
    ok('布尔类型未被字符串化', parsed.world.truthy === true, typeof parsed.world.truthy);
    ok('空字符串保持空字符串', parsed.world.empty === '', JSON.stringify(parsed.world.empty));

    // 宏按 MVU 设计保留在 YAML 里（运行时由 substitudeMacros 替换）
    ok('{{user}} 宏原样保留（交给 MVU 替换）', parsed.user?.name === '{{user}}',
      JSON.stringify(parsed.user?.name));

    // 事件数与人物数不能因为转义/规范化而丢条目
    ok('事件条目数 = 10（无丢失）', Object.keys(parsed.events || {}).length === 10,
      String(Object.keys(parsed.events || {}).length));
    ok('人物条目数 = 11（无丢失）', Object.keys(parsed.characters || {}).length === 11,
      String(Object.keys(parsed.characters || {}).length));
    ok('故事线里的事件名也被规范化',
      JSON.stringify(parsed.custom?.storylines?.['线:-一']?.events) === JSON.stringify(['开篇:-入城', '剑圣-尤莉']),
      JSON.stringify(parsed.custom?.storylines?.['线:-一']?.events));

    // 更新规则引用的路径必须真的能取到（MVU 取不到只会静默跳过，不报错）
    const rule = hostileCard.data.character_book.entries.find(e => e.comment === '变量更新规则').content;
    const paths = extractMvuPaths(rule);
    ok('提取到了路径（正则不能把 {} 当结尾截断）', paths.length > 0, String(paths.length));
    const unreachable = unreachablePaths(parsed, paths);
    ok('特殊字符下更新规则路径依然全部可达', unreachable.length === 0,
      `取不到 ${unreachable.length} 条：${unreachable.slice(0, 4).join(' | ')}`);

    // 最后一行防御：任何路径段都不能再含 `.` 或空白
    const badSegs = paths.flatMap(p => p.split('.')).filter(s => /[.\s]/.test(s));
    ok('所有路径段都不含点号或空白（宏不会切错层）', badSegs.length === 0,
      JSON.stringify([...new Set(badSegs)].slice(0, 6)));

    // 序列化往返（JSON 里也要能原样还原）
    const round = JSON.parse(JSON.stringify(hostileCard));
    const yaml2 = round.data.character_book.entries.find(e => e.comment === '[initvar]勿启用').content;
    ok('JSON 往返后 initvar 字节一致', yaml === yaml2);
    ok('JSON 里没有 \\u003c 之类的转义', !JSON.stringify(hostileCard).includes('\\u003c'));
  }
}

// ============================================================
// 【15】EJS 必须真的能编译（最难发现的一类 bug）
//
// 背景：`<%_ ... _%>` 只是「去空白」的普通 EJS 标签，每个标签内容仍是**独立语句块**，
// EJS 会在标签之间插入 `__append(...)`。所以把对象字面量拆在多个标签里会直接语法错误。
// 历史上 generateB4 就是这么写的：
//     <%_ const 表 = { _%>  <%_ '键': 值, _%>  <%_ }; _%>
// 展开成 `const 表 = { __append("\n") '键': 值, ... };` → SyntaxError: Unexpected token ';'
// 而它是 constant 常驻条目，酒馆助手渲染世界书时会直接抛错。
// 之前的断言只检查「<%_ 原样保留、没被转义」，全部通过 —— 所以必须真渲染一次。
console.log('\n【15】EJS 条目能被真实引擎编译并渲染');
{
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const CANDIDATES = [
    process.env.EJS_PATH,
    path.join(ROOT, 'node_modules', 'ejs'),
    String.raw`D:\Documents\GitHub\SillyTavern\data\default-user\extensions\ST-Prompt-Template\src\3rdparty\ejs.js`,
  ].filter(Boolean);
  let ejs = null;
  for (const c of CANDIDATES) {
    try { ejs = require(c); break; } catch { /* 继续找 */ }
  }

  if (!ejs) {
    console.log('  ⚠ 未找到 EJS 引擎，跳过渲染断言（设 EJS_PATH 或 npm i -D ejs 可启用）');
  } else {
    console.log(`  （引擎：ejs ${ejs.VERSION || '?'}）`);
    // 模拟 MVU 的 stat_data 命名空间
    const makeGetvar = (stat) => (p, opts) => {
      const dflt = opts && 'defaults' in opts ? opts.defaults : undefined;
      let cur = { stat_data: stat };
      for (const seg of String(p).split('.')) {
        if (cur === null || typeof cur !== 'object' || !(seg in cur)) return dflt;
        cur = cur[seg];
      }
      return cur === undefined ? dflt : cur;
    };

    const VARIANTS = [
      ['protagonist', { userMode: { mode: 'protagonist', protagonistName: '林昭' } }],
      ['participant', { userMode: { mode: 'participant' } }],
      ['observer', { userMode: { mode: 'observer' } }],
      ['空上下文', {
        userMode: {}, events: [], characters: [], worldbook: [], phasesWithDeltas: [],
        timeline: { base: 'x', events: [], characters: [] }, variables: {},
      }],
      // 阶段名塞满 EJS 敏感字符：引号 / 反引号 / 反斜杠 / ${}
      ['极端阶段名', {
        userMode: { mode: 'protagonist', protagonistName: '林昭' },
        phasesWithDeltas: [{
          name: "剑圣的'誓约'", startEvent: 'a', endEvent: 'b', coreChange: 'c',
          characterDeltas: [{ character: '林昭', change: '获得`称号`与\\反斜杠 和 ${注入}' }],
        }],
      }],
    ];

    for (const [label, override] of VARIANTS) {
      const c = assembleCharacterCard(makeContext({ ...override }));
      const withEjs = c.data.character_book.entries.filter(e => e.content.includes('<%'));
      ok(`${label}：存在 EJS 条目`, withEjs.length >= 2, String(withEjs.length));
      for (const e of withEjs) {
        let err = null;
        try {
          ejs.render(e.content, { getvar: makeGetvar(override.variables ?? makeContext().variables) }, { async: false });
        } catch (ex) { err = ex; }
        ok(`${label} / 「${e.comment}」可编译渲染`, !err,
          err ? String(err.message).split('\n')[0] : '');
      }
    }

    // 渲染内容也要正确，不是"没报错就行"
    const c = assembleCharacterCard(makeContext());
    const render = (comment, stat) => ejs.render(
      c.data.character_book.entries.find(x => x.comment === comment).content,
      { getvar: makeGetvar(stat) }, { async: false },
    );
    const dir = render('导演指令', {
      world: { time: '天启三年春', phase: '入城立足' },
      events: { 开篇入城: { status: 'ongoing', deviation: 0, pressure: 'core' } },
    });
    ok('导演指令渲染出真实时间', dir.includes('天启三年春'), JSON.stringify(dir.slice(0, 70)));
    ok('导演指令渲染出进行中事件', dir.includes('开篇入城'));
    ok('导演指令无事件时不留空档', render('导演指令', { world: {} }).includes('无进行中事件'));

    const ph = render('角色阶段', { world: { phase: '旧案浮现' } });
    ok('角色阶段按 phase 命中增量', ph.includes('主动出击'), JSON.stringify(ph.slice(0, 120)));
    ok('角色阶段未知 phase 时输出为空',
      render('角色阶段', { world: { phase: '不存在' } }).trim() === '');
  }
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  角色卡测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);