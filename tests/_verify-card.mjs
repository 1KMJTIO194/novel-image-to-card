/**
 * 完整角色卡核验：实际生成一份，然后逐项检查是否"真的是完整可用的 JSON 角色卡"。
 * 这是人工核验脚本，不进 npm test。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const MOCK_PORT = 3122;
const OUT_SAMPLE = path.join(ROOT, '.tmp-card-sample.json');

const NOVEL = [
  '第一章 入城', '天启三年春，林昭年方十七，独自来到云京寻找失踪的兄长。'.repeat(16),
  '第二章 茶楼', '林昭在茶楼遇见沈砚，沈砚递来一盏茶，说他知道玉佩的来历。'.repeat(16),
  '第三章 旧宅', '林昭夜探旧宅，在床板夹层里发现一封没有署名的密信。'.repeat(16),
].join('\n\n');

const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let p = {};
    try { p = JSON.parse(body || '{}'); } catch {}
    const s = String(p.messages?.find(m => m.role === 'system')?.content || '');
    let content;
    if (s.includes('叙事结构')) content = JSON.stringify({ hasSingleProtagonist: true, protagonistName: '林昭' });
    else if (s.includes('时间线抽取器')) content = JSON.stringify([
      { type: 'absolute', raw: '天启三年春', quote: '天启三年春', event: '开篇入城' },
      { type: 'age', raw: '十七岁', quote: '年方十七', subject: '林昭' },
      { type: 'age', raw: '二十岁', quote: '年方二十', subject: '沈砚' },
    ]);
    else if (s.includes('时间线锚点识别器')) content = JSON.stringify({ base: '天启纪年', origin: { raw: '天启三年春', event: '开篇入城', reason: '最早绝对纪年' } });
    else if (s.includes('小说事件抽取器')) content = JSON.stringify([
      { name: '开篇入城', storyline: '入城立足', chapter: '第一章', quote: '林昭踏进城门', canon: '林昭进入云京寻找兄长。', pressure: 'core', prerequisites: { temporal: [], behavioral: '' }, interventions: [{ condition: '若直接报案', result: '线索提前暴露' }] },
      { name: '初见沈砚', storyline: '入城立足', chapter: '第二章', quote: '沈砚递来一盏茶', canon: '林昭与沈砚相识。', pressure: 'buffer', prerequisites: { temporal: ['开篇入城'], behavioral: '' }, interventions: [] },
      { name: '夜探旧宅', storyline: '旧案真相', chapter: '第三章', quote: '床板夹层', canon: '林昭发现密信。', pressure: 'core', prerequisites: { temporal: ['初见沈砚'], behavioral: '' }, interventions: [] },
    ]);
    else if (s.includes('阶段划分器')) content = JSON.stringify({ phases: [
      { name: '入城立足', startEvent: '开篇入城', endEvent: '初见沈砚', coreChange: '从孤身寻亲到获得助力' },
      { name: '旧案浮现', startEvent: '夜探旧宅', endEvent: '夜探旧宅', coreChange: '从被动等待到主动追查' },
    ] });
    else if (s.includes('人设变化抽取器')) content = JSON.stringify({ deltas: [{ character: '林昭', change: '从谨慎观望变为主动出击' }] });
    else if (s.includes('热门作品')) content = JSON.stringify({ wellKnown: false, reason: '原创短篇' });
    else if (s.includes('世界观抽取器')) content = JSON.stringify([
      { category: 'map_world', name: '云京', keys: ['云京', '京城'], content: '云京为王朝都城，分内外两城。', dynamicHint: '' },
      { category: 'system_realm', name: '淬体九境', keys: ['淬体', '境界'], content: '武者共分九境。', dynamicHint: '' },
      { category: 'system_faction', name: '缉影司', keys: ['缉影司'], content: '缉影司掌查办密案。', dynamicHint: '' },
      { category: 'map_location', name: '城南茶楼', keys: ['茶楼'], content: '城南茶楼是消息集散地。', dynamicHint: '' },
    ]);
    else if (s.includes('人物档案抽取器')) {
      const name = /角色名：(\S+)/.exec(String(p.messages?.find(m => m.role === 'user')?.content || ''))?.[1] || '林昭';
      content = JSON.stringify({ name, keys: [name], content: `${name}，云京人物，性格沉静。` });
    }
    else if (s.includes('角色卡的基础字段')) content = JSON.stringify({
      description: '天启三年，云京。林昭为寻失踪的兄长独自入京，却在茶楼遇见了自称旧识的沈砚。这座城里，每个人都在隐瞒什么。',
      personality: '林昭：沉静、果决、警觉，习惯先观察再行动。沈砚：温和有礼，但每句话都留有退路。',
      scenario: '你站在云京城门下，袖中揣着半块玉佩，那是兄长留下的唯一信物。',
      first_mes: '城门在身后合拢。\n\n你抬起头，看见满城灯火——从这一刻起，你只能靠自己了。\n\n街角有个卖汤饼的摊子还亮着灯。你可以过去问问路，也可以先找个地方落脚。',
      alternate_greetings: [
        '茶楼里人声嘈杂。你在角落坐下，对面忽然有人推来一盏茶。\n\n「你在找一块玉佩的主人，对吗？」\n\n你抬起头。',
        '夜里的旧宅门虚掩着。你伸手推开它，灰尘在月光里浮起来。\n\n屋里没有人，但床板似乎被人动过。',
      ],
      mes_example: '<START>\n{{user}}: 你认识这块玉佩？\n{{char}}: 沈砚的手指在杯沿上顿了一下，随即笑了。「见过。」\n\n<START>\n{{user}}: 我兄长在哪？\n{{char}}: 他没有回答，只是把茶又往前推了推。',
      tags: ['古风', '悬疑', '女性主角', '权谋'],
    });
    else content = JSON.stringify({ ok: true });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

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

  const fd = new FormData();
  fd.append('novel', new Blob([Buffer.from(NOVEL, 'utf-8')], { type: 'text/plain' }), '核验用小说.txt');
  fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
  fd.append('apiKey', 'k');
  fd.append('model', 'mock');
  fd.append('userMode', 'auto');
  fd.append('outputMode', 'card');
  fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 3 }));

  const events = await sse(fd);
  const err = events.find(e => e.event === 'error');
  if (err) { console.error('生成失败：', err.data); process.exit(1); }
  const filesEvt = events.find(e => e.event === 'files');
  const dir = path.join(ROOT, 'output', filesEvt.data.taskId);

  const raw = await readFile(path.join(dir, 'character_card.json'), 'utf-8');
  await writeFile(OUT_SAMPLE, raw);          // 留一份样本供人工查看
  const card = JSON.parse(raw);

  console.log(`\n${'='.repeat(64)}`);
  console.log('  完整 JSON 角色卡 · 实际生成核验');
  console.log(`${'='.repeat(64)}\n`);
  console.log(`文件：output/${filesEvt.data.taskId}/character_card.json`);
  console.log(`体积：${(Buffer.byteLength(raw, 'utf8') / 1024).toFixed(1)} KB，${raw.split('\n').length} 行\n`);

  // ============================================================
  console.log('【1】JSON 本身是否有效');
  ok('可被 JSON.parse', !!card);
  ok('无 BOM', !raw.startsWith('\uFEFF'));
  ok('UTF-8 编码正确（中文可读）', /林昭/.test(raw) && !raw.includes('\uFFFD'));
  ok('缩进为 2 空格（可读）', raw.includes('\n  "name"'));
  const roundTrip = JSON.parse(JSON.stringify(card));
  ok('序列化往返无丢失', JSON.stringify(roundTrip) === JSON.stringify(card));

  // ============================================================
  console.log('\n【2】chara_card_v3 规范字段');
  const V3_REQUIRED = [
    'name', 'description', 'personality', 'scenario', 'first_mes',
    'alternate_greetings', 'mes_example', 'creatorcomment', 'avatar',
    'talkativeness', 'fav', 'tags', 'spec', 'spec_version', 'data', 'create_date',
  ];
  for (const f of V3_REQUIRED) ok(`顶层有 ${f}`, f in card, `缺少 ${f}`);
  ok('spec = chara_card_v3', card.spec === 'chara_card_v3', card.spec);
  ok('spec_version = 3.0', card.spec_version === '3.0', card.spec_version);

  const V3_DATA_REQUIRED = [
    'name', 'description', 'personality', 'scenario', 'first_mes',
    'alternate_greetings', 'mes_example', 'creator_notes', 'system_prompt',
    'post_history_instructions', 'tags', 'creator', 'character_version',
    'extensions', 'character_book',
  ];
  for (const f of V3_DATA_REQUIRED) ok(`data 有 ${f}`, f in (card.data || {}), `缺少 data.${f}`);

  ok('顶层与 data.* 的 8 个共享字段完全一致',
    ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']
      .every(k => card[k] === card.data[k])
    && JSON.stringify(card.alternate_greetings) === JSON.stringify(card.data.alternate_greetings)
    && JSON.stringify(card.tags) === JSON.stringify(card.data.tags),
    '存在不一致字段');

  // ============================================================
  console.log('\n【3】字段内容是否非空且合理');
  for (const [f, min] of [['description', 30], ['personality', 20], ['scenario', 20], ['first_mes', 60]]) {
    const v = card[f];
    ok(`${f} 长度 >= ${min}`, typeof v === 'string' && v.length >= min, `${v?.length} 字`);
  }
  ok('alternate_greetings 是数组且 >= 2', Array.isArray(card.alternate_greetings) && card.alternate_greetings.length >= 2,
    String(card.alternate_greetings?.length));
  ok('每个备选开场都是非空字符串',
    card.alternate_greetings.every(g => typeof g === 'string' && g.trim().length > 20));
  ok('mes_example 含 <START> 分隔', card.mes_example.includes('<START>'), card.mes_example.slice(0, 40));
  ok('tags 是 3-8 个字符串', Array.isArray(card.tags) && card.tags.length >= 3 && card.tags.length <= 8,
    JSON.stringify(card.tags));
  ok('first_mes 不含状态栏 HTML（<div/table）', !/<(div|table|span)\b/i.test(card.first_mes),
    (card.first_mes.match(/<[a-z]+/i) || [])[0] || '');
  ok('first_mes 停在等用户行动的位置（以选择/疑问收尾，而非结局）',
    /[？?。]\s*$/.test(card.first_mes.trim()), JSON.stringify(card.first_mes.slice(-30)));

  // ============================================================
  console.log('\n【4】extensions');
  const ext = card.data.extensions || {};
  ok('extensions.talkativeness 为数字 0.5',
    ext.talkativeness === 0.5 && typeof ext.talkativeness === 'number',
    JSON.stringify(ext.talkativeness));
  ok('extensions.fav 为 false', ext.fav === false);
  ok('extensions.world 指向世界书名', ext.world === card.data.character_book.name,
    `${ext.world} vs ${card.data.character_book.name}`);
  ok('depth_prompt 结构正确',
    ext.depth_prompt?.depth === 4 && ext.depth_prompt?.role === 'system' && 'prompt' in ext.depth_prompt);
  ok('regex_scripts 是数组且 >= 1', Array.isArray(ext.regex_scripts) && ext.regex_scripts.length >= 1,
    String(ext.regex_scripts?.length));
  ok('tavern_helper 有 scripts 与 variables',
    Array.isArray(ext.tavern_helper?.scripts) && typeof ext.tavern_helper?.variables === 'object');

  // ============================================================
  console.log('\n【5】正则脚本可用性');
  {
    const r = ext.regex_scripts[0];
    for (const f of ['id', 'scriptName', 'findRegex', 'replaceString', 'trimStrings', 'placement',
      'substituteRegex', 'minDepth', 'maxDepth', 'markdownOnly', 'promptOnly', 'disabled', 'runOnEdit']) {
      ok(`正则有字段 ${f}`, f in r, `缺少 ${f}`);
    }
    ok('id 是合法 UUID v4',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(r.id), r.id);

    // findRegex 是 /pattern/flags 形式，验证真的能被 ST 用起来
    const m = /^\/(.*)\/([gimsuy]*)$/s.exec(r.findRegex);
    ok('findRegex 形如 /pattern/flags', !!m, r.findRegex);
    if (m) {
      let re = null;
      try { re = new RegExp(m[1], m[2]); } catch (e) { /* 下面断言 */ }
      ok('findRegex 可被 RegExp 编译', !!re, '正则语法错误');
      if (re) {
        // 模拟 ST：把回复里的 <update> 片段隐藏掉
        const sample = '正文内容。\n<update>\n_.set(stat_data.world.time, "a", "b");\n</update>\n';
        const replaced = sample.replace(re, '');
        ok('能匹配并移除 <update> 块', !replaced.includes('<update>') && replaced.includes('正文内容'),
          JSON.stringify(replaced.slice(0, 60)));
        ok('不误伤正文', replaced.includes('正文内容'));
      }
    }
    ok('replaceString 为空（只隐藏不替换）', r.replaceString === '');
    ok('markdownOnly + promptOnly 双开（显示与提示词都隐藏）',
      r.markdownOnly === true && r.promptOnly === true);
    ok('placement 覆盖 [1,2]', JSON.stringify(r.placement) === '[1,2]');
  }

  // ============================================================
  console.log('\n【6】character_book 条目完整性与一致性');
  const entries = card.data.character_book.entries;
  ok('entries 是数组且数量 >= 10', Array.isArray(entries) && entries.length >= 10, String(entries.length));
  ok('id 连续从 0 开始', entries.every((e, i) => e.id === i));
  ok('没有重复 comment（人物/事件同名）',
    new Set(entries.map(e => e.comment)).size === entries.length,
    JSON.stringify(entries.map(e => e.comment).filter((c, i, a) => a.indexOf(c) !== i)));

  const INITVAR = entries.find(e => e.comment?.includes('initvar'));
  ok('initvar 条目存在', !!INITVAR);
  ok('initvar enabled === false（关键）', INITVAR?.enabled === false, String(INITVAR?.enabled));
  ok('initvar position = before_char', INITVAR?.position === 'before_char', INITVAR?.position);
  ok('initvar prevent_recursion = true', INITVAR?.extensions?.prevent_recursion === true);

  const EJS_ENTRIES = entries.filter(e => e.content?.includes('<%'));
  ok('有含 EJS 的条目', EJS_ENTRIES.length >= 2, String(EJS_ENTRIES.length));
  ok('EJS 未被 HTML 转义', !raw.includes('&lt;%') && !raw.includes('\\u003c'));
  ok('EJS 标签配对（<%_ 与 _%> 数量一致）',
    EJS_ENTRIES.every(e => {
      const a = (e.content.match(/<%_/g) || []).length;
      const b = (e.content.match(/_%>/g) || []).length;
      return a === b;
    }), JSON.stringify(EJS_ENTRIES.map(e => ({
      c: e.comment,
      open: (e.content.match(/<%_/g) || []).length,
      close: (e.content.match(/_%>/g) || []).length,
    }))));
  ok('EJS 同时用到了 getvar 与输出标签',
    EJS_ENTRIES.some(e => e.content.includes('getvar(')) &&
    EJS_ENTRIES.some(e => e.content.includes('<%=')));

  // 条目字段完整性
  const ENTRY_FIELDS = ['id', 'comment', 'content', 'constant', 'enabled', 'insertion_order',
    'keys', 'secondary_keys', 'selective', 'use_regex', 'position', 'extensions'];
  const missingFields = [];
  entries.forEach((e, i) => {
    for (const f of ENTRY_FIELDS) if (!(f in e)) missingFields.push(`#${i}.${f}`);
  });
  ok('每个条目字段齐全', missingFields.length === 0, missingFields.slice(0, 5).join(','));
  ok('每个 entry 都有 position', entries.every(e => ['after_char', 'before_char'].includes(e.position)),
    JSON.stringify([...new Set(entries.map(e => e.position))]));
  ok('key 触发条目都有非空 keys',
    entries.filter(e => !e.constant).every(e => Array.isArray(e.keys) && e.keys.length > 0),
    JSON.stringify(entries.filter(e => !e.constant && !e.keys?.length).map(e => e.comment)));
  ok('常驻条目 keys 为空数组', entries.filter(e => e.constant).every(e => Array.isArray(e.keys)),
    '');

  // 变量更新规则要按实际变量树展开
  const RULE = entries.find(e => e.comment === '变量更新规则');
  ok('变量更新规则存在', !!RULE);
  ok('含 <status_current_variables>', RULE?.content.includes('<status_current_variables>'));
  ok('引用了 world.time', RULE?.content.includes('get_message_variable::stat_data.world.time'));
  ok('引用了真实事件名（夜探旧宅）', RULE?.content.includes('夜探旧宅'), '');
  ok('引用了真实人物名（沈砚）', RULE?.content.includes('沈砚'), '');
  ok('引用了故事线', RULE?.content.includes('custom.storylines'));

  // 角色阶段要含阶段名与增量
  const PHASE = entries.find(e => e.comment === '角色阶段');
  ok('角色阶段含阶段名表', PHASE?.content.includes('旧案浮现'), '');
  ok('角色阶段含人设增量内容', PHASE?.content.includes('主动出击'), '');

  // 世界书条目要与 A 包一致（同一批数据）
  if (process.env.SKIP_CROSSCHECK !== '1') {
    const wb = JSON.parse(await readFile(path.join(dir, 'worldbook.json'), 'utf-8').catch(() => 'null'));
    if (wb) {
      const wbChars = wb.entries.filter(e => e.comment?.startsWith('[character]')).map(e => e.comment).sort();
      const cbChars = entries.filter(e => e.comment?.startsWith('[character]')).map(e => e.comment).sort();
      ok('角色卡与 A 包的人物条目一致', JSON.stringify(wbChars) === JSON.stringify(cbChars),
        `${JSON.stringify(cbChars)} vs ${JSON.stringify(wbChars)}`);
      const wbEvents = wb.entries.filter(e => e.comment?.startsWith('[event]')).map(e => e.comment).sort();
      const cbEvents = entries.filter(e => e.comment?.startsWith('[event]')).map(e => e.comment).sort();
      ok('角色卡与 A 包的事件条目一致', JSON.stringify(wbEvents) === JSON.stringify(cbEvents));
    }
  }

  // ============================================================
  console.log('\n【7】文件清单（card 模式）');
  const files = await readdir(dir);
  ok('产出 character_card.json', files.includes('character_card.json'));
  ok('card 模式不产出 worldbook.json', !files.includes('worldbook.json'), files.join(','));
  ok('card 模式不产出 preset_fragment.json', !files.includes('preset_fragment.json'));

  // ============================================================
  console.log('\n【8】结构样例（脱敏后打印）');
  console.log(`  顶层键：${Object.keys(card).join(', ')}`);
  console.log(`  data 键：${Object.keys(card.data).join(', ')}`);
  console.log(`  extensions 键：${Object.keys(ext).join(', ')}`);
  console.log(`  character_book：${entries.length} 条`);
  console.log('\n  条目列表：');
  for (const e of entries) {
    const flag = e.constant ? '常驻' : '触发';
    const en = e.enabled ? '启用' : '关闭';
    const ejs = e.content.includes('<%') ? ' EJS' : '';
    console.log(`    #${String(e.id).padStart(2)} [${flag}/${en}] order=${String(e.insertion_order).padStart(2)} depth=${e.extensions?.depth ?? 0}${ejs}  ${e.comment}`);
  }
  console.log(`\n  first_mes（${card.first_mes.length} 字）：`);
  console.log('    ' + card.first_mes.slice(0, 150).replace(/\n/g, '\n    '));

  await rm(dir, { recursive: true, force: true });
  await new Promise(resolve => {
    mock.closeAllConnections?.(); mock.close(() => resolve()); setTimeout(resolve, 1000);
  });

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  核验结果：通过 ${pass} · 失败 ${fail}`);
  console.log(`  样本已留存：.tmp-card-sample.json（供人工查看，可删）`);
  console.log(`${'='.repeat(64)}\n`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); try { mock.close(); } catch {} process.exit(1); });
