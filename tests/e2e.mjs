/**
 * 端到端测试（不需要真实 API Key）
 *
 * 1. 起一个假的 OpenAI 兼容服务，按 system prompt 特征返回对应的 JSON
 * 2. 把小说文本 POST 给本地服务的 /api/generate，消费 SSE
 * 3. 校验产物文件、任务列表、日志、打包下载
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3111;

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

// ============================================================
// 假 LLM
// ============================================================
const MOCK = {
  // ---- 合并版 prompt（默认路径）：同一段正文只喂一次 ----
  // 放在最前面，因为 classify 是按 include 逐键匹配，而合并版 prompt 里
  // 同时含有"时间提及""剧情事件"这些单任务版的特征词；
  // 单任务版键名放后面，正好只在关闭合并时命中（回退路径）。
  '章节级多任务抽取器': {
    mentions: [
      { scope: 'story', type: 'absolute', raw: '天启三年春', quote: '天启三年春', event: '开篇入城', subject: null, anchor: null },
      { scope: 'story', type: 'age', raw: '十七岁', quote: '年方十七', event: null, subject: '林昭', anchor: null },
      { scope: 'story', type: 'age', raw: '二十岁', quote: '年方二十', event: null, subject: '沈砚', anchor: null },
      { scope: 'history', type: 'absolute', raw: '百年前', quote: '百年前天下大乱', event: '天下大乱', subject: null, anchor: null },
    ],
    // 事件带上 participants / location / 明确日期：
    // 这三项会被 deriveEventKeys 变成额外触发词（用户反馈"触发词太少会漏剧情"）
    events: [
      {
        name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭踏进城门',
        canon: '林昭进入云京，寻找失踪的兄长。', pressure: 'core',
        time: '天启三年三月十二日', participants: ['沈砚'], location: '云京城门',
        prerequisites: { temporal: [], behavioral: '' },
        interventions: [{ condition: '若林昭直接去衙门报案', result: '官府介入，线索提前暴露' }],
      },
      {
        name: '初见沈砚', storyline: '入城立足', chapter: '第二章', quote: '沈砚递来一盏茶',
        canon: '林昭与沈砚在茶楼相识，得到一条线索。', pressure: 'buffer',
        participants: ['沈砚'], location: '城南茶楼',
        prerequisites: { temporal: ['开篇入城'], behavioral: '' },
        interventions: [{ condition: '若林昭拒绝沈砚', result: '线索延后' }],
      },
      {
        name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '旧宅的门虚掩着',
        canon: '林昭夜探兄长旧宅，发现密信。', pressure: 'core',
        participants: ['沈砚'], location: '旧宅',
        prerequisites: { temporal: ['初见沈砚'], behavioral: '' },
        interventions: [],
      },
    ],
  },
  '世界观与物品抽取器': {
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城，分内外两城。', dynamicHint: '' },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案。', dynamicHint: '' },
    ],
    items: [
      { category: 'system_item', name: '玉佩', keys: ['玉佩'], content: 'name: 玉佩\ntype: 物品\n外观: 半块残玉。', dynamicHint: '' },
    ],
  },
  '人物档案批量抽取器': {
    profiles: [
      { name: '林昭', keys: ['林昭', '阿昭'], content_yaml: 'name: 林昭\ntitle: 寻亲者\nage: 十七\nappearance: |\n  素衣少女，眉目清淡。\npersonality: |\n  沉静果决。' },
      { name: '沈砚', keys: ['沈砚', '沈公子'], content_yaml: 'name: 沈砚\ntitle: 茶楼常客\nage: 二十余\nappearance: |\n  青衫书生。\npersonality: |\n  从容多谋。' },
    ],
  },
  '叙事结构': { hasSingleProtagonist: true, protagonistName: '林昭', protagonistGender: 'female', reason: '视角集中于林昭' },
  '时间线抽取器': [
    { scope: 'story', type: 'absolute', raw: '天启三年春', quote: '天启三年春', event: '开篇入城', subject: null, anchor: null },
    { scope: 'story', type: 'age', raw: '十七岁', quote: '年方十七', event: null, subject: '林昭', anchor: null },
    { scope: 'story', type: 'age', raw: '二十岁', quote: '年方二十', event: null, subject: '沈砚', anchor: null },
    { scope: 'history', type: 'absolute', raw: '百年前', quote: '百年前天下大乱', event: '天下大乱', subject: null, anchor: null },
  ],
  '时间线锚点识别器': { base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城', reason: '最早绝对纪年' } },
  '小说事件抽取器': [
    {
      name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭踏进城门',
      canon: '林昭进入云京，寻找失踪的兄长。', pressure: 'core',
      prerequisites: { temporal: [], behavioral: '' },
      interventions: [{ condition: '若林昭直接去衙门报案', result: '官府介入，线索提前暴露' }],
    },
    {
      name: '初见沈砚', storyline: '入城立足', chapter: '第二章', quote: '沈砚递来一盏茶',
      canon: '林昭与沈砚在茶楼相识，得到一条线索。', pressure: 'buffer',
      prerequisites: { temporal: ['开篇入城'], behavioral: '' },
      interventions: [{ condition: '若林昭拒绝沈砚', result: '线索延后' }],
    },
    {
      name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '旧宅的门虚掩着',
      canon: '林昭夜探兄长旧宅，发现密信。', pressure: 'core',
      prerequisites: { temporal: ['初见沈砚'], behavioral: '' },
      interventions: [],
    },
  ],
  '阶段划分器': { phases: [
    { name: '入城立足', startEvent: '开篇入城', endEvent: '初见沈砚', coreChange: '从孤身寻亲到获得本地助力' },
    { name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: '从被动等待到主动追查' },
  ] },
  '人设变化抽取器': { phase: '旧案浮现', deltas: [{ character: '林昭', change: '从谨慎观望变为主动出击', quote: '她握紧了那封信' }] },
  '热门作品': { wellKnown: false, reason: '原创短篇' },
  '世界观抽取器': [
    { category: 'map_world', name: '云京', keys: ['云京', '京城'], content: '云京为王朝都城，分内外两城，水系环绕。', dynamicHint: '' },
    { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: '缉影司掌查办密案，不受刑部节制。', dynamicHint: '' },
  ],
  // 人物名单：真名 + 描述性称呼 + 幻觉名混在一起（真实 LLM 的行为），
  // 后面 sanitizeRoster 要把后两类剔掉
  '人物名单抽取器': [
    { name: '林昭', aliases: ['阿昭'], role: '主角' },
    { name: '沈砚', aliases: ['沈公子'], role: '主要NPC' },
    { name: '小女孩', aliases: [], role: '次要NPC' },        // 描述性称呼 → 应被剔除
    { name: '赵无咎', aliases: [], role: '路人NPC' },        // 原文查无此人 → 应被剔除
  ],
  '人物档案抽取器': { name: '林昭', keys: ['本名', '别名', '称号'], content: '林昭，十七岁，为寻兄长独自入京，性格沉静果决，说话简短。' },
  // 分批摘要（每批一次）
  '分批阅读助手': { summary: '本批中林昭入城并与沈砚相识，得到一条关于兄长失踪的线索。', phase: '入城立足', newCharacters: ['林昭', '沈砚'] },
  // 事件条目 + 原著剧情简介（合并版 prompt：一次返回对象）
  '事件条目撰写器与剧情梗概撰写器': {
    events: [
      { name: '开篇入城', keys: ['开篇入城'], content_yaml: '起因: 兄长失踪\n经过: 林昭入城寻人\n结果: 得到线索\n影响: 与沈砚结识\n干预分支: 若直接报案则官府介入' },
    ],
    synopsis: '天启年间，云京为王朝都城。少女林昭的兄长三年前离奇失踪，她独自入京寻人。'
      + '在城南茶楼她结识了书生沈砚，对方知晓玉佩的来历，线索指向城东旧宅。'
      + '林昭夜探旧宅，找到一封密信，发现兄长的失踪与缉影司查办的旧案有关。'
      + '故事当前停在密信刚到手、尚未决定是否联络缉影司的节点上。',
  },
  // 回退路径（关闭 mergeSynopsisCalls 时才命中）
  '事件条目抽取器': [
    { name: '开篇入城', keys: ['开篇入城'], content_yaml: '起因: 兄长失踪\n经过: 林昭入城寻人\n结果: 得到线索\n影响: 与沈砚结识\n干预分支: 若直接报案则官府介入' },
  ],
  '物品条目抽取器': [
    { category: 'system_item', name: '密信', keys: ['密信'], content: '密信：兄长留下的线索，字迹潦草，末尾有半个印章。' },
  ],
};

function classify(system) {
  for (const key of Object.keys(MOCK)) {
    if (String(system).includes(key)) return MOCK[key];
  }
  return { ok: true };
}

/** 本进程收到的所有 LLM 请求（用于验证预设真的作用到了 prompt 上） */
const received = [];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url.replace(/^\/v\d+/, '').startsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'mock-large' }, { id: 'mock-small' }] }));
    }
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch {}
    const system = payload.messages?.find(m => m.role === 'system')?.content || '';
    const user = payload.messages?.find(m => m.role === 'user')?.content || '';
    // 记录每次请求，供预设生效性断言使用
    received.push({ system, user });
    const content = JSON.stringify(classify(system));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    }));
  });
});

// ============================================================
// 工具
// ============================================================
const CH = [
  `第一章 入城

天启三年春，林昭年方十七，独自一人来到云京。她此行的唯一目的，是寻找三年前失踪的兄长。
林昭踏进城门时，守卒正在换班，没有人多看她一眼。城内的喧嚣与记忆中的小城截然不同。
她握紧了袖中的半块玉佩，那是兄长留下的唯一信物。街市两侧的灯笼刚刚点亮，卖汤饼的摊子冒着白气。
一个卖花的老人问她要不要买一枝梅，她摇了摇头，继续往城东走。城东是旧宅聚集的地方，租金便宜。
她在一间客栈住下，把玉佩又摸了一遍，确认它还在。夜里她几乎没有睡，一直在想兄长最后那封信上的字迹。
客栈的伙计叫她阿昭，说是看她年纪小，这么叫亲切些。她没有纠正。`,
  `第二章 茶楼

三日后，林昭在城南茶楼遇到一名自称沈砚的男子。沈砚递来一盏茶，说他知道玉佩的来历。
林昭没有立刻相信，但也没有拒绝。她需要线索，哪怕这线索来自一个陌生人。两人约定次日再见。
沈砚临走时留下一句话：云京的水比你想的深。林昭把这句话在心里翻来覆去地想了很久。
茶楼里有人在说书，讲的是十年前那场大火，烧掉了半条长街。她听着，忽然觉得那些事与兄长有关。
回到客栈，她把沈砚说的话记在一张纸上，又划掉了几个字。她决定先弄清楚玉佩的出处，再决定信不信他。`,
  `第三章 旧宅

入夜后，林昭找到了兄长当年租住的旧宅。旧宅的门虚掩着，屋里积满灰尘，窗纸破了一角。
在床板的夹层里，她发现了一封没有署名的密信。信中提到"缉影司"三个字，还画着一个奇怪的符号。
林昭握紧了那封信，第一次意识到兄长的失踪并非意外。她在屋里又搜了一遍，只找到半截烧焦的灯芯。
出门时天快亮了，巷口的狗叫了两声。她把信贴身收好，决定第二天去找沈砚问清楚缉影司到底是什么。
这一夜之后，她再也不是那个只会等待消息的姑娘了。`,
];
const NOVEL = CH.join('\n\n') + '\n';

async function sseGenerate(form) {
  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', evt = null, data = [];
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (line.startsWith('event:')) evt = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      else if (line.trim() === '' && evt) {
        let parsed = null;
        try { parsed = JSON.parse(data.join('\n')); } catch {}
        events.push({ event: evt, data: parsed });
        evt = null; data = [];
      }
    }
  }
  return events;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));
  console.log(`\n假 LLM 已启动：http://127.0.0.1:${MOCK_PORT}/v1\n`);

  const uploads = path.join(ROOT, '.test-uploads');
  await mkdir(uploads, { recursive: true });
  const novelPath = path.join(uploads, '测试小说.txt');
  await writeFile(novelPath, NOVEL, 'utf-8');

  console.log('【1】健康检查');
  const sys = await (await fetch(`${BASE}/api/system`)).json();
  ok('GET /api/system 返回 ok', sys.ok === true);

  console.log('\n【1.5】界面模块必须真的能被服务器送达（防白屏）');
  {
    // 浏览器会逐个请求模块图里的每个文件；只要有一个 404，整个界面就白屏。
    // 曾经踩过：模块 import 了 public/ 之外的 src/preset.js → 请求 /src/preset.js 得到 404。
    const PUBLIC = path.join(ROOT, 'public');
    const seen = new Set();
    const urls = [];
    const collect = async (absFile) => {
      if (seen.has(absFile)) return;
      seen.add(absFile);
      let src;
      try { src = await readFile(absFile, 'utf-8'); } catch { return; }
      for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        const target = path.resolve(path.dirname(absFile), spec);
        const rel = path.relative(PUBLIC, target).replace(/\\/g, '/');
        const url = `/${rel}`;
        urls.push({ url, outside: rel.startsWith('..') || !target.startsWith(PUBLIC) });
        if (!urls[urls.length - 1].outside) await collect(target);
      }
    };
    await collect(path.join(PUBLIC, 'js/app.js'));

    const escaped = urls.filter(u => u.outside);
    ok('模块图里没有指向 public/ 之外的引用', escaped.length === 0, escaped.map(u => u.url).join(', '));

    const missing = [];
    for (const u of urls) {
      if (u.outside) continue;
      const res = await fetch(`${BASE}${u.url}`).catch(() => null);
      if (!res || !res.ok) missing.push(`${u.url}(${res ? res.status : 'ERR'})`);
    }
    ok(`服务器能送达全部 ${urls.length} 个界面模块`, missing.length === 0, missing.join(', '));

    const html = await (await fetch(`${BASE}/`)).text();
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1]);
    const badRefs = [];
    for (const ref of refs) {
      const res = await fetch(`${BASE}${ref}`).catch(() => null);
      if (!res || !res.ok) badRefs.push(`${ref}(${res ? res.status : 'ERR'})`);
    }
    ok('index.html 引用的资源全部可达', badRefs.length === 0, badRefs.join(', '));
    ok('index.html 引用了模块入口 /js/app.js', refs.includes('/js/app.js'), refs.join(', '));
    console.log(`     已校验 ${urls.length} 个模块 URL、${refs.length} 个 HTML 资源引用`);
  }

  console.log('\n【2】模型列表 / 连通性');
  const models = await (await fetch(`${BASE}/api/models`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` }),
  })).json();
  ok('POST /api/models 返回模型', Array.isArray(models.models) && models.models.includes('mock-large'), JSON.stringify(models));

  const ping = await (await fetch(`${BASE}/api/ping`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-large' }),
  })).json();
  ok('POST /api/ping 连通', ping.ok === true, JSON.stringify(ping));

  console.log('\n【3】文本预估');
  const est = await (await fetch(`${BASE}/api/estimate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: NOVEL }),
  })).json();
  ok('POST /api/estimate 切出 3 章', est.chapters === 3, JSON.stringify(est));
  ok('章节标题只取标题行', est.preview.every(p => p.title.length <= 30), JSON.stringify(est.preview.map(p => p.title)));
  ok('estimate 返回 token 估算', est.tokens > 0);

  console.log('\n【4】完整生成（SSE）');
  const fd = new FormData();
  fd.append('novel', new Blob([NOVEL], { type: 'text/plain' }), '测试小说.txt');
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'test-key');
  fd.append('model', 'mock-large');
  fd.append('userMode', 'auto');
  fd.append('title', '端到端测试');
  fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 3 }));

  const t0 = Date.now();
  const events = await sseGenerate(fd);
  const elapsed = Date.now() - t0;

  const kinds = events.map(e => e.event);
  ok('收到 start 事件', kinds.includes('start'));
  ok('收到多条 progress 事件', kinds.filter(k => k === 'progress').length >= 5, `实际 ${kinds.filter(k => k === 'progress').length}`);
  const filesEvt = events.find(e => e.event === 'files');
  ok('收到 files 事件', !!filesEvt);
  ok('收到 done 事件', kinds.includes('done'));
  ok('没有 error 事件', !kinds.includes('error'), JSON.stringify(events.find(e => e.event === 'error')?.data));
  console.log(`     耗时 ${(elapsed / 1000).toFixed(1)}s，事件数 ${events.length}`);

  if (!filesEvt) { report(); return; }
  const taskId = filesEvt.data.taskId;
  const meta = filesEvt.data.meta;
  ok('任务 ID 形如 task_*', /^task_\d+$/.test(taskId), taskId);

  console.log('\n【5】产物校验');
  const outDir = path.join(ROOT, 'output', taskId);
  const files = await readdir(outDir);
  for (const f of ['character_card.json', 'worldbook.json', 'preset_fragment.json', 'variables.json', 'timeline.json', 'events.json', 'storylines.json', 'phases.json', 'user_mode.json', 'meta.json', 'README.md', 'log.jsonl',
    // Step 7.5 的产出
    'statusbar.json', 'regex_scripts.json', 'statusbar_preview.html']) {
    ok(`产物存在 ${f}`, files.includes(f), files.join(','));
  }

  console.log('\n【5.5】完整角色卡（chara_card_v3）');
  {
    const raw = await readFile(path.join(outDir, 'character_card.json'), 'utf-8');
    const bytes = Buffer.byteLength(raw, 'utf8');
    ok('character_card.json 体积 > 10KB', bytes > 10 * 1024, `${(bytes / 1024).toFixed(1)} KB`);

    let cc = null;
    try { cc = JSON.parse(raw); } catch (e) { /* 由下一条断言报出 */ }
    ok('可被 JSON.parse', !!cc);
    if (cc) {
      ok('含 character_book', !!cc.data?.character_book);
      ok('含 regex_scripts 至少 1 条',
        Array.isArray(cc.data?.extensions?.regex_scripts) && cc.data.extensions.regex_scripts.length >= 1,
        String(cc.data?.extensions?.regex_scripts?.length));
      ok('spec 为 chara_card_v3', cc.spec === 'chara_card_v3', cc.spec);
      ok('顶层 name 与 data.name 一致', cc.name === cc.data.name, `${cc.name} / ${cc.data?.name}`);
      ok('first_mes 非空', typeof cc.first_mes === 'string' && cc.first_mes.length > 0);

      const entries = cc.data.character_book.entries || [];
      ok('世界书条目数 >= 9', entries.length >= 9, String(entries.length));
      const initvar = entries.find(e => e.comment?.includes('initvar'));
      ok('initvar 条目 enabled=false', initvar?.enabled === false, String(initvar?.enabled));
      ok('导演指令含未转义 EJS', entries.find(e => e.comment === '导演指令')?.content?.includes('<%_'));
      ok('角色阶段含未转义 EJS', entries.find(e => e.comment === '角色阶段')?.content?.includes('<%_'));
      ok('文件保留字面 <%_ 且未被 \\u003c 转义',
        raw.includes('<%_') && !raw.includes('\\u003c'));
      ok('含时间线条目', entries.some(e => e.comment === '[timeline]'));
      ok('含事件条目', entries.some(e => e.comment?.startsWith('[event]')));
      ok('含变量更新规则条目', entries.some(e => e.comment === '变量更新规则'));
      ok('变量更新规则引用实际变量路径',
        entries.some(e => e.content?.includes('get_message_variable::stat_data.world.time')));
    }

    console.log('\n【5.6】Step 7.5 状态栏与正则（真实产物）');
    {
      const regexScripts = JSON.parse(await readFile(path.join(outDir, 'regex_scripts.json'), 'utf-8'));
      ok('regex_scripts.json 有 7 条', regexScripts.length === 7, String(regexScripts.length));
      ok('7 条都有 id 与 scriptName', regexScripts.every(s => s.id && s.scriptName));
      ok('含状态栏美化正则', regexScripts.some(s => s.id === 'regex_statusbar_html'));
      ok('状态栏美化用 ``` 围栏包裹',
        regexScripts.find(s => s.id === 'regex_statusbar_html')?.replaceString?.startsWith('```'));
      ok('状态栏纯文本默认关闭',
        regexScripts.find(s => s.id === 'regex_statusbar_text')?.disabled === true);

      const sb = JSON.parse(await readFile(path.join(outDir, 'statusbar.json'), 'utf-8'));
      // 注意：这里要的是**刚落盘的** variables.json，不能用文件后面才声明的同名变量
      const sbVars = JSON.parse(await readFile(path.join(outDir, 'variables.json'), 'utf-8'));
      ok('statusbar.json 有主题', typeof sb.theme === 'string' && sb.theme.length > 0, sb.theme);
      ok('statusbar.json 有布局', ['single', 'tabs'].includes(sb.layout), sb.layout);
      ok('statusbar.json 字段数 > 0', sb.fieldCount > 0, String(sb.fieldCount));
      ok('statusbar.json 全部字段路径都在变量树里',
        Array.isArray(sb.fields) && sb.fields.length > 0 && sb.fields.every(f => {
          const segs = f.path.replace(/^stat_data\./, '').split('.');
          let node = sbVars[segs[0]];
          for (const s of segs.slice(1)) { if (node === null || node === undefined) return false; node = node[s]; }
          return node !== undefined;
        }), JSON.stringify((sb.fields || []).map(f => f.path)));
      ok('statusbar 校验无错误', (sb.validation?.errors || []).length === 0,
        JSON.stringify(sb.validation?.errors));
      ok('statusbar 校验无警告', (sb.validation?.warnings || []).length === 0,
        JSON.stringify(sb.validation?.warnings));

      /**
       * 时间信息必须到"月日"级别。
       *
       * 用户反馈过"状态栏中的时间信息不够完善（没有几月几日）"：
       * 根因是 `world.time` 直接取时间线首条的原文片段，而首条常常只有年份。
       * 现在状态栏读 `world.date.text`（解析后的规范日期），并有 world.date 兜底。
       */
      ok('变量树有 world.date（状态栏读它显示日期）',
        sbVars.world?.date && typeof sbVars.world.date.text === 'string',
        JSON.stringify(sbVars.world?.date));
      ok('world.date.text 与 world.time 都有值',
        !!sbVars.world?.date?.text && !!sbVars.world?.time,
        JSON.stringify({ date: sbVars.world?.date?.text, time: sbVars.world?.time }));
      // 假 LLM 给的时间提及含「1961年的4月8日」，解析后应显示到日
      ok('日期精度到日或有降级说明',
        ['day', 'month', 'year', 'coarse'].includes(sbVars.world?.date?.precision),
        String(sbVars.world?.date?.precision));
      ok('world.date 记录了推断标记',
        typeof sbVars.world?.date?.inferred === 'boolean',
        String(sbVars.world?.date?.inferred));

      // 世界书事件条目的触发词：不能只有事件名本身
      {
        // ⚠️ 不能用后面才声明的外层 `worldbook` 变量（TDZ），从刚落盘的文件读
        const wbJson = JSON.parse(await readFile(path.join(outDir, 'worldbook.json'), 'utf-8'));
        const evEntries = wbJson.entries.filter(e => String(e.comment).startsWith('[event]'));
        if (evEntries.length) {
          const kc = evEntries.map(e => (e.keys || []).length);
          console.log(`   事件触发词：${JSON.stringify(evEntries.map(e => e.keys))}`);
          ok('每个事件至少 1 个触发词', kc.every(n => n >= 1), JSON.stringify(kc));
          ok('事件名恒为触发词之一',
            evEntries.every(e => {
              const nm = String(e.comment).replace(/^\[event\]\s*/, '');
              return (e.keys || []).includes(nm);
            }),
            JSON.stringify(evEntries.map(e => e.keys)));
        }
      }

      if (cc) {
        const ext = cc.data.extensions;
        ok('卡片写入 7 条正则', ext.regex_scripts?.length === 7, String(ext.regex_scripts?.length));
        ok('卡片注册 MVU 脚本',
          ext.tavern_helper?.scripts?.some(s => s.name === 'mvu' && s.enabled === true));
        const outEntry = cc.data.character_book.entries.find(e => e.comment === '输出纪律');
        ok('输出纪律写入占位符', outEntry?.content?.includes('<StatusPlaceHolderImpl/>'));
        ok('输出纪律写入正文包裹标签',
          outEntry?.content?.includes('<zhengwen>') && outEntry?.content?.includes('</zhengwen>'));
        ok('creator_notes 说明纯文本降级方案',
          cc.data.creator_notes.includes('状态栏纯文本') && cc.data.creator_notes.includes('默认关闭'));
        ok('顶层 first_mes 不含状态栏 HTML',
          !cc.first_mes.includes('<StatusPlaceHolderImpl/>') && !/pm-card|panel-container/.test(cc.first_mes));
      }

      const preview = await readFile(path.join(outDir, 'statusbar_preview.html'), 'utf-8');
      ok('预览 HTML 里的宏已换成示例值', !preview.includes('get_message_variable::'));
      ok('预览 HTML 里的脚本已移除', !/<script/i.test(preview));
      ok('预览 HTML 仍是完整 HTML', preview.trim().startsWith('<!DOCTYPE html>') && preview.trim().endsWith('</html>'));
    }

    const readme = await readFile(path.join(outDir, 'README.md'), 'utf-8');
    ok('README 推荐一次导入', /推荐方式（一次导入）/.test(readme));
    ok('README 指向 character_card.json', /character_card\.json/.test(readme));
    ok('README 仍提供分开导入方式', /分开导入（A 包 \+ B 包）/.test(readme), readme.slice(0, 200));
  }

  const worldbook = JSON.parse(await readFile(path.join(outDir, 'worldbook.json'), 'utf-8'));
  ok('worldbook 有 entries', Array.isArray(worldbook.entries) && worldbook.entries.length > 0);
  ok('worldbook 含 timeline 常驻条目', worldbook.entries.some(e => e.comment === '[timeline]' && e.constant));
  // 剧情条目现在是**按天打包**：同一天内的连续剧情合成一条，不拆分；
  // 没有解析到具体某天的事件各自独立成条。
  {
    const evEntries = worldbook.entries.filter(e => e.comment.startsWith('[event]'));
    ok('worldbook 含事件条目', evEntries.length >= 1, String(evEntries.length));
    console.log(`   剧情条目：${JSON.stringify(evEntries.map(e => e.comment))}`);
    // 同一天的打包成一条，触发词是并集
    const grouped = evEntries.filter(e => /（\d+ 个事件）/.test(e.comment));
    for (const g of grouped) {
      const names = g.extensions?.eventNames || [];
      ok(`按天打包的条目「${g.comment}」记录了一天里的事件`,
        names.length >= 2, JSON.stringify(names));
      ok(`按天打包「${g.comment}」的触发词覆盖所有事件名`,
        names.every(n => (g.keys || []).includes(n)), JSON.stringify(g.keys));
    }
  }

  // 原著剧情简介：常驻参考条目
  {
    const syn = worldbook.entries.find(e => e.comment === '[synopsis]');
    ok('worldbook 含原著剧情简介条目', !!syn, JSON.stringify(worldbook.entries.map(e => e.comment)));
    if (syn) {
      ok('剧情简介是常驻条目（否则 AI 看不到）', syn.constant === true, String(syn.constant));
      ok('剧情简介有实质内容', /【原著剧情简介】/.test(syn.content) && syn.content.length > 120,
        String(syn.content.length));
      ok('剧情简介不超上限（常驻会占每轮预算）',
        (syn.extensions?.chars ?? 0) <= 1200, String(syn.extensions?.chars));
    }
  }

  // 故事线：从变量树搬到世界书，按线分段触发
  {
    const slEntries = worldbook.entries.filter(e => e.comment.startsWith('[storyline]'));
    // 从产物文件读，避免依赖上面的块作用域
    const varsJson = JSON.parse(await readFile(path.join(outDir, 'variables.json'), 'utf-8'));
    ok('custom.storylines 已从变量树移除',
      !varsJson?.custom?.storylines, JSON.stringify(Object.keys(varsJson?.custom || {})));
    if (slEntries.length) {
      console.log(`   故事线条目：${JSON.stringify(slEntries.map(e => e.comment))}`);
      ok('故事线条目带触发词（线名 + 线上事件）',
        slEntries.every(e => (e.keys || []).length >= 1), JSON.stringify(slEntries.map(e => e.keys)));
      ok('故事线条目是 key 触发（不常驻）',
        slEntries.every(e => e.constant === false), JSON.stringify(slEntries.map(e => e.constant)));
    }
  }
  ok('worldbook 含人物条目', worldbook.entries.some(e => e.comment.startsWith('[character')));
  ok('事件条目带 keys', worldbook.entries.filter(e => e.comment.startsWith('[event]')).every(e => e.keys.length > 0));

  // 数据层：人物名单必须被清洗过（描述性称呼 / 原文查无此人的幻觉名都要掉）
  {
    // 注释形如 `[character] 名` / `[character·主要NPC] 名`，这里把名字从尾部取出
    const entryName = (c) => String(c).replace(/^\[character(\u00b7[^\]]+)?\]\s*/, '');
    const entryTier = (c) => (/^\[character\u00b7([^\]]+)\]/.exec(c) || [])[1] || '主角';
    const chars = worldbook.entries.filter(e => e.comment.startsWith('[character'));
    const names = chars.map(e => entryName(e.comment));
    console.log(`   人物条目：${JSON.stringify(chars.map(e => e.comment))}`);
    ok('描述性称呼被剔除（小女孩）', !names.includes('小女孩'), JSON.stringify(names));
    ok('原文查无此人的幻觉名被剔除（赵无咎）', !names.includes('赵无咎'), JSON.stringify(names));
    ok('真名保留（林昭 / 沈砚）',
      names.includes('林昭') && names.includes('沈砚'), JSON.stringify(names));
    ok('人物条目 keys 不是 prompt 字段名',
      chars.every(e => !['本名', '别名', '称号'].some(k => e.keys.includes(k))),
      JSON.stringify(chars.map(e => e.keys)));
    ok('人物条目 keys 含真实别名',
      chars.find(e => entryName(e.comment) === '林昭')?.keys.includes('阿昭'),
      JSON.stringify(chars.find(e => entryName(e.comment) === '林昭')?.keys));
    // 分层：主角由 userMode 判定，其余按剧情占比
    const tiers = chars.map(e => `${entryName(e.comment)}=${entryTier(e.comment)}`);
    console.log(`   人物分层：${JSON.stringify(tiers)}`);
    ok('主角不带分层后缀', entryTier(chars.find(e => entryName(e.comment) === '林昭').comment) === '主角',
      JSON.stringify(tiers));
    ok('其余人物带分层后缀',
      chars.filter(e => entryName(e.comment) !== '林昭')
        .every(e => /^\[character\u00b7(主要NPC|次要NPC|路人NPC)\]\s/.test(e.comment)),
      JSON.stringify(tiers));
    ok('分层也写进 extensions（便于脚本按层筛选）',
      chars.every(e => ['主角', '主要NPC', '次要NPC', '路人NPC'].includes(e.extensions?.tier)),
      JSON.stringify(chars.map(e => [entryName(e.comment), e.extensions?.tier])));
    ok('条目记了出场章节数',
      chars.every(e => Number.isFinite(e.extensions?.storyChapters)),
      JSON.stringify(chars.map(e => [entryName(e.comment), e.extensions?.storyChapters])));

    const tl = worldbook.entries.find(e => e.comment === '[timeline]');
    ok('[timeline] 把历史背景与故事线分开',
      tl.content.includes('【事件时间线】') && tl.content.includes('【历史背景】'),
      tl.content.slice(0, 160));
    ok('历史背景不混进事件时间线',
      tl.content.indexOf('天下大乱') > tl.content.indexOf('【历史背景】'),
      tl.content.slice(0, 200));
  }

  const preset = JSON.parse(await readFile(path.join(outDir, 'preset_fragment.json'), 'utf-8'));
  ok('preset 含 B1-B5', ['b1_variables', 'b2_update_rules', 'b3_director', 'b4_persona_delta', 'b5_rules'].every(k => k in preset));
  ok('B1 含 world/events/user', ['world:', 'events:', 'user:'].every(k => preset.b1_variables.includes(k)));
  ok('B4 渲染出舞台本', preset.b4_persona_delta.includes('旧案浮现'));
  ok('B4 含人设增量内容', preset.b4_persona_delta.includes('主动出击'));

  const variables = JSON.parse(await readFile(path.join(outDir, 'variables.json'), 'utf-8'));
  ok('variables.events 有 3 个事件', Object.keys(variables.events).length === 3, JSON.stringify(Object.keys(variables.events)));
  ok('variables 含 user 命名空间', !!variables.user && variables.user.name === '林昭', JSON.stringify(variables.user));
  ok('protagonist 模式下主角从 characters 移出', !variables.characters['林昭']);

  ok('meta.json 记录耗时', meta.durationMs > 0);
  ok('meta 的 token 估算为正数', meta.tokens.a > 0 && meta.tokens.b > 0, JSON.stringify(meta.tokens));
  ok('meta 无校验警告', meta.warnings.length === 0, JSON.stringify(meta.warnings));

  console.log('\n【6】任务 API');
  const list = await (await fetch(`${BASE}/api/tasks`)).json();
  ok('GET /api/tasks 含该任务', list.tasks.some(t => t.taskId === taskId));
  const one = await (await fetch(`${BASE}/api/tasks/${taskId}`)).json();
  ok('GET /api/tasks/:id 返回 meta', one.meta && one.meta.taskId === taskId);
  ok('任务详情带 project 标题', one.project?.title === '端到端测试', JSON.stringify(one.project));

  const log = await (await fetch(`${BASE}/api/tasks/${taskId}/log`)).json();
  ok('日志事件 >= 10 条', log.events.length >= 10, String(log.events.length));

  const fileRes = await (await fetch(`${BASE}/api/tasks/${taskId}/file/meta.json`)).json();
  ok('读取产物文件内容', typeof fileRes.content === 'string' && fileRes.content.includes('taskId'));

  console.log('\n【7】打包下载');
  const zipRes = await fetch(`${BASE}/api/tasks/${taskId}/zip`);
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  ok('zip 响应 200', zipRes.status === 200);
  ok('zip 体积 > 1KB', zipBuf.length > 1024, `${zipBuf.length} B`);
  ok('zip 魔数 PK', zipBuf[0] === 0x50 && zipBuf[1] === 0x4b);
  ok('zip 未包含 log.jsonl（排除内部日志）', !zipBuf.includes(Buffer.from('log.jsonl')));

  console.log('\n【8】错误处理');
  const badFd = new FormData();
  badFd.append('baseUrl', 'http://127.0.0.1:9/v1');
  badFd.append('model', 'x');
  const badEvents = await sseGenerate(badFd);
  ok('缺少小说文件时报 error', badEvents.some(e => e.event === 'error' && /未上传/.test(e.data?.message || '')));

  const badPath = await fetch(`${BASE}/api/tasks/${taskId}/file/..%2F..%2Fserver.js`);
  ok('路径穿越被拒绝', badPath.status === 404 || badPath.status === 400, String(badPath.status));

  console.log('\n【9】外部命令失败不能拖垮服务');
  // 回归：曾经 exec() 同步抛 EPERM 导致整个服务进程退出
  let revealRes, revealErr;
  try {
    revealRes = await fetch(`${BASE}/api/tasks/${taskId}/reveal`);
  } catch (e) {
    revealErr = e;
  }
  ok('GET /reveal 有响应而不是连接被断开', !revealErr, revealErr?.message);
  if (revealRes) {
    const body = await revealRes.json().catch(() => ({}));
    ok('/reveal 返回 200', revealRes.status === 200, String(revealRes.status));
    ok('/reveal 明确回报 ok 或降级提示', typeof body.ok === 'boolean' && (body.ok || !!body.hint),
      JSON.stringify(body));
  }

  // 服务必须还活着
  let alive = null;
  try {
    alive = await (await fetch(`${BASE}/api/system`)).json();
  } catch (e) {
    alive = { error: e.message };
  }
  ok('调用 /reveal 之后服务仍然存活', alive?.ok === true, JSON.stringify(alive));
  const aliveTasks = await (await fetch(`${BASE}/api/tasks`)).json();
  ok('存活后 /api/tasks 依然可用', Array.isArray(aliveTasks.tasks));

  // 不存在的任务应 404，而不是抛异常
  const missing = await fetch(`${BASE}/api/tasks/task_0/reveal`);
  ok('/reveal 对不存在的任务返回 404', missing.status === 404, String(missing.status));

  console.log('\n【10】生成预设：后端真的按 Step 应用');
  // 预设校验 / 步骤 / 预览接口
  const stepsRes = await (await fetch(`${BASE}/api/preset/steps`)).json();
  ok('GET /api/preset/steps 返回 8 个 Step', stepsRes.steps?.length === 8,
    JSON.stringify(stepsRes.steps?.map(s => s.name)));
  ok('Step 列表含分批摘要', stepsRes.steps?.some(s => s.name === 'step-batch'),
    JSON.stringify(stepsRes.steps?.map(s => s.name)));
  ok('Step 带中文说明', stepsRes.steps.every(s => !!s.label));

  const badValidate = await (await fetch(`${BASE}/api/preset/validate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: '{ 坏 json' }),
  })).json();
  ok('POST /api/preset/validate 能报错', badValidate.ok === false && badValidate.errors.length > 0,
    JSON.stringify(badValidate.errors));

  const PRESET = {
    name: '端到端预设',
    description: '验证 append 与按 Step 生效',
    version: '1.0',
    author: '测试',
    mode: 'append',
    global: { system_suffix: 'G-SYS', user_suffix: 'G-USER' },
    steps: {
      step2: { system_suffix: 'S2-SYS', user_suffix: 'S2-USER' },
      step5: { system_suffix: 'S5-SYS' },
    },
  };

  const previewRes = await (await fetch(`${BASE}/api/preset/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preset: PRESET, step: 'step2' }),
  })).json();
  ok('POST /api/preset/preview 标注已生效', previewRes.changed === true, JSON.stringify(previewRes).slice(0, 120));
  ok('预览里 system 含 global+step 后缀',
    previewRes.system.includes('G-SYS') && previewRes.system.includes('S2-SYS'),
    previewRes.system.slice(-80));
  ok('预览未受影响的 Step 不含该 Step 后缀', await (async () => {
    const r = await fetch(`${BASE}/api/preset/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset: PRESET, step: 'step1' }),
    }).then(x => x.json());
    return r.system.includes('G-SYS') && !r.system.includes('S2-SYS');
  })());

  // 带预设跑一次真实生成
  received.length = 0;
  const pfd = new FormData();
  pfd.append('novel', new Blob([NOVEL], { type: 'text/plain' }), '预设测试.txt');
  pfd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  pfd.append('apiKey', 'test-key');
  pfd.append('model', 'mock-large');
  pfd.append('userMode', 'auto');
  pfd.append('title', '预设测试');
  pfd.append('preset', JSON.stringify(PRESET));
  pfd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 2 }));

  const pevents = await sseGenerate(pfd);
  const pfilesEvt = pevents.find(e => e.event === 'files');
  ok('带预设的生成完成', !!pfilesEvt && !pevents.some(e => e.event === 'error'),
    JSON.stringify(pevents.find(e => e.event === 'error')?.data));
  ok('LLM 收到了请求', received.length > 0, String(received.length));

  const withSuffix = received.filter(r => r.system.includes('G-SYS'));
  ok('所有请求都带上了 global 后缀', withSuffix.length === received.length,
    `${withSuffix.length}/${received.length}`);

  const sys2 = received.filter(r => r.system.includes('S2-SYS'));
  const usr2 = received.filter(r => r.user.includes('S2-USER'));
  ok('step2（事件抽取）拿到 step 级后缀', sys2.length >= 3, `命中 ${sys2.length} 次`);
  ok('step2 的 user 后缀也生效', usr2.length >= 3, `命中 ${usr2.length} 次`);
  // 追加格式：...原 prompt\n\n---\nG-SYS\n\nS2-SYS
  ok('step2 请求以 global → step 的顺序结尾（--- 分隔）',
    sys2.every(r => r.system.endsWith('---\nG-SYS\n\nS2-SYS')),
    JSON.stringify(sys2.slice(0, 2).map(r => r.system.slice(-60))));
  ok('原 prompt 未被污染（后缀只在末尾追加）',
    sys2.every(r => {
      const idx = r.system.lastIndexOf('---\nG-SYS\n\nS2-SYS');
      const before = r.system.slice(0, idx);
      // 合并调用一次承担 step1+step2，用的 prompt 是「章节级多任务抽取器」；
      // 关键性质不变：后缀只在末尾追加一次，正文部分不含后缀。
      return before.includes('章节级多任务抽取器') && !before.includes('S2-SYS') && !before.includes('G-SYS');
    }),
    JSON.stringify(sys2[0]?.system.slice(0, 60)));

  const sys5 = received.filter(r => r.system.includes('S5-SYS'));
  ok('step5（世界观/人物）拿到自己的后缀', sys5.length >= 1, `命中 ${sys5.length} 次`);
  ok('step5 不会误带 step2 的后缀', sys5.every(r => !r.system.includes('S2-SYS')));
  ok('未配置的 Step 只带 global 后缀',
    !received.some(r => r.system.includes('S3-SYS')));

  const pdir = path.join(ROOT, 'output', pfilesEvt.data.taskId);
  const pfiles = await readdir(pdir);
  ok('产物包含本次使用的预设', pfiles.includes('generation_preset.json'), pfiles.join(','));
  const savedPreset = JSON.parse(await readFile(path.join(pdir, 'generation_preset.json'), 'utf-8'));
  ok('保存的预设内容完整', savedPreset.name === '端到端预设' && savedPreset.steps.step2.system_suffix === 'S2-SYS');

  const pmeta = JSON.parse(await readFile(path.join(pdir, 'meta.json'), 'utf-8'));
  ok('meta.json 记录预设名与模式',
    pmeta.preset?.name === '端到端预设' && pmeta.preset.mode === 'append', JSON.stringify(pmeta.preset));
  ok('meta.json 记录预设生效位置', Array.isArray(pmeta.preset.applied) && pmeta.preset.applied.length === 3,
    JSON.stringify(pmeta.preset?.applied));

  const plog = await (await fetch(`${BASE}/api/tasks/${pfilesEvt.data.taskId}/log`)).json();
  ok('日志说明已应用预设',
    plog.events.some(e => /已应用预设「端到端预设」（append）/.test(e.data?.msg || '')),
    JSON.stringify(plog.events.slice(0, 3).map(e => e.data?.msg)));

  await rm(pdir, { recursive: true, force: true });

  console.log('\n【11】非法预设不阻断生成');
  received.length = 0;
  const bfd = new FormData();
  bfd.append('novel', new Blob([NOVEL], { type: 'text/plain' }), '坏预设.txt');
  bfd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  bfd.append('apiKey', 'test-key');
  bfd.append('model', 'mock-large');
  bfd.append('preset', '{ 这不是合法 json');
  const bevents = await sseGenerate(bfd);
  const bfiles = bevents.find(e => e.event === 'files');
  ok('非法预设仍能生成成功', !!bfiles, JSON.stringify(bevents.find(e => e.event === 'error')?.data));
  ok('日志给出「已忽略」警告',
    bevents.some(e => e.event === 'progress' && e.data?.step === 'WARN' && /预设无法使用/.test(e.data?.msg || '')),
    JSON.stringify(bevents.filter(e => e.data?.step === 'WARN').map(e => e.data?.msg)));
  ok('非法预设不会污染 prompt', received.every(r => !r.system.includes('这不是合法') && !r.system.includes('---\n{')));
  if (bfiles) await rm(path.join(ROOT, 'output', bfiles.data.taskId), { recursive: true, force: true });

  // ============================================================
  console.log('\n【12】分批评析：110 章 → 10 批');
  {
    // 110 章 × 约 1200 字。三个坑：
    //  · 章号必须用中文数字 —— chunkText 的章节正则只认
    //    `第[一二三四五六七八九十百千零两\d]+[章回节]`，写「第1章」会被当成无章节标记；
    //  · 100 以上我自己拼中文数字容易拼错（「第一百一十章」），
    //    所以 100 起改用阿拉伯数字 —— 正则里的 `\d` 一并认；
    //  · 不要正好用 100 章 —— 「第一百章」本身只有 100 字，
    //    会被 `filter(p => p.trim().length > minChapterLen)`（严格大于 100）滤掉。
    const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const cnNum = (n) => {
      if (n >= 100) return String(n);
      if (n < 10) return CN[n];
      if (n < 20) return `十${n % 10 ? CN[n % 10] : ''}`;
      return `${CN[Math.floor(n / 10)]}十${n % 10 ? CN[n % 10] : ''}`;
    };
    const longNovel = Array.from({ length: 110 }, (_, i) => {
      const n = i + 1;
      const body = `林昭在云京的第${n}日，街市依旧喧嚣，她沿着长街慢慢走，心里想着兄长留下的那句话。`
        .repeat(Math.ceil(1200 / 39));
      return `第${cnNum(n)}章 标题${n}\n\n${body}`;
    }).join('\n\n');

    const lfd = new FormData();
    lfd.append('novel', new Blob([longNovel], { type: 'text/plain' }), '长篇.txt');
    lfd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
    lfd.append('apiKey', 'test-key');
    lfd.append('model', 'mock-large');
    lfd.append('userMode', 'protagonist');
    lfd.append('title', '长篇测试');
    lfd.append('options', JSON.stringify({ concurrency: 4 }));

    const levents = await sseGenerate(lfd);
    const lstarts = levents.filter(e => e.event === 'batch' && e.data?.phase === 'start');
    const ldones = levents.filter(e => e.event === 'batch' && e.data?.phase === 'done');
    // 110 章 / 每批 10 章 → 11 批。不写死批数：真实的批数由 splitIntoBatches 决定，
    // 写死会让"切批规则改了"和"分批坏了"这两种情况无法区分。
    const TOTAL = lstarts.length;
    console.log(`     实际批数：${TOTAL}（${lstarts.map(e => e.data.chapters).join('+')}）`);
    ok('110 章切成 11 批', TOTAL === 11, String(TOTAL));
    ok('每批开始/结束都有事件', ldones.length === TOTAL, String(ldones.length));
    ok('批次事件带 index / total',
      lstarts.every((e, i) => e.data.index === i && e.data.total === TOTAL),
      JSON.stringify(lstarts.map(e => `${e.data.index}/${e.data.total}`)));
    ok('批次事件带章节数与 token',
      lstarts.every(e => e.data.chapters > 0 && e.data.tokens > 0 && e.data.chars > 0));
    ok('除最后一批外都是 10 章（章数先到，字数没超）',
      lstarts.slice(0, -1).every(e => e.data.chapters === 10) && lstarts.at(-1).data.chapters <= 10,
      JSON.stringify(lstarts.map(e => e.data.chapters)));
    ok('每批字数都在上限内',
      lstarts.every(e => e.data.chars <= 30000), JSON.stringify(lstarts.map(e => e.data.chars)));
    ok('各批章数之和 = 章节总数',
      lstarts.reduce((s, e) => s + e.data.chapters, 0) === 110,
      String(lstarts.reduce((s, e) => s + e.data.chapters, 0)));
    ok('长篇生成没有 error',
      !levents.some(e => e.event === 'error'),
      JSON.stringify(levents.find(e => e.event === 'error')?.data));

    const lfiles = levents.find(e => e.event === 'files');
    ok('长篇生成了完整角色卡', !!lfiles && lfiles.data.files.includes('character_card.json'));

    if (lfiles) {
      const ldir = path.join(ROOT, 'output', lfiles.data.taskId);
      ok('产物含 merge_report.json', lfiles.data.files.includes('merge_report.json'), lfiles.data.files.join(','));
      ok('产物含 batch_state.json', lfiles.data.files.includes('batch_state.json'));

      const bfilesList = (await readdir(path.join(ldir, 'batches'))).filter(f => /^batch_\d+\.json$/.test(f));
      ok('batch 目录文件数 = 批数', bfilesList.length === TOTAL, `${bfilesList.length} vs ${TOTAL}`);

      const bz = JSON.parse(await readFile(path.join(ldir, 'batches', 'batch_000.json'), 'utf-8'));
      ok('批次文件记录了章节清单', Array.isArray(bz.chapterTitles) && bz.chapterTitles.length === 10);
      ok('批次文件记录了逐章完成状态', bz.doneChapterTitles.length === 10);
      ok('批次文件标记 complete', bz.complete === true);
      ok('批次文件含摘要（分批摘要已启用）',
        typeof bz.summary === 'string' && bz.summary.length > 0, JSON.stringify(bz.summary));

      const lmeta = JSON.parse(await readFile(path.join(ldir, 'meta.json'), 'utf-8'));
      ok('meta 记录批数一致', lmeta.batch?.total === TOTAL, `${lmeta.batch?.total} vs ${TOTAL}`);
      ok('meta 记录每批规模', lmeta.batch?.sizes?.length === TOTAL);
      ok('meta 记录续跑数 0', lmeta.batch?.resumed === 0);
      ok('meta 记录人物归并账本', typeof lmeta.batch?.merged?.roster?.inputCount === 'number');

      const lreport = JSON.parse(await readFile(path.join(ldir, 'merge_report.json'), 'utf-8'));
      ok('归并账本：事件有去重', lreport.events.dropped > 0,
        JSON.stringify({ in: lreport.events.inputCount, out: lreport.events.outputCount }));
      ok('归并账本：人物去重后不为空', lreport.roster.outputCount > 0);
      ok('归并账本：没有章节错位', lreport.orphanChapters.length === 0,
        JSON.stringify(lreport.orphanChapters));

      const lvars = JSON.parse(await readFile(path.join(ldir, 'variables.json'), 'utf-8'));
      ok('变量树人物数 == 归并后人数',
        Object.keys(lvars.characters).length + (lvars.user?.name && lvars.user.name !== '{{user}}' ? 1 : 0)
          === lreport.roster.outputCount,
        `变量树 ${Object.keys(lvars.characters).length} / 归并 ${lreport.roster.outputCount}`);
      ok('事件变量来自归并后的全局事件',
        Object.keys(lvars.events).length === lreport.events.outputCount,
        `变量树 ${Object.keys(lvars.events).length} / 归并 ${lreport.events.outputCount}`);

      // ---- 断点续跑 ----
      console.log('\n【12.5】断点续跑：复用全部批次');
      const resumedEvents = await sseGenerate((() => {
        const f = new FormData();
        f.append('novel', new Blob([longNovel], { type: 'text/plain' }), '长篇.txt');
        f.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
        f.append('apiKey', 'test-key');
        f.append('model', 'mock-large');
        f.append('userMode', 'protagonist');
        f.append('title', '长篇测试');
        f.append('resumeTaskId', lfiles.data.taskId);
        f.append('options', JSON.stringify({ concurrency: 4 }));
        return f;
      })());
      ok('续跑没有 error', !resumedEvents.some(e => e.event === 'error'),
        JSON.stringify(resumedEvents.find(e => e.event === 'error')?.data));
      const skipped = resumedEvents.filter(e => e.event === 'progress' && /已完成，跳过/.test(e.data?.msg || ''));
      ok('全部批次被跳过', skipped.length === TOTAL, `${skipped.length} vs ${TOTAL}`);
      ok('续跑时没有再调 LLM 抽事件',
        resumedEvents.filter(e => e.event === 'batch' && e.data?.phase === 'start').length === 0,
        String(resumedEvents.filter(e => e.event === 'batch' && e.data?.phase === 'start').length));
      const lmeta2 = JSON.parse(await readFile(path.join(ldir, 'meta.json'), 'utf-8'));
      ok('meta 记录 resumed = 批数', lmeta2.batch?.resumed === TOTAL,
        `${lmeta2.batch?.resumed} vs ${TOTAL}`);

      // ---- 批次 API ----
      const bapi = await (await fetch(`${BASE}/api/tasks/${lfiles.data.taskId}/batches`)).json();
      ok('GET /batches 返回全部批次', bapi.total === TOTAL && bapi.batches.length === TOTAL,
        JSON.stringify({ t: bapi.total, n: bapi.batches.length }));
      ok('GET /batches 全部标 complete', bapi.complete === TOTAL, `${bapi.complete} vs ${TOTAL}`);
      ok('GET /batches 带批次明细', bapi.batches.every(b => b.chapters.length > 0 && b.chars > 0),
        JSON.stringify(bapi.batches.map(b => [b.chapters.length, b.chars])));
      ok('GET /batches 带进度概览', bapi.state?.done === TOTAL && bapi.state?.finished === true,
        JSON.stringify({ d: bapi.state?.done, f: bapi.state?.finished }));

      // ---- 短篇不受影响 ----
      console.log('\n【12.6】短篇（3 章）仍走单批');
      const shortEvents = await sseGenerate((() => {
        const f = new FormData();
        f.append('novel', new Blob([NOVEL], { type: 'text/plain' }), '短篇.txt');
        f.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
        f.append('apiKey', 'test-key');
        f.append('model', 'mock-large');
        f.append('userMode', 'auto');
        return f;
      })());
      const shortStarts = shortEvents.filter(e => e.event === 'batch' && e.data?.phase === 'start');
      ok('3 章只切 1 批', shortStarts.length === 1, String(shortStarts.length));
      const shortFiles = shortEvents.find(e => e.event === 'files');
      ok('短篇仍产出完整角色卡', !!shortFiles && shortFiles.data.files.includes('character_card.json'),
        JSON.stringify(shortEvents.find(e => e.event === 'error')?.data));
      if (shortFiles) {
        const sdir = path.join(ROOT, 'output', shortFiles.data.taskId);
        const svars = JSON.parse(await readFile(path.join(sdir, 'variables.json'), 'utf-8'));
        ok('短篇变量树仍有事件', Object.keys(svars.events).length > 0,
          JSON.stringify(Object.keys(svars.events)));
        ok('短篇世界观条目没丢',
          (JSON.parse(await readFile(path.join(sdir, 'meta.json'), 'utf-8')).counts.worldbookEntries ?? 0) > 0);
        await rm(sdir, { recursive: true, force: true });
      }

      await rm(ldir, { recursive: true, force: true });
    }
  }

  // 清理
  await rm(outDir, { recursive: true, force: true });
  await rm(uploads, { recursive: true, force: true });
  console.log(`\n（已清理测试产物 ${taskId}）`);

  report();
  mock.close();
}

function report() {
  console.log(`\n${'='.repeat(46)}`);
  console.log(`  通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  mock.close(() => process.exit(fail ? 1 : 0));
}
main().catch(e => {
  console.error('\n测试异常：', e);
  mock.close();
  process.exit(1);
});
