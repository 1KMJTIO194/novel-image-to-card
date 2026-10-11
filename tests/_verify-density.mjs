/**
 * 内容密度端到端核验：桩 LLM 按**新模板**返回 content_yaml，
 * 检查产物是否真的按 YAML 结构化、字数是否达标、字段是否齐全。
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MOCK_PORT = 3171;

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n} ${x ?? ''}`); } };

const story = Array.from({ length: 5 }, (_, i) =>
  `第${i + 1}章 标题\n` + `苏青梧在清微宗药园劳作，沈砚递来回春丹，周管事提起地下旧事。`.repeat(30)).join('\n\n');

// ---------- 按新模板构造返回 ----------
const pad = (s, n) => { let t = s; while (t.length < n) t += s; return t.slice(0, n); };

const CHAR_YAML = `name: 苏青梧
title: 清微宗外门弟子
age: 十六岁
height: 约五尺二寸
weight: 偏瘦
measurements: 未提及
appearance: |
  ${pad('身形偏瘦却挺拔，常年劳作使肩背线条利落。', 40)}
  ${pad('乌黑长发以一根木簪束起，额前碎发被汗贴在脸侧。', 40)}
  ${pad('肤色是常年日晒后的浅麦色，眼睛细长偏杏形，瞳色深褐。', 40)}
  左手虎口有一道旧疤，是幼年劈柴留下的，气质沉静疏离。
clothing: |
  ${pad('常服是洗得发白的粗布短打，袖口用麻绳束紧，方便在药田里弯腰。', 40)}
  冬日加一件靛蓝棉袄，领口已磨损；出席宗门集会时换月白直裰，束素色腰带。
background: |
  ${pad('出身青芜州乡野，父母早亡，由舅父抚养长大。', 40)}
  ${pad('元和七年冬入清微宗外门，被分到后山药园，管事姓周。', 40)}
  ${pad('与同屋阿棠相识，二人在药园相依为命。', 40)}
  ${pad('第二章试炼测层只得炼气三层，被同门轻视。', 40)}
  如今她一边在药园劳作，一边暗中追查药园地下的秘密。
personality: |
  核心性格：沉静、隐忍、记恩也记仇。
  ${pad('她习惯先观察再行动，从不把情绪写在脸上，说话简短，常用"嗯""再说"结束话题。', 40)}
  条件性格：一旦涉及亡故的亲人，她会立刻变得锋利，不计代价。
  隐藏面：表面顺从，内心始终把离开宗门当作唯一出路，对任何人都留三分怀疑。
preferences: |
  ${pad('喜欢雨后的药田气味，喜欢把药材按品类排整齐。', 40)}
  ${pad('厌恶被人盯着看，厌恶甜食。', 40)}
  习惯每日卯时起身，随身带一枚磨圆的旧铜钱，说话前会先抿一下嘴角。
erotic_abilities: |
  未提及
special_notes: |
  ${pad('炼气三层，主修药理，能辨认三百余种药材。', 40)}
  ${pad('与沈砚有旧识渊源，但双方都不挑明。', 40)}
  持有半块玉佩，疑与二十年前一位姓苏的将军有关。
私处细节描写: |
  未提及
言行举止: |
  ${pad('说话语速慢，常用"嗯""知道了"作答，称呼同门一律带姓氏。', 40)}
  紧张时会把手指在衣角上擦一下，思考时会盯着远处不动。
`;

const WORLD_YAML = `name: 云京
type: 世界
地理特征: |
  ${pad('云京地处九州腹地，四面环山，中央是冲积平原。', 40)}
  ${pad('气候四季分明，冬季干冷多雪，夏季闷热多雨。', 40)}
气候环境: |
  ${pad('冬季严寒可冻死牲畜，夏季湿热易生疫病，对粮食产量影响很大。', 40)}
人口与阶层: |
  ${pad('人口稠密，分内城外城。内城为官宦与修士，外城是商贩与流民。', 40)}
资源与产出: |
  ${pad('水源靠两条大河，矿产以铁矿与灵砂为主，粮食多来自南郊。', 40)}
文化与习俗: |
  ${pad('崇文尚礼，每年秋季有祭天节，律法对外城苛刻。', 40)}
重要地标: |
  ${pad('城南茶楼、城东旧宅群、缉影司衙门、城北观星台。', 40)}
控制势力: |
  ${pad('朝廷节制内外城，缉影司掌密案，三大宗门在城中各有别院。', 40)}
当前局势: |
  ${pad('十年前一场大火烧毁半条长街，官方称走水，民间另有说法。', 40)}
  苏青梧的兄长失踪与此事有关，林昭正在追查。
`;

const EVENT_YAML = `name: 开篇入城
时间: 天启三年春
参与者: 林昭、守卒
起因: |
  ${pad('林昭的兄长三年前在云京失踪，只留下一封语焉不详的信。', 40)}
  ${pad('她带半块玉佩独自上路，走了一个月才到城门下。', 20)}
经过: |
  ${pad('她在城门换班时进城，没有引起注意。', 40)}
  ${pad('城内喧嚣与记忆中不同，她先去城东找落脚处。', 40)}
  ${pad('夜里她反复摸玉佩，回想兄长信上的字迹。', 40)}
结果: |
  ${pad('成功在城东客栈住下，没有暴露来历。', 40)}
影响: |
  ${pad('她正式进入云京，后续所有线索都在此展开。', 40)}
原著立场: 核
前置: 无
干预可能: |
  若林昭直接去衙门报案 → 官府介入，线索提前暴露
  若林昭先去当铺打听玉佩 → 提前引出沈砚
`;

const ITEM_YAML = `name: 回春丹
类型: 丹药
等级/品质: 下品
外观: |
  ${pad('拇指大小的青白色丹丸，表面有细密纹路，闻起来有淡淡药香。', 40)}
原理: |
  ${pad('以百年回春草为主药，佐以三味温补药材，文火炼制七日。', 40)}
  ${pad('药性走经脉，不补修为只续生机。', 20)}
效果: |
  ${pad('服用后三日内伤势不再恶化，可续命。', 40)}
限制/代价: |
  ${pad('三日之内只能服一枚，多服则药性相冲。', 40)}
来源: |
  ${pad('清微宗药园自炼，外门弟子按季配给。', 40)}
持有者/掌握者: |
  ${pad('苏青梧手中有三枚，是周管事临行所赠，与主线离别相关。', 40)}
`;

const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => { b += c; });
  req.on('end', () => {
    let p = {}; try { p = JSON.parse(b || '{}'); } catch {}
    const sys = String(p.messages?.find(m => m.role === 'system')?.content || '');
    const usr = String(p.messages?.find(m => m.role === 'user')?.content || '');
    let content = JSON.stringify({ ok: true });
    const J = (o) => JSON.stringify(o);

    if (sys.includes('叙事结构')) content = J({ hasSingleProtagonist: true, protagonistName: '苏青梧' });
    else if (sys.includes('时间线抽取器')) content = J([{ scope: 'story', type: 'absolute', raw: '元和七年冬', quote: '元和七年冬', event: '药园立足' }]);
    else if (sys.includes('时间线锚点识别器')) content = J({ base: '元和纪年', origin: { raw: '元和七年冬', event: '药园立足', reason: 'r' } });
    else if (sys.includes('小说事件抽取器')) {
      content = J([{
        name: '开篇入城', storyline: '外门求生', chapter: '第一章', quote: 'q',
        canon: '苏青梧入药园。', pressure: 'core', prerequisites: { temporal: [], behavioral: '' },
        interventions: [],
      }]);
    } else if (sys.includes('阶段划分器')) content = J({ phases: [] });
    else if (sys.includes('人设变化抽取器')) content = J({ deltas: [] });
    else if (sys.includes('热门作品')) content = J({ wellKnown: false });
    else if (sys.includes('世界观抽取器')) {
      content = J([{ category: 'map_world', name: '云京', keys: ['云京'], content_yaml: WORLD_YAML }]);
    } else if (sys.includes('事件条目抽取器')) {
      content = J([{ name: '开篇入城', keys: ['开篇入城'], content_yaml: EVENT_YAML }]);
    } else if (sys.includes('物品条目抽取器')) {
      content = J([{ category: 'system_item', name: '回春丹', keys: ['回春丹'], content_yaml: ITEM_YAML }]);
    } else if (sys.includes('人物名单抽取器')) {
      content = J([{ name: '苏青梧', aliases: [], role: '主角' }]);
    } else if (sys.includes('人物档案抽取器')) {
      content = J({ name: '苏青梧', keys: ['苏青梧'], content_yaml: CHAR_YAML });
    } else if (sys.includes('角色卡的基础字段')) {
      content = J({
        description: '描述。', personality: '人设。', scenario: '场景。',
        first_mes: '开场白内容。', alternate_greetings: ['备选一', '备选二'],
        mes_example: '<START>\nx', tags: ['古风'],
      });
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(J({ choices: [{ message: { content } }] }));
  });
});

async function sse(form) {
  const res = await fetch('http://127.0.0.1:3000/api/generate', { method: 'POST', body: form });
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

await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const fd = new FormData();
fd.append('novel', new Blob([story], { type: 'text/plain' }), '密度测试.txt');
fd.append('baseUrl', `http://127.0.0.1:${MOCK_PORT}/v1`);
fd.append('apiKey', 'k'); fd.append('model', 'mock');
fd.append('userMode', 'auto'); fd.append('outputMode', 'card');
fd.append('options', JSON.stringify({ concurrency: 2, maxCharacters: 4 }));

const evs = await sse(fd);
const err = evs.find(e => e.event === 'error');
if (err) { console.log('生成失败：', JSON.stringify(err.data)); process.exit(1); }
const dir = evs.find(e => e.event === 'files').data.taskDir;

console.log('\n  相关日志：');
for (const e of evs.filter(x => x.event === 'progress')) {
  const m = e.data?.msg || '';
  if (/Step 5|WARN|Done/.test(m) && !/人物 \d+\//.test(m)) console.log(`    [${e.data.step}] ${m}`);
}

const card = JSON.parse(await readFile(path.join(dir, 'character_card.json'), 'utf-8'));
const entries = card.data.character_book.entries;
const meta = JSON.parse(await readFile(path.join(dir, 'meta.json'), 'utf-8'));

// 先打印所有 [event] 条目，便于诊断"哪来的怪条目"
console.log('\n--- 所有 [event] 条目 ---');
for (const e of entries.filter(x => String(x.comment).startsWith('[event]'))) {
  console.log(`  ${e.comment}  ${String(e.content).length} 字`);
  console.log('    前 200 字:', JSON.stringify(String(e.content).slice(0, 200)));
}

const char = entries.find(e => String(e.comment).startsWith('[character]'));
const world = entries.find(e => String(e.comment).includes('[map_world]'));
const ev = entries.find(e => String(e.comment).startsWith('[event]'));
const item = entries.find(e => /\[system_item\]/.test(String(e.comment)));

console.log('\n' + '='.repeat(66));
console.log('  内容密度核验');
console.log('='.repeat(66));

function checkEntry(label, entry, minChars, mustKeys) {
  console.log(`\n【${label}】${entry ? entry.comment : '（无）'}`);
  if (!entry) { ok(`${label} 条目存在`, false); return; }
  const text = String(entry.content);
  let parsed = null, yerr = null;
  try { parsed = YAML.parse(text); } catch (e) { yerr = e; }
  const chars = text.replace(/[\s|>#\-]/g, '').length;
  console.log(`  字数（去 YAML 标点）：${chars}`);
  console.log(`  可被 YAML 解析：${yerr ? '✗ ' + yerr.message : '✓'}`);
  if (parsed) {
    console.log(`  解析出的字段：${JSON.stringify(Object.keys(parsed))}`);
    for (const k of mustKeys) {
      const v = parsed[k];
      const filled = v !== undefined && String(v).trim() !== '' && String(v).trim() !== '未提及';
      console.log(`    ${filled ? '✓' : '○'} ${k}${filled ? '' : '（未提及/缺失）'}`);
    }
  }
  ok(`${label}：content 可 YAML 解析`, !yerr, yerr?.message);
  ok(`${label}：字数 ≥ ${minChars}`, chars >= minChars, `实际 ${chars}`);
  const missing = mustKeys.filter(k => parsed && !(k in parsed));
  ok(`${label}：模板字段齐全`, missing.length === 0, `缺 ${JSON.stringify(missing)}`);
  const realFields = mustKeys.filter(k => {
    const v = parsed?.[k];
    return v !== undefined && String(v).trim() && String(v).trim() !== '未提及';
  });
  ok(`${label}：至少 3 个字段有真实内容`, realFields.length >= 3, `只有 ${realFields.length} 个`);
}

checkEntry('角色条目', char, 600, [
  'name', 'title', 'age', 'height', 'weight', 'measurements', 'appearance', 'clothing',
  'background', 'personality', 'preferences', 'erotic_abilities', 'special_notes',
  '私处细节描写', '言行举止',
]);
checkEntry('地点条目', world, 300, [
  'name', 'type', '地理特征', '气候环境', '人口与阶层', '资源与产出',
  '文化与习俗', '重要地标', '控制势力', '当前局势',
]);
checkEntry('事件条目', ev, 300, [
  'name', '时间', '参与者', '起因', '经过', '结果', '影响', '原著立场', '前置', '干预可能',
]);
checkEntry('物品条目', item, 150, [
  'name', '类型', '等级/品质', '外观', '原理', '效果', '限制/代价', '来源', '持有者/掌握者',
]);

console.log('\n【预算】');
console.log('  meta.tokens:', JSON.stringify(meta.tokens));
const warnings = meta.warnings || [];
const tokenWarnings = warnings.filter(w => /token/.test(w));
console.log('  token 相关警告:', tokenWarnings.length ? JSON.stringify(tokenWarnings) : '无');
ok('没有"单条超限"警告', !tokenWarnings.some(w => /单条上限/.test(w)), JSON.stringify(tokenWarnings));

console.log('\n【ST 兼容性】');
ok('content 是字符串（YAML 只是文本）', entries.every(e => typeof e.content === 'string'));
ok('条目字段结构未变（id/keys/position 等齐全）',
  entries.every(e => ['id', 'comment', 'content', 'constant', 'enabled', 'insertion_order', 'keys', 'position'].every(k => k in e)));
ok('id 唯一连续', entries.every((e, i) => e.id === i));

await rm(dir, { recursive: true, force: true });
mock.close();
console.log(`\n${'='.repeat(66)}`);
console.log(`  内容密度核验：通过 ${pass} · 失败 ${fail}`);
console.log('='.repeat(66) + '\n');
process.exitCode = fail ? 1 : 0;
