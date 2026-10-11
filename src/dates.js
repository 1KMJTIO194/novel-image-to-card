/**
 * 日期解析与补全
 *
 * 解决两个实际问题（都来自真实产物）：
 *
 * ① **时间信息不完整**。抽取只拿到原文里写的那个时间片段，于是
 *    `timeline.json` 里会出现 `10月9日`（没有年份）、`6月1日`、`7月份` 这种条目。
 *    状态栏直接显示 `world.time`，用户看到的就是"没有几月几日"或者"不知道哪一年"。
 *
 * ② **时间线排不准**。同一章内多个日期按原文顺序排，
 *    `1960年 → 6月1日 → 10月1日 → 1961年` 这种顺序里，
 *    裸月日的年份只能靠上下文推断。
 *
 * 做法：
 *   - `parseDateParts` 从原文片段里抠出年月日（支持中文/阿拉伯数字、季节、年代）
 *   - `resolveDateYears` 给缺失年份的条目补年份 —— **只在有明确依据时补**：
 *     取"它前面最近的、带年份的条目"（文本顺序），补不出就留空
 *   - `compareDateParts` 用于排序；缺失部分视为"未知"，不影响已知位的比较
 *
 * ⚠️ 补年份是**推断**，不是原文事实。所以：
 *   - 推断结果带 `inferred: true` 标记，UI/产物能区分
 *   - `formatDate` 在只有月日时输出 `6月1日`（不硬凑一个年份）
 *   - 任何补不出来的情况都留空，绝不默认成 1 月 1 日
 */

const CN_DIGITS = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000 };

/** 把中文数字（十二 / 二十三 / 一九六一）转成整数；纯阿拉伯数字直接用 */
export function cnNumToInt(s) {
  const str = String(s || '').trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) return Number(str);

  // 逐位读法：「一九六一」= 1961（四位以上且全是数字字时按位读）
  const chars = [...str];
  if (chars.length >= 2 && chars.every(c => c in CN_DIGITS)) {
    return Number(chars.map(c => CN_DIGITS[c]).join(''));
  }
  // 单位读法：「十二」= 12、「二十三」= 23、「三十」= 30
  let total = 0;
  let section = 0;
  let lastDigit = null;
  for (const c of chars) {
    if (c in CN_DIGITS) { lastDigit = CN_DIGITS[c]; section = lastDigit; continue; }
    if (c in CN_UNITS) {
      const unit = CN_UNITS[c];
      section = (lastDigit === null ? 1 : lastDigit) * unit;
      total += section;
      lastDigit = null;
      section = 0;
      continue;
    }
    return null;   // 出现无法识别的字，整体放弃
  }
  return total + section;
}

/**
 * 从一段原文时间表述里解析出年月日。
 *
 * @param {string} raw 例如「1960年12月25日」「10月9日」「现在是1961年」「60年代」「整个二月，甚至三月」
 * @returns {{year:number|null, month:number|null, day:number|null,
 *            season:string|null, decade:number|null,
 *            hasMonthDay:boolean, inferred?:boolean}}
 */
export function parseDateParts(raw) {
  const s = String(raw || '');
  const out = { year: null, month: null, day: null, season: null, decade: null, hasMonthDay: false };

  // 年代：60年代 / 1960年代 / 六〇年代
  const dec = /((?:\d{2,4})|[〇零一二两三四五六七八九]{2})\s*年代/.exec(s);
  if (dec) {
    let d = cnNumToInt(dec[1]);
    if (d !== null) {
      if (d < 100) d = d >= 30 ? 1900 + d : 2000 + d;   // 60年代 → 1960；20年代 → 2020
      out.decade = d;
    }
  }

  // 年份：1960年 / 一九六〇年 / 天启三年（自定义纪年，数字部分仍可解析）
  const ym = /(\d{2,4}|[〇零一二两三四五六七八九]{2,4})\s*年/.exec(s);
  if (ym) {
    const y = cnNumToInt(ym[1]);
    if (y !== null) out.year = y;
  } else if (out.decade !== null) {
    out.year = out.decade;    // 只有年代时，用年代起点当年份近似
  }

  // 季节
  const sea = /(春|夏|秋|冬)(季|天)?/.exec(s);
  if (sea) out.season = sea[1];

  /**
   * 钟点：`四点了` / `现在三点半` / `晚上十点`
   *
   * 与月日**分开存**：`四点` 是"一天中的几点"，不是日期。
   * 混进年/月/日会让状态栏把"四点"当成"当前日期"，看着像日期其实完全不是。
   * 这里单独给出 `timeOfDay`，需要时可以显示"下午四点"这种字样。
   */
  const tod = /(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|晚上|夜里|深夜)?\s*([〇零一二两三四五六七八九十\d]{1,3})\s*点(?:半|钟|整)?/.exec(s);
  if (tod) {
    const h = cnNumToInt(tod[1]);
    if (h !== null && h >= 0 && h <= 24) out.timeOfDay = tod[0].trim();
  }

  /**
   * 月日：12月25日 / 10月9号 / 十二月二十五日 / 一九六一年四月八日 / 二月
   *
   * ⚠️ 数字部分必须用**贪婪**的 `+` 而不是 `{1,3}`：
   * `{1,3}` 会回溯，在「十二月」里只吃到「十」（=10、合法月），
   * 于是「十二月二十五日」被解析成 2 月 —— 实测踩过。
   * 贪婪匹配整串「十二」后交给 cnNumToInt 得到 12 才是对的。
   */
  const NUM = '(?:\\d+|[〇零一二两三四五六七八九十]+)';
  const md = new RegExp(`(${NUM})\\s*月\\s*(?:(${NUM})\\s*[日号])?`).exec(s);
  if (md) {
    const m = cnNumToInt(md[1]);
    // 非法月份（13月）留空而不是回滚：`Date.UTC(1961, 14, 1)` 会**静默滚到下一年**，
    // 那会产出一个看起来合法、实际错误的日期。宁可承认"解析不出"。
    if (m !== null && m >= 1 && m <= 12) out.month = m;
    if (md[2] !== undefined) {
      const d = cnNumToInt(md[2]);
      if (d !== null && d >= 1 && d <= 31) out.day = d;
    }
  }
  out.hasMonthDay = out.month != null;
  return out;
}

/** 这条日期是不是"有月或日"（用于判断能不能作为触发词 / 状态栏显示） */
export function hasMonthOrDay(parts) {
  return !!parts && (parts.month !== null || parts.day !== null);
}

/**
 * 把形如 `1960年 + 三日后` 的链式时间拆成各段并逐段解析。
 * solveTimeline 里相对时间是 `${anchor.time} + ${m.raw}`，要按段解析才能取到锚点的年月日。
 */
export function parseChainedTime(time) {
  const segments = String(time || '').split('+').map(s => s.trim()).filter(Boolean);
  const merged = { year: null, month: null, day: null, season: null, decade: null, hasMonthDay: false };
  let relativeDays = 0;

  for (const seg of segments) {
    const p = parseDateParts(seg);
    if (p.year !== null && merged.year === null) merged.year = p.year;
    if (p.month !== null && merged.month === null) merged.month = p.month;
    if (p.day !== null && merged.day === null) merged.day = p.day;
    if (p.season && !merged.season) merged.season = p.season;
    if (p.decade !== null && merged.decade === null) merged.decade = p.decade;
    // 相对段：「三日后」「半月后」「两年后」—— 只累加天数，年月偏移做粗略推算
    const rel = /([〇零一二两三四五六七八九十百半\d]+)\s*(日|天|月|年|周|星期)/.exec(seg);
    if (rel && /后|之后|以后/.test(seg)) {
      // 「半」= 0.5，中文里极常见的相对时间（半月后 / 半年后）
      const n = rel[1] === '半' ? 0.5 : cnNumToInt(rel[1]);
      if (n !== null) {
        if (rel[2] === '日' || rel[2] === '天') relativeDays += n;
        else if (rel[2] === '周' || rel[2] === '星期') relativeDays += n * 7;
        else if (rel[2] === '月') relativeDays += n * 30;
        else if (rel[2] === '年') relativeDays += n * 365;
      }
    }
  }
  merged.hasMonthDay = merged.month !== null;
  merged.relativeDays = relativeDays;
  return merged;
}

/**
 * 把若干天加到年月日上（够用即可，不引第三方库）。
 *
 * ⚠️ 运算前必须校验范围：`Date.UTC(1961, 14, 1)` 不会报错，
 * 而是**静默滚到 1962 年 3 月** —— 那会产出一个看着合法、实际错误的日期。
 * 缺字段或越界一律原样返回，宁可不算。
 */
export function addDays(year, month, day, days) {
  if (!days) return { year, month, day };
  if (year == null || month == null || day == null) return { year, month, day };
  if (month < 1 || month > 12 || day < 1 || day > 31) return { year, month, day };
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return { year, month, day };
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * 给缺失年份的日期补年份。
 *
 * **只在有明确依据时补**：按传入顺序（＝叙事顺序）扫描，
 * 记住"最近一个带年份的日期"，后面缺年份的用它。
 * 补不出（整段都没有年份）就留 `null`。
 *
 * ⚠️ `window: 'chapter'` 会把锚点限制在**同一章节内**。
 * 为什么需要这个模式：跨章沿用年份会编出错误日期 ——
 * 实测第 25 章的 `现在是1961年` 之后，第 26 章的裸 `6月1日` 被补成 1961；
 * 但同一个第 26 章里还有 `1961年的4月8日`，说明这一章的事件未必都在 6 月之后。
 * 更要命的是它会与显式年份**自相矛盾**（推断出 6月1日 而显式的 4月8日更早）。
 * 拿不准就留空，让上层显示"6月1日"（不带年份）而不是一个可能错的年份。
 *
 * @param {Array<{time:string}>} items 按叙事顺序排列的时间线条目
 * @param {{window?: 'global'|'chapter', chapterOf?: (item:any, index:number)=>string}} [opts]
 * @returns {Map<number, object>} 下标 → 解析结果（含 inferred 标记）
 */
export function resolveDateYears(items, { window = 'global', chapterOf = null } = {}) {
  const out = new Map();
  const list = Array.isArray(items) ? items : [];
  let anchorYear = null;
  let currentChapter = Symbol('init');

  list.forEach((it, i) => {
    // 章节模式的边界判定：换章就丢掉上一个锚点
    if (window === 'chapter' && typeof chapterOf === 'function') {
      const ch = chapterOf(it, i);
      if (ch !== currentChapter) { currentChapter = ch; anchorYear = null; }
    }

    const p = parseChainedTime(it?.time);
    if (p.year !== null) {
      anchorYear = p.year;
      out.set(i, { ...p, inferred: false });
      return;
    }
    if (anchorYear !== null) {
      out.set(i, { ...p, year: anchorYear, inferred: true });
    } else {
      out.set(i, { ...p, inferred: false });
    }
  });
  return out;
}

/**
 * 年/月/日的比较：**可比较性级联**。
 *
 * 规则：只有当**两个日期都在同一层有值**时，才用这一层比大小；
 * 任一方缺这一层，该层与更细的层都不可比，直接返回 0（"分不出先后"）。
 *
 * 为什么不是"跳过缺失的那一层、继续比下一层"：
 *   `{year:null, month:12}` 与 `{year:1960, month:1}` 如果跳过 year 去比 month，
 *   会得出 +11 —— 也就是把"1960年1月"判定为**早于**"12月"，
 *   而那个"12月"究竟是哪一年根本不知道。这种答案会污染 worldDate 的挑选。
 *   承认"分不出"比给一个看似有依据的错答案安全。
 *
 * ⚠️ 用 `== null` 而不是 `=== null`：手工构造的日期对象常整个缺字段（undefined）。
 */
export function compareDateParts(a, b) {
  if (!a || !b) return 0;
  // 年
  if (a.year == null || b.year == null) return 0;
  if (a.year !== b.year) return a.year - b.year;
  // 月（年相同才轮到月；月不可比则整条不可比）
  if (a.month == null || b.month == null) return 0;
  if (a.month !== b.month) return a.month - b.month;
  // 日
  if (a.day == null || b.day == null) return 0;
  return a.day - b.day;
}

/**
 * 格式化成可读文本。
 *
 * **只输出真实已知的部分** —— 缺年份就不写年份，绝不补一个默认值：
 *   {year:1961, month:4, day:8} → 「1961年4月8日」
 *   {year:null, month:6, day:1} → 「6月1日」
 *   {year:1960, month:null}     → 「1960年」
 *   {year:null, season:'春'}    → 「春季」
 *   {timeOfDay:'四点'}（无日期） → 「四点」（钟点不是日期，但总比显示"未知"强）
 * 什么都没有时返回 fallback（调用方通常传原始文本）。
 */
export function formatDate(parts, { fallback = '', markInferred = false } = {}) {
  if (!parts) return fallback;
  const bits = [];
  const inferredMark = markInferred && parts.inferred ? '（年份推断）' : '';
  if (parts.year != null) {
    // 只有年代精度时不要写成"1960年"这种看起来精确的样子。
    // ⚠️ 用 `!= null` 而不是 `!== null`：调用方手工构造的日期对象往往没有 decade 字段，
    // `undefined !== null` 为真会把「1960年」误判成「1960年代」（测试抓到过）。
    bits.push(parts.decade != null && parts.month == null && parts.day == null
      ? `${parts.decade}年代`
      : `${parts.year}年`);
  }
  if (parts.month != null) {
    bits.push(`${parts.month}月`);
    if (parts.day != null) bits.push(`${parts.day}日`);
  } else if (parts.season) {
    bits.push(`${parts.season}季`);
  }
  // 没有任何日历成分、只有钟点时，把钟点作为退路输出 ——
  // 否则状态栏会显示"未知"，而原文其实给了"四点了"这种可用的时间信息
  if (!bits.length && parts.timeOfDay) return String(parts.timeOfDay) + inferredMark;
  if (!bits.length) return fallback;
  return bits.join('') + inferredMark;
}

/**
 * 能不能用这个日期做世界书触发词。
 *
 * **必须到"日"**，且月/日都在合法范围。理由见 deriveEventKeys：
 * 只写月份（如「6月」）会让整月里每一轮对话都触发该事件，属于误触发灾难。
 */
export function dateTriggerToken(parts) {
  if (!parts) return null;
  const { year, month, day } = parts;
  if (month === null || day === null) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return year !== null && year !== undefined
    ? `${year}年${month}月${day}日`
    : `${month}月${day}日`;
}
