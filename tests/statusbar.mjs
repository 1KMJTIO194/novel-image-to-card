/**
 * Step 7.5 · 状态栏生成器 + 正则体系 测试
 *
 * 覆盖设计文档第九节第 9 条列出的六项：
 *   字段识别 / 布局决策 / 主题选择 / HTML 生成 / 7 条正则 / 纯文本降级版
 * 外加：校验清单 1-10、与 Step 8 的对接（B5-5、regex_scripts、tavern_helper）。
 *
 * 运行：node tests/statusbar.mjs
 */
import { JSDOM } from 'jsdom';
import {
  generateStatusbar,
  buildStatusbar,
  selectDisplayFields,
  decideLayout,
  pickTheme,
  buildRegexScripts,
  buildPlainText,
  buildBodyBeautify,
  validateStatusbar,
  checkHtmlSyntax,
  checkPaths,
  checkMacros,
  checkClassPairing,
  checkPrefixedSelectors,
  escapeHtml,
  isDisplayable,
  mapToGroup,
  PLACEHOLDER,
  BODY_WRAPPER,
  THEMES,
} from '../src/step75_statusbar.js';
import { assembleCharacterCard } from '../src/pipeline.js';
import { buildOutputDiscipline, B5_5 } from '../src/templates.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}

/**
 * 真实变量树形状。
 * 来自 pipeline 的 buildVariables + initializeUserNamespace：
 *   world{time,phase} / events{...} / characters{名:{affinity,state}} / custom{storylines} / user{...}
 */
function realVariables(extra = {}) {
  return {
    world: { time: '第三日黄昏', phase: '起始' },
    events: { 开场: { status: 'ongoing', deviation: 0, pressure: 'buffer' } },
    characters: { 沈砚: { affinity: 0, state: '正常' }, 苏九: { affinity: 0, state: '正常' } },
    custom: { storylines: { 主线: { stage: '开场', core: true } } },
    user: { name: '{{user}}', watching: '主角' },
    ...extra,
  };
}

/** 文档第八节「御兽世界」那种丰富的变量树 */
const RICH_VARIABLES = {
  角色信息: { 姓名: '林昭', 种族: '人族', 性别: '女', 年龄: 19, 位置: '云京', 时间: '第三日黄昏' },
  角色职业: { 御兽师天赋: '双生灵契', 御兽师等级: 3, 御兽空间等级: 2 },
  物品栏: ['青锋剑', '回春丹'],
  宠兽: [{ 名称: '雪团', 等阶: '二阶' }],
  人际关系: [{ 姓名: '沈砚', 好感: 42 }],
};

// ============================================================
console.log('\n【1】变量树里没有 status/events/custom 泄漏');
{
  const fields = selectDisplayFields(realVariables());
  const paths = fields.map(f => f.path);
  ok('排除 events 命名空间', !paths.some(p => p.startsWith('stat_data.events')), paths.join(','));
  ok('排除 custom 命名空间', !paths.some(p => p.startsWith('stat_data.custom')), paths.join(','));
  ok('world 字段被选中', paths.includes('stat_data.world.time'));
  ok('characters 字段被选中', paths.includes('stat_data.characters.沈砚'));
  ok('user 字段被选中', paths.includes('stat_data.user.name'));

  // 元信息关键词
  const withMeta = realVariables({
    characters: {
      沈砚: { affinity: 0, state: '正常', deviation: 10 },
      苏九: { affinity: 0, core: true, pressure: 'buffer', status: 'pending' },
    },
  });
  const sub = selectDisplayFields(withMeta)
    .filter(f => f.valueType === 'record')
    .flatMap(f => f.subKeys || []);
  ok('子字段排除 deviation', !sub.includes('deviation'), sub.join(','));
  ok('子字段排除 pressure', !sub.includes('pressure'));
  ok('子字段排除 core', !sub.includes('core'));
  ok('子字段排除 status', !sub.includes('status'));
  ok('保留 affinity / state', sub.includes('affinity') && sub.includes('state'));

  // 空值
  ok('空字符串不算可展示', !isDisplayable('x', '   '));
  ok('null 不算可展示', !isDisplayable('x', null));
  ok('空数组不算可展示', !isDisplayable('x', []));
  ok('数字 0 算可展示', isDisplayable('x', 0));
  ok('false 算可展示', isDisplayable('x', false));
}

// ============================================================
console.log('\n【2】分组归类（中英命名空间都要能分对）');
{
  ok('characters → relations', mapToGroup('characters', '沈砚') === 'relations');
  ok('world → profile', mapToGroup('world', 'time') === 'profile');
  ok('user → profile', mapToGroup('user', 'name') === 'profile');
  ok('物品栏 → items', mapToGroup('角色信息', '物品栏') === 'items');
  ok('宠兽 → pets', mapToGroup('角色信息', '宠兽') === 'pets');
  ok('人际关系 → relations', mapToGroup('角色信息', '人际关系') === 'relations');
  ok('御兽师等级 → class', mapToGroup('角色职业', '御兽师等级') === 'class');
  ok('unknown → misc', mapToGroup('foo', 'bar') === 'misc');

  const fields = selectDisplayFields(realVariables());
  const groupList = [...new Set(fields.map(f => f.group))];
  ok('真实变量树至少分出 2 组（不会只剩"其他"）', groupList.length >= 2, groupList.join(','));
  ok('真实变量树含 relations 组', groupList.includes('relations'), groupList.join(','));
}

// ============================================================
console.log('\n【3】布局决策');
{
  const one = [{ group: 'profile', key: 'a', valueType: 'primitive', path: 'stat_data.a' }];
  ok('≤1 组 → single', decideLayout(one).layout === 'single');
  ok('≤1 组 → 1 页', decideLayout(one).tabCount === 1);

  const two = [
    { group: 'profile', key: 'a', valueType: 'primitive', path: 'stat_data.a' },
    { group: 'items', key: 'b', valueType: 'primitive', path: 'stat_data.b' },
  ];
  ok('2 组 → tabs', decideLayout(two).layout === 'tabs');
  ok('2 组 → 2 页', decideLayout(two).tabCount === 2);

  const three = [...two, { group: 'pets', key: 'c', valueType: 'primitive', path: 'stat_data.c' }];
  ok('3 组 → 3 页', decideLayout(three).tabCount === 3);
  ok('默认第一页 active', decideLayout(three).tabs[0].active === true);
  ok('其它页不 active', decideLayout(three).tabs.slice(1).every(t => !t.active));

  // 7 个组，其中两个是"大组"（≥2 字段），其余单字段
  const many = [];
  const groups = ['profile', 'class', 'items', 'pets', 'relations', 'skills', 'missions'];
  groups.forEach((g, i) => {
    many.push({ group: g, key: `${g}a`, valueType: 'primitive', path: `stat_data.${g}a` });
    if (i < 2) many.push({ group: g, key: `${g}b`, valueType: 'primitive', path: `stat_data.${g}b` });
  });
  const lay = decideLayout(many);
  ok('>3 组合并后仍在 3-5 页', lay.tabCount >= 3 && lay.tabCount <= 5, String(lay.tabCount));
  const totalFields = lay.tabs.reduce((s, t) => s + t.fields.length, 0);
  ok('合并不丢字段', totalFields === many.length, `${totalFields} vs ${many.length}`);
  const seen = new Set(lay.tabs.flatMap(t => t.fields.map(f => f.key)));
  ok('合并后字段不重复', seen.size === many.length, `${seen.size} vs ${many.length}`);
  ok('页数等于 tabs 长度', lay.tabs.length === lay.tabCount);
}

// ============================================================
console.log('\n【4】主题选择');
{
  const cases = [
    ['修仙', 'xianxia'], ['御兽', 'xianxia'], ['仙侠', 'xianxia'], ['武侠', 'xianxia'],
    ['校园', 'campus'], ['青春日常', 'campus'],
    ['悬疑', 'mystery'], ['推理', 'mystery'], ['恐怖', 'mystery'],
    ['科幻', 'scifi'], ['赛博朋克', 'scifi'],
    ['奇幻', 'fantasy'], ['西幻', 'fantasy'],
    ['都市', 'urban'], ['现代职场', 'urban'],
  ];
  for (const [g, want] of cases) {
    const got = pickTheme(g).key;
    ok(`「${g}」→ ${want}`, got === want, got);
  }
  ok('未知类型 → default', pickTheme('').key === 'default');
  ok('default 兜底到 urban 配色', pickTheme('').bg === THEMES.urban.bg);
  ok('6 个主题 + default 都在', ['xianxia', 'urban', 'campus', 'mystery', 'scifi', 'fantasy', 'default']
    .every(k => THEMES[k] && THEMES[k].bg && THEMES[k].accent && THEMES[k].secondary
      && THEMES[k].text && THEMES[k].pattern && THEMES[k].font && THEMES[k].title));
  // 用一个不含任何类型关键词的串，才能验证"真的走了兜底"
  ok('无类型关键词 → default', pickTheme('ABC123').key === 'default');
  ok('default 与 urban 同配色但 key 不同',
    THEMES.default.bg === THEMES.urban.bg && THEMES.default.key !== THEMES.urban.key);
}

// ============================================================
console.log('\n【5】HTML 生成与结构');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: '御兽世界' });
  const html = r.statusbar.html;
  ok('HTML 以 <!DOCTYPE html> 开头', html.trim().startsWith('<!DOCTYPE html>'));
  ok('HTML 以 </html> 结尾', html.trim().endsWith('</html>'));
  ok('含 <meta charset="UTF-8">', html.includes('<meta charset="UTF-8">'));
  ok('script 用 type="module"', /<script type="module">/.test(html));
  ok('使用 waitGlobalInitialized', html.includes("waitGlobalInitialized('Mvu')"));
  ok('使用 errorCatched', html.includes('errorCatched'));
  ok('定义了 escapeHtml', /function\s+escapeHtml\s*\(/.test(html));
  ok('无 HTML 语法错误', checkHtmlSyntax(html).length === 0, checkHtmlSyntax(html).join('；'));

  // jsdom 真解析
  //
  // ⚠️ 所有 class 都带 `custom-` 前缀：ST 的 DOMPurify 钩子会把消息里的
  // class 改写成 `custom-<原名>`，而 `<style>` 里的选择器不会被改写。
  // 两边都写 `custom-xxx` 才能在两种情况下都匹配（详见 src/step75_statusbar.js 顶部注释）。
  const dom = new JSDOM(html);
  const d = dom.window.document;
  const tabCount = r.statusbar.tabCount;
  ok('radio 数量 == 标签页数', d.querySelectorAll('input.custom-tab-radio').length === tabCount);
  ok('label 数量 == 标签页数', d.querySelectorAll('label.custom-tab-button-nav').length === tabCount);
  ok('pane 数量 == 标签页数', d.querySelectorAll('.custom-tab-pane-content').length === tabCount);
  ok('恰好一个 radio 默认 checked', d.querySelectorAll('input.custom-tab-radio:checked').length === 1);
  ok('每个 label 都指向存在的 radio',
    [...d.querySelectorAll('label.custom-tab-button-nav')].every(l => d.getElementById(l.getAttribute('for'))));
  ok('radio 与 wrapper 同级（CSS 兄弟选择器可用）',
    [...d.querySelectorAll('input.custom-tab-radio')].every(i => i.parentElement === d.querySelector('.custom-panel-container')));
  ok('radio 在 wrapper 之前',
    [...d.querySelectorAll('input.custom-tab-radio')].every(i =>
      i.compareDocumentPosition(d.querySelector('.custom-tab-content-wrapper')) & 4 /* DOCUMENT_POSITION_FOLLOWING */));

  const css = d.querySelector('style').textContent;
  for (let i = 0; i < tabCount; i++) {
    ok(`CSS 有第 ${i} 页显隐规则`,
      css.includes(`#sb-tab-${i}:checked ~ .custom-tab-content-wrapper [data-pane="${i}"]`));
  }
  ok('单页时不生成 radio 规则', !buildStatusbar({ variables: { world: { time: 'x' } } }).html.includes('sb-tab-0:checked'));

  // 无 JS 也能用：panes 的内容是服务端生成的，不靠脚本
  ok('pane 里有真实的 data-value 节点', d.querySelectorAll('.custom-data-value').length > 0);
  ok('值用 ST 宏而非 JS 渲染', d.querySelectorAll('.custom-data-value')[0].textContent.includes('get_message_variable::'));
  ok('顶部信息栏有内容', (d.querySelector('.custom-header-info-bar')?.textContent || '').trim().length > 0);
  ok('结果里带字段清单（供落盘 statusbar.json 用）',
    Array.isArray(r.statusbar.fields) && r.statusbar.fields.length === r.statusbar.fieldCount);
  ok('裸构建器用 displayFields 命名（避开内部 fields 变量）',
    Array.isArray(buildStatusbar({ variables: realVariables() }).displayFields));
  ok('字段清单含 path / group / valueType',
    r.statusbar.fields.every(f => typeof f.path === 'string' && typeof f.group === 'string'
      && typeof f.valueType === 'string'));
}

// ============================================================
console.log('\n【6】值路径与宏（校验清单 2 / 8）');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: 'W' });
  ok('所有 stat_data 路径都存在', checkPaths(r.statusbar.html, realVariables()).length === 0,
    checkPaths(r.statusbar.html, realVariables()).join(','));
  ok('HTML 里没有非 ST 宏的 {{ }}', checkMacros(r.statusbar.html).length === 0,
    checkMacros(r.statusbar.html).join(' | '));
  ok('纯文本里没有非 ST 宏的 {{ }}', checkMacros(r.statusbar.plainText).length === 0);
  ok('纯文本路径都存在', checkPaths(r.statusbar.plainText, realVariables()).length === 0);

  // 反向：路径不存在时必须报错
  const broken = '<div class="data-value">{{get_message_variable::stat_data.nope.x}}</div>';
  ok('路径不存在时能被查出', checkPaths(broken, realVariables()).length === 1);
  ok('非 stat_data 命名空间能被查出',
    checkPaths('<i>{{get_message_variable::foo.bar}}</i>', realVariables()).length === 1);
  ok('非 ST 宏的 {{ }} 能被查出', checkMacros('<b>{{ someVue }}</b>').length === 1);
  ok('format_message_variable 也算合法宏',
    checkMacros('<b>{{format_message_variable::stat_data}}</b>').length === 0);
}

// ============================================================
console.log('\n【7】纯文本降级版');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: '御兽世界', characterName: '沈砚' });
  const t = r.statusbar.plainText;
  ok('含分隔线', t.includes('━'));
  ok('含作品名', t.includes('御兽世界'));
  ok('含分组标题', t.includes('【角色档案】') && t.includes('【因缘簿】'));
  ok('含 ST 宏取值', t.includes('{{get_message_variable::stat_data.world.time}}'));
  ok('record 展开成子项', t.includes('{{get_message_variable::stat_data.characters.沈砚.affinity}}'));
  ok('不含 HTML 标签', !/<[a-z/][^>]*>/i.test(t), (t.match(/<[a-z/][^>]*>/i) || [''])[0]);
  ok('多行', t.split('\n').length >= 6, String(t.split('\n').length));

  const empty = buildPlainText([], { tabs: [] }, { worldName: 'X' });
  ok('无字段时给出提示', empty.includes('暂无可展示的字段'));
}

// ============================================================
console.log('\n【8】7 条正则');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: 'W' });
  const rs = r.regexScripts;
  ok('恰好 7 条', rs.length === 7, String(rs.length));

  const ids = rs.map(s => s.id);
  ok('id 互不重复', new Set(ids).size === 7, ids.join(','));
  ok('id 与文档一致', ['regex_thinking_hide', 'regex_update_hide', 'regex_body_prompt_hide',
    'regex_statusbar_prompt_hide', 'regex_body_beautify', 'regex_statusbar_html', 'regex_statusbar_text']
    .every(id => ids.includes(id)), ids.join(','));
  ok('每条都有 id 和 scriptName', rs.every(s => s.id && s.scriptName));

  // 执行顺序（文档 4.3）
  ok('顺序：正文prompt隐藏 在 正文美化 之前', ids.indexOf('regex_body_prompt_hide') < ids.indexOf('regex_body_beautify'));
  ok('顺序：正文prompt隐藏 在 状态栏prompt隐藏 之前', ids.indexOf('regex_body_prompt_hide') < ids.indexOf('regex_statusbar_prompt_hide'));
  ok('顺序：状态栏prompt隐藏 在 状态栏美化 之前', ids.indexOf('regex_statusbar_prompt_hide') < ids.indexOf('regex_statusbar_html'));
  ok('顺序：状态栏美化 在 状态栏纯文本 之前', ids.indexOf('regex_statusbar_html') < ids.indexOf('regex_statusbar_text'));

  // 每条的结构
  ok('placement 都是 [1] / [2] / [1,2]',
    rs.every(s => ['[1]', '[2]', '[1,2]'].includes(JSON.stringify(s.placement))),
    rs.map(s => JSON.stringify(s.placement)).join(','));
  ok('都有 trimStrings 数组', rs.every(s => Array.isArray(s.trimStrings)));
  ok('都是 substituteRegex 0', rs.every(s => s.substituteRegex === 0));
  ok('都有 disabled / markdownOnly / promptOnly / runOnEdit 布尔值',
    rs.every(s => typeof s.disabled === 'boolean' && typeof s.markdownOnly === 'boolean'
      && typeof s.promptOnly === 'boolean' && typeof s.runOnEdit === 'boolean'));
  ok('都有 findRegex', rs.every(s => typeof s.findRegex === 'string' && s.findRegex.length > 0));

  const byId = Object.fromEntries(rs.map(s => [s.id, s]));

  // 1 思维链
  ok('思维链隐藏 placement [2]', JSON.stringify(byId.regex_thinking_hide.placement) === '[2]');
  ok('思维链隐藏 markdownOnly+promptOnly', byId.regex_thinking_hide.markdownOnly === true
    && byId.regex_thinking_hide.promptOnly === true);
  ok('思维链隐藏 runOnEdit true', byId.regex_thinking_hide.runOnEdit === true);
  ok('思维链隐藏替换为空', byId.regex_thinking_hide.replaceString === '');
  ok('思维链隐藏能吃 <thinking>（本项目实际标签）',
    new RegExp(byId.regex_thinking_hide.findRegex.replace(/^\/|\/gsi$/g, ''), 'gsi')
      .test('<thinking>内心独白</thinking>'));

  // 2 变量更新
  ok('变量更新隐藏 runOnEdit false', byId.regex_update_hide.runOnEdit === false);
  ok('变量更新隐藏 placement [2]', JSON.stringify(byId.regex_update_hide.placement) === '[2]');
  ok('变量更新隐藏替换为空', byId.regex_update_hide.replaceString === '');

  // 3 正文 prompt 隐藏
  ok('正文prompt隐藏 minDepth 8', byId.regex_body_prompt_hide.minDepth === 8);
  ok('正文prompt隐藏 maxDepth null', byId.regex_body_prompt_hide.maxDepth === null);
  ok('正文prompt隐藏 placement [1,2]', JSON.stringify(byId.regex_body_prompt_hide.placement) === '[1,2]');
  ok('正文prompt隐藏保留文本（$1）', byId.regex_body_prompt_hide.replaceString === '$1');

  // 4 状态栏 prompt 隐藏
  ok('状态栏prompt隐藏匹配占位符', byId.regex_statusbar_prompt_hide.findRegex === PLACEHOLDER);
  ok('状态栏prompt隐藏替换为空格', byId.regex_statusbar_prompt_hide.replaceString === ' ');
  ok('状态栏prompt隐藏 markdownOnly false', byId.regex_statusbar_prompt_hide.markdownOnly === false);
  ok('状态栏prompt隐藏 promptOnly true', byId.regex_statusbar_prompt_hide.promptOnly === true);

  // 5 正文美化
  ok('正文美化 maxDepth 8', byId.regex_body_beautify.maxDepth === 8);
  ok('正文美化 minDepth null', byId.regex_body_beautify.minDepth === null);
  ok('正文美化 markdownOnly true / promptOnly false',
    byId.regex_body_beautify.markdownOnly === true && byId.regex_body_beautify.promptOnly === false);

  // 6 状态栏美化
  const beauty = byId.regex_statusbar_html;
  ok('状态栏美化匹配占位符', beauty.findRegex === PLACEHOLDER);
  ok('状态栏美化 replaceString 以 ``` 开头', beauty.replaceString.startsWith('```'));
  ok('状态栏美化 replaceString 以 ``` 结尾', beauty.replaceString.trimEnd().endsWith('```'));
  ok('状态栏美化 maxDepth 3', beauty.maxDepth === 3);
  ok('状态栏美化内含生成的 HTML', beauty.replaceString.includes(r.statusbar.html));
  ok('状态栏美化 disabled false', beauty.disabled === false);

  // 7 状态栏纯文本
  ok('状态栏纯文本 disabled true', byId.regex_statusbar_text.disabled === true);
  ok('状态栏纯文本 maxDepth 3', byId.regex_statusbar_text.maxDepth === 3);
  ok('状态栏纯文本匹配占位符', byId.regex_statusbar_text.findRegex === PLACEHOLDER);
  ok('状态栏纯文本含纯文本版', byId.regex_statusbar_text.replaceString === r.statusbar.plainText);

  // 正则本身能跑
  const strip = (script, s) => s.replace(new RegExp(script.findRegex.replace(/^\/|\/gsi$/g, ''), 'gsi'), script.replaceString);
  ok('思维链隐藏正则能吃掉 <thinking>',
    strip(byId.regex_thinking_hide, '前<thinking>想</thinking>后') === '前后');
  ok('思维链隐藏正则能吃掉 <disclaimer>',
    strip(byId.regex_thinking_hide, '前<disclaimer>免责</disclaimer>后') === '前后');
  ok('正文prompt隐藏正则只去标签留文本',
    strip(byId.regex_body_prompt_hide, 'A<zhengwen>正文</zhengwen>B') === 'A正文B');
  ok('正文美化正则把 $1 填进卡片',
    strip(byId.regex_body_beautify, '<zhengwen>正文</zhengwen>').includes('>正文</div>'));
  ok('正文美化正则不残留 zhengwen 标签',
    !strip(byId.regex_body_beautify, '<zhengwen>正文</zhengwen>').includes('<zhengwen>'));
}

// ============================================================
console.log('\n【9】校验清单 1-10');
{
  const vars = realVariables();
  const r = await generateStatusbar({ variables: vars, genre: '仙侠', worldName: 'W' });
  ok('正常产出无 errors', r.validation.errors.length === 0, r.validation.errors.join('；'));
  ok('正常产出无 warnings', r.validation.warnings.length === 0, r.validation.warnings.join('；'));

  const vt = (patch) => validateStatusbar({ ...r, ...patch }, vars);

  ok('清单1 HTML 语法坏掉会被查出',
    vt({ html: '<!DOCTYPE html><html><body><div></body></html>' }).errors.some(e => e.includes('状态栏 HTML')));
  ok('清单2 路径不存在会被查出',
    vt({ html: '<!DOCTYPE html><html><body><i>{{get_message_variable::stat_data.zzz}}</i></body></html>' })
      .errors.some(e => e.includes('不存在')));
  ok('清单3 正则缺 id 会被查出',
    vt({ regexScripts: r.regexScripts.map((s, i) => (i === 0 ? { ...s, id: '' } : s)) })
      .errors.some(e => e.includes('缺少 id')));
  ok('清单3 正则缺 scriptName 会被查出',
    vt({ regexScripts: r.regexScripts.map((s, i) => (i === 0 ? { ...s, scriptName: '' } : s)) })
      .errors.some(e => e.includes('scriptName')));
  ok('清单4 placement 非法会被查出',
    vt({ regexScripts: r.regexScripts.map((s, i) => (i === 0 ? { ...s, placement: [1, 2, 3] } : s)) })
      .errors.some(e => e.includes('placement')));
  ok('清单5 美化正则没 ``` 会被警告',
    vt({ regexScripts: r.regexScripts.map(s => (s.id === 'regex_statusbar_html' ? { ...s, replaceString: s.replaceString.slice(3) } : s)) })
      .warnings.some(w => w.includes('```')));
  ok('清单6 纯文本正则被启用会被警告',
    vt({ regexScripts: r.regexScripts.map(s => (s.id === 'regex_statusbar_text' ? { ...s, disabled: false } : s)) })
      .warnings.some(w => w.includes('纯文本')));
  ok('清单8 非 ST 宏会被查出',
    vt({ html: '<!DOCTYPE html><html><body><i>{{abc}}</i></body></html>' })
      .errors.some(e => e.includes('非 ST 宏')));
  ok('清单9 script 缺 type=module 会被警告',
    vt({ html: '<!DOCTYPE html><html><body><script>var a=1;</script></body></html>' })
      .warnings.some(w => w.includes('module')));
  ok('清单9 空 script 标签只报一条（不重复报）',
    vt({ html: '<!DOCTYPE html><html><body><script></script></body></html>' })
      .warnings.filter(w => w.includes('module')).length === 1);
  // 说明：注释里写出 `<script>` 字样**会**触发这条警告。这是刻意接受的假阳性 ——
  // 要区分"注释里的字样"和"真的标签"得写真正的 HTML 解析器，而这条本身只是警告，
  // 代价（重写一个解析器）远大于收益（少一条可能多余的警告）。
  ok('清单9 注释里的标签字样会触发警告（已知假阳性，记此防回退）',
    vt({ html: '<!DOCTYPE html><html><body><script type="module">\n// 这里提到 <script> 三个字\n</script></body></html>' })
      .warnings.some(w => w.includes('module')));
  ok('清单9 type=module 的标签本身不报',
    validateStatusbar({
      ...r,
      html: '<!DOCTYPE html><html><body><script type="module">var a=1;</script></body></html>',
    }, vars).warnings.filter(w => w.includes('module')).length === 0);
  ok('清单10 escapeHtml 缺失会被警告',
    vt({ html: '<!DOCTYPE html><html><body><i>x</i></body></html>' })
      .warnings.some(w => w.includes('escapeHtml')));
  ok('正则条数不对会被查出', vt({ regexScripts: r.regexScripts.slice(0, 3) }).errors.some(e => e.includes('7')));
  ok('缺状态栏美化正则会被查出',
    vt({ regexScripts: r.regexScripts.filter(s => s.id !== 'regex_statusbar_html') })
      .errors.some(e => e.includes('状态栏美化')));
}

// ============================================================
console.log('\n【10】占位符与正文包裹标签');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: 'W' });
  ok('placeholder == <StatusPlaceHolderImpl/>', r.placeholder === '<StatusPlaceHolderImpl/>');
  ok('bodyWrapper.open == <zhengwen>', r.bodyWrapper.open === '<zhengwen>');
  ok('bodyWrapper.close == </zhengwen>', r.bodyWrapper.close === '</zhengwen>');
  ok('与模块常量一致', r.placeholder === PLACEHOLDER
    && r.bodyWrapper.open === BODY_WRAPPER.open && r.bodyWrapper.close === BODY_WRAPPER.close);
}

// ============================================================
console.log('\n【11】Step 8 对接：B5-5 输出纪律');
{
  const r = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: 'W' });
  const withSb = buildOutputDiscipline(r);
  ok('带状态栏时写入占位符', withSb.includes('<StatusPlaceHolderImpl/>'));
  ok('带状态栏时写入 <zhengwen>', withSb.includes('<zhengwen>'));
  ok('带状态栏时写入 </zhengwen>', withSb.includes('</zhengwen>'));
  ok('保留 <update> 纪律', withSb.includes('<update>'));
  ok('保留 <thinking>', withSb.includes('<thinking>'));
  ok('保留写作纪律', withSb.includes('不替用户做决定'));
  ok('占位符出现在输出顺序清单里（不只出现在纪律段）',
    withSb.includes('<update>变量更新</update>\n  <StatusPlaceHolderImpl/>'),
    JSON.stringify(withSb.split('<update>变量更新</update>')[1]?.slice(0, 60)));
  ok('占位符排在 <update> 之后（与纪律段文字一致）',
    withSb.indexOf('<StatusPlaceHolderImpl/>', withSb.indexOf('固定输出顺序'))
      > withSb.indexOf('<update>变量更新</update>'));
  ok('明确要求占位符是整段回复的最后一行', withSb.includes('最后一行'));
  ok('明确禁止把占位符写进正文', withSb.includes('不要把占位符写进'));

  ok('不带状态栏时退回原 B5_5', buildOutputDiscipline() === B5_5);
  ok('空对象也退回原 B5_5', buildOutputDiscipline({}) === B5_5);
  ok('原 B5_5 本身不含占位符', !B5_5.includes('StatusPlaceHolderImpl'));
}

// ============================================================
console.log('\n【12】Step 8 对接：assembleCharacterCard');
{
  const mkCtx = (statusbar) => ({
    timeline: { base: '相对纪元', origin: null, events: [{ name: '开场', time: '第三日', chapter: 1 }], characters: [] },
    events: [{ name: '开场', pressure: 'core', time: '第三日' }],
    characters: [{ name: '沈砚', role: '主角', keys: ['沈砚'], content: '剑修。' }],
    worldbook: [{ name: '云京', category: 'map_world', constant: true, content: '主城。', keys: [] }],
    variables: realVariables(),
    phasesWithDeltas: [{ name: '起始', characterDeltas: [] }],
    userMode: { mode: 'protagonist', protagonistName: '沈砚' },
    cardFields: { name: '测试卡', description: 'd', personality: 'p', scenario: 's', first_mes: 'f', tags: [] },
    statusbar,
  });

  const sb = await generateStatusbar({ variables: realVariables(), genre: '仙侠', worldName: '测试卡' });
  const card = assembleCharacterCard(mkCtx(sb));
  const ext = card.data.extensions;

  ok('regex_scripts 写入 7 条', ext.regex_scripts.length === 7, String(ext.regex_scripts.length));
  ok('regex_scripts 就是 Step 7.5 的产出', ext.regex_scripts === sb.regexScripts);
  ok('tavern_helper.scripts 注册了 mvu', Array.isArray(ext.tavern_helper?.scripts)
    && ext.tavern_helper.scripts.length === 1 && ext.tavern_helper.scripts[0].name === 'mvu');
  ok('mvu 脚本 id 固定', ext.tavern_helper.scripts[0].id === 'a86260a6-5f82-4c84-b9ad-564442540716');
  ok('mvu 脚本 enabled true', ext.tavern_helper.scripts[0].enabled === true);
  ok('mvu 脚本 content 指向 MVU bundle',
    ext.tavern_helper.scripts[0].content.includes('MagVarUpdate/artifact/bundle.js'));

  const outEntry = card.data.character_book.entries.find(e => e.comment === '输出纪律');
  ok('世界书里有「输出纪律」条目', !!outEntry);
  ok('输出纪律条目含占位符', outEntry.content.includes('<StatusPlaceHolderImpl/>'));
  ok('输出纪律条目含 <zhengwen>', outEntry.content.includes('<zhengwen>'));

  const initvar = card.data.character_book.entries.find(e => e.comment === '[initvar]勿启用');
  ok('[initvar] 存在', !!initvar);
  ok('[initvar] enabled false（清单 7）', initvar.enabled === false);
  ok('[initvar] constant true', initvar.constant === true);
  ok('[initvar] position before_char', initvar.position === 'before_char');
  ok('[initvar] insertion_order 2', initvar.insertion_order === 2);
  ok('[initvar] extensions 结构', initvar.extensions.position === 0
    && initvar.extensions.depth === 4 && initvar.extensions.prevent_recursion === true);
  ok('[initvar] 内容是变量树的 YAML', initvar.content.includes('characters:') && initvar.content.includes('沈砚'));

  ok('creator_notes 提到状态栏纯文本降级',
    card.data.creator_notes.includes('状态栏纯文本'));
  ok('creator_notes 说明纯文本默认关闭',
    /默认关闭/.test(card.data.creator_notes));
  ok('creator_notes 给出开启方式',
    card.data.creator_notes.includes('Scoped') && card.data.creator_notes.includes('状态栏美化'));
  ok('creator_notes 警告 MVU 缺失时显示 —',
    card.data.creator_notes.includes('"—"') || card.data.creator_notes.includes('"‑"')
    || card.data.creator_notes.includes('—'));
  ok('creator_notes 含导入三件事', card.data.creator_notes.includes('① 导入内嵌世界书')
    && card.data.creator_notes.includes('② 保持') && card.data.creator_notes.includes('③ 放行'));

  // 无 Step 7.5 时不能崩，且退回旧正则
  const bare = assembleCharacterCard(mkCtx(null));
  ok('无 statusbar 时不崩溃', !!bare);
  ok('无 statusbar 时只有 1 条旧正则', bare.data.extensions.regex_scripts.length === 1);
  ok('无 statusbar 时正则隐藏 <update>',
    bare.data.extensions.regex_scripts[0].findRegex.includes('<update'));
  ok('无 statusbar 时 B5-5 不含占位符',
    !bare.data.character_book.entries.find(e => e.comment === '输出纪律').content.includes('StatusPlaceHolderImpl'));
  ok('无 statusbar 时仍注册 mvu', bare.data.extensions.tavern_helper.scripts.length === 1);
}

// ============================================================
console.log('\n【13】降级与边界');
{
  // 空变量树
  const empty = await generateStatusbar({ variables: {}, genre: '', worldName: '' });
  ok('空变量树不崩', !!empty.statusbar.html);
  ok('空变量树无 errors', empty.validation.errors.length === 0, empty.validation.errors.join('；'));
  ok('空变量树 layout single', empty.statusbar.layout === 'single');
  ok('空变量树 HTML 仍是合法 HTML', checkHtmlSyntax(empty.statusbar.html).length === 0);

  // null / undefined 变量树
  const nul = await generateStatusbar({ variables: null });
  ok('variables=null 不崩', !!nul.statusbar.html);
  ok('无参调用不崩', !!(await generateStatusbar()).statusbar.html);

  // 深层嵌套
  const deep = { a: { b: { c: { d: 1 } } } };
  const dr = await generateStatusbar({ variables: deep, worldName: 'D' });
  ok('深层嵌套不崩', !!dr.statusbar.html);
  ok('深层嵌套路径正确', dr.statusbar.html.includes('stat_data.a.b'));

  // 键名含点号（varKey 保证不会，但独立调用时可能）
  const dotted = { characters: { 'a.b': { affinity: 1 } } };
  const dotr = await generateStatusbar({ variables: dotted });
  ok('键名含点号不崩', !!dotr.statusbar.html);

  // HTML 特殊字符必须被转义
  ok('escapeHtml 处理 &<>"\'',
    escapeHtml('<a href="x">&</a>\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;&#39;');
  const evil = await generateStatusbar({ variables: { '<script>': { '<img>': 1 } }, worldName: '<b>X</b>' });
  // 键名与作品名都必须以实体形式出现：
  // `&lt;img&gt;` 里当然含有子串 "<img>"？不 —— 实体形式是 `&lt;`，不含 `<`。
  // 所以直接断言"原样的尖括号形式不存在"就是有效的。
  ok('变量键名里的尖括号被转义', evil.statusbar.html.includes('&lt;img&gt;')
    && !evil.statusbar.html.includes('><img>'));
  ok('作品名里的标签被转义', !evil.statusbar.html.includes('<b>X</b>')
    && evil.statusbar.html.includes('&lt;b&gt;X&lt;/b&gt;'));
  ok('宏路径里的尖括号也被转义（否则会提前闭合标签）',
    !/\{\{get_message_variable::[^}]*[<>]/.test(evil.statusbar.html));
  ok('恶意输入仍无 HTML 语法错误', checkHtmlSyntax(evil.statusbar.html).length === 0,
    checkHtmlSyntax(evil.statusbar.html).join('；'));

  // 正文美化（class 同样带 custom- 前缀，理由见文件头注释）
  ok('正文美化含 custom-pm-card-container',
    buildBodyBeautify(THEMES.xianxia).includes('.custom-pm-card-container'));
  ok('正文美化含 $1 捕获组', buildBodyBeautify(THEMES.xianxia).includes('>$1</div>'));
  ok('正文美化按主题取色', buildBodyBeautify(THEMES.xianxia).includes(THEMES.xianxia.accent));

  /**
   * 防回归：**HTML 用到的 class 必须在 CSS 里有同名选择器**。
   *
   * 这是"背景透明"那个事故的直接防线。根因是 ST 会给消息里的 class 加
   * `custom-` 前缀，而 `<style>` 里的选择器不加 —— 只要两边不一致，
   * 样式就全部静默失配（不报错，只是看起来透明/没样式）。
   */
  for (const theme of Object.keys(THEMES)) {
    const sb = buildStatusbar({ variables: { world: { time: 'x', phase: 'p' }, characters: { 甲: { affinity: 1 } } }, genre: theme });
    ok(`主题 ${theme}：class 与 CSS 选择器一一对应`,
      checkClassPairing(sb.html).length === 0, checkClassPairing(sb.html).join('；'));
    ok(`主题 ${theme}：class 全部带 custom- 前缀`,
      [...sb.html.matchAll(/class="([^"]*)"/g)]
        .flatMap(m => m[1].split(/\s+/))
        .filter(Boolean)
        .every(c => c.startsWith('custom-')),
      JSON.stringify([...sb.html.matchAll(/class="([^"]*)"/g)].flatMap(m => m[1].split(/\s+/)).filter(c => !c.startsWith('custom-'))));

    /**
     * 防回归（"背景透明"的字面原因）：
     * ST 会给消息内 `<custom-style>` 的每条规则选择器加 `.mes_text ` 前缀。
     * 所以 body / 文档根选择器会变成 `.mes_text body` 这种**永不匹配**的规则，
     * 样式静默失效 —— 背景没了、CSS 变量全落空。
     * 背景与变量都必须挂在**容器**上。
     */
    ok(`主题 ${theme}：没有前缀化后永不匹配的选择器`,
      checkPrefixedSelectors(sb.html).length === 0, checkPrefixedSelectors(sb.html).join('；'));
    const cssText = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(sb.html)?.[1] || '';
    ok(`主题 ${theme}：背景渐变挂在容器上`,
      /\.custom-panel-container\{[^}]*background:linear-gradient/s.test(cssText));
    ok(`主题 ${theme}：CSS 变量挂在容器上（不用文档根选择器）`,
      /\.custom-panel-container\{[^}]*--accent-primary:/s.test(cssText));
  }

  // 正文美化同样不能把背景挂在 body 上（同一个坑）
  {
    const bb = buildBodyBeautify(THEMES.xianxia);
    const bbCss = /<style>([\s\S]*?)<\/style>/.exec(bb)?.[1] || '';
    ok('正文美化没有 body 选择器', !/(^|[}])\s*body\s*\{/.test(bbCss), bbCss.slice(0, 80));
    ok('正文美化背景挂在容器上',
      /\.custom-pm-card-container\{[^}]*background:linear-gradient/s.test(bbCss));
    ok('正文美化字体挂在容器上', /\.custom-pm-card-container\{[^}]*font-family:/s.test(bbCss));
    ok('正文美化没有前缀化后永不匹配的选择器', (() => {
      // 复用同一套判据：把 body 包进一个带 <style> 的壳里检查
      return !/(^|[}])\s*(body|html)\s*\{/i.test(bbCss);
    })());
  }
}

// ============================================================
console.log('\n【14】主题影响 HTML');
{
  const vars = realVariables();
  const x = await generateStatusbar({ variables: vars, genre: '仙侠', worldName: 'W' });
  const u = await generateStatusbar({ variables: vars, genre: '都市', worldName: 'W' });
  ok('仙侠与都市配色不同', x.statusbar.html !== u.statusbar.html);
  ok('仙侠主题名进了 statusbar.theme', x.statusbar.theme === 'xianxia');
  ok('都市主题名进了 statusbar.theme', u.statusbar.theme === 'urban');
  ok('主题标题按主题变化', x.statusbar.themeTitle !== u.statusbar.themeTitle);
  ok('标题带上作品名', x.statusbar.html.includes('御兽世界') || x.statusbar.html.includes('W'));
  ok('title 也用了主题标题', x.statusbar.themeTitle.includes('灵兽') || x.statusbar.themeTitle.includes('御兽'));

  // 结果里带 theme 对象（供 buildRegexScripts 用）
  ok('结果返回 theme 对象', x.theme && x.theme.accent === THEMES.xianxia.accent);
  ok('buildRegexScripts 用传入主题', buildRegexScripts({ html: 'H', plainText: 'P', theme: THEMES.mystery })[4]
    .replaceString.includes(THEMES.mystery.accent));
}

// ============================================================
console.log('\n==============================================');
console.log(`  状态栏测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
