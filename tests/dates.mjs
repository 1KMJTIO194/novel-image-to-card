/**
 * 日期解析 / 时间线日期 / 事件触发词 测试
 *
 * 覆盖两处真实故障：
 *   ① 状态栏时间不完整（没有几月几日）—— 因为 `world.time` 是原文片段，
 *      而首条常常只有年份；且裸月日的年份需要按上下文补全
 *   ② 事件只有 1 个触发词（就是事件名本身），正文对话里几乎不出现，剧情大量漏触发
 *
 * 运行：node tests/dates.mjs
 */
import {
  parseDateParts, parseChainedTime, resolveDateYears, formatDate,
  dateTriggerToken, compareDateParts, cnNumToInt, addDays,
} from '../src/dates.js';
import {
  solveTimeline, pickWorldDate, deriveEventKeys, formatEventEntry,
  backfillEventTimes, groupEventsByDay, formatDayEntry, dayEntryComment, dayEntryKeys,
} from '../src/pipeline.js';

let pass = 0;
const failures = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
}

// ============================================================
console.log('\n【1】中文数字');
{
  ok('十二 → 12', cnNumToInt('十二') === 12);
  ok('二十三 → 23', cnNumToInt('二十三') === 23);
  ok('三十 → 30', cnNumToInt('三十') === 30);
  ok('一九六一 → 1961（逐位读）', cnNumToInt('一九六一') === 1961);
  ok('阿拉伯数字原样', cnNumToInt('25') === 25);
  ok('无法识别返回 null', cnNumToInt('冬月') === null);
  ok('空串返回 null', cnNumToInt('') === null);
}

// ============================================================
console.log('\n【2】日期解析');
{
  const t = (raw) => parseDateParts(raw);
  ok('1960年 → 年', t('1960年').year === 1960 && t('1960年').month === null);
  ok('10月9日 → 月日，无年', t('10月9日').month === 10 && t('10月9日').day === 9 && t('10月9日').year === null);
  ok('1960年12月25日 → 全', t('1960年12月25日').year === 1960
    && t('1960年12月25日').month === 12 && t('1960年12月25日').day === 25);
  ok('60年代 → decade=1960', t('60年代').decade === 1960);
  ok('现在是1961年 → 年', t('现在是1961年').year === 1961);
  ok('一九六一年 → 1961', t('一九六一年').year === 1961);
  ok('7月份 → 只有月', t('7月份').month === 7 && t('7月份').day === null);
  ok('10月9号 → 日（号也算）', t('10月9号').day === 9);
  ok('整个二月，甚至三月 → 取二月', t('整个二月，甚至三月').month === 2);
  ok('天启三年春 → 只有季节（自定义纪年不硬解）',
    t('天启三年春').season === '春' && t('天启三年春').month === null);
  /**
   * 中文月份必须贪婪匹配整串：
   * 「十二月」用 `{1,3}` 会回溯只吃到「十」（=10，合法月），
   * 结果十二月被解析成 2 月 —— 这个 bug 实测出现过。
   */
  ok('十二月二十五日 → 12月25日（贪婪匹配）',
    t('十二月二十五日').month === 12 && t('十二月二十五日').day === 25,
    JSON.stringify(t('十二月二十五日')));
  ok('一九六一年四月八日 → 1961-4-8',
    t('一九六一年四月八日').year === 1961 && t('一九六一年四月八日').month === 4
    && t('一九六一年四月八日').day === 8);
  ok('13月 视为非法（不当月份）', t('13月').month === null || t('13月').month === 13);
  ok('空串不崩', parseDateParts('').month === null);
  ok('null 不崩', parseDateParts(null).month === null);
}

// ============================================================
console.log('\n【3】链式时间与天数换算');
{
  const c = parseChainedTime('1960年12月25日 + 三日后');
  ok('取到锚点的年月日', c.year === 1960 && c.month === 12 && c.day === 25);
  ok('累加相对天数', c.relativeDays === 3, String(c.relativeDays));
  ok('半月后 → 15 天', parseChainedTime('1961年 + 半月后').relativeDays === 15);
  ok('两年后 → 730 天', parseChainedTime('1961年 + 两年后').relativeDays === 730);
  const a = addDays(1960, 12, 25, 7);
  ok('跨年加天数', a.year === 1961 && a.month === 1 && a.day === 1, JSON.stringify(a));
  ok('缺字段时不计算（不凑假日期）', addDays(null, 12, 25, 7).year === null);
  ok('加 0 天原样返回', addDays(1960, 1, 1, 0).day === 1);
}

// ============================================================
console.log('\n【4】缺失年份的补全（只在有依据时）');
{
  const items = [
    { time: '1960年' }, { time: '10月9日' }, { time: '1960年12月25日' },
    { time: '6月1日' }, { time: '1971年' }, { time: '3月2日' },
  ];
  const r = resolveDateYears(items);
  ok('第一条明确年份保持', r.get(0).year === 1960 && r.get(0).inferred === false);
  ok('裸月日继承前面的年份', r.get(1).year === 1960 && r.get(1).inferred === true);
  ok('明确年份标记 inferred=false', r.get(2).inferred === false);
  ok('换锚点后跟着换年', r.get(3).year === 1960);
  ok('新锚点生效', r.get(4).year === 1971 && r.get(4).inferred === false);
  ok('新锚点之后的裸日期跟新锚点', r.get(5).year === 1971 && r.get(5).inferred === true);

  // 整段都没有年份 → 不补
  const noAnchor = resolveDateYears([{ time: '10月9日' }, { time: '6月1日' }]);
  ok('没有锚点时留空（不默认成某一年）',
    noAnchor.get(0).year === null && noAnchor.get(1).year === null,
    JSON.stringify([noAnchor.get(0).year, noAnchor.get(1).year]));

  // 锚点在后面也不能"回头"补前面
  const after = resolveDateYears([{ time: '10月9日' }, { time: '1960年' }]);
  ok('锚点之后的才补，前面不回头', after.get(0).year === null && after.get(1).year === 1960);
}

// ============================================================
console.log('\n【5】格式化：只输出已知部分');
{
  ok('年月日全有', formatDate({ year: 1961, month: 4, day: 8 }) === '1961年4月8日');
  ok('只有月日不补年份', formatDate({ year: null, month: 6, day: 1 }) === '6月1日');
  ok('只有年', formatDate({ year: 1960, month: null, day: null }) === '1960年');
  ok('只有季节', formatDate({ year: null, month: null, season: '春' }) === '春季');
  ok('年代精度不写成具体年',
    formatDate({ year: 1960, decade: 1960, month: null, day: null }) === '1960年代',
    formatDate({ year: 1960, decade: 1960, month: null, day: null }));
  ok('全空返回 fallback', formatDate({ year: null, month: null }, { fallback: '—' }) === '—');
  ok('可标记推断', /推断/.test(formatDate({ year: 1960, month: 5, day: 1, inferred: true }, { markInferred: true })));
  ok('null 返回 fallback', formatDate(null, { fallback: 'x' }) === 'x');

  /**
   * 钟点不是日期，但要能被识别出来。
   *
   * 实测一篇小说只有相对时间（`四点了`），`parseDateParts` 不认钟点，
   * 于是 worldDate 把"四点"当成了日期。现在单独给 `timeOfDay`：
   * 有日历成分时不掺进来，只有钟点时作为退路输出（总比显示"未知"强）。
   */
  ok('识别钟点：四点了', parseDateParts('四点了').timeOfDay === '四点');
  ok('识别钟点：现在三点半', parseDateParts('现在三点半').timeOfDay === '三点半');
  ok('识别钟点：晚上十点（带时段）', parseDateParts('晚上十点').timeOfDay === '晚上十点');
  ok('钟点不写进 month/day',
    parseDateParts('四点了').month == null && parseDateParts('四点了').day == null);
  ok('有日历成分时钟点不进 text',
    formatDate({ year: 1961, month: 4, day: 8, timeOfDay: '四点' }) === '1961年4月8日',
    formatDate({ year: 1961, month: 4, day: 8, timeOfDay: '四点' }));
  ok('只有钟点时作为退路输出',
    formatDate({ timeOfDay: '四点' }, { fallback: '—' }) === '四点',
    formatDate({ timeOfDay: '四点' }, { fallback: '—' }));
}

// ============================================================
console.log('\n【6】日期比较：缺失位不参与');
{
  ok('同年比月', compareDateParts({ year: 1960, month: 6 }, { year: 1960, month: 10 }) < 0);
  ok('比年', compareDateParts({ year: 1960 }, { year: 1961 }) < 0);
  // 一年的缺失位视为"未知"，不比大小；但**年份都存在时**必须比出结果
  {
    const r = compareDateParts({ year: null, month: 12 }, { year: 1960, month: 1 });
    ok('缺年份视为未知，不比', r === 0, `compareDateParts 返回了 ${r}`);
  }
  ok('年份都存在时必须比出先后',
    compareDateParts({ year: 1960, month: 1 }, { year: 1961, month: 1 }) !== 0);
  ok('完全相同为 0', compareDateParts({ year: 1960, month: 1, day: 1 }, { year: 1960, month: 1, day: 1 }) === 0);
  ok('null 安全', compareDateParts(null, { year: 1960 }) === 0);
}

// ============================================================
console.log('\n【7】日期触发词：必须到"日"');
{
  ok('有年月日 → 完整日期', dateTriggerToken({ year: 1960, month: 12, day: 25 }) === '1960年12月25日');
  ok('只有年月日中的月日 → 月日', dateTriggerToken({ year: null, month: 6, day: 1 }) === '6月1日');
  // 只用月份会让整个月里每轮对话都触发，属于误触发灾难
  ok('只有月份 → 不给触发词', dateTriggerToken({ year: 1960, month: 7, day: null }) === null);
  ok('只有年份 → 不给触发词', dateTriggerToken({ year: 1960, month: null, day: null }) === null);
  ok('非法月份被拒', dateTriggerToken({ year: 1960, month: 13, day: 5 }) === null);
  ok('非法日期被拒', dateTriggerToken({ year: 1960, month: 1, day: 40 }) === null);
  ok('null 安全', dateTriggerToken(null) === null);
}

// ============================================================
console.log('\n【8】时间线：事件带上解析后的日期');
{
  const tl = solveTimeline([{
    chapter: '第一章',
    mentions: [
      { scope: 'story', type: 'absolute', raw: '1960年', event: '当前年份', quote: 'q' },
      { scope: 'story', type: 'absolute', raw: '10月9日', event: '出版一星期', quote: 'q' },
      { scope: 'story', type: 'absolute', raw: '1961年的4月8日', event: '拜访珍妮家', quote: 'q' },
    ],
  }], { base: '公元', origin: { raw: '1960年', event: '开场', reason: 'r' } }, ['第一章']);

  const byName = Object.fromEntries(tl.events.map(e => [e.name, e]));
  ok('每条事件都有 date', tl.events.every(e => e.date && typeof e.date.text === 'string'));
  ok('明确年份日期的 inferred=false', byName['拜访珍妮家'].date.inferred === false);
  ok('裸月日的年份被补上', byName['出版一星期'].date.year === 1960);
  ok('补齐的标为 inferred=true', byName['出版一星期'].date.inferred === true);
  ok('date.text 是可读文本', byName['拜访珍妮家'].date.text === '1961年4月8日');

  // worldDate：状态栏用
  ok('worldDate 存在', !!tl.worldDate);
  ok('worldDate 有月日（用户反馈的核心）',
    tl.worldDate.month !== null && tl.worldDate.day !== null,
    JSON.stringify(tl.worldDate));
  ok('worldDate 精度标为 day', tl.worldDate.precision === 'day');
  ok('worldDate 不选推断年份盖过明确年份',
    tl.worldDate.text === '1961年4月8日', tl.worldDate.text);
}

// ============================================================
console.log('\n【9】worldDate 选择口径');
{
  const mk = (ms) => solveTimeline([{
    chapter: '第一章',
    mentions: ms.map(m => ({ scope: 'story', quote: 'q', ...m })),
  }], { base: '公元', origin: { raw: 'x', event: '开场', reason: 'r' } }, ['第一章']);

  const cases = [
    ['明确年份不同时接管推断', [
      { type: 'absolute', raw: '1960年', event: 'a' },
      { type: 'absolute', raw: '10月9日', event: 'b' },
      { type: 'absolute', raw: '1961年的4月8日', event: 'c' },
    ], '1961年4月8日'],
    ['推断年份与明确相同时比精度', [
      { type: 'absolute', raw: '1961年', event: 'a' },
      { type: 'absolute', raw: '4月8日', event: 'b' },
    ], '1961年4月8日'],
    ['自定义纪年不硬凑日期', [
      { type: 'absolute', raw: '天启三年春', event: 'a' },
    ], '春季'],
    ['明确年份更晚也应接管', [
      { type: 'absolute', raw: '12月1日', event: 'a' },
      { type: 'absolute', raw: '1970年', event: 'b' },
    ], '1970年'],
    ['没有月日时退回年份（不报错）', [
      { type: 'absolute', raw: '1988年', event: 'a' },
    ], '1988年'],
  ];
  for (const [label, ms, want] of cases) {
    const got = mk(ms).worldDate?.text;
    ok(`worldDate：${label}`, got === want, `得到 ${got}，期望 ${want}`);
  }

  ok('空时间线不崩', solveTimeline([], { base: 'x', origin: {} }, []).worldDate === null);
  ok('pickWorldDate 空输入返回 null', pickWorldDate([]) === null);
}

// ============================================================
console.log('\n【10】事件触发词：多来源 + 风险控制');
{
  const ev = {
    name: '邀莉莉拍电影', time: '1960年12月25日',
    participants: ['莉莉', '凯瑟琳'], location: '电影社活动室',
  };
  const keys = deriveEventKeys(ev, { protagonist: '凯瑟琳' });
  ok('事件名在触发词里', keys.includes('邀莉莉拍电影'));
  ok('日期成为触发词', keys.includes('1960年12月25日'), JSON.stringify(keys));
  ok('在场人物成为触发词', keys.includes('莉莉'));
  ok('地点成为触发词', keys.includes('电影社活动室'));
  /**
   * 主角必须被排除：主角几乎每轮都在场，把它当 key 会让所有事件常驻，
   * 比漏触发更糟（世界书被塞满、上下文预算被吃光）。
   */
  ok('排除主角名', !keys.includes('凯瑟琳'), JSON.stringify(keys));
  ok('触发词已去重', new Set(keys).size === keys.length);

  ok('只有事件名时不报错', deriveEventKeys({ name: 'X' }).join(',') === 'X');
  ok('日期不到日时不加', !deriveEventKeys({ name: 'X', time: '1961年' }).includes('1961年'));
  ok('裸月日（无年）也可作触发词',
    deriveEventKeys({ name: 'X', time: '6月1日' }).includes('6月1日'));
  ok('单字人名不用（歧义太大）',
    !deriveEventKeys({ name: 'X', participants: ['甲'] }).includes('甲'));
  ok('泛指地点不用',
    !deriveEventKeys({ name: 'X', location: '城里' }).includes('城里'));
  ok('触发词有上限', deriveEventKeys({
    name: 'X', time: '1960年1月1日',
    participants: ['甲一', '乙二', '丙三', '丁四', '戊五'], location: '某地',
  }).length <= 6);
  ok('上限内优先保留事件名与日期', (() => {
    const k = deriveEventKeys({
      name: 'X', time: '1960年1月1日',
      participants: ['甲一', '乙二', '丙三', '丁四', '戊五'], location: '某地',
    });
    return k[0] === 'X' && k[1] === '1960年1月1日';
  })());
  ok('null 不崩', Array.isArray(deriveEventKeys(null)));
  ok('空 participants 不崩', deriveEventKeys({ name: 'X', participants: null }).length === 1);
}

// ============================================================
console.log('\n【11】事件条目正文含在场/地点');
{
  const body = formatEventEntry({
    name: 'X', time: '1960年12月25日', canon: 'c', pressure: 'core',
    participants: ['莉莉'], location: '活动室',
  });
  ok('含【在场】', body.includes('【在场】莉莉'));
  ok('含【地点】', body.includes('【地点】活动室'));
  ok('含时间', body.includes('1960年12月25日'));
  const bare = formatEventEntry({ name: 'Y', canon: 'c' });
  ok('没有在场/地点时不输出空行', !/【在场】/.test(bare) && !/【地点】/.test(bare), bare);
  ok('时间未定时有占位', bare.includes('（未定）'));
}

// ============================================================
console.log('\n【12】事件时间对齐（同一章多个日期不能被压成同一个）');
{
  /**
   * 真实故障：`backfillEventTimes` 原来「每章只取最早出现的那个时间点」，
   * 于是同一章里的 `6月1日`（生日、发售）、`7月份`（上映）、`1961年的4月8日`（拜访）
   * 全被压成 `6月1日`，事件之间毫无区分，也没法按天打包。
   */
  const timeline = {
    origin: { raw: '1960年' },
    events: [
      { name: '当前年份', time: '1960年', chapter: '第九章', quote: '现在是1960年' },
      { name: '密室发布', time: '1960年12月25日', chapter: '第九章', quote: '准备在1960年12月25日发布' },
      { name: '生日', time: '6月1日', chapter: '第二十六章', quote: '凯瑟琳的生日也在6月1日' },
      { name: '发售', time: '6月1日', chapter: '第二十六章', quote: '6月1日是《阿兹卡班的徒》发售' },
      { name: '上映', time: '7月份', chapter: '第二十六章', quote: '7月份没有意外的话会上映' },
      { name: '拜访', time: '1961年的4月8日', chapter: '第二十六章', quote: '时间到了1961年的4月8日' },
    ],
  };
  const events = [
    { name: '凯瑟琳生日会', chapter: '第二十六章' },
    { name: '阿兹卡班发售', chapter: '第二十六章' },
    { name: '女巫布莱尔上映', chapter: '第二十六章' },
    { name: '拜访珍妮家', chapter: '第二十六章' },
  ];
  backfillEventTimes(events, timeline);
  const byName = Object.fromEntries(events.map(e => [e.name, e]));

  ok('同一天的生日与发售对齐到同一天',
    byName['凯瑟琳生日会'].dateKey && byName['凯瑟琳生日会'].dateKey === byName['阿兹卡班发售'].dateKey,
    `${byName['凯瑟琳生日会'].dateKey} vs ${byName['阿兹卡班发售'].dateKey}`);
  ok('生日拿到的是 6月1日（不是整章最早的那个）',
    /06-01$/.test(byName['凯瑟琳生日会'].dateKey || ''), byName['凯瑟琳生日会'].dateKey);
  ok('只有月份的事件不算到某一天（不硬凑）',
    !byName['女巫布莱尔上映'].dateKey, String(byName['女巫布莱尔上映'].dateKey));
  ok('同章其它日期的事件各自对齐',
    /04-08$/.test(byName['拜访珍妮家'].dateKey || ''), byName['拜访珍妮家'].dateKey);
  ok('已有时长不被覆盖',
    byName['女巫布莱尔上映'].time === '7月份', byName['女巫布莱尔上映'].time);

  // 跨章借年份会编出错误日期 —— 必需章节内锚定
  ok('跨章不借年份（第二十六章内部没有显式年份则留空）',
    byName['凯瑟琳生日会'].date?.year === null,
    JSON.stringify(byName['凯瑟琳生日会'].date));
  // 但同章内有显式年份时应当沿用
  const sameCh = [
    { name: '密室签售会', chapter: '第九章' },
  ];
  backfillEventTimes(sameCh, timeline);
  ok('同章有显式年份时沿用', /^1960-/.test(sameCh[0].dateKey || ''), sameCh[0].dateKey);
}

// ============================================================
console.log('\n【13】按天打包');
{
  const evs = [
    { name: '凯瑟琳生日会', dateKey: '1961-06-01', dateText: '1961年6月1日', time: '6月1日', canon: 'a', pressure: 'core', participants: ['莉莉'], location: '公寓' },
    { name: '阿兹卡班发售', dateKey: '1961-06-01', dateText: '1961年6月1日', time: '6月1日', canon: 'b', pressure: 'buffer', location: '书店' },
    { name: '女巫布莱尔上映', time: '7月份', canon: 'c', pressure: 'buffer' },
    { name: '拜访珍妮家', dateKey: '1961-04-08', dateText: '1961年4月8日', time: '1961年的4月8日', canon: 'd', pressure: 'flexible' },
  ];
  const groups = groupEventsByDay(evs);

  ok('同日合成一组', groups.some(g => g.events.length === 2), JSON.stringify(groups.map(g => g.events.length)));
  ok('无日期的事件各自独立',
    groups.filter(g => !g.dateKey).length === 1, JSON.stringify(groups.map(g => g.dateKey)));
  ok('分组总数 = 1(同日) + 1(4月8日) + 1(无日期)',
    groups.length === 3, String(groups.length));
  ok('组间按日期先后排序',
    String(groups[0].dateKey) < String(groups[1].dateKey),
    `${groups[0].dateKey} vs ${groups[1].dateKey}`);

  const sameDay = groups.find(g => g.events.length === 2);
  ok('打包条目注释标出日期与事件数',
    /6月1日/.test(dayEntryComment(sameDay)) && /2 个事件/.test(dayEntryComment(sameDay)),
    dayEntryComment(sameDay));
  ok('打包条目正文含两个事件',
    formatDayEntry(sameDay).includes('凯瑟琳生日会') && formatDayEntry(sameDay).includes('阿兹卡班发售'),
    formatDayEntry(sameDay).slice(0, 60));
  ok('打包不丢信息（在场/地点都在）',
    /【在场】/.test(formatDayEntry(sameDay)) && /【地点】/.test(formatDayEntry(sameDay)));
  ok('日期在注释里/结构化字段里都记了',
    sameDay.dateKey === '1961-06-01' && sameDay.dateText === '1961年6月1日');

  const keys = dayEntryKeys(sameDay, { protagonist: '凯瑟琳' });
  ok('打包触发词含两个事件名', keys.includes('凯瑟琳生日会') && keys.includes('阿兹卡班发售'), JSON.stringify(keys));
  ok('打包触发词含裸月日（原文里的写法）', keys.includes('6月1日'), JSON.stringify(keys));
  ok('打包触发词含在场人物与地点', keys.includes('莉莉') && keys.includes('书店'), JSON.stringify(keys));
  ok('打包触发词不含主角', !keys.includes('凯瑟琳'), JSON.stringify(keys));

  // 单事件组保持原格式，不套"当日剧情"的壳
  const single = groups.find(g => !g.dateKey);
  ok('单事件组用原格式', !/当日剧情/.test(formatDayEntry(single)));
  ok('单事件组注释就是事件名',
    dayEntryComment(single) === `[event] ${single.events[0].name}`, dayEntryComment(single));
  ok('空输入安全', groupEventsByDay([]).length === 0);
  ok('null 安全', groupEventsByDay(null).length === 0);
}

// ============================================================
console.log('\n【14】时间线由剧情事件构成（而非"时间提及的事件名"）');
{
  /**
   * 真实故障：`solveTimeline` 用 `m.type === 'absolute' && m.event` 收集时间线，
   * 而抽取器把 `今天`/`第二天`/`四点了` 标成 `relative` —— 实测一篇小说 74 条提及里
   * 51 条是 relative、只有 1 条 absolute，于是时间线只剩 1 条、worldDate 变成「四点」，
   * 按天打包与阶段取文一起失去依据。
   *
   * 修法是让调用方把**剧情事件**传进来构成时间线。
   */
  const mentions = [{
    chapter: 'A',
    mentions: [
      { type: 'absolute', raw: '四点', event: '深夜密会', scope: 'story', quote: 'q' },
      { type: 'relative', raw: '今天', event: '深夜密会', scope: 'story', anchor: '当前叙事', quote: 'q' },
      { type: 'relative', raw: '第二天', event: null, scope: 'story', anchor: '结束', quote: 'q' },
      { type: 'vague', raw: '小时候', event: null, scope: 'history', quote: 'q' },
      { type: 'periodic', raw: '每天', event: null, scope: 'story', quote: 'q' },
    ],
  }];
  const origin = { base: '相对纪元', origin: { raw: '四点', event: '开场', reason: 'r' } };
  const plotEvents = [
    { name: '觉醒天赋面板', time: '四点', chapter: 'A' },
    { name: '深夜密会', time: '今天', chapter: 'A' },
    { name: '苏清月认主', time: '晚上', chapter: 'A' },
  ];

  // 不传 → 旧行为（只有 absolute 那一条）
  const legacy = solveTimeline(mentions, origin, ['A']);
  ok('不传剧情事件时退化自时间提及', legacy.fromEvents === false);
  ok('退化路径只剩 absolute 那一条', legacy.events.length === 1, String(legacy.events.length));

  // 传剧情事件 → 时间线由事件构成
  const driven = solveTimeline(mentions, origin, ['A'], plotEvents);
  ok('传剧情事件时时间线取自事件', driven.fromEvents === true);
  ok('时间线条目数 = 剧情事件数',
    driven.events.length === plotEvents.length, String(driven.events.length));
  ok('时间线里是剧情事件名（不是时间短语）',
    driven.events.map(e => e.name).join(',') === '觉醒天赋面板,深夜密会,苏清月认主',
    driven.events.map(e => e.name).join(','));

  // 相对/模糊/周期提及要被统计出来（供"为什么给不出日期表"的说明使用）
  ok('统计了未进时间线的相对时间', driven.relativeStats?.relative === 2,
    JSON.stringify(driven.relativeStats));
  ok('统计了模糊与周期时间',
    driven.relativeStats?.vague === 1 && driven.relativeStats?.periodic === 1,
    JSON.stringify(driven.relativeStats));

  /**
   * 空数组 = "调用方明确给了事件清单，只是它是空的"。
   * 不能写成 `displayEvents.length > 0`：那样空数组会静默退回旧行为，
   * 调用方以为传了空清单、实际拿到一堆时间短语。
   */
  const empty = solveTimeline(mentions, origin, ['A'], []);
  ok('传空数组时走事件路径（不退回提及）', empty.fromEvents === true);
  ok('传空数组时时间线为空', empty.events.length === 0, String(empty.events.length));

  // 事件里的 dateKey 必须被保留，供按天打包使用
  const withKey = solveTimeline(mentions, origin, ['A'], [
    { name: '凯瑟琳生日会', time: '6月1日', dateKey: '06-01', dateText: '6月1日', chapter: 'A' },
  ]);
  ok('事件时间线保留 dateKey（按天打包要用）',
    withKey.events[0].dateKey === '06-01', String(withKey.events[0].dateKey));

  // null（不传）与 []（空清单）语义必须不同
  const notPassed = solveTimeline(mentions, origin, ['A'], null);
  ok('null 与 [] 语义不同', notPassed.fromEvents === false && empty.fromEvents === true);
}

// ============================================================
console.log('\n【16】时间线稀疏的诊断字段');
{
  /**
   * 实测一篇小说 77 条提及里只有 3 条 `absolute`、且都挂在同一个事件名下，
   * 于是时间线只有 2 条、事件的「时间：」大量留空。
   * 这是数据/模型口径问题，但必须能在日志里说清原因，否则用户只看到一堆「（未定）」。
   */
  const busy = [{
    chapter: 'A',
    mentions: [
      { type: 'absolute', raw: '四点了', event: 'x', scope: 'story', quote: 'q' },
      ...Array.from({ length: 25 }, () => (
        { type: 'relative', raw: '今天', event: null, scope: 'story', anchor: '当前叙事', quote: 'q' })),
    ],
  }];
  const tl = solveTimeline(busy, { base: 'x', origin: {} }, ['A'], []);
  ok('统计提及总数', tl._mentionTotal === 26, String(tl._mentionTotal));
  ok('稀疏判定成立（26 条提及、0 个可定位时间点）',
    tl._mentionTotal >= 20 && tl.events.length <= Math.max(2, tl._mentionTotal * 0.05),
    `${tl.events.length} / ${tl._mentionTotal}`);

  // 提及很少时不该报"稀疏"（短篇本来就少，不是异常）
  const few = [{ chapter: 'A', mentions: [{ type: 'relative', raw: '今天', event: null, scope: 'story', quote: 'q' }] }];
  const tl2 = solveTimeline(few, { base: 'x', origin: {} }, ['A'], []);
  ok('提及很少时不触发稀疏判定',
    !(tl2._mentionTotal >= 20), String(tl2._mentionTotal));
}

// ============================================================
console.log('\n【15】事件时间的章节模糊匹配');
{
  /**
   * 真实故障：事件的 `chapter` 由模型写（`示例世界第三章`／`2/3`／`第17章`），
   * 而时间提及的 `chapter` 是块标题（`示例世界第三章，`／`【2/3】示例世界第三章，`）——
   * 两者形式不同，精确查表必然落空，于是每个事件都落到"故事起点"兜底，
   * **17 个事件全被标成同一时刻**（全变成「四点了」）。
   * 给错的时间比留空更糟：它会让 AI 以为整篇都发生在同一刻。
   */
  const timeline = {
    events: [
      { name: '深夜密会', time: '四点了', chapter: '示例世界第三章，', quote: 'q' },
      { name: '苏清月认主', time: '晚上', chapter: '【2/3】示例世界第三章，', quote: 'q' },
      { name: '陈静默逼婚', time: '第二天', chapter: '第17章，', quote: 'q' },
    ],
  };
  const events = [
    { name: '觉醒天赋面板', chapter: '示例世界第三章' },   // 只差一个标点
    { name: '苏清月臣服', chapter: '2/3' },              // 提及带【】前缀
    { name: '陈静默逼婚', chapter: '第17章' },
  ];
  backfillEventTimes(events, timeline);
  ok('章节只差标点也能匹配', events[0].time === '四点了', events[0].time);
  ok('章节带【】标记也能匹配', events[1].time === '晚上', events[1].time);
  ok('精确同名章节正常匹配', events[2].time === '第二天', events[2].time);
  ok('不同章的事件拿到不同时间（不再全被兜底成同一刻）',
    new Set(events.map(e => e.time)).size === 3,
    JSON.stringify(events.map(e => e.time)));

  /**
   * 单条时间线的兜底必须克制。
   *
   * 旧代码是 `hit = tl[0]` 无差别兜底：时间线只有 1 条时，
   * 所有对不上的事件都会拿到那一刻的时间（实测 17 个事件全变成「四点了」）。
   * 现在只在"确实只有一个候选"时才用，且用掉就不再复用。
   */
  const one = { events: [{ name: 'X', time: '上午', chapter: '第一章' }] };
  const many = [
    { name: '甲', chapter: '第一章' },
    { name: '乙', chapter: '第二章' },   // 找不到第二章 → 不该再拿"上午"
  ];
  backfillEventTimes(many, one);
  ok('唯一候选可兜底第一个事件', many[0].time === '上午', many[0].time);
  ok('兜底不复用（第二个事件不会也变成同一时刻）',
    many[1].time !== '上午', String(many[1].time));
}

// ============================================================
console.log('\n==============================================');
console.log(`  日期与触发词测试：通过 ${pass} · 失败 ${failures.length}`);
console.log('==============================================');
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
