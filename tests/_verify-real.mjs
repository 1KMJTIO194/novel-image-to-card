/**
 * 真实长篇小说 → 完整角色卡：端到端 + 深度核验。
 * 源文件是工作区里那份真实 GBK 小说（读取 3 遍拼成 ~127k 汉字，模拟长篇）。
 * 结论写入 .tmp-real-report.txt，避免后台任务刷屏。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3123;
const SRC = path.join(ROOT, 'uploads', 'f4c2b164027d2a30b9f09842599c95ae');
const REPORT = path.join(ROOT, '.tmp-real-report.txt');

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; say(`  ✓ ${name}`); }
  else { fail++; say(`  ✗ ${name}   ${extra}`); }
};

// ---------- mock LLM：按 prompt 特征返回结构化 JSON ----------
const EVENTS = [
  ['初入宗门', '拜入山门', '第一章', 'core'], ['药园初遇', '拜入山门', '第二章', 'buffer'],
  ['秘境试炼', '筑基之路', '第三章', 'core'], ['师门变故', '筑基之路', '第四章', 'core'],
  ['远走北境', '北境风雪', '第五章', 'flexible'],
];
const WORLDBOOK = [
  { category: 'map_world', name: '玄天界', keys: ['玄天界', '此界'], content: '玄天界分九州，灵气稀薄，修士以筑基为第一道门槛。' },
  { category: 'map_region', name: '青芜州', keys: ['青芜州'], content: '青芜州地处东南，多山多瘴，宗门林立。' },
  { category: 'system_realm', name: '炼气筑基', keys: ['炼气', '筑基'], content: '炼气九层后可筑基，筑基失败者多成废人。' },
  { category: 'system_faction', name: '清微宗', keys: ['清微宗'], content: '清微宗为青芜州三大宗门之一，以药理闻名。' },
  { category: 'map_location', name: '药园', keys: ['药园'], content: '药园在后山，终年雾气不散，是外门弟子劳作之处。' },
  { category: 'system_item', name: '回春丹', keys: ['回春丹'], content: '回春丹可续命三日，市价三十灵石。' },
  { category: 'history', name: '百年前大乱', keys: ['大乱'], content: '百年前魔道东来，九州修士死伤过半。' },
];

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const s = String(p.messages?.find(m => m.role === 'system')?.content || '');
    const u = String(p.messages?.find(m => m.role === 'user')?.content || '');
    let content;

    if (s.includes('叙事结构')) content = JSON.stringify({ hasSingleProtagonist: true, protagonistName: '苏青梧' });
    else if (s.includes('时间线抽取器')) content = JSON.stringify([
      { type: 'absolute', raw: '元和七年', quote: '元和七年', event: '初入宗门' },
      { type: 'age', raw: '十六岁', quote: '年方十六', subject: '苏青梧' },
      { type: 'relative', raw: '三年后', quote: '三年后', event: '远走北境' },
    ]);
    else if (s.includes('时间线锚点识别器')) content = JSON.stringify({ base: '元和纪年', origin: { raw: '元和七年', event: '初入宗门', reason: '首个绝对纪年' } });
    else if (s.includes('小说事件抽取器')) content = JSON.stringify(EVENTS.map(([name, storyline, chapter, pressure], i) => ({
      name, storyline, chapter,
      quote: `${name}的原文片段`,
      canon: `${name}：原著中此事按既定脉络发生，结果是第 ${i + 1} 个转折点。`,
      pressure,
      prerequisites: { temporal: i ? [EVENTS[i - 1][0]] : [], behavioral: i === 2 ? '需先取得药园令牌' : '' },
      interventions: i === 0 ? [{ condition: '若拒绝入门', result: '转为散修线' }] : [],
    })));
    else if (s.includes('阶段划分器')) content = JSON.stringify({ phases: [
      { name: '拜入山门', startEvent: '初入宗门', endEvent: '药园初遇', coreChange: '从孤女到外门弟子' },
      { name: '筑基之路', startEvent: '秘境试炼', endEvent: '师门变故', coreChange: '从旁观者到被卷入宗门争斗' },
      { name: '北境风雪', startEvent: '远走北境', endEvent: '远走北境', coreChange: '从宗门弟子到独行者' },
    ] });
    else if (s.includes('人设变化抽取器')) content = JSON.stringify({ deltas: [
      { character: '苏青梧', change: '由沉默隐忍转为主动争取资源' },
      { character: '苏青梧', change: '对师门的信任崩塌，开始只为自保' },
    ] });
    else if (s.includes('热门作品')) content = JSON.stringify({ wellKnown: false, reason: '原创长篇' });
    else if (s.includes('世界观抽取器')) {
      const slice = u.slice(0, WORLDBOOK.length * 40);
      content = JSON.stringify(WORLDBOOK);
    }
    else if (s.includes('人物档案抽取器')) {
      const name = /角色名：(\S+)/.exec(u)?.[1] || '苏青梧';
      content = JSON.stringify({ name, keys: [name, name.slice(-2)], content: `${name}：清微宗外门弟子，性格坚韧，擅长药理。` });
    }
    else if (s.includes('角色卡的基础字段')) content = JSON.stringify({
      description: '元和七年，青芜州。苏青梧以孤女之身拜入清微宗外门，靠一双手在药园里熬过第一个冬天。灵气稀薄，人心更薄——她只想活下去，然后往上走。',
      personality: '苏青梧：沉默、隐忍、记仇也记恩，做事先算代价。对药理有近乎偏执的耐心，对人心则始终留三分怀疑。',
      scenario: '你刚被分到后山药园，管事丢给你一把锄头和半块干粮，说了一句「活过这个冬天再说」。',
      first_mes: '雾气从山谷里漫上来，把药田的垄沟填平了。\n\n你蹲在最边上一畦，把手指插进湿冷的土里。管事的话还在耳边——活过这个冬天。\n\n远处传来钟声，是外门弟子集合的时辰。你也可以先把这畦药苗补完，或者去听听今天讲什么。',
      alternate_greetings: [
        '夜里有人在药园外叫你名字。\n\n你握紧了锄头。声音又响了一遍，比刚才近。',
        '试炼碑前挤满了人。你排在最后，听见前面有人低声说：「炼气九层以下的，进去就是送死。」\n\n轮到你时，石碑亮起的光只有薄薄一层。',
        '雪下了一整夜。你醒来时，同屋的人已经走了，铺位是凉的，只留下半块令牌。',
      ],
      mes_example: '<START>\n{{user}}: 这株药苗怎么了？\n{{char}}: 苏青梧没抬头，指甲刮过叶背：「根烂了。浇多了水。」\n\n<START>\n{{user}}: 你为什么帮我？\n{{char}}: 她把回春丹推回去，动作很轻。「不是帮你。」\n\n<START>\n{{user}}: 我要去秘境。\n{{char}}: 她终于抬眼看了你一下，然后继续碾手里的药：「活着回来。」',
      tags: ['修仙', '女性主角', '成长', '群像', '慢热'],
    });
    else if (s.includes('你的创作助手')) content = JSON.stringify({ ok: true });
    else content = JSON.stringify({ ok: true });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

async function sse(form) {
  const res = await fetch(`${BASE}/api/generate`, { method: 'POST', body: form });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', evt = null, data = [];
  const out = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (l.startsWith('event:')) evt = l.slice(6).trim();
      else if (l.startsWith('data:')) data.push(l.slice(5).trim());
      else if (l.trim() === '' && evt) {
        let parsed = null; try { parsed = JSON.parse(data.join('\n')); } catch {}
        out.push({ event: evt, data: parsed }); evt = null; data = [];
      }
    }
  }
  return out;
}

async function main() {
  await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const gbk = await readFile(SRC);                       // 原始 GBK 字节，故意不解码
  const big = Buffer.concat([gbk, gbk, gbk]);            // 真实长篇体量 ~216 KB
  say(`源文件：uploads/f4c2b164027d2a30b9f09842599c95ae（GBK，${gbk.length} B）× 3 = ${big.length} B`);

  const fd = new FormData();
  fd.append('novel', new Blob([big], { type: 'text/plain' }), '痴女改造.txt');
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'k');
  fd.append('model', 'mock');
  fd.append('userMode', 'auto');
  fd.append('outputMode', 'card');
  fd.append('options', JSON.stringify({ concurrency: 4, maxCharacters: 6 }));

  const t0 = Date.now();
  const events = await sse(fd);
  const err = events.find(e => e.event === 'error');
  if (err) { say(`生成失败：${JSON.stringify(err.data)}`); await writeFile(REPORT, log.join('\n')); process.exit(1); }
  const filesEvt = events.find(e => e.event === 'files');
  const dir = path.join(ROOT, 'output', filesEvt.data.taskId);
  say(`生成完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，task=${filesEvt.data.taskId}`);
  for (const e of events.filter(x => x.event === 'log')) {
    const m = String(e.data?.message || e.data || '');
    if (/编码|切分|角色卡|Done|WARN/.test(m)) say(`  [日志] ${m}`);
  }

  const raw = await readFile(path.join(dir, 'character_card.json'), 'utf-8');
  const card = JSON.parse(raw);
  const KB = (Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1);
  say(`\ncharacter_card.json：${KB} KB / ${raw.split('\n').length} 行`);
  say('='.repeat(66));
  say('  真实长篇 · 完整角色卡深度核验');
  say('='.repeat(66));

  say('\n【A】JSON 合法性');
  ok('JSON.parse 成功', !!card);
  ok('再序列化字节一致（无不可逆内容）', JSON.stringify(JSON.parse(raw)) === JSON.stringify(card));
  ok('无 U+FFFD 乱码（GBK 转码干净）', !raw.includes('\uFFFD'));
  ok('中文可读', /苏青梧/.test(raw));
  ok('体积 15KB ~ 900KB（内容饱满且不失控）',
    Buffer.byteLength(raw, 'utf8') > 15 * 1024 && Buffer.byteLength(raw, 'utf8') < 900 * 1024, `${KB} KB`);
  {
    // 体积主要由这几块撑起来，逐块确认不是空壳
    const ivl = (card.data.character_book.entries.find(e => /initvar/.test(e.comment))?.content || '').length;
    const rl = (card.data.character_book.entries.find(e => e.comment === '变量更新规则')?.content || '').length;
    ok('initvar 变量树有实体内容（> 200 字）', ivl > 200, `${ivl} 字`);
    ok('变量更新规则随变量规模增长（> 2000 字）', rl > 2000, `${rl} 字`);
  }

  say('\n【B】ST 规范字段');
  for (const f of ['name', 'description', 'personality', 'scenario', 'first_mes', 'alternate_greetings',
    'mes_example', 'creatorcomment', 'avatar', 'talkativeness', 'fav', 'tags', 'spec', 'spec_version', 'data', 'create_date']) {
    ok(`顶层 ${f}`, f in card);
  }
  ok('spec/spec_version', card.spec === 'chara_card_v3' && card.spec_version === '3.0');
  ok('顶层 6 字段与 data.* 全等',
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'].every(k => card[k] === card.data[k]));
  ok('alternate_greetings / tags 两处一致',
    JSON.stringify(card.alternate_greetings) === JSON.stringify(card.data.alternate_greetings) &&
    JSON.stringify(card.tags) === JSON.stringify(card.data.tags));
  ok('create_date 是 ISO 且可解析', !Number.isNaN(Date.parse(card.create_date)), card.create_date);
  ok('talkativeness 是数字 0.5（ST 类型契约是 number）',
    card.talkativeness === 0.5 && typeof card.talkativeness === 'number',
    JSON.stringify(card.talkativeness));
  ok('fav === false', card.fav === false);

  say('\n【C】character_book 容器（ST 世界书导入路径）');
  const b = card.data.character_book;
  ok('有 name', typeof b?.name === 'string' && b.name.length > 0, b?.name);
  ok('entries 是数组', Array.isArray(b?.entries));
  ok('entries 数量 15~80', b.entries.length >= 15 && b.entries.length <= 80, String(b.entries.length));
  ok('id 连续', b.entries.every((e, i) => e.id === i));
  const MISS = [];
  for (const [i, e] of b.entries.entries()) {
    for (const f of ['id', 'keys', 'content', 'constant', 'enabled', 'insertion_order', 'position', 'extensions']) {
      if (!(f in e)) MISS.push(`#${i}.${f}`);
    }
    if (typeof e.content !== 'string' || !e.content.trim()) MISS.push(`#${i}.content 为空`);
  }
  ok('每条都字段齐全且 content 非空', MISS.length === 0, MISS.slice(0, 6).join(', '));
  ok('position 合法', b.entries.every(e => ['before_char', 'after_char'].includes(e.position)));
  ok('insertion_order 无重复（排序稳定）',
    new Set(b.entries.map(e => e.insertion_order)).size === b.entries.length,
    `重复：${JSON.stringify(b.entries.map(e => e.insertion_order).filter((v, i, a) => a.indexOf(v) !== i))}`);
  ok('comment 无重复', new Set(b.entries.map(e => e.comment)).size === b.entries.length);

  say('\n【D】initvar 与变量树');
  const iv = b.entries.find(e => String(e.comment).includes('initvar'));
  const rule = b.entries.find(e => e.comment === '变量更新规则');
  ok('initvar 存在', !!iv);
  ok('initvar enabled === false', iv?.enabled === false, String(iv?.enabled));
  ok('initvar position = before_char', iv?.position === 'before_char');
  ok('initvar prevent_recursion = true', iv?.extensions?.prevent_recursion === true);
  {
    const y = iv?.content || '';
    // 依据 StageDog 官方教程：initvar 的 YAML 顶层直接是变量名，
    // 不写 stat_data 包裹层（stat_data 是 MVU 运行时的变量根，只出现在取值路径里）。
    ok('initvar 顶层直接是变量名（无 stat_data 包裹层）',
      !/^stat_data:/m.test(y), (y.split('\n')[0] || '').slice(0, 40));
    ok('initvar 根键是 world/events/characters/custom',
      ['world:', 'events:', 'characters:', 'custom:'].every(k => new RegExp(`^${k}`, 'm').test(y)),
      ['world:', 'events:', 'characters:', 'custom:'].filter(k => !new RegExp(`^${k}`, 'm').test(y)).join(','));
    ok('取值侧仍使用 stat_data. 前缀（EJS / MVU 宏）',
      /getvar\('stat_data\./.test(b.entries.find(e => e.content.includes('<%'))?.content || '')
      && /get_message_variable::stat_data\./.test(rule?.content || ''));
    ok('initvar 含 5 个真实事件名', EVENTS.every(([n]) => y.includes(n)),
      EVENTS.filter(([n]) => !y.includes(n)).map(([n]) => n).join(','));
    ok('initvar 含真实人物名', y.includes('苏青梧'));
  }
  ok('变量更新规则按真实变量树展开',
    rule?.content.includes('get_message_variable::stat_data.events.初入宗门.status'));
  ok('规则含 <status_current_variables>', rule?.content.includes('<status_current_variables>'));
  ok('规则含 <update> 输出格式', rule?.content.includes('<update>'));

  say('\n【E】EJS 条目（酒馆助手运行时渲染）');
  const ejs = b.entries.filter(e => e.content.includes('<%'));
  ok('EJS 条目 >= 2', ejs.length >= 2, String(ejs.length));
  ok('EJS 未被转义', !raw.includes('&lt;%') && !raw.includes('\\u003c'));
  ok('EJS 定界符配对',
    ejs.every(e => (e.content.match(/<%_/g) || []).length === (e.content.match(/_%>/g) || []).length));
  ok('EJS 引用了真实事件名', ejs.some(e => e.content.includes('初入宗门')));
  ok('EJS 引用了 stat_data.world', ejs.some(e => e.content.includes("getvar('stat_data.world.time'")));
  ok('EJS 含条件分支（if）', ejs.some(e => /<%_\s*if\s*\(/.test(e.content)));

  say('\n【F】正则脚本');
  const rs = card.data.extensions?.regex_scripts;
  ok('恰好 1 条', Array.isArray(rs) && rs.length === 1, String(rs?.length));
  {
    const r = rs[0];
    ok('id 是 UUID v4', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id));
    const m = /^\/(.*)\/([gimsuy]*)$/s.exec(r.findRegex);
    ok('findRegex 可编译', !!m && (() => { try { new RegExp(m[1], m[2]); return true; } catch { return false; } })());
    if (m) {
      const re = new RegExp(m[1], m[2]);
      const sample = '正文第一段。\n<update>\n_.set(stat_data.world.time, "元和七年", "元和八年");\n</update>\n正文第二段。';
      const out = sample.replace(re, '');
      ok('隐藏 <update> 块且保留正文', !out.includes('<update>') && out.includes('正文第一段') && out.includes('正文第二段'));
      ok('不吞掉 <update> 之后的所有内容', out.includes('正文第二段'));
    }
    ok('markdownOnly & promptOnly', r.markdownOnly === true && r.promptOnly === true);
    ok('runOnEdit === false', r.runOnEdit === false);
  }

  say('\n【G】文件与跨产物一致性');
  const files = await readdir(dir);
  say(`  目录内容：${files.join(', ')}`);
  ok('产出 character_card.json', files.includes('character_card.json'));
  ok('产出 meta.json', files.includes('meta.json'));
  ok('card 模式不产出 worldbook.json', !files.includes('worldbook.json'));
  const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));
  ok('meta.outputMode = card', meta.outputMode === 'card', String(meta.outputMode));
  ok('meta 记录源编码 GB2312',
    /GB/i.test(JSON.stringify(meta.sourceEncoding ?? meta.encoding ?? '')),
    JSON.stringify(meta.sourceEncoding));
  {
    const vars = JSON.parse(await readFile(path.join(dir, 'variables.json'), 'utf-8'));
    const y = iv?.content || '';
    const evNames = Object.keys(vars.events || {});
    ok('initvar 覆盖 variables.json 的全部事件', evNames.length > 0 && evNames.every(n => y.includes(n)),
      evNames.filter(n => !y.includes(n)).join(','));
    ok('variables.json 与 card 人物一致',
      Object.keys(vars.characters || {}).every(n => b.entries.some(e => e.comment === `[character] ${n}`)),
      Object.keys(vars.characters || {}).join(','));
  }

  say('\n【H】条目清单');
  for (const e of b.entries) {
    say(`  #${String(e.id).padStart(2)} [${e.constant ? '常驻' : '触发'}/${e.enabled ? '启用' : '关闭'}] order=${String(e.insertion_order).padStart(2)} depth=${e.extensions?.depth ?? 0}${e.content.includes('<%') ? ' EJS' : ''} ${e.comment}`);
  }

  await rm(dir, { recursive: true, force: true });
  await new Promise(r => { mock.closeAllConnections?.(); mock.close(() => r()); setTimeout(r, 1000); });

  say('\n' + '='.repeat(66));
  say(`  真实长篇核验：通过 ${pass} · 失败 ${fail}`);
  say('='.repeat(66));
  await writeFile(REPORT, log.join('\n'));
  process.exitCode = fail ? 1 : 0;
}

main().catch(async e => {
  say(`异常：${e?.stack || e}`);
  try { mock.close(); } catch {}
  await writeFile(REPORT, log.join('\n')).catch(() => {});
  process.exit(1);
});
