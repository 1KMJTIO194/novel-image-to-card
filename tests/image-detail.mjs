/**
 * 主要角色外貌/服装精修 测试
 *
 * 用户反馈（原话）：
 *   「主要NPC的外貌服装注意力不足描写的不够详细有遗漏，
 *     我觉得可以在区分主要NPC和次要NPC之后重点观察描写NPC的外貌和服装」
 *
 * 所以这里钉住四件事：
 *   ① 只精修 主角 / 主要NPC，不同层面（次要/路人）不浪费请求
 *   ② 能给这个角色找到"他出现过"的图；找不到名字匹配时按页采样兜底
 *   ③ 精修结果**只在更详细时覆盖**；found:false 绝不清空原描述
 *   ④ 精修失败不影响主流程
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

const D = await import(pathToFileURL(path.join(ROOT, 'src/image_detail.js')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'src/steps.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);
const IMG = await import(pathToFileURL(path.join(ROOT, 'src/image_summary.js')).href);

const mkSummary = () => ({
  world: { overview: '', era: '', locations: [], factions: [], systems: [], history: [] },
  characters: [
    { name: '主角甲', importance: '主角', appearance: '黑发', clothing: '外套', identity: '学生' },
    { name: '主要乙', importance: '主要NPC', appearance: '棕发', clothing: '裙子' },
    { name: '次要丙', importance: '次要NPC', appearance: '路人样' },
    { name: '路人丁', importance: '路人NPC' },
  ],
  scenario: '教室',
  opening: '……',
});

const mkImages = (n = 10) => Array.from({ length: n }, (_, i) => ({ index: i, path: `/img/${i}.jpg` }));

/** 假 LLM：记录调用，返回"更详细"的外观 */
function makeMockLLM({ fail = false, found = true } = {}) {
  const calls = [];
  return {
    calls,
    async chatJSON(system, user, step, opts = {}) {
      calls.push({ system, user, step, images: opts.images || [] });
      if (fail) throw new Error('模拟失败');
      if (!found) return { found: false, reason: '图里没找到' };
      return {
        found: true,
        name: '认出的名字',
        appearance: '及腰的黑长直，齐刘海略遮眉，眼尾下垂、瞳色是偏灰的蓝；左眼下方有一颗小痣；'
          + '肤色偏冷白，身形纤细，锁骨明显。',
        clothing: '深灰色连帽外套，拉链拉到一半；内搭白色圆领T恤；下身黑色百褶短裙，'
          + '过膝黑色长袜与棕色乐福鞋；左手腕一只细银手链。',
        build: '身高约 160cm，肩窄，习惯微微含胸',
        accessories: ['银手链', '黑色发夹'],
        distinctive: '左眼下方的小痣',
        uncertain: '鞋子在多数画面只露出前半段',
      };
    },
  };
}

// ============================================================
console.log('\n【1】只精修主要角色（主角 / 主要NPC）');
{
  const s = mkSummary();
  const targets = D.pickDetailTargets(s);
  const names = targets.map(t => t.character.name);
  ok('选中主角与主要NPC', names.includes('主角甲') && names.includes('主要乙'), JSON.stringify(names));
  ok('不选次要NPC/路人', !names.includes('次要丙') && !names.includes('路人丁'), JSON.stringify(names));
  ok('主角排在前面', names[0] === '主角甲', JSON.stringify(names));
  ok('max 可限制个数', D.pickDetailTargets(s, { max: 1 }).length === 1, '');
  ok('max=0 时一个都不选', D.pickDetailTargets(s, { max: 0 }).length === 0, '');

  // 没有 importance 的老数据：按顺序取前 N
  const noImp = { characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] };
  const t2 = D.pickDetailTargets(noImp, { max: 2 });
  ok('缺 importance 时按顺序取前 N', t2.map(x => x.character.name).join(',') === 'A,B', JSON.stringify(t2.map(x => x.character.name)));

  ok('空 summary 不崩', D.pickDetailTargets(null).length === 0, '');
  ok('没有 characters 不崩', D.pickDetailTargets({}).length === 0, '');
}

// ============================================================
console.log('\n【2】找这个角色出现过的图');
{
  const profiles = [
    { name: '黑发少女', imageIndex: 0, namesFromText: ['主角甲'] },
    { name: '路人A', imageIndex: 1, namesFromText: [] },
    { name: '黑发少女（图3）', imageIndex: 2, namesFromText: [] },
  ];
  const idxs = D.pickImagesForCharacter({ name: '主角甲' }, profiles, 10);
  ok('按视觉档案的名字/文字称呼匹配到图', JSON.stringify(idxs) === '[0]', JSON.stringify(idxs));

  // 名字对不上 → 均匀采样
  const sampled = D.pickImagesForCharacter({ name: '完全不同的名字' }, profiles, 10, 4);
  ok('对不上名字时均匀采样（不是空）', sampled.length > 0 && sampled.length <= 4, JSON.stringify(sampled));
  ok('采样是有序的', sampled.every((v, i) => i === 0 || v > sampled[i - 1]), JSON.stringify(sampled));
  ok('采样覆盖首尾', sampled[0] === 0 && sampled[sampled.length - 1] === 9, JSON.stringify(sampled));

  // 图片少于上限时全给
  ok('图少时全给', D.pickImagesForCharacter({ name: 'X' }, profiles, 2, 6).length === 2, '');
  ok('没有图时返回空', D.pickImagesForCharacter({ name: 'X' }, [], 0).length === 0, '');
  ok('cap=1 只给一张', D.pickImagesForCharacter({ name: 'X' }, [], 10, 1).length === 1, '');
}

// ============================================================
console.log('\n【3】精修结果解析与清洗');
{
  const n = D.normalizeDetail({
    found: true, name: '甲', appearance: '图片中可见黑长直。', clothing: '深灰外套',
    accessories: ['银手链', ''], distinctive: '小痣', uncertain: '鞋子看不清',
  });
  ok('found 默认 true', n.found === true, '');
  ok('**指涉图片的措辞被清洗**', !/图片|画面/.test(n.appearance), n.appearance);
  ok('空配饰被过滤', n.accessories.length === 1, JSON.stringify(n.accessories));
  ok('uncertain 保留', n.uncertain === '鞋子看不清', n.uncertain);
  ok('found:false 能识别', D.normalizeDetail({ found: false, reason: '没找到' }).found === false, '');
  ok('null 不崩', D.normalizeDetail(null).found === true, '');
}

// ============================================================
console.log('\n【4】合并：只在更详细时覆盖，绝不写坏');
{
  const c = { name: '甲', appearance: '黑发', clothing: '外套', accessories: ['旧配饰'], notes: '' };
  const merged = D.mergeDetailIntoCharacter(c, {
    found: true,
    // 注意：这里故意**不**把 distinctive 写进 appearance，
    // 以验证"显著特征会被补进外貌"这条逻辑（两者相同就不该重复追加）
    appearance: '及腰黑长直，齐刘海略遮眉，眼尾下垂、瞳色偏灰蓝。',
    clothing: '深灰连帽外套，内搭白T，黑色百褶短裙，过膝袜与乐福鞋。',
    build: '约 160cm，肩窄',
    accessories: ['银手链'],
    distinctive: '左眼下方小痣',
    uncertain: '鞋子多数画面只见前半段',
  });
  ok('外貌被更详细的内容覆盖', merged.appearance.includes('及腰'), merged.appearance.slice(0, 40));
  ok('服装被更详细的内容覆盖', merged.clothing.includes('百褶'), merged.clothing.slice(0, 40));
  ok('配饰取并集', merged.accessories.length === 2, JSON.stringify(merged.accessories));
  ok('显著特征补进外貌', /显著特征：左眼下方小痣/.test(merged.appearance), merged.appearance.slice(-40));
  ok('看不清的部位记进 notes', /外观待补/.test(merged.notes), merged.notes);
  ok('标记已精修', merged.appearanceRefined === true, '');

  // 精修反而更短 → 不覆盖
  const c2 = { name: '乙', appearance: '一段很长很详细的外貌描写'.repeat(5), clothing: '很详细的服装'.repeat(10) };
  const m2 = D.mergeDetailIntoCharacter(c2, { found: true, appearance: '短', clothing: '短' });
  ok('原描述更长时**不**被覆盖', m2.appearance === c2.appearance && m2.clothing === c2.clothing, '');

  // found:false → 原样返回
  const c3 = { name: '丙', appearance: '原样' };
  ok('found:false 时原样返回', D.mergeDetailIntoCharacter(c3, { found: false }).appearance === '原样', '');

  // 不改原对象（避免调用方持有的引用被偷改）
  const c4 = { name: '丁', appearance: 'x' };
  const before = JSON.stringify(c4);
  D.mergeDetailIntoCharacter(c4, { found: true, appearance: 'yyy' });
  ok('不修改传入的原对象', JSON.stringify(c4) === before, '');
}

// ============================================================
console.log('\n【5】跑一轮：调用次数、写回、跳过');
{
  const llm = makeMockLLM();
  const summary = mkSummary();
  const r = await D.refineMainAppearance({
    llm, summary, images: mkImages(10),
    profiles: [{ name: '主角甲', imageIndex: 0 }],
    send: () => {},
  });
  ok('只对主要角色发起请求（2 个）', llm.calls.length === 2, String(llm.calls.length));
  ok('请求里带了图片', llm.calls.every(c => c.images.length > 0), JSON.stringify(llm.calls.map(c => c.images.length)));
  ok('用的是外观精修 prompt', llm.calls.every(c => /外观设定师/.test(c.system)), '');
  ok('写回了 summary.characters', summary.characters[0].appearance.includes('及腰'), summary.characters[0].appearance.slice(0, 30));
  ok('次要NPC 未被改动', !summary.characters[2].appearanceRefined, '');
  ok('返回精修名单', r.refined.length === 2, JSON.stringify(r.refined.map(x => x.name)));

  // 模型说没找到 → 跳过并保留原描述
  const llm2 = makeMockLLM({ found: false });
  const s2 = mkSummary();
  const r2 = await D.refineMainAppearance({ llm: llm2, summary: s2, images: mkImages(5), profiles: [], send: () => {} });
  ok('found:false 时计入 skipped', r2.skipped.length === 2, JSON.stringify(r2.skipped));
  ok('found:false 时保留原描述', s2.characters[0].appearance === '黑发', s2.characters[0].appearance);

  // 失败不抛出
  const llm3 = makeMockLLM({ fail: true });
  const s3 = mkSummary();
  let threw = null;
  try {
    const r3 = await D.refineMainAppearance({ llm: llm3, summary: s3, images: mkImages(5), profiles: [], send: () => {} });
    ok('失败时记进 skipped 且不抛', r3.skipped.length === 2, JSON.stringify(r3.skipped));
  } catch (e) { threw = e; }
  ok('失败不冒泡到调用方', !threw, threw ? threw.message : '');
  ok('失败时原描述仍在', s3.characters[0].appearance === '黑发', '');

  // 边界
  ok('没有 images 直接返回', (await D.refineMainAppearance({ llm: makeMockLLM(), summary: mkSummary(), images: [] })).refined.length === 0, '');
  ok('没有 summary 直接返回', (await D.refineMainAppearance({ llm: makeMockLLM(), summary: null, images: mkImages(3) })).refined.length === 0, '');
  ok('没有 llm 直接返回', (await D.refineMainAppearance({ summary: mkSummary(), images: mkImages(3) })).refined.length === 0, '');
}

// ============================================================
console.log('\n【6】prompt 要真的要求细节');
{
  const p = S.STEP_IMAGE_DETAIL;
  ok('存在外观精修 prompt', typeof p === 'string' && p.length > 400, String(p && p.length));
  for (const [label, re] of [
    ['发型', /发型/], ['五官/眼型', /眼型|瞳色/], ['肤色体态', /肤色/],
    ['上装', /上装/], ['下装', /下装/], ['鞋袜', /鞋袜/], ['配饰', /配饰/], ['配色', /配色/],
    ['特殊标记', /特殊标记|兽耳/],
  ]) ok(`要求写「${label}」`, re.test(p), '');
  ok('禁止指涉图片本身', /不要出现「图片」「画面」/.test(p), '');
  ok('看不清要写明而不是编造', /不要编造/.test(p), '');
  ok('提供 found:false 出口', /found.*false/.test(p), '');
  ok('输出结构含 appearance/clothing/accessories/distinctive',
    /"appearance"/.test(p) && /"clothing"/.test(p) && /"accessories"/.test(p) && /"distinctive"/.test(p), '');
}

// ============================================================
console.log('\n【7】分层用上 importance（决定谁被精修）');
{
  const merged = IC.mergeSummaryCharacters([
    { name: 'A', importance: '主角' },
    { name: 'B', importance: '主要NPC' },
    { name: 'C', importance: '次要NPC' },
    { name: 'D', importance: '路人NPC' },
    { name: 'E' },
  ], [], '');
  const tiers = Object.fromEntries(merged.map(c => [c.name, c.tier]));
  ok('importance 映射成 tier',
    tiers.A === '主角' && tiers.B === '主要NPC' && tiers.C === '次要NPC' && tiers.D === '路人NPC',
    JSON.stringify(tiers));
  ok('缺 importance 时退回主要NPC', tiers.E === '主要NPC', JSON.stringify(tiers));

  // 世界书里的出场：主要角色的条目应当带 tier 前缀
  const yamlOf = (c) => c.content_yaml;
  ok('人物 YAML 正常生成', merged.every(c => /name:/.test(yamlOf(c))), '');
}

// ============================================================
console.log('\n【8】接线：两个入口都要跑精修，且可关闭');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  const plug = await readFile(path.join(ROOT, 'dsh/lib/tasks.js'), 'utf-8');
  const page = await readFile(path.join(ROOT, 'public/js/pages/image-card.js'), 'utf-8');

  ok('Web 版 import 了 refineMainAppearance', /from '\.\/src\/image_detail\.js'/.test(srv), '');
  ok('Web 版在 summary 之后调用', srv.indexOf('refineMainAppearance({') > srv.indexOf('extractCardSummary({'), '');
  ok('Web 版可用 options 关闭', /refineMainAppearance !== false/.test(srv), '');
  ok('Web 版精修失败不中断主流程', /外观精修失败（保留原有描述）/.test(srv), '');

  ok('插件 importCore 了 image_detail.js', /importCore\('image_detail\.js'\)/.test(plug), '');
  ok('插件也调用精修', plug.indexOf('refineMainAppearance({') > plug.indexOf('extractCardSummary({'), '');
  ok('插件精修失败不中断', /外观精修失败（保留原有描述）/.test(plug), '');

  ok('页面有精修开关', /image-card-refine/.test(page) && /refineMainAppearance/.test(page), '');
  ok('开关默认打开', /name: 'refineMainAppearance', checked: true/.test(page), '');
  ok('开关值传给服务端', /refineMainAppearance: refineToggle\.checked/.test(page), '');
  ok('summary 模块的清洗被复用（精修结果也去图片化）',
    /stripImageFraming/.test(await readFile(path.join(ROOT, 'src/image_detail.js'), 'utf-8')), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  外观精修测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
