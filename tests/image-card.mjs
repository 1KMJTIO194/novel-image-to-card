/**
 * 图片 → 角色卡 测试
 *
 * 两条路径分别测：
 *   · 视觉抽取（需要真视觉模型）→ 只测可离线验证的部分：
 *     JSON 容错归一化、图片校验、错误信息可读性
 *   · 装配段（纯计算）→ **完整测**，用注入的抽取结果跑出真卡并校验结构
 *
 * 这样即使当前端点不支持视觉，装配段的正确性也是被钉死的。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const M = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);
function pathToFileURL(p) { return new URL('file://' + p.replace(/\\/g, '/')); }

// ============================================================
console.log('\n【1】图片校验：错误信息必须指到具体哪一张');
{
  const bad = M.validateImages(['a.txt', 'b.png', 'c.bmp']);
  ok('不支持的格式被拦下', !bad.ok);
  ok('错误信息点名具体图片',
    bad.errors.some(e => e.includes('图片1')) && bad.errors.some(e => e.includes('图片3')),
    JSON.stringify(bad.errors));
  ok('指出支持的格式', bad.errors.some(e => /png.*jpg.*webp.*gif/.test(e)), JSON.stringify(bad.errors));
  ok('警告说明跳过了几张', bad.warnings.length > 0, JSON.stringify(bad.warnings));

  const good = M.validateImages(['a.png', 'b.JPG', 'c.webp', 'd.gif']);
  ok('常见格式都通过', good.ok, JSON.stringify(good.errors));
  ok('大写扩展名也认', good.images.length === 4);

  const empty = M.validateImages([]);
  ok('空列表报错', !empty.ok && empty.errors.some(e => /至少需要 1 张/.test(e)), JSON.stringify(empty.errors));
}

// ============================================================
console.log('\n【2】视觉返回的容错归一化（模型形状不保证）');
{
  // 标准形状
  const a = M.normalizeCharacterProfiles({ characters: [{ name: 'A', appearance: 'x' }] }, { imageCount: 1 });
  ok('标准 characters 数组', a.length === 1 && a[0].name === 'A');

  // 顶层就是数组
  const b = M.normalizeCharacterProfiles([{ name: 'B', appearance: 'y' }], { imageCount: 1 });
  ok('顶层数组也认', b.length === 1 && b[0].name === 'B');

  // 中文键
  const c = M.normalizeCharacterProfiles({ characters: [{ 名称: '丙', 外貌: '描述' }] }, { imageCount: 1 });
  ok('中文键也认', c.length === 1 && c[0].name === '丙' && c[0].appearance === '描述',
    JSON.stringify(c.map(x => ({ n: x.name, a: x.appearance }))));

  // 空壳条目要丢掉（否则卡里会出现无名空档案）
  const d = M.normalizeCharacterProfiles({ characters: [{}, { name: '有名字' }] }, { imageCount: 2 });
  ok('全空条目被丢弃', d.length === 1 && d[0].name === '有名字', String(d.length));

  // 无名但有外貌 → 给占位名而不是丢
  const e = M.normalizeCharacterProfiles({ characters: [{ appearance: '一袭白衣' }] }, { imageCount: 1 });
  ok('无名但有内容 → 给占位名', e.length === 1 && e[0].name.length > 0, JSON.stringify(e));

  // 越界 imageIndex 要夹回范围
  const f = M.normalizeCharacterProfiles({ characters: [{ name: 'X', imageIndex: 9, appearance: 'z' }] }, { imageCount: 3 });
  ok('越界 imageIndex 夹回范围', f[0].imageIndex === 2, String(f[0].imageIndex));

  // 非法 confidence 兜底为 medium
  const g = M.normalizeCharacterProfiles({ characters: [{ name: 'Y', appearance: 'z', confidence: '乱写' }] }, { imageCount: 1 });
  ok('非法 confidence 兜底', g[0].confidence === 'medium', g[0].confidence);

  // 垃圾输入不能崩
  ok('null 不崩', M.normalizeCharacterProfiles(null).length === 0);
  ok('字符串不崩', M.normalizeCharacterProfiles('nonsense').length === 0);
  ok('数字不崩', M.normalizeCharacterProfiles(42).length === 0);

  /**
   * **同名必须去重**：变量树是 `characters.<名>`，同名会互相覆盖。
   *
   * 实测踩过：两张图是同一场景里的两个剪影，模型给了同一个名字
   * （都叫「左前景剪影行人」）→ **2 个人物在变量树里只剩 1 个键**，
   * 状态栏少一页，AI 永远更新不到第二个角色。
   */
  {
    const dup = M.normalizeCharacterProfiles({ characters: [
      { imageIndex: 0, name: '剪影行人', appearance: '深色轮廓' },
      { imageIndex: 1, name: '剪影行人', appearance: '亮色块' },
      { imageIndex: 2, name: '银发少女', appearance: '银色长发' },
    ] }, { imageCount: 3 });
    ok('同名被去重（数量不减）', dup.length === 3, String(dup.length));
    ok('去重后名字两两不同', new Set(dup.map(c => c.name)).size === 3,
      JSON.stringify(dup.map(c => c.name)));
    ok('去重时标出图片序号', dup[1].name.includes('图2'), dup[1].name);
    ok('不重名的角色不受影响', dup[2].name === '银发少女', dup[2].name);
  }
}

// ============================================================
console.log('\n【2b】视觉可用性判定（本功能最要紧的一道闸）');
{
  /**
   * 背景：当前端点（api.deepseek.com）接受图片字段但**不做视觉理解**。
   * 它会返回结构完全正确的 JSON，只是字段内容全在说"看不到"。
   * 若不拦，用户会拿到一张看起来正常、实际一个字有用信息都没有的空壳卡。
   *
   * 下面两段是真实返回，**逐字抄录**作为回归样本（含它把字段名罗列一遍的写法）。
   */
  const REAL_BLIND_1 = { sawImage: false, characters: [{
    imageIndex: 0, name: '无法辨识角色', confidence: 'low',
    appearance: '由于图片未能加载或格式不支持，无法获取任何视觉信息，因此无法辨认角色的发色发型、瞳色眼型、肤色、面部特征以及有无特殊标记等外貌细节。请提供有效图片或补充文字描述。',
    clothing: '由于图片未能加载或格式不支持，无法获取任何视觉信息，因此无法辨认角色的服装款式、颜色、材质、层次以及配饰等细节。请提供有效图片或补充文字描述。',
    build: '无法辨认', scene: '图片未提供，无法确定场景',
  }] };
  const REAL_BLIND_2 = { sawImage: false, characters: [{
    imageIndex: 0, name: '未知人物', confidence: 'low',
    appearance: '图片未提供或无法解析，无法辨认任何外貌特征。由于输入图像缺失，无法描述发色、发型、瞳色、肤色、面部特征或特殊标记。',
    clothing: '图片未提供或无法解析，无法辨认服装款式、颜色、材质与层次。因视角或数据限制，无法描述任何衣着细节。',
    build: '图片未提供，无法判断体型、身高感或姿态特征。', scene: '图片未提供，无法判断场景、地点、时间、天气或环境元素。',
  }] };

  const norm = (raw) => M.normalizeCharacterProfiles(raw, { imageCount: 1 });

  // ① 模型显式声明看不到图 → 必须拦下（最可靠的信号）
  const b1 = M.assessVisionQuality(norm(REAL_BLIND_1), { sawImage: false });
  ok('模型自述看不到 → 拦下', !b1.usable && b1.reason === 'model-says-blind', JSON.stringify(b1));
  ok('显式声明算已验证', b1.verified === true, String(b1.verified));
  const b2 = M.assessVisionQuality(norm(REAL_BLIND_2), { sawImage: false });
  ok('第二种拒绝措辞也拦下', !b2.usable, JSON.stringify(b2));

  /**
   * ② 模型漏答 sawImage → 走内容兜底，**放行但标记未验证**。
   *
   * 这是刻意的取舍：兜底分不干净 —— 拒绝文本里含 8-9 个具体词
   * （"发色发型、瞳色眼型、肤色"），而简短但真实的描述只有 2 个，计数完全重叠。
   * 阈值 30 会误伤真实的简短答案，阈值 8 又漏掉拒绝文本（两种都实测踩过）。
   * 所以选择：放行 + 明确告知用户"未验证"，而不是误判任务失败。
   */
  const fb = M.assessVisionQuality(norm(REAL_BLIND_2), { sawImage: null });
  ok('漏答 sawImage 时走兜底放行', fb.usable, JSON.stringify(fb));
  ok('漏答时明确标记为未验证（关键）', fb.verified === false, String(fb.verified));

  // ③ 真看到图 → 放行且已验证
  const good = M.assessVisionQuality(norm({ sawImage: true, characters: [{
    name: '银发少女', appearance: '银色长发垂至腰际，赤色瞳孔，皮肤白皙，左眼下有一颗小痣',
    clothing: '黑色皮衣，金属铆钉，腰间束带', scene: '雨夜霓虹街道',
  }] }), { sawImage: true });
  ok('真有视觉细节 → 放行', good.usable, JSON.stringify(good));
  ok('真看到时标记为已验证', good.verified === true, String(good.verified));

  // ④ 简短但真实也必须放行（不许误伤）
  const brief = M.assessVisionQuality(norm({ sawImage: true, characters: [{
    name: 'A', appearance: '黑发少年', clothing: '白衬衫', scene: '教室',
  }] }), { sawImage: true });
  ok('简短但真实 → 放行（不误伤）', brief.usable, JSON.stringify(brief));

  // ⑤ 空档案在两种情况下都不可用
  ok('空档案 + 未声明 → 不可用',
    !M.assessVisionQuality([], { sawImage: null }).usable);
  ok('空档案 + 声明看到 → 仍不可用（声明不能替代内容）',
    !M.assessVisionQuality([], { sawImage: true }).usable);
}

// ============================================================
console.log('\n【3】content_yaml：必须把「看到的」与「推出来的」分开');
{
  const yaml = M.renderContentYaml({
    name: '银发少女', gender: '女', ageRange: '少女',
    appearance: '银色长发，赤瞳', clothing: '黑色风衣', accessories: ['银质耳环'],
    palette: ['黑', '银'], scene: '雨夜街道', worldHints: ['现代都市'],
    personalityHints: ['神情冷淡'], inferredIdentity: '可能是佣兵',
    inferredAbilities: '身手敏捷', inferredRelations: '与另一张图的人是同伴',
    confidence: 'high',
  });
  ok('含 name 字段', /^name: 银发少女/m.test(yaml));
  ok('外貌原样写入（不掺推断）', /银色长发，赤瞳/.test(yaml));
  ok('推断字段带「据画面推断」标注', /据画面推断/.test(yaml), '');
  ok('推断身份被标注', /可能是佣兵（据画面推断）/.test(yaml));
  ok('没有的字段写「图片未提供」而不是编造', /图片未提供/.test(yaml));
  ok('字段数足够（与小说路径同构）', (yaml.match(/^\S+:/gm) || []).length >= 14,
    String((yaml.match(/^\S+:/gm) || []).length));

  // 关键：描述性字段里不能出现推断内容。
  // 按字段取，不要用 indexOf 切片 —— `indexOf('background:')` 会被 `measurements` 之类
  // 的子串搅乱（实测切出半行，导致断言本身不可靠）。
  const fieldOf = (y, key) => {
    const lines = y.split('\n');
    const start = lines.findIndex(l => l.startsWith(key + ':'));
    if (start < 0) return '';
    const out = [];
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\S+:/.test(l)) break;            // 撞到下一个顶层字段就停
      if (l.trim()) out.push(l.trim());
    }
    return out.join(' ');
  };
  const descPart = ['appearance', 'clothing', 'build'].map(k => fieldOf(yaml, k)).join(' ');
  ok('描述性字段里没有身份推断', !/佣兵/.test(descPart), JSON.stringify(descPart.slice(0, 90)));
  ok('描述性字段里没有能力推断', !/身手敏捷/.test(descPart), JSON.stringify(descPart.slice(0, 90)));
  ok('描述性字段确实有内容（不是空跑）', descPart.length > 10, String(descPart.length));
  // 推断内容必须出现在 inferred 类字段里
  const identity = fieldOf(yaml, 'background');
  ok('推断身份落在 background 段', /佣兵/.test(identity), JSON.stringify(identity.slice(0, 80)));

  // 低置信度要标出来
  const low = M.renderContentYaml({ name: 'X', appearance: '看不清', confidence: 'low' });
  ok('低置信度会标注', /置信度低/.test(low), '');
  // 完全没有 personalityHints 时不许编
  ok('无依据时不编性格', /无法可靠推断性格/.test(low), '');
}

// ============================================================
console.log('\n【3b】世界书条目名必须是短地名（不能是一整段场景描写）');
{
  /**
   * 踩过的坑：一开始直接把 profile.scene 当条目名，而视觉模型给的 scene 是
   * 一整段描写（100+ 字：「夜间城市街道，正中央是一条宽阔的沥青马路，路面湿润反光…」），
   * 于是世界书条目的名字变成一整段话、触发词也变成那句话。
   */
  const longScene = '夜间城市街道，正中央是一条宽阔的沥青马路，路面湿润反光，横贯一条醒目的黄色斑马线；两侧是低层沿街商铺与卷帘门，左边墙面有大面积涂鸦';
  const short = M.shortPlaceName(longScene);
  ok('长场景描写被收成短名', short.length <= 14 && short.length >= 2, JSON.stringify(short));
  ok('短名取自第一个子句', !short.includes('沥青马路'), JSON.stringify(short));

  ok('已经是短名的原样保留', M.shortPlaceName('山间石阶') === '山间石阶', M.shortPlaceName('山间石阶'));
  ok('空场景返回空', M.shortPlaceName('') === '');
  ok('null 不崩', M.shortPlaceName(null) === '');
  ok('极短片段有兜底', M.shortPlaceName('室内').length >= 2, M.shortPlaceName('室内'));

  /**
   * 指回上一张图的场景**不是新地点**，不能单独成条。
   *
   * 实测模型会写「与上一张为同一处夜晚街景：高架混凝土巨构横跨头顶…」，
   * 照单收下就会多出一条名字叫「与上一张为同一处夜间城市街道」的条目，
   * 触发词也是那句话 —— 明显是噪音。
   */
  for (const s of [
    '与上一张为同一处夜晚街景：高架混凝土巨构横跨头顶',
    '与前景为同一地点',
    '同一处街景',
    '同上',
  ]) {
    ok(`指回上一张图的场景被跳过：${s.slice(0, 12)}`, M.shortPlaceName(s) === '', JSON.stringify(M.shortPlaceName(s)));
  }
  // 但真的新地点必须留下
  ok('新地点不被误杀', M.shortPlaceName('山间石阶，两侧竹林') === '山间石阶', M.shortPlaceName('山间石阶，两侧竹林'));

  const items = M.renderWorldbookFromProfiles([{
    scene: longScene, worldHints: ['赛博朋克'], palette: ['青绿', '品红'],
  }], { title: '霓虹街道' });
  const loc = items.filter(x => x.category === 'map_location');
  ok('生成场景条目', loc.length === 1, String(loc.length));
  ok('场景条目名是短名', loc[0].name.length <= 14, JSON.stringify(loc[0].name));
  ok('完整场景描写保留在正文里', loc[0].content.includes('沥青马路'), loc[0].content.slice(0, 60));
  ok('触发词用短名', loc[0].keys.every(k => k.length <= 14), JSON.stringify(loc[0].keys));
}

// ============================================================
console.log('\n【4】装配段：用注入的抽取结果跑出真卡（核心）');
{
  const profiles = M.normalizeCharacterProfiles({
    characters: [
      {
        imageIndex: 0, name: '沈砚', gender: '男', ageRange: '青年', confidence: 'high',
        appearance: '黑色短发，深色瞳孔，眉骨明显，下颌线清晰', clothing: '藏青色长衫，立领，腰间束带',
        build: '身高约一米八，肩宽', accessories: ['玉佩'], palette: ['藏青', '白'],
        scene: '山间石阶', worldHints: ['古风', '修仙'], personalityHints: ['神情沉静'],
        inferredIdentity: '可能是修士', inferredAbilities: '剑术', inferredRelations: '与另一人同行',
      },
      {
        imageIndex: 1, name: '柳青', gender: '女', ageRange: '少女', confidence: 'medium',
        appearance: '茶色马尾，浅褐色眼睛，皮肤白皙', clothing: '浅绿色襦裙，广袖',
        build: '身形纤细', accessories: ['发带'], palette: ['浅绿'],
        scene: '山间石阶', worldHints: ['古风', '修仙'], personalityHints: [],
        inferredIdentity: '可能是同门弟子', inferredAbilities: '', inferredRelations: '与沈砚同行',
      },
    ],
  }, { imageCount: 2 });

  const r = await M.buildCardFromExtraction({ profiles, title: '山间同行' });

  ok('产出完整卡对象', !!r.card?.data, '');
  ok('人物条目数 = 档案数', r.characters.length === 2, String(r.characters.length));
  ok('第一人是主角层', r.characters[0].tier === '主角', r.characters[0].tier);
  ok('第二人是主要NPC层', r.characters[1].tier === '主要NPC', r.characters[1].tier);

  // 变量树：图片路径固定 participant 模式 —— 所有图片角色都留在 characters 里
  const charKeys = Object.keys(r.variables.characters || {});
  ok('变量树含全部图片角色（participant 模式不移走主角）',
    charKeys.length === 2 && charKeys.includes('沈砚') && charKeys.includes('柳青'),
    JSON.stringify(charKeys));
  ok('用户以 {{user}} 身份进入（participant）',
    r.variables.user?.name === '{{user}}', JSON.stringify(r.variables.user));
  ok('变量树含事件（否则导演指令空转）',
    Object.keys(r.variables.events || {}).length >= 1, JSON.stringify(Object.keys(r.variables.events || {})));
  ok('恰有一个事件是 ongoing',
    Object.values(r.variables.events).filter(v => v.status === 'ongoing').length === 1,
    JSON.stringify(r.variables.events));
  ok('world 段存在', !!r.variables.world, JSON.stringify(Object.keys(r.variables)));
  ok('user 段存在', !!r.variables.user, JSON.stringify(Object.keys(r.variables)));

  // 状态栏 + 正则体系
  ok('状态栏有 HTML', typeof r.statusbar.statusbar.html === 'string' && r.statusbar.statusbar.html.length > 500,
    String(r.statusbar.statusbar.html?.length));
  ok('恰好 7 条正则', r.statusbar.regexScripts.length === 7, String(r.statusbar.regexScripts.length));
  ok('状态栏校验无 error', r.statusbar.validation.errors.length === 0,
    JSON.stringify(r.statusbar.validation.errors));
  ok('题材识别为仙侠（世界线索含修仙）', r.statusbar.statusbar.theme === 'xianxia',
    r.statusbar.statusbar.theme + ' / hint=' + r.genreHint);

  // 世界书
  ok('世界书至少 1 条（世界概览）', r.worldbook.length >= 1, String(r.worldbook.length));
  ok('世界概览条目标明是图片推断',
    r.worldbook.some(w => /图片/.test(w.content) && /推断/.test(w.content)),
    JSON.stringify(r.worldbook.map(w => w.content.slice(0, 24))));

  // 完整卡结构
  const entries = r.card.data.character_book.entries;
  ok('卡里有世界书条目', entries.length > 0, String(entries.length));
  ok('卡里有正则脚本', (r.card.data.extensions.regex_scripts || []).length === 7,
    String((r.card.data.extensions.regex_scripts || []).length));
  ok('卡名 = 标题', r.card.data.name === '山间同行', r.card.data.name);
  ok('顶层 name 与 data.name 一致', r.card.name === undefined || r.card.name === r.card.data.name,
    String(r.card.name));
  ok('第一张图设为头像的依据（imageIndex 保留）', r.characters[0].imageIndex === 0);

  // 统计
  const sum = M.summarizeCard(r);
  ok('统计能算出条目数', sum.entries === entries.length, `${sum.entries} vs ${entries.length}`);
  ok('统计能算字节数', sum.cardBytes > 1000, String(sum.cardBytes));

  globalThis.__result = r;
  globalThis.__profiles = profiles;
}

// ============================================================
console.log('\n【5】边界：0 个档案、单档案、超长档案');
{
  const empty = await M.buildCardFromExtraction({ profiles: [], title: '空卡' });
  ok('0 档案不崩', !!empty.card?.data, '');
  ok('0 档案时变量树仍有事件（兜底不能空转）',
    Object.keys(empty.variables.events || {}).length >= 1,
    JSON.stringify(Object.keys(empty.variables.events || {})));
  ok('0 档案时世界书仍给世界概览', empty.worldbook.length >= 1, String(empty.worldbook.length));

  const one = await M.buildCardFromExtraction({
    profiles: M.normalizeCharacterProfiles({ characters: [{ name: '独行', appearance: 'a'.repeat(400) }] }, { imageCount: 1 }),
    title: '单人',
  });
  ok('单档案正常', one.characters.length === 1 && !!one.card?.data, '');

  // 极端名（含点、空格）不能把变量路径切坏
  const weird = await M.buildCardFromExtraction({
    profiles: M.normalizeCharacterProfiles({ characters: [{ name: 'A.B C', appearance: 'x'.repeat(80) }] }, { imageCount: 1 }),
    title: '怪名',
  });
  const wk = Object.keys(weird.variables.characters || {});
  ok('怪名变量键不含裸点', wk.every(k => !k.includes('.')), JSON.stringify(wk));
}

// ============================================================
console.log('\n【6】产物落盘：目录结构要与小说路径一致（好复用现有页面）');
{
  const dir = await mkdtemp(path.join(tmpdir(), 'imgcard-'));
  try {
    // 造一张真 PNG 用于头像复制
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const imgPath = path.join(dir, 'one.png');
    await writeFile(imgPath, png);

    const written = await M.writeImageCardOutputs(dir, globalThis.__result, {
      imagePaths: [imgPath],
      vision: { raw: '{"characters":[]}' },
      meta: { taskId: 'task_test' },
    });
    ok('写出了 character_card.json', written.includes('character_card.json'));
    ok('写出了 worldbook.json', written.includes('worldbook.json'));
    ok('写出了 statusbar_preview.html', written.includes('statusbar_preview.html'));
    ok('写出了 avatar（第一张图）', written.some(w => w.startsWith('avatar')), JSON.stringify(written));
    ok('写出了 README.md', written.includes('README.md'));

    const card = JSON.parse(await readFile(path.join(dir, 'character_card.json'), 'utf-8'));
    ok('落盘的卡可再解析且有 entries', (card.data?.character_book?.entries || []).length > 0, '');
    const readme = await readFile(path.join(dir, 'README.md'), 'utf-8');
    ok('README 说明图片推断的局限', /推断/.test(readme) && /图片/.test(readme), '');
    ok('README 说明事件表只有开场', /开场/.test(readme), '');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================
console.log('\n【8】长漫画支持：上限放宽 + 分批 + 全局图号');
{
  /**
   * 背景：原来上限 8 —— 长一点的漫画（一话 15-25 页）根本导不进来。
   * 现在总数放宽到 MAX_IMAGES，内部按 DEFAULT_VISION_BATCH 分批送模型。
   */

  // ---------- 8a 上限 ----------
  ok('MAX_IMAGES 已放宽（不再是 8）', M.MAX_IMAGES > 8, String(M.MAX_IMAGES));
  ok('每批张数是有限的小值（避免注意力稀释）',
    M.DEFAULT_VISION_BATCH >= 2 && M.DEFAULT_VISION_BATCH <= 12, String(M.DEFAULT_VISION_BATCH));
  ok('并发批次保持低位（避免限流）',
    M.DEFAULT_VISION_CONCURRENCY >= 1 && M.DEFAULT_VISION_CONCURRENCY <= 4,
    String(M.DEFAULT_VISION_CONCURRENCY));
  ok('批次级重试次数 ≥2', M.BATCH_ATTEMPTS >= 2, String(M.BATCH_ATTEMPTS));

  // 一话漫画（20 页）必须能通过校验
  const ep = Array.from({ length: 20 }, (_, i) => `p${i + 1}.jpg`);
  ok('20 张（一话漫画）可以通过校验', M.validateImages(ep).ok === true,
    JSON.stringify(M.validateImages(ep).errors));
  // 刚好到上限可以，超一张不行
  const atMax = Array.from({ length: M.MAX_IMAGES }, (_, i) => `p${i}.png`);
  ok(`刚好 ${M.MAX_IMAGES} 张可以`, M.validateImages(atMax).ok === true,
    JSON.stringify(M.validateImages(atMax).errors));
  const overMax = Array.from({ length: M.MAX_IMAGES + 1 }, (_, i) => `p${i}.png`);
  const overRes = M.validateImages(overMax);
  ok('超一张被拒', overRes.ok === false, JSON.stringify(overRes.errors));
  ok('超限报错说清"最多几张"和实际张数',
    overRes.errors.some(e => e.includes(String(M.MAX_IMAGES)) && e.includes(String(M.MAX_IMAGES + 1))),
    JSON.stringify(overRes.errors));
  ok('超限报错给出可操作建议（分批/挑选）',
    overRes.errors.some(e => /分批|挑选/.test(e)), JSON.stringify(overRes.errors));

  // ---------- 8b imageOffset：全局图号 ----------
  // 第 3 批（全局下标 12..17）里模型给的是**本批**下标 0..5
  const batch3Raw = {
    characters: [
      { name: '甲', imageIndex: 0, appearance: '黑发' },
      { name: '乙', imageIndex: 3, appearance: '金发' },
    ],
  };
  const local = M.normalizeCharacterProfiles(batch3Raw, { imageCount: 6 });
  ok('不加 offset 时是本批局部编号', local[0].imageIndex === 0 && local[1].imageIndex === 3,
    JSON.stringify(local.map(p => p.imageIndex)));

  const global = M.normalizeCharacterProfiles(batch3Raw, { imageCount: 6, imageOffset: 12 });
  ok('加 offset 后是全局编号', global[0].imageIndex === 12 && global[1].imageIndex === 15,
    JSON.stringify(global.map(p => p.imageIndex)));

  // 关键：越界的本批下标要按**本批**夹取，再加 offset（顺序反了后面批次全变 0）
  const oob = M.normalizeCharacterProfiles(
    { characters: [{ name: '丙', imageIndex: 99, appearance: 'x' }] },
    { imageCount: 6, imageOffset: 12 },
  );
  ok('越界下标按本批夹到 5，再加 offset = 17（不是被夹成 0/12）',
    oob[0].imageIndex === 17, String(oob[0].imageIndex));

  // ---------- 8c 跨批去重 ----------
  /**
   * 主角跨多批出现 → 同名档案。变量树是 characters.<varKey(名)>，
   * 同名会塌成一个键，所以必须加「（图N）」区分，且 N 要用全局图号。
   */
  const merged = M.mergeBatchProfiles([
    [{ name: '主角', imageIndex: 0, appearance: 'a' }, { name: '甲', imageIndex: 1, appearance: 'b' }],
    [{ name: '主角', imageIndex: 7, appearance: 'c' }],   // 第 2 批里的同一主角
    [{ name: '主角', imageIndex: 13, appearance: 'd' }],  // 第 3 批
  ]);
  ok('跨批同名不会塌成一条', merged.length === 4, String(merged.length));
  const names = merged.map(p => p.name);
  ok('第一个保留原名', names.includes('主角'), JSON.stringify(names));
  ok('后面的加全局图号标记',
    names.includes('主角（图8）') && names.includes('主角（图14）'), JSON.stringify(names));
  ok('全部名字唯一', new Set(names).size === names.length, JSON.stringify(names));
  ok('按来源图顺序排序',
    merged.map(p => p.imageIndex).join(',') === '0,1,7,13',
    JSON.stringify(merged.map(p => p.imageIndex)));

  // 同一批内不同的人不能被动到
  ok('不同名不受影响', names.includes('甲'));

  // 批内已经带「（图N）」的名字，跨批再撞时要能继续区分而不是死循环
  const tricky = M.mergeBatchProfiles([
    [{ name: '甲（图2）', imageIndex: 1, appearance: 'x' }],
    [{ name: '甲（图2）', imageIndex: 5, appearance: 'y' }],
    [{ name: '甲（图2）', imageIndex: 9, appearance: 'z' }],
  ]);
  ok('带图号的名字再撞也能区分', new Set(tricky.map(p => p.name)).size === 3,
    JSON.stringify(tricky.map(p => p.name)));

  // 空输入安全
  ok('空批不崩', M.mergeBatchProfiles([]).length === 0);
  ok('含空批不崩', M.mergeBatchProfiles([[], [{ name: 'A', imageIndex: 0 }], []]).length === 1);

  /**
   * 空批次（请求成功但一条档案都没抽到）不能静默。
   *
   * 实测：20 张图跑出 18 条，第 4 批没报错、返回 0 条档案，
   * 那 2 张图的内容就静默消失了 —— 用户只会觉得"怎么少了几个人"。
   */
  const withEmpty = M.mergeBatchProfiles([
    [{ name: '甲', imageIndex: 0 }],
    [],                                   // ← 这一批什么都没抽到
    [{ name: '乙', imageIndex: 8 }],
  ]);
  ok('空批次不影响其它批', withEmpty.length === 2, String(withEmpty.length));
  ok('空批次不产生占位条目', withEmpty.every(p => p.name), JSON.stringify(withEmpty.map(p => p.name)));

  // ---------- 8d 批数计算 ----------
  const batchCount = (n, size) => Math.ceil(n / size);
  ok('20 张 / 每批 6 = 4 批', batchCount(20, M.DEFAULT_VISION_BATCH) === 4,
    String(batchCount(20, M.DEFAULT_VISION_BATCH)));
  ok(`${M.MAX_IMAGES} 张的批数在合理范围（≤12 批）`,
    batchCount(M.MAX_IMAGES, M.DEFAULT_VISION_BATCH) <= 12,
    String(batchCount(M.MAX_IMAGES, M.DEFAULT_VISION_BATCH)));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片生成角色卡测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
