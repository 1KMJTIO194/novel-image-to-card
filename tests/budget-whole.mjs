/**
 * 整套常驻预算测试
 *
 * 背景（真 bug，实测发现）：
 *   一张用「完整角色卡」模式生成的卡，A 包世界书常驻 893 tok（裁剪后很干净），
 *   但 `assembleCharacterCard` 还**内置**了 7 条固定常驻模板
 *   （变量更新规则 / 导演指令 / 角色阶段 / 围栏与隔离 / 输出纪律 / 干预与偏离度 /
 *   变量更新强调），合计 2162 tok。导入完整卡时两者**同时生效**。
 *
 *   而旧的 `validate` 只统计 `worldbook.entries`（报 1478 tok「合格」），
 *   内置模板**完全不在账上** —— 于是 3055 tok 的超标是静默的。
 *
 * 这里钉住：整套口径要被算出来、超了要告警、并且进 meta.tokens.whole。
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

const P = await import(pathToFileURL(path.join(ROOT, 'src/pipeline.js')).href);
const { estimateTokens } = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);

// ============================================================
console.log('\n【1】collectBuiltinConstantText：只挑卡内置的常驻模板');
{
  const worldbook = {
    entries: [
      { comment: '[map_world] 现代小城', content: 'x'.repeat(400), constant: true, enabled: true },
      { comment: '[system_realm] 魔法体系', content: 'y'.repeat(300), constant: true, enabled: true },
      { comment: '[map_location] 高中', content: 'z'.repeat(200), constant: false, enabled: true },
    ],
  };
  const card = {
    data: {
      character_book: {
        entries: [
          ...worldbook.entries,
          { comment: '变量更新规则', content: 'a'.repeat(500), constant: true, enabled: true },
          { comment: '导演指令', content: 'b'.repeat(400), constant: true, enabled: true },
          // 非常驻的内置条目不该计入
          { comment: '[timeline]', content: 'c'.repeat(100), constant: false, enabled: true },
        ],
      },
    },
  };

  const text = P.collectBuiltinConstantText(card, worldbook);
  const t = estimateTokens(text);

  ok('算出的 token 只含内置模板', t === estimateTokens('a'.repeat(500) + 'b'.repeat(400)),
    `${t} vs ${estimateTokens('a'.repeat(500) + 'b'.repeat(400))}`);
  ok('不含世界书常驻条目', !text.includes('x'.repeat(50)) && !text.includes('y'.repeat(50)), '');
  ok('不含非常驻条目', !text.includes('c'.repeat(50)), '');

  // 边界
  ok('卡没有 character_book 时返回空串',
    P.collectBuiltinConstantText({ data: {} }, worldbook) === '', '');
  ok('card 为 null 时返回空串', P.collectBuiltinConstantText(null, worldbook) === '', '');
  ok('worldbook 为 null 时不崩（把全部常驻都当内置）',
    typeof P.collectBuiltinConstantText(card, null) === 'string', '');

  /**
   * 关键性质：**新加的内置模板会自动计入**。
   * 如果实现改成写死一张名单，以后加模板就会重新出现"不在账上"的漏洞。
   */
  const card2 = JSON.parse(JSON.stringify(card));
  card2.data.character_book.entries.push({ comment: '将来新增的模板', content: 'd'.repeat(300), constant: true, enabled: true });
  const t2 = estimateTokens(P.collectBuiltinConstantText(card2, worldbook));
  ok('新增的内置模板自动计入（不是写死名单）', t2 > t, `${t} → ${t2}`);
}

// ============================================================
console.log('\n【2】用真实生成的卡复算，确认旧口径确实漏了');
{
  // 有就跑（真实产物可能已被清理），没有就跳过
  const real = path.join('C:', 'Users', '六六六', '.dsh', 'novel2card', 'output', 'task_1791853047760');
  let card = null, worldbook = null;
  try {
    card = JSON.parse(await readFile(path.join(real, 'character_card.json'), 'utf-8'));
    worldbook = JSON.parse(await readFile(path.join(real, 'worldbook.json'), 'utf-8'));
  } catch { /* 跳过 */ }

  if (!card || !worldbook) {
    console.log('  （真实产物不存在，跳过这组）');
  } else {
    const aPack = estimateTokens(worldbook.entries.filter(e => e.constant).map(e => e.content).join(''));
    const builtin = estimateTokens(P.collectBuiltinConstantText(card, worldbook));
    const whole = aPack + builtin;

    console.log(`     A 包世界书常驻 ${aPack} tok / 卡内置模板 ${builtin} tok / 整套 ${whole} tok`);
    ok('A 包本身在上限内（这就是旧口径看不出问题的原因）', aPack <= 2000, String(aPack));
    ok('卡内置模板是实打实的开销（>1000 tok）', builtin > 1000, String(builtin));
    ok('整套超过 maxA（旧口径漏掉了）', whole > 2000, String(whole));
    ok('整套口径能算出真实的超标幅度', whole === aPack + builtin, '');
  }
}

// ============================================================
console.log('\n【3】接线：pipeline 里真的用了这套口径');
{
  const src = await readFile(path.join(ROOT, 'src/pipeline.js'), 'utf-8');
  ok('组装卡之后调用了 collectBuiltinConstantText', /collectBuiltinConstantText\(characterCard/.test(src), '');
  ok('有整套预算的告警文案', /整套常驻 \$\{wholeTokens\} token 超过上限/.test(src), '');
  ok('meta.tokens 里有 whole', /whole: tokensWhole/.test(src), '');
  ok('Done 阶段报出整套常驻', /整套常驻 \$\{tokensWhole\.total\}/.test(src), '');
  ok('collectBuiltinConstantText 是导出的（可测）',
    typeof P.collectBuiltinConstantText === 'function', typeof P.collectBuiltinConstantText);
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  整套常驻预算测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
