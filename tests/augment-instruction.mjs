/**
 * 完善指令 + 已有卡世界观上下文 测试
 *
 * 这段逻辑决定**给模型看了什么**，出错的方式很隐蔽：
 * 喂了空摘要、摘要被截成没信息量的片段、指令没拼进去 ——
 * 都不报错，只是"效果变差"。所以用断言钉住。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const C = await import(pathToFileURL(path.join(ROOT, 'src/augment_context.js')).href);
const A = await import(pathToFileURL(path.join(ROOT, 'src/augment.js')).href);

/** 造一份 extractCardStructure 形状的数据 */
const entry = (comment, content, group) => ({ comment, content, keys: [], extensions: group ? { group } : {} });

// ============================================================
console.log('\n【1】已有卡世界观摘要：要能读懂、不能爆上下文');
{
  const structure = {
    entries: [
      entry('[character·主角] 林昭', 'name: 林昭\ntitle: 寻亲者\nappearance: |\n  素衣少女，眉目清淡，腰间悬着一枚半块玉佩。\npersonality: |\n  沉静果决。', 'character'),
      entry('[map_world] 云京', 'name: 云京\ntype: 世界\n地理概况: 王朝都城，分内外两城，雨季漫长。\ndynamicHint: 无', 'map_world'),
      entry('[system_faction] 缉影司', 'name: 缉影司\ntype: 势力\n运作原理: 掌查密案，不归三法司管辖。', 'system_faction'),
      entry('[event] 开篇入城', '起因: 寻兄\n经过: 林昭进入云京\n结果: 得到线索', 'event'),
    ],
  };
  const digest = C.buildCardWorldviewDigest(structure);

  ok('摘要非空', digest.length > 0, String(digest.length));
  ok('含角色名', digest.includes('林昭'), '');
  ok('含世界名', digest.includes('云京'), '');
  ok('含势力名', digest.includes('缉影司'), '');
  ok('按分组归类', digest.includes('【人物】') && digest.includes('【世界观'),
    digest.slice(0, 80));
  // 取的是**正文里有信息量的值**，而不是复述条目名
  ok('取了正文内容而不是复述条目名',
    digest.includes('寻亲者') || digest.includes('素衣少女') || digest.includes('王朝都城'),
    digest);
  ok('没有出现「林昭：林昭」这种无用摘要', !/林昭：林昭/.test(digest), digest);
  ok('YAML 键名没被原样塞进去', !digest.includes('dynamicHint'), '');
  ok('长度受控（每条 ≤ 60 字左右）',
    digest.split('\n').filter(l => l.startsWith('- ')).every(l => l.length < 90),
    String(Math.max(...digest.split('\n').filter(l => l.startsWith('- ')).map(l => l.length))));

  // 空卡
  ok('空卡返回空串', C.buildCardWorldviewDigest({ entries: [] }) === '');
  ok('null 输入不崩', C.buildCardWorldviewDigest(null) === '');
  ok('entries 缺失不崩', C.buildCardWorldviewDigest({}) === '');

  // 超长卡要截断并说明
  const many = { entries: Array.from({ length: 100 }, (_, i) => entry(`条目${i}`, `内容${i}`, 'map_world')) };
  const big = C.buildCardWorldviewDigest(many, { maxItems: 10 });
  ok('超过上限时截断', (big.match(/^- /gm) || []).length <= 10, String((big.match(/^- /gm) || []).length));
  ok('截断后说明还有多少条没列', /另有 \d+ 条未列出/.test(big), big.split('\n').pop());
}

// ============================================================
console.log('\n【2】指令段：拼进 prompt 且措辞明确');
{
  const b = C.buildInstructionBlock('只合并角色，要符合原卡世界观');
  ok('含用户原文', b.includes('只合并角色，要符合原卡世界观'), '');
  ok('标为高优先级', /优先级高于/.test(b), b.slice(0, 60));
  ok('说明不得违反事实（防指令让模型编造）', /不得违反事实/.test(b), '');
  ok('空指令返回空串', C.buildInstructionBlock('') === '');
  ok('纯空白返回空串', C.buildInstructionBlock('   \n  ') === '');
  ok('null 不崩', C.buildInstructionBlock(null) === '');
  ok('默认标题可读', b.includes('用户对本次完善的额外要求'), '');
}

// ============================================================
console.log('\n【3】世界观段：必须明确要求"一致"');
{
  const w = C.buildWorldviewBlock('- 云京：王朝都城');
  ok('含世界观内容', w.includes('云京'), '');
  ok('明确要求一致', /必须与之\*\*一致\*\*/.test(w), '');
  ok('要求沿用已有名词（防另起名字）', /沿用已有卡的说法/.test(w), '');
  ok('要求不要引入矛盾体系', /矛盾/.test(w), '');
  ok('禁止凭空补全', /不要凭空补全/.test(w), '');
  ok('空摘要返回空串', C.buildWorldviewBlock('') === '');
}

// ============================================================
console.log('\n【4】组合上下文：顺序与完整性');
{
  const ctx = C.buildAugmentContext({ instruction: '只合并角色', digest: '- 云京：都城' });
  ok('同时含世界观与指令', ctx.includes('云京') && ctx.includes('只合并角色'), '');
  ok('世界观在前、指令在后（先给背景再给要求）',
    ctx.indexOf('云京') < ctx.indexOf('只合并角色'), '');
  ok('以换行开头（便于直接拼接）', ctx.startsWith('\n'), JSON.stringify(ctx.slice(0, 5)));

  ok('只有指令时也能用',
    C.buildAugmentContext({ instruction: 'x' }).includes('x')
    && !C.buildAugmentContext({ instruction: 'x' }).includes('已有角色卡的世界观'), '');
  ok('只有摘要时也能用',
    C.buildAugmentContext({ digest: 'y' }).includes('y')
    && !C.buildAugmentContext({ digest: 'y' }).includes('用户对本次完善'), '');
  ok('都没有时返回空串', C.buildAugmentContext({}) === '');
  ok('undefined 不崩', C.buildAugmentContext() === '');
}

// ============================================================
console.log('\n【5】与 runAugment 的接线（指令真的进了 prompt）');
{
  // 直接看源码里 config.instruction 的读取与 4 个步骤的注入
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(path.join(ROOT, 'src/augment.js'), 'utf-8');

  ok('读取了 config.instruction', /config\.instruction/.test(src), '');
  ok('构造了 augmentCtx', /buildAugmentContext\(/.test(src), '');
  ok('事件抽取注入了上下文', /STEP_2_EVENTS[^\n]*augmentCtx/.test(src), '');
  ok('世界观抽取注入了上下文', /STEP_5_WORLDBOOK[\s\S]{0,200}?augmentCtx/.test(src), '');
  ok('人物名单注入了上下文', /STEP_5_CHARACTER_LIST[\s\S]{0,200}?augmentCtx/.test(src), '');
  ok('人物档案注入了上下文', /STEP_5_CHARACTER[\s\S]{0,300}?augmentCtx/.test(src), '');
  ok('空世界观条目的卡会告警（否则新内容无从对齐）',
    /没有可用的世界观条目/.test(src), '');
  ok('Log 里报出指令字数与摘要字数', /已附加用户指令/.test(src) && /已附加已有卡世界观摘要/.test(src), '');

  // 导出面没被破坏
  ok('runAugment 仍是导出的异步函数', typeof A.runAugment === 'function', typeof A.runAugment);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  完善指令测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
