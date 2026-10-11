import { varKey } from './utils.js';

export const B3_PROTAGONIST = `<%_ const 事件列表 = Object.keys(getvar('stat_data.events', { defaults: {} })); _%>
<%_ const 当前事件 = 事件列表.find(e => getvar(\`stat_data.events.\${e}.status\`) === 'ongoing'); _%>
<%_ const 下一事件 = 事件列表.find(e => getvar(\`stat_data.events.\${e}.status\`) === 'pending'); _%>
<%_ /* 优先用解析后的规范日期（world.date.text）：world.time 是原文片段，
      可能是「现在是1961年」这种大白话，也可能只有年份、没有几月几日 */ _%>
<%_ const 世界日期 = getvar('stat_data.world.date.text', { defaults: '' }) || getvar('stat_data.world.time', { defaults: '未知' }); _%>
<%_ const 日期精度 = getvar('stat_data.world.date.precision', { defaults: '' }); _%>
<%_ const 年份是推的 = getvar('stat_data.world.date.inferred', { defaults: false }); _%>

【当前时间】<%= 世界日期 %><%_ if (年份是推的) { _%>（年份按上下文推断）<%_ } _%>
<%_ if (日期精度 === 'year' || 日期精度 === 'coarse') { _%>
【时间提示】原文未给出具体月日 —— 推进剧情时如出现"几月"「某日」的表述，请更新 world.date
<%_ } _%>
【当前阶段】<%= getvar('stat_data.world.phase', { defaults: '起始' }) %>

<%_ if (当前事件) { _%>
【正在发生】<%= 当前事件 %>
  原著压力：<%= getvar(\`stat_data.events.\${当前事件}.pressure\`) %>
  偏离度：<%= getvar(\`stat_data.events.\${当前事件}.deviation\`) %>
  <%_ const 偏离 = getvar(\`stat_data.events.\${当前事件}.deviation\`, { defaults: 0 }); _%>
  <%_ if (偏离 > 60) { _%>
  → 用户已深度干预，本事件按偏离方向展开。
  <%_ } else if (偏离 > 20) { _%>
  → 用户有轻度干预，细节可偏离，但原著核心结果应以变形方式回归。
  <%_ } else { _%>
  → 暂无干预，按原著推进。
  <%_ } _%>
<%_ } else if (下一事件) { _%>
【下一事件】<%= 下一事件 %>
  原著压力：<%= getvar(\`stat_data.events.\${下一事件}.pressure\`) %>
<%_ } else { _%>
【当前事件】（无进行中事件，从事件清单里选尚未发生的一个切入）
<%_ } _%>

【推进原则】
- 按事件列表顺序推进，不得跳过未触发事件
- 当前事件未完成前，不引入下一事件
- 元信息不得出现在叙事正文中`;

export const B3_PARTICIPANT = `<%_ const 事件列表 = Object.keys(getvar('stat_data.events', { defaults: {} })); _%>
<%_ const 当前事件 = 事件列表.find(e => getvar(\`stat_data.events.\${e}.status\`) === 'ongoing'); _%>
<%_ const user位置 = getvar('stat_data.user.position', { defaults: '未知' }); _%>
<%_ const 世界日期 = getvar('stat_data.world.date.text', { defaults: '' }) || getvar('stat_data.world.time', { defaults: '未知' }); _%>

【世界时间】<%= 世界日期 %>
【user 位置】<%= user位置 %>
【当前世界事件】<%= 当前事件 || '（无进行中事件）' %>

<%_ if (当前事件) { _%>
该事件正在发生。user 是否在场？
- 若 user 位置与事件地点重合 → user 可参与，干预影响偏离度
- 若 user 位置远离 → 事件按原著推进，user 从远处得知消息
<%_ } _%>

【推进原则】
- 世界事件按时间线推进，不因 user 缺席而停滞
- user 的行动可以提前/延后/改变事件，但需付出相应代价
- 元信息不得出现在正文`;

export const B3_OBSERVER = `<%_ const 事件列表 = Object.keys(getvar('stat_data.events', { defaults: {} })); _%>
<%_ const 当前事件 = 事件列表.find(e => getvar(\`stat_data.events.\${e}.status\`) === 'ongoing'); _%>
<%_ const 下一事件 = 事件列表.find(e => getvar(\`stat_data.events.\${e}.status\`) === 'pending'); _%>
<%_ const 世界日期 = getvar('stat_data.world.date.text', { defaults: '' }) || getvar('stat_data.world.time', { defaults: '未知' }); _%>

【世界时间】<%= 世界日期 %>
【观测视角】<%= getvar('stat_data.user.watching', { defaults: '主角' }) %>
【当前事件】<%= 当前事件 || 下一事件 || '（世界暂时平静）' %>
<%_ if (当前事件) { _%>
  原著压力：<%= getvar(\`stat_data.events.\${当前事件}.pressure\`) %>
<%_ } _%>

【推进原则】
- 事件按原著推进，user 的输入仅影响视角切换
- 可以描写 user 观察到的场景、对话、内心活动
- 元信息不得出现在正文`;

/**
 * 角色阶段条目（原 B4）：按 `stat_data.world.phase` 输出该阶段的人设增量。
 *
 * ⚠️ 这里必须把整个表写进**单个** EJS 标签里。
 * `<%_ ... _%>` 只是「去空白」的普通 EJS 标签，每个标签内容仍是独立语句块：
 * EJS 会在标签之间插入 `__append("\n")` 之类的输出语句。如果把一个对象字面量
 * 拆在多个标签里（`= { ` / `'键': 值,` / `};`），展开后会变成
 *
 *     const 人设增量表 = { __append("\n") '起始': `…`, __append("\n") };
 *
 * 直接是 SyntaxError（Unexpected token ';'）—— 真实 ejs 3.1.9 实测编译失败。
 * 该条目是 constant 常驻，一旦编译失败，酒馆助手渲染世界书时整条链路报错。
 *
 * 用 JSON.stringify 生成纯 JSON 更稳：键和值都由 JSON 语法自己转义，
 * 阶段名里的引号 / 反引号 / 反斜杠 / `${}` 都不会再影响 EJS 编译，
 * 也就不需要手写模板字面量转义了。
 */
export function generateB4(phases) {
  const 表 = { 起始: '无变化，按世界书基线人设演绎。' };
  for (const p of phases) {
    if (!p.characterDeltas?.length) continue;
    表[p.name] = p.characterDeltas
      .map(d => `${d.character}：${d.change}`)
      .join('\n');
  }
  // JSON.stringify 的产物是合法的 JS 字面量；其中的 \u2028/\u2029 需要额外处理，
  // 否则在旧 JS 引擎里会被当成行终止符
  const literal = JSON.stringify(表).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  return [
    `<%_ const 阶段 = getvar('stat_data.world.phase', { defaults: '起始' }); _%>`,
    ``,
    `<%_ const 人设增量表 = ${literal}; _%>`,
    ``,
    `<%_ if (人设增量表[阶段]) { _%>`,
    `【当前人设增量】（叠加在世界书基线人设之上）`,
    `<%= 人设增量表[阶段] %>`,
    `【应用规则】`,
    `- 增量是"新增/改变"，不是替换`,
    `- 增量优先于基线，冲突时以增量为准`,
    `<%_ } _%>`,
  ].join('\n');
}

export const B5_1 = `你既是这部作品的叙事者，也是它的导演。

你同时维护三样东西，三者严格分离：
  叙事：给用户看的故事，写在 <context> 内
  时间线：按世界书的事件顺序推进剧情
  状态：通过 <update> 记录变量变化

叙事中不得出现时间线管理、状态更新、世界书调用的任何痕迹。`;

export const B5_2_PROTAGONIST = `世界书中有一条常驻"时间线"，是你的顺序锚点。

推进规则：
- 事件按时间线顺序推进，不得跳过"未触发"事件
- 当前事件未完成前，不引入下一事件
- 事件完成后，在 <update> 中将其状态改为"已完成"

用户主动提到未来事件时的应对：
- 若前置已完成 → 可提前推进
- 若前置未完成 → 用"时机未到"自然回避
- 绝不暴露"这是未来才会发生的事"

时间流逝与事件进度一致：
- 不一轮跨过多个事件
- 不数十轮不推进任何事件`;

export const B5_2_PARTICIPANT = `世界书中有一条常驻"时间线"，是世界的客观进度。

推进规则：
- 世界事件按时间线独立推进，不因 user 缺席而停滞
- user 的行动可以提前/延后/改变事件，但需付出代价
- user 若不在场，事件按原著推进；user 若在场，可干预

user 认知边界：
- user 只能知道其所在位置能获取的信息
- 世界事件在 user 未接触前，user 不应"恰好"知晓细节
- 通过 NPC 转述、报纸、广播等方式合理传递信息

时间流逝：
- 世界时间持续推进，不因 user 静止而停滞`;

export const B5_2_OBSERVER = `世界书中有一条常驻"时间线"，是世界的客观进度。

推进规则：
- 事件严格按时间线推进
- user 的输入不改变事件走向，只改变"观测视角"
- 用户可以选择观察哪个角色、哪个场景

叙述规则：
- 以 user 观测到的内容为主体
- 可以描写 user 观察到的场景、对话、内心活动
- user 自身不直接参与剧情`;

export const B5_3 = `【元信息围栏】
以下内容严格禁止出现在 <context> 正文中：
- 世界书条目里的【】标记
- 事件名、人物条目名、世界观条目名（作为"标签"时）
- 变量名与变量路径（stat_data.xxx）
- 时间线、阶段名、偏离度、原著压力等元信息
- <update>、<thinking> 等分析标签
- 对"原著""原作""剧情走向"的元评论

【认知隔离】
角色认知边界：
- 角色只能知道其身份、经历、认知范围内的事
- 角色不读心，不知道其他角色的内心活动
- 角色不知道"原作剧情""时间线""用户是穿越者"等元信息

用户认知边界：
- 用户的行动由用户自己描述，你只回应，不代述
- 用户的内心活动你只能从外部行为推测，不直接写`;

export const B5_4 = `用户做出与原著不同的关键选择时，主动提高对应事件的"偏离度"。

偏离度三档：
  0-20    按原著推进
  21-60   细节可偏离，但原著核心结果以变形方式回归
  61-100  真偏离，原著结果作废，按用户走向发展

与"原著压力"组合：
  核 + 偏离 ≤ 80   即使干预，核心结果也要以变形方式发生
  核 + 偏离 > 80   允许核心结果改变
  缓 + 任何偏离    角色按自身性格抵抗，不强制回归
  弹 + 任何偏离    允许真偏离

禁止两种极端：
  硬扳剧情：已救的角色莫名死去，或用巧合强行拉回原著
  彻底发散：偏离后完全脱离世界书的时间线`;

export const B5_4_OBSERVER = `本作采用观测模式，user 的输入不改变世界线。

处理规则：
- user 的所有输入都视为"视角切换"或"观察请求"
- 不计算偏离度，不改变事件状态
- 若用户试图干预，自然回避：
  - "你无法触及那个世界"
  - "你只是观察者，无法改变既定的事实"
- 或者以梦境/幻觉/闪回的方式呈现"如果 user 干预会怎样"`;

export const B5_5 = `每次回复的固定输出顺序：
  <thinking>...</thinking>
  <context>叙事正文</context>
  <update>变量更新</update>

状态更新纪律：
- 每次回复末尾必须输出 <update> 标签
- <update> 内只写变量修改
- 若本轮无变量变化，输出空标签 <update></update>

写作纪律：
- 不替用户做决定，在需要用户选择的节点停下
- 不写总结、不写抒情、不做升华式结尾`;

/**
 * 输出纪律条目（原 B5_5 + 每轮固定输出顺序 + 状态栏/正文包裹）。
 *
 * Step 7.5 生成的占位符与正文包裹标签必须写进这里：
 * AI 不输出 `<StatusPlaceHolderImpl/>`，卡内嵌的「状态栏美化」正则就没有可替换的目标，
 * 状态面板永远不会出现 —— 而且不报错，用户只会觉得"这卡没有状态栏"。
 *
 * @param {{placeholder?:string, bodyWrapper?:{open:string,close:string}}} [sb]
 */
export function buildOutputDiscipline(sb = {}) {
  const ph = sb.placeholder || null;
  const bw = sb.bodyWrapper || null;
  if (!ph && !bw) return B5_5;

  return `每次回复的固定输出顺序：
  <thinking>...</thinking>
  ${bw ? `${bw.open}叙事正文${bw.close}` : '<context>叙事正文</context>'}
  <update>变量更新</update>${ph ? `\n  ${ph}` : ''}

${bw ? `正文包裹纪律：
- 所有叙事正文必须完整包裹在 ${bw.open} 与 ${bw.close} 之间，一个标点都不能落在标签外
- 每轮回复有且只有一对 ${bw.open}${bw.close}，不要嵌套、不要拆成多对
- 标签内不出现 ${bw.open}${bw.close} 字样本身，也不要提前闭合
` : ''}${ph ? `状态栏纪律：
- 整段回复的**最后一行**必须是占位符，它排在 <update> 之后：${ph}
- 占位符独占一行，前后各有一个换行；不要写成行内、不要加引号、反引号或代码块
- 不要把占位符写进 ${bw ? bw.open + bw.close : '<update>'} 内部
- 占位符只是标记，不要解释它、不要提及"状态栏"或"占位符"这些词

` : ''}状态更新纪律：
- 每次回复末尾必须输出 <update> 标签
- <update> 内只写变量修改
- 若本轮无变量变化，输出空标签 <update></update>

写作纪律：
- 不替用户做决定，在需要用户选择的节点停下
- 不写总结、不写抒情、不做升华式结尾`;
}

// ============================================================
// 完整角色卡（chara_card_v3）用的世界书条目构造器
//
// 这些函数产出的是**直接写进世界书 content 的正文**，不是预设片段：
//   - 含 EJS 的条目：<%_ ... _%> 必须原样保留（不转义），由酒馆助手在运行时渲染//   - 不含 EJS 的条目：使用与其它世界书条目一致的【】标记风格
// ============================================================

/**
 * 世界观分类之间的相对插入顺序（数值越小越靠前）。
 *
 * 注意：这些数值**只用来决定分类之间的相对次序**，不要直接当 insertion_order 写进
 * 完整角色卡 —— 5~30 的区间会和内置条目（1~9）撞车：map_world(5) 撞「导演指令」(5)、
 * system_realm(6) 撞「角色阶段」(6)、system_faction(8) 撞「输出纪律」(8)。
 * ST 对同 insertion_order 的条目没有稳定排序保证，撞号会让常驻规则被挤乱。
 * assembleCharacterCard 会把它们整体顺移到内置条目之后。
 * A 包（worldbook.json）没有内置条目，可以直接使用这些数值。
 */
export const CATEGORY_ORDER = {
  map_world: 5,
  system_realm: 6,
  system_faction: 8,
  map_region: 10,
  map_location: 11,
  system_item: 12,
  system_skill: 13,
  system_bloodline: 14,
  history: 30,
};

/**
 * 把变量树展开成可直接读取的当前值清单（用于变量更新规则条目）。
 * 路径按实际变量树生成，不照抄模板。
 *
 * 键名在**拼进路径之前**做 varKey 规范化 —— 这是唯一正确的时机：
 * 拼好之后再规范化会把合法分层（`events` / `status`）也当成名字里的点号切碎。
 * 变量树理论上已由 buildVariables 规范化过，但本函数可被独立调用，
 * 且键名来自 LLM 抽取，所以这里再兜一层，保证"路径段不含点号与空白"这个不变量。
 */
function flattenVariables(variables, prefix = '', out = [], depth = 0) {
  if (out.length > 400) return out;
  if (depth >= 4) return out;
  for (const [k, v] of Object.entries(variables || {})) {
    const key = varKey(k);
    if (!key) continue;
    const p = prefix ? `${prefix}.${key}` : key;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      flattenVariables(v, p, out, depth + 1);
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * 把变量树压成"值得每轮都发"的清单。
 *
 * ⚠️ 这里是整张卡**最大的常驻开销**，而且很容易被忽略：
 * 原实现把**每一个变量路径**都写进 `<status_current_variables>`，
 * 而那个块每轮都发。实测 40 个事件 + 15 个人物时：
 *
 *     B2 总长 12139 字符，其中 status 块 11191 字符 = 92.2%（158/184 行）
 *
 * B 包预算才 3507 tok（≈5000 字符），**光这一个块就超预算两倍**。
 *
 * 规则：
 *   · `events` —— 只展开**当前剧情**：ongoing 的那个 + 下一个 pending，
 *     其余只列名字。AI 需要知道"后面还有哪些事件"以便推进，
 *     但不需要每轮复核每一个事件的 status/deviation（那是用户说的
 *     "events 只显示当前剧情就好了"）。
 *   · 其余命名空间 —— 全部展开；但整体行数设上限，超了就只列名字。
 */
export function condenseVariablePaths(variables, { maxLines = 80 } = {}) {
  const paths = flattenVariables(variables);
  const byTop = {};
  for (const p of paths) {
    const [top, ...rest] = p.split('.');
    if (!byTop[top]) byTop[top] = [];
    byTop[top].push(rest.length ? rest.join('.') : p);
  }

  const out = [];
  const listOnly = (top, names, note) => {
    out.push(`${top}:` + (note ? `   # ${note}` : ''));
    out.push(`  名单（${names.length} 个，状态按需查询）: ${names.join('、')}`);
  };

  for (const top of Object.keys(byTop)) {
    const subs = byTop[top];
    if (top === 'events') {
      const names = subs.filter(s => s.endsWith('.status')).map(s => s.replace(/\.status$/, ''));
      /**
       * "当前剧情"＝ ongoing 的那个 + **下一个**还没开始的。
       *
       * 只要这两个：AI 需要知道现在演到哪、下一步该推进什么；
       * 其余事件每轮复核 status/deviation 是纯浪费（而且变更本来就会在
       * 对话里体现，需要时按名字查一次即可）。
       *
       * ⚠️ 顺序要紧：先把 ongoing 收进来，再从"不在集合里"的 pending 里取下一个，
       * 否则会把列表最前面的那个（未必是下一个）也收进来。
       */
      const live = new Set(names.filter(n => variables?.events?.[n]?.status === 'ongoing'));
      const nextPending = names.find(n => !live.has(n) && variables?.events?.[n]?.status === 'pending');
      if (nextPending) live.add(nextPending);

      const liveSubs = subs.filter(s => live.has(s.split('.')[0]));
      const restNames = names.filter(n => !live.has(n));
      out.push('events:');
      for (const sub of liveSubs) out.push(`  ${sub}: {{get_message_variable::stat_data.events.${sub}}}`);
      if (restNames.length) {
        out.push(`  # 其余 ${restNames.length} 个事件（不在当前剧情里，需要时再查）：${restNames.join('、')}`);
      }
      continue;
    }
    out.push(`${top}:`);
    for (const sub of subs) out.push(`  ${sub}: {{get_message_variable::stat_data.${top}.${sub}}}`);
  }

  // 兜底：整体还是太长就只列名字（宁可少给上下文，也不要顶爆 B 包预算）
  if (out.length > maxLines) {
    const condensed = [];
    for (const top of Object.keys(byTop)) {
      const names = [...new Set(byTop[top].map(s => s.split('.')[0]))];
      listOnly(top, names, '字段过多，已折叠为名单');
    }
    return condensed;
  }
  return out;
}

/** 变量更新规则条目（原 B2，改为可直接放进世界书的完整规则） */
export function buildVariableUpdateRule(variables) {
  const lines = [];
  lines.push('task: 在每次回复末尾输出 <update> 标签，按以下规则更新变量');
  lines.push('');
  lines.push('<status_current_variables>');
  lines.push(...condenseVariablePaths(variables));
  lines.push('</status_current_variables>');
  lines.push('');
  lines.push('rule: you must output variable update analysis in the end of the next reply');
  lines.push('');
  lines.push('check list:');
  lines.push(`  - update 'world.time' 剧情推进后更新`);
  lines.push(`  - update 'world.date.text' 出现「几月几日」时同步更新（状态栏显示的是它）`);
  lines.push(`  - update 'world.phase' 关键事件完成后切换，取值为「角色阶段」条目中定义的阶段名`);
  lines.push(`  - update 'events.<事件名>.status' pending → ongoing → done / diverged`);
  lines.push(`  - update 'events.<事件名>.deviation' 用户每做出与原作不同的关键选择，+20~40`);
  lines.push(`  - update 'characters.<人名>.affinity' 0-100，根据互动 ±(3~6)`);
  lines.push(`  - update 'characters.<人名>.state' 剧情导致的状态变化`);
  // 故事线已搬进世界书（[storyline] 条目），变量树里不再有 custom.storylines。
  // 这里刻意不再列它 —— 让 AI 更新一个不存在的字段只会产生无效 diff。
  lines.push('');
  lines.push('format: |-');
  lines.push('  <update>');
  lines.push('  <update_analysis>$(IN ENGLISH, no more than 80 words)');
  lines.push('  - 判断本轮推进了哪些事件');
  lines.push('  - 判断用户是否干预了原著走向');
  lines.push('  - 逐一检查每个变量的变化');
  lines.push('  </update_analysis>');
  lines.push('  _.set(stat_data.world.time, "${旧值}", "${新值}"); // ${理由}');
  lines.push('  _.set(stat_data.events.${事件名}.status, "${旧值}", "${新值}"); // ${理由}');
  lines.push('  _.set(stat_data.events.${事件名}.deviation, ${旧值}, ${新值}); // ${理由}');
  lines.push('  _.set(stat_data.characters.${人名}.affinity, ${旧值}, ${新值}); // ${理由}');
  lines.push('  </update>');
  return lines.join('\n');
}

/** 变量更新强调条目 */
export function buildUpdateEmphasis() {
  return [
    '---',
    '变量更新强调:',
    '  rule: the following must be inserted to the end of each reply and cannot be omitted',
    '  format: |-',
    '    <update>',
    '    ...',
    '    </update>',
  ].join('\n');
}

/**
 * 导演指令条目（原 B3，按 userMode 选择变体）。
 * 内容为运行时 EJS，读取变量决定当前事件与推进方式。
 */
export function buildDirectorEJS(userMode, events) {
  const base = userMode === 'participant' ? B3_PARTICIPANT
    : userMode === 'observer' ? B3_OBSERVER
    : B3_PROTAGONIST;
  const list = Array.isArray(events) ? events : [];
  if (!list.length) return base;
  // 事件清单只作为兜底参考；运行时仍以 stat_data.events 为准
  return `${base}

【事件清单】
${list.map(e => `- ${e.name}`).join('\n')}`;
}

/**
 * 角色阶段条目（原 B4）：按 stat_data.world.phase 输出该阶段的人设增量。
 */
export function buildPersonaPhaseEJS(phases) {
  return generateB4(phases || []);
}

/** 围栏与隔离条目（原 B5_3） */
export function buildFenceRules() {
  return B5_3;
}

/** 干预与偏离度条目（按 userMode 选择变体） */
export function buildInterventionRules(userMode) {
  return userMode === 'observer' ? B5_4_OBSERVER : B5_4;
}

/**
 * Step 8.5 的提示词：生成角色卡的基础字段。
 * 与其它 Step 一样，输入数据由 pipeline 拼好后传进来。
 */
export function buildCharacterCardFieldsPrompt({
  firstEvent = null,
  protagonist = null,
  userMode = 'protagonist',
  worldbook = [],
  excerpt = '',
} = {}) {
  const worldLines = worldbook.length
    ? worldbook.slice(0, 5).map(w => `- ${w.name}：${String(w.content || '').split(/[。\n]/)[0]}。`).join('\n')
    : '（无世界观条目）';

  return `基于以下信息，生成 SillyTavern 角色卡的基础字段。

输入：

时间线首事件：${firstEvent ? `${firstEvent.name}（${firstEvent.time || '时间未定'}）` : '（无）'}

主角：${protagonist || '无明确主角'}

user 模式：${userMode}

世界观摘要：
${worldLines}

前 3 章原文：
${excerpt || '（无原文）'}

输出 JSON：
{
  "description": "200-400字，描述这个世界的核心设定和主角，用作角色卡的 description 字段",
  "personality": "150-300字。protagonist 模式下描述主角性格；participant/observer 模式下描述世界意志或主角作为 NPC 的性格",
  "scenario": "200-400字，描述故事的开场情境",
  "first_mes": "400-800字，角色卡的第一条消息。participant/observer 模式下写成'你进入这个世界'的场景，protagonist 模式下写成主角的开场动作",
  "alternate_greetings": [
    "另起一个开场分支，300-600字",
    "另一个分支"
  ],
  "mes_example": "可选。用 <START> 分隔的对话示例，2-3 组",
  "tags": ["标签1", "标签2"]
}

规则：
- 不要写成小说文本，要像角色卡的字段
- first_mes 必须停在"等用户行动"的位置，不要写完整场景
- alternate_greetings 至少 2 个，最多 5 个
- tags 3-8 个，反映作品类型
- first_mes 不要包含状态栏 HTML（状态栏由 AI 每轮输出）`;
}