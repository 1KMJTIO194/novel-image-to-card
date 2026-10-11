/**
 * 数据层测试：人物名单 / 时间线 / 世界观。
 *
 * 这些断言对应四类**真实踩过的**数据层故障（都来自对真实产物的体检）：
 *   ① 人物 keys 用错 —— keys 变成 ["本名","别名","称号"]（把 prompt 字段名当关键词）
 *   ② 人物条目重复虚构 —— 同一个人拆成 4 条；原文里根本没有的角色也被编出档案
 *   ③ 时间线被历史背景淹没 —— 20 条里 12 条是历史年份，且顺序倒挂
 *   ④ 世界观条目全缺 —— 只看开头 15000 字，长篇后半本的设定一条都抽不到
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const P = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const {
  sanitizeRoster, sampleAcrossText, normalizeWorldbookItems, fallbackWorldbook,
  solveTimeline, isDescriptorName, looksLikeNonPerson, appearsInText,
  normalizeRosterShape, resolveNameInText, checkPhaseAlignment, backfillEventTimes,
  assembleCharacterCard,
} = P;

// ============================================================
// 模拟一部真实小说：真名 + 描述性称呼 + 机构名，全部"在原文里出现过"
const NOVEL = [
  '元和七年冬，苏青梧被分到后山药园。管事姓周，人称周管事。同屋的还有个叫阿棠的姑娘。',
  '守园人老陈说，药园底下埋着东西。沈砚第二天递来一株回春丹。',
  '清微宗是青芜州三大宗门之一。玄天界分九州，炼气九层之后方可尝试筑基。',
  '那个小女孩站在门口，中年女人牵着她的手。',
].join('\n');

console.log('【1】描述性称呼不能被当成人名');
{
  for (const n of ['小女孩', '小女孩儿', '女人', '中年女人', '老年男人', '男青年', '女学生',
    '青年', '少年', '老人', '妇人', '众人', '对方', '那人', '管事', '老板']) {
    ok(`拦截描述词「${n}」`, isDescriptorName(n));
  }
  for (const n of ['周管事', '陈管事', '老陈', '小张', '阿棠', '沈砚', '苏青梧', '罗伯特', '王大夫']) {
    ok(`保留真名/称呼「${n}」`, !isDescriptorName(n));
  }
  // "+量词"型描述词（"一个中年女人"）词形上拦不住，靠「必须逐字出现在原文」兜底：
  // 原文写的是「站着一个中年女人」，名字串「一个中年女人」是它的子串 → 会被匹配到，
  // 所以真正的兜底是「原文里根本没有这个词」的情况。
  ok('带量词前缀的描述词词形上不拦（避免误伤）', !isDescriptorName('一个中年女人'));
  ok('原文里查无此名时直接丢弃', !appearsInText('一个中年女人', '门口站着一个妇人。'));
}

console.log('\n【2】机构 / 地名 / 体系名不能当人名');
{
  // 带组织后缀的能直接靠词形拦住
  for (const n of ['清微宗', '缉影司', '玄天界', '云京城', '青云门', '天机阁']) {
    ok(`拦截非人物「${n}」`, looksLikeNonPerson(n));
  }
  // 不带后缀的（药园 / 炼气筑基 / 化神）词形上像人名，**不能靠后缀拦**，
  // 真正的防线是 sanitizeRoster 里的"必须逐字出现在原文"。这里明确记录这个边界。
  ok('无后缀的设定词不靠词形拦（避免误伤「王药园」这类真名）',
    !looksLikeNonPerson('药园') && !looksLikeNonPerson('化神'));
  for (const n of ['苏青梧', '沈砚', '阿棠', '周管事', '凯瑟琳·埃德森', '鲁曼·怀特']) {
    ok(`保留人名「${n}」`, !looksLikeNonPerson(n));
  }
}

console.log('\n【3】人物名单清洗（幻觉名 / 描述词 / 重复 / 字段名）');
{
  const raw = [
    { name: '苏青梧', aliases: ['青梧'], role: '主角' },
    { name: '沈砚', aliases: ['沈师兄'], role: '主要配角' },
    { name: '阿棠', aliases: ['本名', '别名', '称号'], role: '主要配角' },   // 别名里的字段名要剔
    { name: '周管事', aliases: ['管事'], role: '次要配角' },
    { name: '小女孩', aliases: [], role: '主要配角' },        // 描述词
    { name: '中年女人', aliases: [], role: '主要配角' },      // 描述词
    { name: '清微宗', aliases: [], role: '提及' },            // 机构
    { name: '鲁曼·怀特', aliases: [], role: '主要配角' },     // 原文查无此人（幻觉）
    { name: '不存在的人', aliases: [], role: '主角' },        // 幻觉
    { name: '苏青梧', aliases: [], role: '主角' },            // 重复
  ];
  const { roster, dropped } = sanitizeRoster(raw, NOVEL, { max: 20 });
  const names = roster.map(r => r.name);
  console.log('   清洗结果：', JSON.stringify(names));
  console.log('   剔除原因：', JSON.stringify(dropped));

  ok('保留全部真名', ['苏青梧', '沈砚', '阿棠', '周管事'].every(n => names.includes(n)), JSON.stringify(names));
  ok('剔除描述性称呼', !names.some(n => ['小女孩', '中年女人'].includes(n)));
  ok('剔除机构名', !names.includes('清微宗'));
  ok('剔除原文查无此人的幻觉名', !names.includes('鲁曼·怀特') && !names.includes('不存在的人'));
  ok('去重（同一人只留一条）', names.filter(n => n === '苏青梧').length === 1);
  ok('主角排最前', names[0] === '苏青梧', names[0]);
  ok('返回剔除原因（可观测）', dropped.length > 0 && dropped.every(d => typeof d === 'string'),
    JSON.stringify(dropped.slice(0, 3)));
  ok('别名里的字段名被剔除',
    JSON.stringify(roster.find(r => r.name === '阿棠')?.aliases) === '[]',
    JSON.stringify(roster.find(r => r.name === '阿棠')?.aliases));
  ok('合法别名保留', (roster.find(r => r.name === '苏青梧')?.aliases || []).includes('青梧'));
  ok('max 生效', sanitizeRoster(raw, NOVEL, { max: 2 }).roster.length === 2);
}

// ============================================================
// 【3b】人物名单必须能吃下 LLM 的任意返回形态
//   实测同样的 prompt，LLM 可能返回 11 种不同形态；只要对不上，
//   sanitizeRoster 就会静默返回空数组 → 整张卡没有人物条目（曾真实发生）。
console.log('\n【3b】人物名单的形态鲁棒性（防"人物条目全丢"）');
{
  const T = '天启三年春，林昭年方十七。沈砚递来一盏茶。客栈的伙计叫她阿昭。周管事在门口等着。';
  const SHAPES = [
    ['标准数组', [{ name: '林昭', aliases: ['阿昭'], role: '主角' }, { name: '沈砚', aliases: [], role: '主要配角' }], 2],
    ['裸字符串数组', ['林昭', '沈砚'], 2],
    ['包在 characters 里', { characters: [{ name: '林昭', aliases: [], role: '主角' }] }, 1],
    ['包在 list 里', { list: [{ name: '林昭', aliases: [], role: '主角' }] }, 1],
    ['字段名是 姓名', [{ 姓名: '林昭', 别名: [], 角色: '主角' }], 1],
    ['字段名是 character', [{ character: '林昭', role: '主角' }], 1],
    ['单对象', { name: '林昭' }, 1],
    ['中文顿号字符串', '林昭、沈砚', 2],
    ['换行分隔字符串', '林昭\n沈砚', 2],
    ['名字带书名号', [{ name: '「林昭」', aliases: [], role: '主角' }], 1],
    ['名字带空白', [{ name: ' 林昭 ', aliases: [], role: '主角' }], 1],
    ['原文用简称（全名+敬称）', [{ name: '林昭小姐', aliases: [], role: '主角' }], 1],
  ];
  for (const [label, raw, expectCount] of SHAPES) {
    const got = sanitizeRoster(raw, T, { max: 20 }).roster;
    ok(`吃下形态「${label}」→ ${expectCount} 人`, got.length === expectCount,
      `实际 ${got.length}：${JSON.stringify(got.map(r => r.name))}`);
  }
  for (const [label, raw] of [['空数组', []], ['null', null], ['纯乱码字符串', '！！！']]) {
    ok(`形态「${label}」安全返回空`, sanitizeRoster(raw, T, { max: 20 }).roster.length === 0);
  }
  // 名字要收敛成原文里的形式（否则条目名/变量键会带上书名号或敬称）
  ok('书名号被收敛掉', resolveNameInText('「林昭」', T) === '林昭', String(resolveNameInText('「林昭」', T)));
  ok('敬称被收敛掉', resolveNameInText('林昭小姐', T) === '林昭', String(resolveNameInText('林昭小姐', T)));
  ok('查无此人返回 null', resolveNameInText('赵无咎', T) === null);
  ok('normalizeRosterShape 对 null 返回空数组', normalizeRosterShape(null).length === 0);
  ok('normalizeRosterShape 过滤无名字项',
    normalizeRosterShape([{ role: '主角' }, { name: '林昭' }]).length === 1);

  // 主名在原文里找不到、但**别名能找到** → 必须靠别名保下来。
  // 实测踩过：LLM 给全名「旗木卡卡西」，原文只写简称「卡卡西」，
  // 只看主名会把真人当"查无此人"整条丢掉。
  {
    const T2 = '林昭和卡卡西在云京查案。';
    const got = sanitizeRoster([{ name: '旗木卡卡西', aliases: ['卡卡西'], role: '主要配角' }], T2, { max: 5 });
    ok('主名查不到时用别名保下来', got.roster.length === 1, JSON.stringify(got.dropped));
    ok('名字收敛成原文里的形式', got.roster[0]?.name === '卡卡西', got.roster[0]?.name);
    ok('未在原文出现的全名不进 keys',
      !(got.roster[0]?.aliases || []).includes('旗木卡卡西'),
      JSON.stringify(got.roster[0]?.aliases));

    // 主名与别名都在原文 → 两个都是触发关键词
    const T3 = '旗木卡卡西，人称卡卡西。';
    const g2 = sanitizeRoster([{ name: '旗木卡卡西', aliases: ['卡卡西'], role: '主要配角' }], T3, { max: 5 });
    ok('主名与别名都在原文时都保留',
      g2.roster[0]?.name === '旗木卡卡西' && (g2.roster[0]?.aliases || []).includes('卡卡西'),
      JSON.stringify(g2.roster[0]));
  }
}

console.log('\n【4】人物条目 keys 必须是真实称呼，不能是字段名');
{
  const roster = sanitizeRoster([
    { name: '凯瑟琳·埃德森', aliases: ['凯特'], role: '主角' },
  ], '凯瑟琳·埃德森，家人与朋友多称凯特。', { max: 5 }).roster;
  const items = roster.map(r => ({ name: r.name, keys: [r.name, ...r.aliases] }));
  const card = assembleCharacterCard({
    timeline: { base: 'x', events: [], characters: [] },
    events: [], variables: {}, phasesWithDeltas: [],
    userMode: { mode: 'protagonist', protagonistName: '凯瑟琳·埃德森' },
    cardFields: { name: '测试' },
    characters: items.map(i => ({ ...i, content: '档案正文。' })),
    worldbookName: '测试集',
  });
  // 注释带剧情分层后缀：`[character] 名` 或 `[character·次要NPC] 名`
  const entry = card.data.character_book.entries
    .find(e => (e.comment || '').startsWith('[character') && (e.comment || '').endsWith(' 凯瑟琳·埃德森'));
  const keys = entry?.keys || [];
  console.log('   条目 keys：', JSON.stringify(keys));
  ok('keys 含本名', keys.includes('凯瑟琳·埃德森'));
  ok('keys 含真实别名', keys.includes('凯特'));
  for (const bad of ['本名', '别名', '称号', '昵称', '姓名']) {
    ok(`keys 不含字段名「${bad}」`, !keys.includes(bad));
  }
}

console.log('\n【5】时间线：历史背景必须与故事线分离');
{
  const mentions = [
    { chapter: '第一章', mentions: [
      { scope: 'story', type: 'absolute', raw: '元和七年冬', quote: '元和七年冬', event: '药园立足' },
      { scope: 'history', type: 'absolute', raw: '百年前', quote: '百年前魔道东来', event: '魔道东来' },
      { scope: 'history', type: 'absolute', raw: '百年前', quote: '百年前大乱', event: '大乱' },
    ] },
    { chapter: '第三章', mentions: [
      { scope: 'story', type: 'relative', raw: '三日后', quote: '三日后', anchor: '药园立足', event: '夜访药园' },
    ] },
    { chapter: '第五章', mentions: [
      { scope: 'story', type: 'absolute', raw: '元和八年春', quote: '元和八年春', event: '决意北行' },
    ] },
  ];
  const tl = solveTimeline(mentions, { base: '元和纪年', origin: { event: '药园立足' } },
    ['第一章', '第三章', '第五章']);

  ok('历史背景被拆到 history 里', tl.history.length === 2, String(tl.history.length));
  ok('主时间线不含历史背景',
    !tl.events.some(e => ['魔道东来', '大乱'].includes(e.name)),
    JSON.stringify(tl.events.map(e => e.name)));
  ok('主时间线顺序正确（不是 绝对/相对 混排倒挂）',
    JSON.stringify(tl.events.map(e => e.name)) === JSON.stringify(['药园立足', '夜访药园', '决意北行']),
    JSON.stringify(tl.events.map(e => e.name)));
  ok('每个事件都带 chapter（排序依据）', tl.events.every(e => e.chapter));
}

console.log('\n【6】时间线：年龄提及的描述性主语不能进人物时间线');
{
  const tl = solveTimeline([
    { chapter: '第一章', mentions: [
      { type: 'age', raw: '十来岁', subject: '小女孩', quote: '她看上去十来岁的样子' },
      { type: 'age', raw: '四十之后', subject: '女人', quote: '女人四十之后' },
      { type: 'age', raw: '12岁', subject: '凯瑟琳', quote: '虽然才12岁' },
    ] },
  ], { base: 'x', origin: {} }, ['第一章']);
  const names = tl.characters.map(c => c.name);
  console.log('   人物时间线：', JSON.stringify(names));
  ok('描述性主语被剔除', !names.includes('小女孩') && !names.includes('女人'));
  ok('真实人名保留', names.includes('凯瑟琳'));
}

console.log('\n【7】全文分层采样：长篇的后半本必须被覆盖到');
{
  const text = 'A'.repeat(5000) + 'MID' + 'B'.repeat(5000) + 'TAIL_后半本的关键设定' + 'C'.repeat(5000);
  const s = sampleAcrossText(text, 6000);
  ok('短文本原样返回', sampleAcrossText('短', 6000) === '短');
  ok('采样长度受控', s.length < text.length, `${s.length} / ${text.length}`);
  ok('包含开头', s.includes('A'.repeat(100)));
  ok('包含后半本的关键内容', s.includes('TAIL_后半本的关键设定'), '后半本没被覆盖');
}

console.log('\n【8】世界观条目清洗与兜底');
{
  const raw = [
    { category: 'map_world', name: '玄天界', keys: [], content: '玄天界分九州，灵气自北向南递减，越往北修士越少。' },
    { category: 'system_realm', name: '炼气筑基', keys: ['炼气', '筑基'], content: '修士共分炼气九层，九层圆满方可尝试筑基，失败者多成废人。' },
    { category: 'map_world', name: '玄天界', keys: [], content: '这是与上面重复的条目，应当被去重丢掉。' },   // 去重
    { category: 'bogus_cat', name: 'X', keys: [], content: '分类非法的条目应当被剔除掉，不该进世界书。' },     // 分类非法
    { category: 'map_location', name: '空内容', keys: [], content: '短' },                                    // 内容过短
    { category: 'system_item', name: '回春丹', keys: ['本名'], content: '回春丹可续命三日，市价三十灵石，颇为珍贵。' }, // keys 是字段名
  ];
  const items = normalizeWorldbookItems(raw);
  console.log('   清洗结果：', JSON.stringify(items.map(i => `${i.category}/${i.name}`)));
  ok('保留全部合法条目（3 条）', items.length === 3, String(items.length));
  ok('去重生效', items.filter(i => i.name === '玄天界').length === 1);
  ok('非法分类被剔除', !items.some(i => i.category === 'bogus_cat'));
  ok('空/过短内容被剔除', !items.some(i => i.name === '空内容'));
  ok('keys 为空时用条目名兜底', items.find(i => i.name === '玄天界')?.keys.length > 0);
  ok('字段名型 keys 被清掉后用条目名兜底',
    JSON.stringify(items.find(i => i.name === '回春丹')?.keys) === JSON.stringify(['回春丹']),
    JSON.stringify(items.find(i => i.name === '回春丹')?.keys));
  ok('map_world / system_realm 默认常驻',
    items.find(i => i.name === '玄天界').constant === true
    && items.find(i => i.name === '炼气筑基').constant === true);

  // 兜底：全空时给一条**有实质内容**的作品概览，而不是占位符
  const fb = fallbackWorldbook(
    { base: '元和纪年', origin: { event: '药园立足' } },
    [{ name: '药园立足', chapter: '第一章', storyline: '外门求生' },
      { name: '夜访药园', chapter: '第三章', storyline: '地下之秘' }],
    '测试世界',
    [{ name: '药园立足', characterDeltas: [] }],
  );
  console.log('   兜底条目：', JSON.stringify(fb.map(f => `${f.category}/${f.name}`)));
  // 兜底现在给两条：一条 map_world（原文摘录 + 结构，验收要求必须有 map_world）+ 一条作品概览
  ok('世界观全空时有兜底条目', fb.length >= 1, String(fb.length));
  ok('兜底里包含 map_world（验收硬要求）',
    fb.some(f => f.category === 'map_world'), JSON.stringify(fb.map(f => f.category)));
  ok('兜底内容有实质信息（含纪年/起点/章节数）',
    fb.map(f => f.content).join('').includes('元和纪年')
    && fb.map(f => f.content).join('').includes('药园立足'),
    fb.map(f => f.content).join('').slice(0, 80));
  // 允许说明"未抽到明确设定"这一事实（那是给模型的有效上下文），
  // 但不允许整条就是一句占位空话
  const fbAll = fb.map(f => f.content).join('\n');
  ok('兜底不是纯占位空话',
    fbAll.length >= 80 && !/^(原文未(提及|说明)|暂无|待补充|未知)[。.]?$/.test(fbAll.trim()),
    fbAll.slice(0, 80));
  ok('兜底条目 keys 非空且不含字段名',
    fb.every(f => f.keys.length > 0 && !f.keys.includes('本名')),
    JSON.stringify(fb.map(f => f.keys)));
  ok('数据不足时兜底返回空数组（宁可不加也不放占位符）',
    fallbackWorldbook({ base: '相对纪元', events: [] }, [], null, [], '').length === 0);

  // 占位符条目必须被拦掉（"map_world 是占位符"的直接对策）
  const placeholders = normalizeWorldbookItems([
    { category: 'map_world', name: '世界观', keys: [], content: '本作的世界观设定。' },
    { category: 'map_world', name: '设定集', keys: [], content: '这里填写世界设定相关内容。' },
    { category: 'map_region', name: '云京', keys: [], content: '原文未提及。' },
    { category: 'map_region', name: '云京', keys: [], content: '云京' },
    { category: 'map_region', name: '云京', keys: [], content: '暂无相关信息' },
    { category: 'map_region', name: '云京', keys: [], content: '云京为王朝都城，分内外两城，水系环绕。' },
  ]);
  console.log('   占位符过滤后：', JSON.stringify(placeholders.map(p => p.name)));
  ok('占位符条目名被剔除', !placeholders.some(p => ['世界观', '设定集'].includes(p.name)));
  ok('占位符正文被剔除', placeholders.length === 1, String(placeholders.length));
  ok('只重复条目名的正文被剔除', placeholders[0].content.length > 5);
  ok('剔除原因可观测', (placeholders.dropped || []).length >= 4,
    JSON.stringify(placeholders.dropped));
}

console.log('\n【8b】phase 必须落在「角色阶段」增量表里');
{
  const phases = [
    { name: '入城立足', characterDeltas: [] },                                  // 首阶段通常没增量
    { name: '旧案浮现', characterDeltas: [{ character: '林昭', change: 'x' }] },
  ];
  ok('首阶段无增量时用「起始」', checkPhaseAlignment({ world: { phase: '起始' } }, phases).length === 0);
  ok('有增量的阶段名可用', checkPhaseAlignment({ world: { phase: '旧案浮现' } }, phases).length === 0);
  ok('不在表里的阶段名被检出',
    checkPhaseAlignment({ world: { phase: '入城立足' } }, phases).length === 1);
  ok('phase 为空被检出', checkPhaseAlignment({ world: {} }, phases).length === 1);
  ok('未知阶段被检出', checkPhaseAlignment({ world: { phase: '不存在' } }, phases).length === 1);

  // 端到端：卡里的 world.phase 必须能命中角色阶段条目渲染出的内容
  const card = assembleCharacterCard({
    timeline: { base: '元和纪年', origin: { event: '药园立足' }, events: [], characters: [] },
    events: [], characters: [], worldbook: [],
    variables: { world: { time: '元和七年冬', phase: '起始' }, events: {}, characters: {}, custom: {} },
    phasesWithDeltas: phases,
    userMode: { mode: 'protagonist', protagonistName: '苏青梧' },
    cardFields: { name: '测试' },
    worldbookName: '测试集',
  });
  const yaml = card.data.character_book.entries.find(e => e.comment === '[initvar]勿启用').content;
  const b4 = card.data.character_book.entries.find(e => e.comment === '角色阶段').content;
  const m = /phase:\s*(\S+)/.exec(yaml);
  ok('initvar 里的 phase 非空', !!m, yaml.slice(0, 80));
  ok('initvar 的 phase 出现在角色阶段表里',
    !!m && (b4.includes(`"${m[1]}"`) || b4.includes(`'${m[1]}'`) || m[1] === '起始'),
    `phase=${m?.[1]}；表内容=${b4.slice(0, 120)}`);
}

console.log('\n【9】appearsInText 的边界');
{
  ok('原文里有 → true', appearsInText('苏青梧', NOVEL));
  ok('原文里没有 → false', !appearsInText('鲁曼·怀特', NOVEL));
  ok('单字 → false（误判率高，不收）', !appearsInText('人', NOVEL));
  ok('超长 → false', !appearsInText('名'.repeat(30), NOVEL));
  ok('空值 → false', !appearsInText('', NOVEL) && !appearsInText(null, NOVEL));
}

console.log('\n【9】事件时间回填（原来事件条目全是「时间：（未定）」）');
{
  const timeline = {
    events: [
      { name: '药园立足', time: '元和七年冬', chapter: '第一章' },
      { name: '夜访药园', time: '元和七年冬 + 三日后', chapter: '第三章' },
      { name: '决意北行', time: '元和八年春', chapter: '第五章' },
    ],
    origin: { raw: '元和七年冬' },
  };
  const events = [
    { name: '药园立足', chapter: '第一章' },      // 名字精确
    { name: '夜访', chapter: '第三章' },          // 名字部分包含
    { name: '初入秘境', chapter: '第五章' },       // 靠章节
    { name: '无章节事件' },                       // 兜底到起点
    { name: '已有时间', time: '不该被覆盖', chapter: '第一章' },
  ];
  const r = backfillEventTimes(events, timeline);
  ok('全部事件都有时间了', r.events.every(e => e.time), JSON.stringify(r.events.map(e => e.time)));
  ok('名字精确匹配', r.events[0].time === '元和七年冬');
  ok('名字部分包含也能匹配', r.events[1].time === '元和七年冬 + 三日后');
  ok('同章节时间点可回填', r.events[2].time === '元和八年春');
  ok('无章节时退回故事起点', r.events[3].time === '元和七年冬');
  ok('已有时间不被覆盖', r.events[4].time === '不该被覆盖');
  ok('回填计数正确', r.filled === 4 && r.total === 5, `${r.filled}/${r.total}`);
  ok('空输入安全', backfillEventTimes([], null).filled === 0);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  数据层测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(fail ? 1 : 0);
