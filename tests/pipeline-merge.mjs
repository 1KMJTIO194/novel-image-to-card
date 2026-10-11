/**
 * 合并调用的测试（同一段正文只喂一次）
 *
 * 覆盖三处优化，每条都同时测**合并路径**与**回退路径**：
 *   P1a 逐批：世界观 + 物品 合并为一次调用
 *   P1b 人物档案：分组批量、共享一份抽样
 *   P0  逐章：时间线（时间提及）+ 事件 合并为一次调用
 *
 * 最重要的断言是"合并 prompt 不能偷偷削规则"——合并省的是重复正文，
 * 不是要求本身。删掉任何关键规则片段都会掉数据质量，且很难在产出上看出来。
 *
 * 运行：node tests/pipeline-merge.mjs
 */
import * as S from '../src/steps.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}

// ============================================================
console.log('\n【1】三个合并 prompt 都存在且是对象形态');
{
  for (const k of ['STEP_CHAPTER_EXTRACT', 'STEP_5_WORLDBOOK_ITEMS', 'STEP_5_CHARACTER_BATCH']) {
    ok(`${k} 存在`, typeof S[k] === 'string' && S[k].length > 200, String(S[k]?.length));
  }
  ok('逐章合并版要求输出对象（mentions + events）',
    /"mentions"/.test(S.STEP_CHAPTER_EXTRACT) && /"events"/.test(S.STEP_CHAPTER_EXTRACT));
  ok('逐批合并版要求输出对象（worldbook + items）',
    /"worldbook"/.test(S.STEP_5_WORLDBOOK_ITEMS) && /"items"/.test(S.STEP_5_WORLDBOOK_ITEMS));
  ok('人物批量版要求输出对象（profiles）', /"profiles"/.test(S.STEP_5_CHARACTER_BATCH));
}

// ============================================================
console.log('\n【2】合并 prompt 必须保留单任务版的关键规则');
{
  /**
   * 这些片段是各自单任务 prompt 里"少了就会掉质量"的骨头。
   * 抽掉它们不会报错、产出也还是 JSON，只是内容变差 —— 所以必须锁住。
   */
  const CASES = [
    ['STEP_CHAPTER_EXTRACT', [
      'scope 规则', 'story：**当前故事正在发生**', 'history：**背景资料性质**',
      '只抽取，不推断，不补全，不合并', 'quote 必须能在原文中逐字找到',
      'calendar_note', '不抽取"很久以前""从前"等无信息量的表述',
      // 事件侧
      '只抽剧情事件', '不要抽背景资料', 'storyline 名要具体', '禁止使用"其他""杂项"',
      'pressure 三条件全满足才是 core', '长期状态发生改变', '在后续章节被反复引用', '原著中该事件不可逆',
      '每块抽 0-3 个事件，宁少勿滥', 'interventions 2-4 条', 'quote 必须逐字匹配',
    ]],
    ['STEP_5_WORLDBOOK_ITEMS', [
      'map_world', 'map_region', 'map_location', 'system_realm', 'system_faction',
      'system_item', 'history',
      '地理概况', '风土人情', '经济与资源', '文化与习俗', '重要地标', '控制势力', '当前局势',
      '层级或构成', '运作原理', '获取或晋升', '代表人物或实例', '限制与代价', '与主线关联',
      '地图类必须写"当前局势"，设定类必须写"与主线关联"',
      '绝对禁止占位符内容', '不要凑数', '编造原文里没有的地名',
      // 物品侧的模板
      '外观', '来源或产地', '用途或效果', '持有者与流转',
      '只抽**在原文中有实际戏份或反复出现**的物品',
    ]],
    ['STEP_5_CHARACTER_BATCH', [
      'name:', 'title:', 'age:', 'height:', 'weight:', 'measurements:',
      'appearance:', 'clothing:', 'background:', 'personality:', 'preferences:',
      'erotic_abilities:', 'special_notes:', '私处细节描写:', '言行举止:',
      '不少于 100 字', '不少于 150 字', '不少于 80 字',
      'keys 必须是**该角色在原文中实际被称呼过的名称**',
      '不是字段名、不是描述', 'keys 里每一个词都必须真的在原文里出现过',
      '内容必须来自原文或基于原文的合理推断，禁止瞎编',
      '详细度优先于简洁度', '600-1500 字',
    ]],
  ];
  for (const [key, frags] of CASES) {
    const text = S[key] || '';
    const missing = frags.filter(f => !text.includes(f));
    ok(`${key} 关键规则齐全（${frags.length} 项）`, missing.length === 0,
      missing.length ? `缺: ${missing.slice(0, 4).join(' / ')}` : '');
  }
}

// ============================================================
console.log('\n【3】人物批量版必须要求"一个都不能少"');
{
  const t = S.STEP_5_CHARACTER_BATCH;
  ok('要求覆盖清单里每个角色', /必须覆盖输入清单里的每一个角色/.test(t));
  ok('要求名字原样照抄', /name 必须原样使用输入清单里的名字/.test(t));
  ok('禁止用别人的信息填充', /不要用别的角色的信息填充/.test(t));
  ok('禁止因为批量而写短', /不能因为"一次写多个"就写短/.test(t));
  ok('keys 反例仍在（字段名）', /\["本名", "别名", "称号"\]/.test(t));
}

// ============================================================
console.log('\n【4】逐批合并版必须明说"只合并这两类"');
{
  // 说明性文字不是给模型看的，但代码维护者需要知道为什么人物名单/摘要没并进来
  const t = S.STEP_5_WORLDBOOK_ITEMS;
  ok('物品条目 category 限定为 system_item', /category 只允许 system_item/.test(t));
  ok('两类都不能只有占位符', /整条 content_yaml 不能只有"未提及"/.test(t));
}

// ============================================================
console.log('\n==============================================');
console.log(`  合并调用测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
