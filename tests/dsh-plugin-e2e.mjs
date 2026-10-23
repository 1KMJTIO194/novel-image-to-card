/**
 * DSH 插件：HTTP 层端到端
 *
 * 把插件的路由真的挂到一个 HTTP 服务器上，再用一个**假的 OpenAI 兼容端点**
 * 当 LLM，跑完整的一次「小说 → 角色卡」。
 *
 * 这一层验证的是 Node 里能确证的部分：
 *   · ctx.webServer.register 的 handler 契约（req/res 直接拥有响应）
 *   · multipart 上传 → 任务创建 → SSE 事件流 → 产物列表 → 文件下载
 *   · 错误路径（缺参数、任务不存在）返回可读 JSON 而不是崩掉
 *
 * 不验证：真的装进 DSH profile、真的调模型、浏览器里长什么样。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

// ============================================================
// 假 LLM：按 system prompt 的特征词返回对应 schema 的 JSON
// ============================================================
const MOCK = {
  // ⚠️ key 用的是 prompts 里的**唯一子串**，且 classify 按 key 长度从长到短匹配。
  // 早期版本按声明顺序 includes 匹配，结果「状态栏生成器」抢在「角色卡字段生成器」前面，
  // 统计里就出现了并不存在的「状态栏生成器」命中。
  '你是一个章节级多任务抽取器': {
    mentions: [
      { scope: 'story', type: 'absolute', raw: '天启三年春', quote: '天启三年春', event: '开篇入城', subject: null, anchor: null },
    ],
    events: [
      {
        name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭踏进城门',
        canon: '林昭进入云京寻找兄长。', pressure: 'core',
        time: '天启三年三月十二日', participants: ['沈砚'], location: '云京城门',
        prerequisites: { temporal: [], behavioral: '' },
        interventions: [{ condition: '若直接报案', result: '官府介入' }],
      },
      {
        name: '初见沈砚', storyline: '入城立足', chapter: '第二章', quote: '沈砚递来一盏茶',
        canon: '林昭与沈砚相识。', pressure: 'buffer',
        participants: ['沈砚'], location: '城南茶楼',
        prerequisites: { temporal: ['开篇入城'], behavioral: '' },
        interventions: [],
      },
      {
        name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '旧宅的门虚掩着',
        canon: '林昭夜探旧宅发现密信。', pressure: 'core',
        participants: ['沈砚'], location: '旧宅',
        prerequisites: { temporal: ['初见沈砚'], behavioral: '' },
        interventions: [],
      },
    ],
  },
  '你是世界观与物品抽取器': {
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', dynamicHint: '' },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案。', dynamicHint: '' },
    ],
    items: [
      { category: 'system_item', name: '玉佩', keys: ['玉佩'], content: 'name: 玉佩\ntype: 物品\n外观: 半块残玉。', dynamicHint: '' },
    ],
  },
  // 批量档案与单人档案**首句相同**，所以用各自独有的短语区分
  '同一份原文节选和一份角色清单': {
    profiles: [
      { name: '林昭', keys: ['林昭', '阿昭'], content_yaml: 'name: 林昭\ntitle: 寻亲者\nage: 十七\nappearance: |\n  素衣少女，眉目清淡。\npersonality: |\n  沉静果决，为寻兄不惜涉险。' },
      { name: '沈砚', keys: ['沈砚'], content_yaml: 'name: 沈砚\ntitle: 茶楼主人\nage: 二十\nappearance: |\n  青衫男子，眉眼温和。\npersonality: |\n  圆滑通透，说话总留三分。' },
    ],
  },
  '能直接拿来扮演': {
    name: '林昭', keys: ['林昭'],
    content_yaml: 'name: 林昭\ntitle: 寻亲者\nage: 十七\nappearance: |\n  素衣少女，眉目清淡。\npersonality: |\n  沉静果决。',
  },
  '抽出**真正的人物名单**': {
    characters: [{ name: '林昭', aliases: ['阿昭'] }, { name: '沈砚', aliases: [] }],
  },
  '你是分批阅读助手': { summary: '林昭入城并结识沈砚。', newCharacters: ['林昭', '沈砚'] },
  '你是时间线锚点识别器': { origin: { event: '开篇入城', reason: '故事当下的起点' } },
  // 注意：是「阶段划分器」，不是「剧情阶段划分器」
  '你是阶段划分器': { phases: [{ name: '入城', coreChange: '林昭抵达云京', chapter: '第一章' }] },
  '你是人设变化抽取器': { deltas: [] },
  // 这条 prompt 在源文件里不带「你是」前缀
  '判断给定作品是否为广为人知的热门作品': { popular: false, title: '', reason: '原创作品' },
  '你是事件条目撰写器与剧情梗概撰写器': {
    events: [
      { name: '开篇入城', content_yaml: '起因: 寻兄\n经过: 入城\n结果: 得到线索\n影响: 结识沈砚\n干预分支: 若直接报案则官府介入' },
      { name: '初见沈砚', content_yaml: '起因: 茶楼相遇\n经过: 交谈\n结果: 得到线索\n影响: 结盟\n干预分支: 无' },
      { name: '夜探旧宅', content_yaml: '起因: 追寻线索\n经过: 夜探\n结果: 得到密信\n影响: 指向缉影司\n干预分支: 无' },
    ],
    synopsis: '林昭为寻兄来到云京，在茶楼结识沈砚，夜探旧宅得到密信。',
  },
  // 「角色卡字段生成器」的真实首句
  '生成 SillyTavern 角色卡的基础字段': {
    description: '云京旧案的寻亲之旅。',
    first_mes: '城门在你面前打开，守卒正在换班。林昭握紧袖中的半块玉佩，抬脚走了进去。',
    personality: '沉静果决',
    scenario: '天启三年春，云京。',
    mes_example: '',
    tags: ['古代', '悬疑'],
    creator_notes: '由 DSH 插件测试生成。',
  },
  '你是物品条目抽取器': {
    items: [
      { category: 'system_item', name: '密信', keys: ['密信'], content: 'name: 密信\ntype: 物品\n外观: 字迹潦草，末尾半个印章。', dynamicHint: '' },
    ],
  },
  '你是世界观抽取器': {
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', dynamicHint: '' },
    ],
  },
  '从给定小说中抽取世界观设定条目': {
    worldbook: [
      { category: 'map_world', name: '云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', dynamicHint: '' },
    ],
  },
  '分析给定小说的前几章': { structure: 'linear', protagonist: '林昭', confidence: 'high' },
};

const received = [];
/** 按 key 长度从长到短匹配，避免短 key 抢占长 key */
function classify(system) {
  const s = String(system);
  const keys = Object.keys(MOCK).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (s.includes(k)) return { key: k, value: MOCK[k] };
  }
  return { key: '(未匹配)', value: { ok: true } };
}

const llmHits = [];
const mockLLM = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    if (req.url.replace(/^\/v\d+/, '').startsWith('/models')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    }
    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const system = payload.messages?.find(m => m.role === 'system')?.content || '';
    const user = payload.messages?.find(m => m.role === 'user')?.content || '';
    received.push({ system, user });
    const hit = classify(system);
    const matched = hit.key;
    llmHits.push(matched);
    if (matched === '(未匹配)' && process.env.N2C_DEBUG_MOCK) {
      console.log('\n--- 未匹配的 system prompt 前 300 字 ---');
      console.log(String(system).slice(0, 300));
      console.log('---\n');
    }
    const content = JSON.stringify(hit.value);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { total_tokens: 42 },
    }));
  });
});

const LLM_PORT = 3221;
const SRV_PORT = 3222;
await new Promise(r => mockLLM.listen(LLM_PORT, '127.0.0.1', r));

// ============================================================
// 用假 ctx 挂插件路由，再起一个真 HTTP 服务器
// ============================================================
const tmpRoot = await mkdtemp(path.join(tmpdir(), 'n2c-dsh-test-'));
process.env.DSH_HOME = tmpRoot;

const HostMod = await import(pathToFileURL(path.join(ROOT, 'dsh/index.js')).href);

const routes = [];
const fakeCtx = {
  webServer: { register: (r) => { routes.push(r); return () => { routes.splice(routes.indexOf(r), 1); }; } },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  logger: { info: () => {} },
};
HostMod.apply(fakeCtx);

/** 按 webserver 的契约派发：精确匹配 → 最长前缀 → 404 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const exact = routes.find(r => r.kind === 'exact' && r.path === url.pathname);
  if (exact) return exact.handler(req, res);
  const prefixes = routes.filter(r => r.kind === 'prefix' && url.pathname.startsWith(r.path))
    .sort((a, b) => b.path.length - a.path.length);
  if (prefixes.length) return prefixes[0].handler(req, res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});
await new Promise(r => server.listen(SRV_PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${SRV_PORT}`;

/** SSE 收集器：返回全部事件与终态 */
async function collectStream(taskId, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(`${BASE}/novel2card/stream?id=${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const da = /^data: (.+)$/m.exec(block);
        if (!ev) continue;
        let data = null;
        try { data = da ? JSON.parse(da[1]) : null; } catch { /* 忽略 */ }
        events.push({ event: ev[1].trim(), data });
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

const CH = [
  `第一章 入城

天启三年春，林昭年方十七，独自一人来到云京。她此行的唯一目的，是寻找三年前失踪的兄长。
林昭踏进城门时，守卒正在换班，没有人多看她一眼。城内的喧嚣与记忆中的小城截然不同。
她握紧了袖中的半块玉佩，那是兄长留下的唯一信物。街市两侧的灯笼刚刚点亮，卖汤饼的摊子冒着白气。
林昭在城门口站了很久，直到暮色四合，才沿着主街往里走。她记得兄长临走前说过，云京的雨很冷。

第二章 茶楼

沈砚递来一盏茶，说他知道那半块玉的来历。林昭抬眼看他，茶烟在两人之间散开。
沈砚是城南茶楼的主人，年纪不大，眉眼温和，说话却总留三分。他说三年前也有一个人来找过同样的玉。
林昭的手在袖中收紧。她问那人后来去了哪里，沈砚摇摇头，只说那人往旧宅的方向去了，再没回来过。
窗外的雨落下来，打在青石板上，声音很密。林昭把茶喝完，站起来说要走。

第三章 旧宅

旧宅的门虚掩着。林昭推门而入，屋里积着薄薄的灰，桌椅都还在原处，只是没人打理。
她在书案下摸到一封密信，字迹潦草，末尾有半个印章，另外半个像是被人撕走了。
信上写着几个地名，还有一句话：若我未归，去寻缉影司的旧档。林昭把信折好，贴身收进衣襟。
院中的老树被雨打了一夜，落叶铺满了石阶。她在这里站到天亮，然后关上门，往衙门的方向走去。`,
].join('\n');

// ============================================================
console.log('\n【5】HTTP 端到端：小说 → 角色卡');
{
  // 健康检查
  const meta = await (await fetch(`${BASE}/novel2card/meta`)).json();
  ok('GET /meta 返回能力清单', meta.ok === true && Array.isArray(meta.kinds), JSON.stringify(meta).slice(0, 120));
  ok('/meta 报告数据目录指向 DSH_HOME', String(meta.dataDir).includes(tmpRoot.replace(/\\/g, '\\')),
    `${meta.dataDir} vs ${tmpRoot}`);

  // 未知路径 404
  const nf = await fetch(`${BASE}/novel2card/nope`);
  ok('未知路径返回 404', nf.status === 404, String(nf.status));

  // 缺参数 → 可读错误，而不是崩
  const bad = await fetch(`${BASE}/novel2card/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  ok('缺 baseUrl 返回 400 且带中文原因', bad.status === 400
    && /baseUrl/.test((await bad.json()).error || ''), String(bad.status));

  const bad2 = await fetch(`${BASE}/novel2card/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseUrl: 'http://x', model: 'm' }),
  });
  ok('没给文本也能给出可读错误', bad2.status === 400
    && /小说文本/.test((await bad2.json()).error || ''), String(bad2.status));

  // 真跑一次：multipart 上传文本
  const fd = new FormData();
  fd.append('kind', 'generate');
  fd.append('baseUrl', `http://127.0.0.1:${LLM_PORT}/v1`);
  fd.append('apiKey', 'test');
  fd.append('model', 'mock-model');
  fd.append('title', '云京旧案');
  fd.append('userMode', 'participant');
  fd.append('outputMode', 'card');
  fd.append('chapterRange', 'all');
  fd.append('novelText', CH);

  const created = await fetch(`${BASE}/novel2card/generate`, { method: 'POST', body: fd });
  const cj = await created.json();
  ok('POST /generate 返回 200 与 taskId', created.status === 200 && !!cj.taskId,
    `${created.status} ${JSON.stringify(cj).slice(0, 120)}`);
  const taskId = cj.taskId;

  // 状态
  const st = await (await fetch(`${BASE}/novel2card/task?id=${taskId}`)).json();
  ok('GET /task 能查到任务', st.taskId === taskId, JSON.stringify(st).slice(0, 120));
  ok('任务类型为 generate', st.kind === 'generate', String(st.kind));

  // 事件流（跑到结束）
  const events = await collectStream(taskId);
  const types = [...new Set(events.map(e => e.event))];
  ok('收到 start 事件', types.includes('start'), JSON.stringify(types));
  ok('收到 progress 事件', types.includes('progress'), JSON.stringify(types));
  ok('收到 files 事件（产物清单）', types.includes('files'), JSON.stringify(types));
  ok('收到 done 事件收尾', types.includes('done'), JSON.stringify(types));
  const doneEv = events.find(e => e.event === 'done');
  ok('done 报告状态为 done', doneEv?.data?.status === 'done',
    JSON.stringify(doneEv?.data).slice(0, 160));
  ok('progress 至少 5 条（流程真的在跑）',
    events.filter(e => e.event === 'progress').length >= 5,
    String(events.filter(e => e.event === 'progress').length));

  // 假 LLM 确实被调用了，且命中的是预期步骤
  ok('假 LLM 收到了请求', received.length > 0, `${received.length} 次`);
  ok('命中了章节级多任务抽取器', llmHits.includes('你是一个章节级多任务抽取器'),
    JSON.stringify([...new Set(llmHits)]));
  /**
   * 人物档案这一步：先走"批量档案"，批量里缺人时再单独补抽。
   * 实测这一轮批量返回空，于是走了补抽（「能直接拿来扮演」那条）—— 两者都算命中。
   */
  ok('命中了人物档案抽取（批量或补抽）',
    llmHits.includes('同一份原文节选和一份角色清单') || llmHits.includes('能直接拿来扮演'),
    JSON.stringify([...new Set(llmHits)]));
  ok('所有 LLM 请求都被 mock 接住了（无未匹配）',
    !llmHits.includes('(未匹配)'), JSON.stringify([...new Set(llmHits)]));
  ok('覆盖了至少 8 个不同的流程步骤',
    new Set(llmHits).size >= 8, `${new Set(llmHits).size} 个`);

  // 产物
  const st2 = await (await fetch(`${BASE}/novel2card/task?id=${taskId}`)).json();
  const names = (st2.artifacts || []).map(a => a.name);
  ok('产出了 character_card.json', names.includes('character_card.json'), JSON.stringify(names));
  ok('产出了 meta.json', names.includes('meta.json'), JSON.stringify(names));
  ok('产出了 README.md', names.includes('README.md'), JSON.stringify(names));
  ok('产物列表带字节数', (st2.artifacts || []).every(a => typeof a.size === 'number'));

  // 下载角色卡并校验结构
  const dl = await fetch(`${BASE}/novel2card/file?id=${taskId}&name=character_card.json`);
  ok('下载返回 200', dl.status === 200, String(dl.status));
  ok('Content-Disposition 带文件名',
    /character_card\.json/.test(dl.headers.get('content-disposition') || ''),
    String(dl.headers.get('content-disposition')));
  const card = JSON.parse(await dl.text());
  ok('下载的是合法角色卡 JSON', card?.spec === 'chara_card_v3' || !!card?.data,
    JSON.stringify(Object.keys(card || {})).slice(0, 80));
  ok('卡名与请求一致', card.data?.name === '云京旧案', String(card.data?.name));
  ok('含 character_book.entries', Array.isArray(card.data?.character_book?.entries),
    String(card.data?.character_book?.entries?.length));
  ok('条目非空', (card.data?.character_book?.entries?.length || 0) > 0,
    String(card.data?.character_book?.entries?.length));
  ok('顶层 description 与 data.description 一致',
    card.description === card.data?.description,
    `${String(card.description).slice(0, 20)} vs ${String(card.data?.description).slice(0, 20)}`);

  // 目录穿越必须被拒
  const esc = await fetch(`${BASE}/novel2card/file?id=${taskId}&name=${encodeURIComponent('../../../etc/passwd')}`);
  ok('目录穿越被拒', esc.status === 404 || esc.status === 500, String(esc.status));

  // 任务不存在
  const noTask = await fetch(`${BASE}/novel2card/task?id=task_不存在`);
  ok('不存在的任务返回 404', noTask.status === 404, String(noTask.status));

  // 任务列表包含它
  const list = await (await fetch(`${BASE}/novel2card/tasks`)).json();
  ok('任务列表包含刚跑完的任务',
    (list.tasks || []).some(t => t.taskId === taskId), JSON.stringify(list).slice(0, 160));
  ok('列表里状态为 done',
    (list.tasks || []).find(t => t.taskId === taskId)?.status === 'done',
    String((list.tasks || []).find(t => t.taskId === taskId)?.status));

  // 重复订阅已完成任务：应立即收尾而不是挂住
  const again = await collectStream(taskId, 8000);
  ok('对已完成任务再次订阅会立刻收到 done',
    again.some(e => e.event === 'done'), JSON.stringify(again.map(e => e.event)));

  // 删除任务
  const rmRes = await fetch(`${BASE}/novel2card/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
  });
  ok('remove 返回 ok', (await rmRes.json()).ok === true, String(rmRes.status));
  const after = await fetch(`${BASE}/novel2card/task?id=${taskId}`);
  ok('删除后查不到', after.status === 404, String(after.status));
}

// ============================================================
console.log('\n【6】取消路径');
{
  const fd = new FormData();
  fd.append('kind', 'generate');
  fd.append('baseUrl', `http://127.0.0.1:${LLM_PORT}/v1`);
  fd.append('apiKey', 'test');
  fd.append('model', 'mock-model');
  fd.append('title', '取消测试');
  fd.append('novelText', CH);
  const cj = await (await fetch(`${BASE}/novel2card/generate`, { method: 'POST', body: fd })).json();
  const taskId = cj.taskId;

  const c = await fetch(`${BASE}/novel2card/cancel`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId }),
  });
  ok('cancel 返回 ok', (await c.json()).ok === true, String(c.status));

  const events = await collectStream(taskId, 20000);
  const doneEv = events.find(e => e.event === 'done');
  ok('取消后事件流收尾', !!doneEv, JSON.stringify(events.map(e => e.event)));
  const finalStatus = doneEv?.data?.status;
  ok('终态是 cancelled 或 done（取消是协作式的，可能刚好跑完）',
    finalStatus === 'cancelled' || finalStatus === 'done', String(finalStatus));
}

// ============================================================
console.log('\n【6b】完善指令：真的进了 prompt，且限长');
{
  /**
   * 用户诉求：「让小说中的角色合并到角色卡里并且角色设定要符合角色卡世界观」。
   * 指令要拼进每个抽取步骤；已有卡的世界观摘要也要一并喂进去。
   * 这里用假 LLM 抓实际请求体验证接线。
   */
  const card = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
      name: '云京旧案', description: 'd', personality: '', scenario: '',
      first_mes: 'f', mes_example: '', tags: [], creator: '',
      character_version: '1.0', alternate_greetings: [], extensions: {},
      character_book: {
        name: '云京世界书',
        entries: [
          { id: 0, comment: '[map_world] 云京', keys: ['云京'], content: 'name: 云京\ntype: 世界\n地理概况: 王朝都城。', constant: true, enabled: true, insertion_order: 1, extensions: { group: 'map_world' } },
          { id: 1, comment: '[system_faction] 缉影司', keys: ['缉影司'], content: 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案。', constant: false, enabled: true, insertion_order: 2, extensions: { group: 'system_faction' } },
        ],
      },
    },
  };

  // 请求体里有 instruction / 云京 / 缉影司的调用数
  const before = received.length;

  const INSTR = '只合并角色，角色设定必须符合原卡世界观；地图势力也纳入，但沿用原卡地名';
  const fd = new FormData();
  fd.append('kind', 'augment');
  fd.append('baseUrl', `http://127.0.0.1:${LLM_PORT}/v1`);
  fd.append('apiKey', 'test');
  fd.append('model', 'mock-model');
  fd.append('title', '带指令的完善');
  fd.append('strategy', 'merge');
  fd.append('instruction', INSTR);
  fd.append('novelText', CH);
  fd.append('card', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'card.json');

  const res = await fetch(`${BASE}/novel2card/generate`, { method: 'POST', body: fd });
  const cj = await res.json();
  ok('带指令的完善任务能创建', res.status === 200 && !!cj.taskId,
    `${res.status} ${JSON.stringify(cj).slice(0, 120)}`);

  if (cj.taskId) {
    const events = await collectStream(cj.taskId, 60000);
    const doneEv = events.find(e => e.event === 'done');
    // 允许 done 或 error（假 LLM 对 augment 的返回形状不保证完美），
    // 关键看**发出的请求体**里有没有指令与世界观摘要
    ok('任务收尾（done 或 error 都算跑到了）', !!doneEv, JSON.stringify(events.map(e => e.event)));

    const sent = received.slice(before);
    ok('augment 真的调用了 LLM', sent.length > 0, String(sent.length));
    const withInstr = sent.filter(r => String(r.user).includes(INSTR));
    ok('指令进了至少 2 个步骤的 prompt', withInstr.length >= 2, String(withInstr.length));
    ok('指令被标为高优先级', withInstr.some(r => /优先级高于/.test(String(r.user))));

    const withDigest = sent.filter(r => String(r.user).includes('已有角色卡的世界观'));
    ok('已有卡世界观摘要也进了 prompt', withDigest.length >= 1, String(withDigest.length));
    ok('摘要含原卡地名「云京」', withDigest.some(r => String(r.user).includes('云京')), '');
    ok('摘要含原卡势力「缉影司」', withDigest.some(r => String(r.user).includes('缉影司')), '');
    ok('摘要带一致性要求', withDigest.some(r => /沿用已有卡的说法/.test(String(r.user))), '');
  }

  // 限长：超过 2000 字要拒，且给出可读原因
  const big = new FormData();
  big.append('kind', 'augment');
  big.append('baseUrl', `http://127.0.0.1:${LLM_PORT}/v1`);
  big.append('model', 'mock-model');
  big.append('novelText', CH);
  big.append('instruction', 'x'.repeat(2001));
  big.append('card', new Blob([JSON.stringify(card)], { type: 'application/json' }), 'card.json');
  const bigRes = await fetch(`${BASE}/novel2card/generate`, { method: 'POST', body: big });
  const bigJson = await bigRes.json();
  ok('超长指令被拒（400）', bigRes.status === 400, String(bigRes.status));
  ok('超长指令的报错说明上限与当前长度',
    /2000/.test(bigJson.error || '') && /2001/.test(bigJson.error || ''),
    JSON.stringify(bigJson));
}

// ============================================================
console.log('\n【7】信任栅栏：非本机 / 跨站请求必须被拒');
{
  /**
   * 实测发现的问题：DSH 自己的路由对非授权请求返回 401，
   * 而**插件注册的路由完全不受那套校验保护** ——
   * 实测 `GET /` → 401 而 `GET /novel2card/meta` → 200。
   *
   * 本插件风险尤其实在：generate 接收 API Key、file 能读出用户小说产物。
   * 所以每条路由都要过 `lib/guard.js`。
   *
   * 这里**不带 fence**（模拟"宿主栅栏不可用"），验证自带校验是否足够。
   */
  /**
   * ⚠️ 必须用 `http.request` 而不是 `fetch` 来测这一节。
   *
   * `fetch`（undici）会**忽略调用方设置的 `Host` 头** —— 它是 forbidden header，
   * 由运行时自己重写。所以用 fetch 伪造 Host 测栅栏是测不出来的
   *（第一版就是这么写的，结果所有用例都是 200/404，看起来像栅栏没生效）。
   */
  const rawGet = (opts = {}) => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: SRV_PORT,
      path: opts.path || '/novel2card/meta',
      method: opts.method || 'GET',
      headers: {
        Host: opts.host ?? '127.0.0.1:3222',
        ...(opts.origin ? { Origin: opts.origin } : {}),
        ...(opts.fetchSite ? { 'Sec-Fetch-Site': opts.fetchSite } : {}),
        ...(opts.method === 'POST' ? { 'Content-Type': 'application/json', 'Content-Length': 2 } : {}),
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', () => resolve({ status: 0 }));
    if (opts.method === 'POST') req.write('{}');
    req.end();
  });

  ok('本机请求通过', (await rawGet()).status === 200);
  ok('localhost 也算本机', (await rawGet({ host: 'localhost:3222' })).status === 200);
  ok('127.0.0.53（127/8 全段）也算本机',
    (await rawGet({ host: '127.0.0.53:3222' })).status === 200);
  ok('Sec-Fetch-Site: cross-site 被拒',
    (await rawGet({ fetchSite: 'cross-site' })).status === 403);
  ok('Origin 与 Host 不同源被拒',
    (await rawGet({ origin: 'http://evil.example' })).status === 403);
  ok('Origin 与 Host 同源通过',
    (await rawGet({ origin: 'http://127.0.0.1:3222' })).status === 200);
  ok('127.0.0.1.evil.com 不被当成本机（逐段校验，不是 startsWith）',
    (await rawGet({ host: '127.0.0.1.evil.com:3222' })).status === 403);
  ok('128.0.0.1 不算本机', (await rawGet({ host: '128.0.0.1:3222' })).status === 403);
  ok('非本机 Host 的读请求在无栅栏时也被拒（fail-closed）',
    (await rawGet({ host: '192.168.1.50:3222' })).status === 403);
  ok('非本机 Host 的写请求被拒',
    (await rawGet({ method: 'POST', host: '192.168.1.50:3222', path: '/novel2card/generate' })).status === 403);

  // 所有路由都受保护，不是只有 meta
  for (const [m, p] of [
    ['GET', '/novel2card/meta'], ['GET', '/novel2card/tasks'], ['GET', '/novel2card/task?id=x'],
    ['GET', '/novel2card/stream?id=x'], ['GET', '/novel2card/file?id=x&name=y'],
    ['POST', '/novel2card/cancel'], ['POST', '/novel2card/remove'], ['POST', '/novel2card/generate'],
  ]) {
    const r = await rawGet({ method: m, path: p, host: '192.168.1.50:3222' });
    ok(`${m} ${p.split('?')[0]} 受保护`, r.status === 403, String(r.status));
  }
}

// ============================================================
console.log('\n【8】打开产物目录（省得用户翻文件夹）');
{
  /**
   * 用户反馈：「dsh 上生成的角色卡都保存在了哪里，我翻文件找有点麻烦」。
   *
   * 插件数据目录是 `~/.dsh/novel2card/output/task_<时间戳>/`，
   * 手动翻确实麻烦，所以面板上给了「打开目录 / 复制路径」。
   *
   * ⚠️ 这个接口的安全要点：**不接受任意路径**，目录只能来自服务端任务记录，
   * 且必须落在插件数据根之下 —— 否则就成了"让宿主打开任意目录"的洞。
   */
  const Tasks = await import(pathToFileURL(path.join(ROOT, 'dsh/lib/tasks.js')).href);
  const dataRoot = path.join(tmpRoot, 'novel2card');

  const post = (body) => fetch(`${BASE}/novel2card/reveal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // 建一个合法任务（outDir 在数据根之下）
  const job = await Tasks.createJob({ kind: 'generate', title: '打开目录测试', baseDir: dataRoot });
  const okRes = await post({ taskId: job.taskId });
  const okJson = await okRes.json();
  ok('合法任务 → 200', okRes.status === 200, `${okRes.status} ${JSON.stringify(okJson).slice(0, 120)}`);
  ok('返回产物目录路径', typeof okJson.outDir === 'string' && okJson.outDir.includes(job.taskId),
    String(okJson.outDir));
  ok('返回告知用哪个命令打开', typeof okJson.opened === 'string' && okJson.opened.length > 0,
    String(okJson.opened));

  // 未知任务
  const nf = await post({ taskId: 'task_does_not_exist' });
  ok('未知任务 → 404', nf.status === 404, String(nf.status));

  // 非 POST
  const getRes = await fetch(`${BASE}/novel2card/reveal`);
  ok('GET → 405', getRes.status === 405, String(getRes.status));

  // 路径穿越 / 数据根之外的任务必须被拒
  const outside = await Tasks.createJob({
    kind: 'generate', title: '越界测试', baseDir: path.join(tmpRoot, '..', 'n2c-outside'),
  });
  const forb = await post({ taskId: outside.taskId });
  const forbJson = await forb.json();
  ok('产物目录在数据根之外 → 403（防打开任意目录）', forb.status === 403,
    `${forb.status} ${JSON.stringify(forbJson).slice(0, 120)}`);
  ok('拒绝时说明原因', /不在插件数据目录内/.test(forbJson.error || ''), String(forbJson.error));

  // 非法 JSON
  const badJson = await fetch(`${BASE}/novel2card/reveal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json',
  });
  ok('非法 JSON → 400', badJson.status === 400, String(badJson.status));

  // 这个写接口同样受信任栅栏保护
  // （`rawGet` 是【7】块内的局部函数，这里内联一个，避免跨块依赖）
  const remoteStatus = await new Promise((resolve) => {
    const r = http.request({
      host: '127.0.0.1', port: SRV_PORT, path: '/novel2card/reveal', method: 'POST',
      headers: { Host: '192.168.1.50:3222', 'Content-Type': 'application/json', 'Content-Length': 2 },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve(0));
    r.write('{}');
    r.end();
  });
  ok('非本机请求 → 403（与其他写接口一致）', remoteStatus === 403, String(remoteStatus));
}

// ============================================================
// 收尾
await new Promise(r => server.close(r));
await new Promise(r => mockLLM.close(r));
await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});

console.log(`\n${'='.repeat(46)}`);
console.log(`  DSH 插件 HTTP 端到端：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
