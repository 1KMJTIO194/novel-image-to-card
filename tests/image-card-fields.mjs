/**
 * 图片卡改进测试：同一张图的重复合并 + 截图文字被真正用起来
 *
 * 背景（用户报告"全部都是根据图中描述，而且也没有把角色卡生成的有多完善"）：
 *
 * 问题一：同一张长截图的 6 段被登记成 6 个角色
 *   名字依次是「银发头像少女 uyu」「…（图1）」「…（图1）·」…（去重逻辑加的点）。
 *   这是我的切片功能引入的 bug：切片让同一个原图对应多个文件，
 *   而 prompt 当时写的是"每一张图片都要有一条"，于是模型每段各出一条。
 *
 * 问题二：截图里的文字完全没被利用
 *   邮文/聊天记录类截图里文字才是主要信息源，但 prompt 没要求转录，
 *   于是模型只能围着"头像直径只有 60 像素"打转；description 也成了
 *   "图片未提供；该角色在 6 张截图里没有以任何形式出现…"。
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

const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

// ============================================================
console.log('\n【1】normalizeProfileName：判"是不是同一个名字"');
{
  const n = IC.normalizeProfileName;
  ok('去掉「（图1）」', n('银发头像少女 uyu（图1）') === n('银发头像少女 uyu'), n('银发头像少女 uyu（图1）'));
  ok('去掉尾部去重用的点', n('银发头像少女 uyu（图1）···') === n('银发头像少女 uyu'), n('银发头像少女 uyu（图1）···'));
  ok('去掉空白差异', n('银发 少女') === n('银发少女'), n('银发 少女'));
  ok('大小写不敏感', n('UYU') === n('uyu'), n('UYU'));
  ok('中文括号也认', n('角色（图12）') === n('角色'), n('角色（图12）'));
  ok('不同名字不会被归一成同一个', n('银发少女') !== n('黑发少女'), '');
  ok('空输入不崩', n('') === '' && n(null) === '', '');
}

// ============================================================
console.log('\n【2】mergeSameImageProfiles：同图重复要合并，不同人不能并');
{
  const mk = (name, extra = {}) => ({
    name, imageIndex: 0, sliceIndexes: [0], transcript: '', namesFromText: [], aliases: [],
    gender: '女', ageRange: '少女', confidence: 'low', appearance: '', clothing: '',
    build: '', accessories: [], palette: [], scene: '', worldHints: [], personalityHints: [],
    inferredIdentity: '', inferredAbilities: '', inferredRelations: '', notes: '', ...extra,
  });

  /**
   * 实测那组：一张图的 6 段，模型给了 6 个只差后缀的名字。
   */
  const real = [
    mk('银发头像少女 uyu', { sliceIndexes: [0], appearance: '长发，浅银灰。', confidence: 'low' }),
    mk('银发头像少女 uyu（图1）', { appearance: '头发很长，银白色，两侧垂到肩前，肤色白皙。', confidence: 'medium' }),
    mk('银发头像少女 uyu（图1）·', { appearance: '长发银灰。' }),
    mk('银发头像少女 uyu（图1）··', { appearance: '银灰长发垂肩。' }),
    mk('银发头像少女 uyu（图1）···', { appearance: '浅银灰长发。' }),
    mk('银发头像少女 uyu（图1）····', { appearance: '长发，白偏银。' }),
  ];
  const merged = IC.mergeSameImageProfiles([real]);
  ok('6 条重复合成 1 条', merged.length === 1, String(merged.length));
  ok('保留信息量最大的外貌（取更长的那份）',
    merged[0].appearance.includes('两侧垂到肩前'), merged[0].appearance);
  ok('置信度取更高的（medium 胜 low）', merged[0].confidence === 'medium', merged[0].confidence);
  ok('sliceIndexes 并集去重排序', JSON.stringify(merged[0].sliceIndexes) === '[0]',
    JSON.stringify(merged[0].sliceIndexes));

  // 不同名字不能合并 —— 这可能是同一张图里的两个人
  const two = [
    mk('银发少女', { appearance: 'A' }),
    mk('黑发少女', { appearance: 'B' }),
  ];
  ok('同图不同名的两个人**不合并**', IC.mergeSameImageProfiles([two]).length === 2,
    String(IC.mergeSameImageProfiles([two]).length));

  // 不同图的同名角色也不该在这里合并（跨图合并是 mergeBatchProfiles 的职责）
  const crossImg = [
    mk('少女', { imageIndex: 0 }),
    mk('少女', { imageIndex: 1 }),
  ];
  const r2 = IC.mergeSameImageProfiles([[crossImg[0]], [crossImg[1]]]);
  ok('跨图同名不在这里合并（分组边界要守住）', r2.length === 2, String(r2.length));

  // sliceIndexes 并集
  const withSlices = [
    mk('甲', { sliceIndexes: [0, 1] }),
    mk('甲（图1）', { sliceIndexes: [2] }),
  ];
  ok('sliceIndexes 取并集', JSON.stringify(IC.mergeSameImageProfiles([withSlices])[0].sliceIndexes) === '[0,1,2]',
    JSON.stringify(IC.mergeSameImageProfiles([withSlices])[0].sliceIndexes));

  // 数组字段取并集
  const arrs = [
    mk('乙', { worldHints: ['校园'], accessories: ['眼镜'], namesFromText: ['uyu'] }),
    mk('乙（图1）', { worldHints: ['宿舍'], accessories: ['发夹'], namesFromText: ['@uyu1289742'] }),
  ];
  const m2 = IC.mergeSameImageProfiles([arrs])[0];
  ok('worldHints 取并集', JSON.stringify(m2.worldHints) === '["校园","宿舍"]', JSON.stringify(m2.worldHints));
  ok('accessories 取并集', m2.accessories.length === 2, JSON.stringify(m2.accessories));
  ok('namesFromText 取并集', m2.namesFromText.length === 2, JSON.stringify(m2.namesFromText));

  // 转录取更长的
  const tr = [
    mk('丙', { transcript: '短文字' }),
    mk('丙（图1）', { transcript: '这是一段更长的转录文字内容' }),
  ];
  ok('transcript 取更长的那份', IC.mergeSameImageProfiles([tr])[0].transcript.includes('更长'), '');

  // 边界
  ok('空输入返回空数组', IC.mergeSameImageProfiles([]).length === 0, '');
  ok('null 不崩', IC.mergeSameImageProfiles(null).length === 0, '');
  ok('空组不崩', IC.mergeSameImageProfiles([[], null, undefined]).length === 0, '');
  ok('无名字的条目原样保留不参与合并', IC.mergeSameImageProfiles([[mk('')]]).length === 1, '');
}

// ============================================================
console.log('\n【3】新字段：transcript / namesFromText / sliceIndexes 要被归一化');
{
  const raw = { characters: [{
    imageIndex: 0, name: '甲',
    transcript: '  帖文正文：今天发生了……  ',
    namesFromText: ['uyu', '@uyu1289742', ''],
    sliceIndexes: [0, 1, 'x', -2],
    appearance: 'x',
  }] };
  const p = IC.normalizeCharacterProfiles(raw, { imageCount: 1 })[0];
  ok('transcript 被读取并 trim', p.transcript === '帖文正文：今天发生了……', JSON.stringify(p.transcript));
  ok('namesFromText 读成数组并过滤空值',
    Array.isArray(p.namesFromText) && p.namesFromText.length === 2, JSON.stringify(p.namesFromText));
  ok('sliceIndexes 过滤掉非整数与负数',
    JSON.stringify(p.sliceIndexes) === '[0,1]', JSON.stringify(p.sliceIndexes));
  ok('缺字段时给安全默认值', (() => {
    const q = IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 0, name: '乙', appearance: 'y' }] }, {})[0];
    return q.transcript === '' && Array.isArray(q.namesFromText) && q.sliceIndexes.length === 0;
  })(), '');
}

// ============================================================
console.log('\n【4】截图文字要真的写进世界书（这是最可靠的信息）');
{
  const profiles = [
    { name: 'uyu', scene: '深色模式手机界面', transcript: '寝室里住着一个想扣你逼的女人', worldHints: ['校园'], palette: [], inferredIdentity: '', inferredRelations: '' },
    { name: '室友', scene: '深色模式手机界面', transcript: '我知道你听到我玩小玩具了，要不要和我一起', worldHints: [], palette: [], inferredIdentity: '', inferredRelations: '' },
  ];
  const items = IC.renderWorldbookFromProfiles(profiles, { title: '测试卡' });
  const tr = items.find(i => /图中文字/.test(i.name));

  ok('生成了「图中文字」条目', !!tr, JSON.stringify(items.map(i => i.name)));
  ok('条目里含转录原文', tr.content.includes('寝室里住着'), '');
  ok('两段文字都在', tr.content.includes('小玩具'), '');
  ok('说明了这是可靠信息而非推断', /转录自图片画面/.test(tr.content), '');
  ok('说明了涉及人名/关系应以它为准', /以此为准/.test(tr.content), '');
  ok('条目带触发词（能按 keys 命中）', Array.isArray(tr.keys) && tr.keys.length > 0, JSON.stringify(tr.keys));

  // 重复转录要去重（同一张长图的不同段常给出重叠文本）
  const dup = [
    { name: 'A', scene: '', transcript: '同一段文字内容不变', inferredIdentity: '', inferredRelations: '' },
    { name: 'B', scene: '', transcript: '同一段文字内容不变', inferredIdentity: '', inferredRelations: '' },
  ];
  const di = IC.renderWorldbookFromProfiles(dup, {});
  const dt = di.find(i => /图中文字/.test(i.name));
  const segCount = (dt.content.match(/【第 \d+ 段】/g) || []).length;
  ok('重复的转录被去重（只留一段）', segCount === 1, String(segCount));

  // 没有文字时不该产生空条目
  const none = IC.renderWorldbookFromProfiles(
    [{ name: 'A', scene: '某地', transcript: '', inferredIdentity: '', inferredRelations: '' }], {});
  ok('没有文字时不生成该条目', !none.some(i => /图中文字/.test(i.name)), JSON.stringify(none.map(i => i.name)));
  ok('「画面无文字」也不算有文字',
    !IC.renderWorldbookFromProfiles([{ name: 'A', scene: '', transcript: '画面无文字', inferredIdentity: '', inferredRelations: '' }], {})
      .some(i => /图中文字/.test(i.name)), '');
  ok('原来的 map_world 还在', none.some(i => i.category === 'map_world'), '');
}

// ============================================================
console.log('\n【5】卡字段要用上文字信息，不能只是"看不见什么"');
{
  // 用注入的档案跑装配段（纯函数，不需要视觉模型）
  const base = {
    name: 'uyu', imageIndex: 0, sliceIndexes: [0], transcript: '帖文：住同寝室、开学不久、有导员',
    namesFromText: ['uyu', '@uyu1289742'], aliases: [], gender: '女', ageRange: '少女',
    confidence: 'medium', appearance: '银灰长发，发丝垂到肩前，肤色白皙，眼型细长。',
    clothing: '深灰色上衣，领口包覆感强。', build: '肩线偏窄。', accessories: [], palette: ['黑', '银灰'],
    scene: '深色模式的手机社交平台界面', worldHints: ['校园'],
    personalityHints: ['内向', '容易紧张'],
    inferredIdentity: '住同一寝室的大学生（帖文自述）',
    inferredAbilities: '图片未提供',
    inferredRelations: '与同寝室女性关系复杂（帖文自述）',
    notes: '',
  };

  const out = await IC.buildCardFromExtraction({
    profiles: [base], title: '测试卡', wantStatusbar: false,
  });
  const d = out.card.data;

  console.log('    description:', JSON.stringify(d.description.slice(0, 120)));
  console.log('    scenario   :', JSON.stringify(d.scenario.slice(0, 120)));

  ok('description 里有人名', d.description.includes('uyu'), '');
  ok('description 写出了身份（来自文字）', /大学生|寝室/.test(d.description), d.description.slice(0, 150));
  ok('description 写出了关系', /关系/.test(d.description), '');
  ok('description 不再以"图片未提供"开头', !/^图片未提供/.test(d.description.trim()), d.description.slice(0, 60));
  ok('description 标出了文字里的称呼', /文字中的称呼/.test(d.description), '');
  ok('personality 带上了人名前缀', d.personality.includes('uyu'), d.personality);
  ok('scenario 用了关系/身份而不是只有画面描述',
    /人物关系|身份线索/.test(d.scenario), d.scenario.slice(0, 120));
  ok('first_mes 里有在场角色', d.first_mes.includes('uyu'), d.first_mes);
  ok('first_mes 不再把整段画面描述塞进去',
    !/深色模式的中文社交平台界面/.test(d.first_mes.split('\n')[0]), d.first_mes.split('\n')[0]);

  // 「图片未提供」不该被当成摘要内容
  const empty2 = { ...base, inferredIdentity: '图片未提供', inferredRelations: '图片未提供', appearance: '' };
  const out2 = await IC.buildCardFromExtraction({ profiles: [empty2], title: 'T', wantStatusbar: false });
  ok('信息全无时如实说明（不编造）',
    /没有提供可用的人物信息|待补充/.test(out2.card.data.description), out2.card.data.description.slice(0, 100));

  // 完全没有档案时不能崩
  const out3 = await IC.buildCardFromExtraction({ profiles: [], title: 'T', wantStatusbar: false });
  ok('零档案不崩', !!out3.card, '');
  ok('零档案时 description 为待补充', out3.card.data.description === '待补充', out3.card.data.description);
}

// ============================================================
console.log('\n【6】prompt 里必须有新的指令');
{
  const steps = await readFile(path.join(ROOT, 'src/steps.js'), 'utf-8');
  const m = /STEP_IMAGE_TO_CARD = `([\s\S]*?)`;/.exec(steps);
  const prompt = m ? m[1] : '';

  ok('要求"每一个真实人物一条"（不再是"每一张图一条"）',
    /每一个真实人物\*?\*?输出一条|每一个真实人物/.test(prompt), '');
  ok('明确说了"不是每张图一条"', /不是"每一张图一条"/.test(prompt) || /不是「每一张图一条」/.test(prompt)
    || /不是"每一张图一条"/.test(prompt), '');
  ok('要求转录截图文字', /转录/.test(prompt), '');
  ok('要求用文字里的人名做 name', /优先用作 name/.test(prompt), '');
  ok('要求同一个人只输出一条', /同一个人只输出一条/.test(prompt), '');
  ok('要求列出 sliceIndexes', /sliceIndexes/.test(prompt), '');
  ok('输出格式含 transcript', /"transcript"/.test(prompt), '');
  ok('输出格式含 namesFromText', /"namesFromText"/.test(prompt), '');
  ok('仍然要求区分看到与推断', /区分「看到的」与「推出来的」/.test(prompt), '');
  ok('仍然要求先答 sawImage', /must|必须首先回答 sawImage/.test(prompt), '');
  ok('仍然禁止编造', /不要为了填满字段而编造/.test(prompt), '');
  ok('说清了"文字是画面的一部分，不算编造"', /不算编造/.test(prompt), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片卡改进测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
