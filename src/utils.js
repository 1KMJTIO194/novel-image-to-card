/**
 * 通用工具：JSON 解析、并发映射、章节切分、token 估算
 */

/** 从模型输出里尽力解析出 JSON（容忍 ```json 围栏、前后废话） */
export function parseJSON(text) {
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const first = s.search(/[{[]/);
  if (first > 0) s = s.slice(first);
  const last = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (last >= 0) s = s.slice(0, last + 1);
  return JSON.parse(s);
}

/**
 * 粗略 token 估算。
 * 中文约 1 字 ≈ 0.7 token，英文约 4 字符 ≈ 1 token。
 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  const cjk = (s.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const rest = s.length - cjk;
  return Math.ceil(cjk * 0.7 + rest / 4);
}

/** 并发映射，带进度回调与单条失败兜底 */
export async function pMap(items, fn, concurrency = 3, onProgress = null) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        console.error(`[pMap] item ${i}: ${e.message}`);
        results[i] = null;
      }
      done++;
      if (onProgress) onProgress(done, items.length);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, worker)
  );
  return results;
}

/**
 * 切分章节。
 * @param {string} text 全文
 * @param {{maxLen?: number, minChapterLen?: number, mergeShort?: boolean}} opts
 */
/**
 * 把用户填的章节范围解析成**从 1 开始的章号数组**。
 *
 * 支持：'' / 'all' / '1-10' / '1,3,5-8' / '3' / 混合。
 * 约定（见需求「必须遵守的规则」）：
 *   - 空值或 'all' → 全部章节
 *   - 越界章号**静默忽略**，不报错
 *   - 不合法片段（NaN、倒序）忽略
 *   - '999' 超出总数 → []
 */
export function parseRange(rangeStr, total) {
  const n = Math.max(0, Number(total) || 0);
  const all = () => Array.from({ length: n }, (_, i) => i + 1);
  if (rangeStr === undefined || rangeStr === null) return all();
  const s = String(rangeStr).trim();
  if (!s || s === 'all') return all();

  const idx = new Set();
  for (const part of s.split(',')) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes('-')) {
      const [a, b] = p.split('-');
      let start = parseInt(a, 10);
      let end = parseInt(b, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (start > end) [start, end] = [end, start];   // 写反了也能用
      for (let i = Math.max(1, start); i <= Math.min(end, n); i++) idx.add(i);
    } else {
      const v = parseInt(p, 10);
      if (!Number.isNaN(v) && v >= 1 && v <= n) idx.add(v);
    }
  }
  return [...idx].sort((a, b) => a - b);
}

/**
 * 中文标题的**句子边界**。
 *
 * 为什么需要：整篇正文挤在一行时（实测小说很常见），取标题会取到一大段正文，
 * 于是"章节标题"变成 `第17章，心照不宣，是然然啊，快请进，我去给你倒杯茶，由于……`。
 * 在标点处收口，标题才是真标题（`第17章，心照不宣`）。
 */
const SENTENCE_END = /[。！？；!?;：:，,、]/;

/** 取标题用的句子：在第一个句读处收口，再按字数兜底 */
function firstSentence(s, maxChars) {
  const str = String(s || '').trim();
  if (!str) return '';
  for (let i = 0; i < Math.min(str.length, maxChars); i++) {
    if (SENTENCE_END.test(str[i])) return str.slice(0, i + 1);
  }
  return str.slice(0, maxChars);
}

/**
 * 判断一行是不是**书名/文件名行**（而不是章节标题或正文）。
 *
 * 实测的小说文件第 1 行就是文件名：
 *   `某长篇网文 开局签到无敌 全城围观主角名场面#热门小说标签`（29 字）
 * 特征是「短 + 无句读 + 带 # 话题标签」。
 *
 * ⚠️ 一定要比"真正的章节标题"更严，否则会把 `第1章 标题1` 这种正常标题误判掉
 * （正常标题同样没有句读）。两者靠这三点区分：
 *   · 含 `#` 话题标签（正常章节标题几乎不会有）
 *   · 不含章节编号（`第N章/回/节`）
 *   · 长度 ≥ 20（正常标题一般更短）
 */
const CHAPTER_MARK = /第\s*[0-9〇零一二三四五六七八九十百千两]+\s*[章回节]/;

/**
 * 书籍元信息行：`书名：示例小说 A` / `作者：示例作者` / `简介：…` / `标签：…`
 *
 * 实测：有的文件开头是两行元信息（书名 + 作者），它们**带冒号**，
 * 而冒号在我的句读集合里 —— 于是不会被上面"无句读"那条判据拦住，
 * 反倒被当成"本章第一句正文"取作前言，续块标题就变成了 `【2/2】书名：`。
 */
const BOOK_META_RE = /^\s*(书名|作者|简介|标签|类型|状态|字数|来源|正文|声明|文案|原著|原名|连载|更新|内容简介|作品简介)\s*[:：]/;

function looksLikeBookTitle(line) {
  // ⚠️ 必须先剥行尾 `\r`（CRLF 文件）：`☆、001\r` 带着 `\r` 时
  // CHAPTER_LINE_RE 的 `$` 锚点失配，于是章节标记行被误判成"正文第一句"，
  // 续块前言就变成了 `☆、`（实测标题全变成 `☆、`）。
  const s = stripCR(String(line || '')).trim();
  if (!s || s.length > 140) return false;
  // 含章节标记（`☆、001` / `第1章 标题1` / `001.`）→ 是章节标题行，不是书名行。
  // 必须放在书名判据之前，否则 `第1章 标题1` 会被误判成书名、标题被丢掉。
  if (CHAPTER_MARK.test(s)) return false;
  if (isChapterMarkerLine(s)) return false;
  if (BOOK_META_RE.test(s)) return true;               // 书名/作者等元信息
  if (SENTENCE_END.test(s)) return false;              // 有句读 → 是正文
  // 无句读、无章节号：带 # 话题标签、或足够长 → 书名/文件名
  return /#[^\s#]{2,}/.test(s) || s.length >= 20;
}

/**
 * 跳过文件/章节开头的"书名行"，取真正第一句正文。
 */
function introSentence(text, maxChars) {
  const src = String(text || '');
  for (const line of src.split('\n')) {
    const s = stripCR(line).trim();
    if (!s) continue;

    /**
     * ⚠️ **先**判断"这一行是不是章节标记"，再看它像不像书名。
     *
     * 顺序反了会出错：`looksLikeBookTitle` 对章节标记行返回 false（它不是书名），
     * 但它前面还有一层 `if (looksLikeBookTitle(s)) continue` —— 若把标记判断放在后面，
     * 某些行会先被别的分支处理掉。实测第一本小说（无换行）的第 4 章标题变成了「，」。
     */
    if (isChapterMarkerLine(s)) return s;

    /**
     * ⚠️ 章节标记行**整行返回**，不能过 `firstSentence`。
     *
     * `SENTENCE_END` 里含顿号 `、`，而 `☆、001` 的顿号就在第 2 个字符上 ——
     * `firstSentence` 会在那里收口，把章节标记切成 `☆、`
     * （实测续块前言与标题全变成 `☆、`）。
     * `☆、` 是标记语法的一部分，不是句子边界。
     */
    if (looksLikeBookTitle(s)) continue;

    /**
     * 行**中间**是章节标记（`…上一段第17章…`）→ 取标记开头那一段当标题。
     *
     * 第一本小说整篇没有换行，章节号夹在正文里，只有这一条能取出有意义的标题
     * （否则会去第一个句读处收口，得到「，」这种结果）。
     */
    const mid = CHAPTER_LOOSE_RE.exec(s);
    if (mid && mid.index > 0) {
      CHAPTER_LOOSE_RE.lastIndex = 0;                  // exec 带 g，用完必须复位
      return firstSentence(s.slice(mid.index), maxChars);
    }
    CHAPTER_LOOSE_RE.lastIndex = 0;

    return firstSentence(s, maxChars);
  }
  // 整篇都没有正文句（极端）→ 退回整体截断
  return firstSentence(src.trim(), maxChars);
}

/**
 * 章节正文的标题。
 *
 * ⚠️ 两种情况都要处理，判据顺序不能反：
 *
 *   1. **正常的章节文件**：首行就是标题（`第1章 标题1`）。
 *      这种标题**通常没有句读**，所以不能套用"无句读就跳过"的规则 ——
 *      否则真标题会被跳过、取到下面的正文（实测把 `正文。` 当成了标题）。
 *      → 首行长度在 3-60 之间就直接用它。
 *
 *   2. **整篇挤在一行的文件**（实测这个小说就是）：首行是整章正文，
 *      甚至第 1 行是文件名 —— 标题会变成
 *      「示例小说 B 开局签到无敌全城围观…」。
 *      → 这时才用句子边界收口 / 跳过书名行。
 */
function titleOf(part, i) {
  const firstLine = stripCR(String(part || '').split('\n', 1)[0]).trim();
  /**
   * ① 首行本身就是章节标记（`☆、002` / `第1章 标题1`）→ **整行当标题**。
   *
   * 不要用正则捕获组拼标题：`第1章 标题1` 的捕获组只拿到 `第1章`
   * （章节号本身），把后面的真标题丢了。标记行通常很短，整行留着最完整。
   */
  if (isChapterMarkerLine(firstLine)) return firstLine;
  // 首行是正常长度的标题、且不像书名行 → 直接用
  if (firstLine.length >= 3 && firstLine.length <= 60 && !looksLikeBookTitle(firstLine)) {
    return firstLine;
  }
  // 首行是书名行或超长正文 → 跳过它，在句读处收口
  const head = introSentence(part, 60);
  if (head) return head;
  return String(part || '').trim().slice(0, 40) || `第${i + 1}章`;
}

/**
 * 把超长章节按**段落边界**切成多块（每块 ≤ maxLen）。
 *
 * 背景：原来只要文本里有 2 个以上章节标记，就 `return parts.map(...)` 直接返回，
 * **完全不看 maxLen**。于是"前 13,000 字没有章节标记、后面才出现 第16章"这类文本
 * （实测一篇小说就是这样）会产生一个 15,630 字的巨型块，连锁导致：
 *   · 章序全错：`第16章` 标记落在第 13,594 字，它前面 58% 的正文也被归进"第16章"
 *   · 分批失效：整篇只算 1 批，一次全进 prompt
 *   · 提及数据塌陷：提及按章聚合，只剩 2 条
 *
 * 切分策略：
 *   · 先按空行分段；段落仍超长（整篇挤一行的文本就是这样）再按单换行切；再不行硬切
 *   · **续块带一段限长前言**（取本章第一句正文），既是给模型的内容上下文，
 *     也天然成为这块的标题 —— 否则续块标题只能编成「（续 2/4）」这种无信息量的东西
 *   · 每块的 `part` 都是同一个源章节，`partCount` 是这一章的段数
 */
function splitLongPart(part, title, maxLen, partNo = 1) {
  const text = String(part);
  if (text.length <= maxLen) {
    return [{ text, title, part: partNo, partCount: 1 }];
  }

  // 前言：本章第一句正文，限长。让每个续块都知道"这一段属于哪一章的什么内容"
  const intro = introSentence(text, 120);

  // 段落切分：先空行，再单换行
  let blocks = text.split(/\n{2,}/).filter(b => b.trim());
  if (blocks.length <= 1) blocks = text.split(/\n/).filter(b => b.trim());

  /**
   * 贪心装箱。额度是**已知常数**，不动态算 —— 动态算容易在"恰好装满"的边界上溢出
   * （实测每块会超出 11 个字符，正好是分隔符 `\n\n` 的宽度）。
   *
   *   首块额度   = maxLen
   *   续块额度   = maxLen - 前言长度 - 2（分隔符）
   *
   * 超长段落按本次可用额度切开，因此**只要续块额度 > 0，装箱结果必然 ≤ maxLen**。
   * 续块额度贴到 ≤0 的极端情况（前言几乎占满 maxLen）把前言截短兜底。
   */
  const contLimit = Math.max(1, maxLen - (intro ? intro.length + 2 : 0));
  const chunksRaw = [];
  let cur = '';
  const isFirst = () => chunksRaw.length === 0;
  const limit = () => (isFirst() ? maxLen : contLimit);
  const flush = () => { if (cur) { chunksRaw.push(cur); cur = ''; } };

  for (const b of blocks) {
    let rest = b;
    while (rest) {
      const room = limit() - cur.length - (cur ? 2 : 0);
      if (room <= 0) { flush(); continue; }
      if (rest.length <= room) {
        cur = cur ? `${cur}\n\n${rest}` : rest;
        rest = '';
        continue;
      }
      // 装不下：先尽可能装满（可能剩余为 0），余下的下一轮继续
      cur = cur ? `${cur}\n\n${rest.slice(0, room)}` : rest.slice(0, room);
      rest = rest.slice(room);
      flush();
    }
  }
  flush();

  const out = chunksRaw.map((body, i) => {
    const chunkText = i === 0 ? body : (intro ? `${intro}\n\n${body}` : body);
    return { text: chunkText, first: i === 0 };
  });

  const total = out.length;
  return out.map((o, i) => {
    /**
     * 标题必须**块块唯一**。
     *
     * 踩过的坑：续块的前言都取自"本章第一句"，于是同一章的多个续块标题**完全相同**。
     * 而 `solveTimeline` 用 `Map<标题, 章序>` 建索引、同名只留第一个 ——
     * 5 个块会塌成 2 个章序，时间线锚定跟着错乱（实测把时间线条目清成了 0 条）。
     *
     * 所以续块标题带位置标记：既能一眼看出"这是这一章的第几段"，
     * 也保证 key 唯一。
     */
    const t = o.first
      ? title
      /**
       * 续块标题取它**自己内容**的第一句。
       *
       * ⚠️ 用 `introSentence` 而不是 `firstSentence`：续块开头是本章前言
       * （往往就是 `☆、001` 这类章节标记行），`firstSentence` 会在顿号处把它切成 `☆、`。
       * `introSentence` 会跳过书名行、并对章节标记行整行返回。
       */
      : `【${i + 1}/${out.length}】${introSentence(o.text, 34) || title}`;
    return { text: o.text, title: t, part: partNo, partCount: total };
  });
}

/**
 * 章节标记（严格版：要求出现在**行首**）。
 *
 * ⚠️ **章节标记行必然很短**（`☆、001` / `第1章 标题1`），所以调用方必须**限制行长**：
 * "整篇挤一行"的文件里，那一整行是几百上千字的正文，而它天然以行首开头、
 * 也没有句读（整行正文可能一个句号都没有），会被误判成"章节标记行" ——
 * 实测这会让前言无限叠加（把整章正文当前言反复前置，产出 6000 万字）。
 * 支持的真实格式，都来自实测：
 *   · `第1章 标题` / `第十二回` / `第3节`      —— 最常见
 *   · `☆、001` / `☆.001` / `☆001`            —— 女频/PO 系常见
 *   · `001.` / `1、` 单独成行的纯编号          —— 简洁排版
 *
 * ⚠️ 为什么必须锚定行首：宽松版（允许标记出现在任意位置）会把正文里的
 * 「可是第一回到求道谷的？」当成章节分隔 —— 实测一本 `☆、001` 格式的书
 * 因此只切出 1 处"章节"（还是误切的），21 章的真实结构全丢。
 *
 * ⚠️ `[ \t　]` 里**不能加 `\r`**：CRLF 文件按 `\n` 切分后行尾残留 `\r`，
 * 若把 `\r` 当空白吃掉，`☆、001\r` 会同时满足"纯编号单独成行"那条分支，
 * 捕获组只拿到 `☆、`（实测标题因此全变成 `☆、`）。让 `\r` 留在行里、
 * 由调用方先剥掉，分支就不会互相抢。
 */
const CHAPTER_LINE_RE = new RegExp(
  '^[ \\t　]*('
  // ⚠️ 「纯编号单独成行」要放在星号分支前面：`☆.001` 既匹配星号分支
  // 也匹配这条，谁在前面决定标题取到 `☆.001` 还是 `☆.`
  + '\\d{1,4}\\s*[、.．·]\\s*$'                                          // 001. 单独成行
  + '|☆[、,，.·・]?\\s*\\d{1,4}'                                          // ☆、001
  + '|☆[、,，.·・]?\\s*第?\\s*[0-9〇零一二三四五六七八九十百千两]{1,6}\\s*[章回节]?'
  + '|第\\s*[0-9〇零一二三四五六七八九十百千两]{1,6}\\s*[章回节卷]'          // 第1章
  + ')[ \\t　]*(.*)$',
);

/** 剥掉行尾的 `\r`（CRLF 文件按 `\n` 切分后会残留） */
const stripCR = (s) => String(s).replace(/\r+$/, '');

/** 章节标记行必然很短；超过这个长度的一律不当作标记行 */
const MARKER_LINE_MAX = 80;

/** 该行是否是章节标记行（含长度上限，见 CHAPTER_LINE_RE 注释） */
function isChapterMarkerLine(line) {
  const s = stripCR(String(line || '')).trim();
  return s.length > 0 && s.length <= MARKER_LINE_MAX && CHAPTER_LINE_RE.test(s);
}

/**
 * 宽松的章节标记：标记的**起始位置**。
 *
 * 两种真实文本的要求是矛盾的，靠两条判据区分：
 *
 *   · 要支持：整篇没有换行的文件，章节号夹在正文之间
 *     （实测 `…上一段第16章…`，全文 2 个章节号、必须切出来）
 *   · 要排除：正文句子里的「可是**第一回到**求道谷的？」（实测一本 `☆、001`
 *     格式的书因此多切出 2 章，而那竟是它唯一"识别到"的章节）
 *
 * 排除判据（与引号无关，是**结构性**的）：
 *   `第N章/回/节` 后面紧跟 `到`／`了`／`过`／`的` 这类**续接虚词**时，
 *   它是句中成分而不是章节标记 —— `第一回到求道谷` 里的「第一回」正是如此，
 *   而真正的章节标记后面跟的是标题或句读。
 *
 * ⚠️ 这个正则**只用来定位**（配 `matchAll` 取 `index`），不要拿它做
 * `String.split`。踩过的坑：`split` 会把每个**捕获组**插进结果数组，
 * 若捕获组写成 `(第N章[^\n]{0,24})`，它会吃掉标记所在行前面的正文，
 * 于是"标记 + 标题"被切成两段，标题直接丢掉。用 index 切分就没有这个问题。
 */
const CHAPTER_LOOSE_RE = /第\s*[一二三四五六七八九十百千零两\d]+\s*[章回节](?![到了过之]|的)/g;

/**
 * 按章节标记切分。
 *
 * 先用**行首**标记（真实章节），识别不到再退回任意位置匹配。
 * 返回的每一段都保留自己的标题行，交给 `titleOf` 处理。
 */
function splitByChapterMarkers(text) {
  const src = String(text);
  const lines = src.split('\n');

  // ① 行首标记：逐行扫描，找到标记行就开新章
  const starts = [];
  for (let i = 0; i < lines.length; i++) {
    if (isChapterMarkerLine(lines[i])) starts.push(i);
  }
  if (starts.length >= 2) {
    const parts = [];
    for (let k = 0; k < starts.length; k++) {
      const from = starts[k];
      const to = k + 1 < starts.length ? starts[k + 1] : lines.length;
      parts.push(lines.slice(from, to).join('\n'));
    }
    // 第一个标记之前的内容（书名/作者/简介）作为序章并入第一章，
    // 否则这部分设定会整块丢掉。
    // ⚠️ 结尾必须补换行：head 若自带换行会被下一行的拼接压平，
    // 章节标记就落到行中间去了，标题判据（行首是标记）随之失效。
    if (starts[0] > 0) {
      const head = lines.slice(0, starts[0]).join('\n').trim();
      if (head) parts[0] = `${head}\n${parts[0]}`;
    }
    return parts.map(p => p.trim()).filter(Boolean);
  }

  /**
   * ② 退回宽松匹配（整篇挤一行的文件）。
   *
   * ⚠️ 用 **index 切分**，不要 `src.split(RE)`：
   * `split` 会把每个捕获组插进结果，而捕获组里的 `[^\n]{0,N}`（若这么写）
   * 会连标记**前面**的正文一起吃进来，把"标记 + 标题"切成两段、标题因此丢掉。
   * 按 index 切分则标记永远落在它所在分段的**开头**，
   * `titleOf` 的第一条判据（行首是标记 → 整行当标题）就能正常生效。
   */
  const cuts = [...src.matchAll(CHAPTER_LOOSE_RE)].map(m => m.index);
  if (!cuts.length) return [src.trim()].filter(Boolean);
  const out = [];
  for (let k = 0; k < cuts.length; k++) {
    const from = cuts[k];
    const to = k + 1 < cuts.length ? cuts[k + 1] : src.length;
    out.push(src.slice(from, to).trim());
  }
  // 第一个标记之前的内容（书名/简介）并入第一章，别丢掉设定。
  // ⚠️ 结尾补换行，理由同上：否则标记会被压到行中间，标题判据失效。
  const head = src.slice(0, cuts[0]).trim();
  if (head) out[0] = `${head}\n${out[0]}`;
  return out.filter(Boolean);
}

/**
 * 切分章节。返回的 index **从 0 开始**（内部用），
 * 对外展示请用 index+1，或直接用 listChapters()。
 */
function parseChapters(text, { maxLen = 6000, minChapterLen = 100, mergeShort = true } = {}) {
  let parts = splitByChapterMarkers(text).filter(p => p.trim().length > minChapterLen);

  // 过短的“章节”多半是误切（目录、卷首语），合并到上一章。
  // 但如果整篇都很短（章节普遍 < 400 字），说明是短篇，不应合并。
  if (mergeShort && parts.length > 1) {
    const lens = parts.map(p => p.trim().length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (avg >= minChapterLen * 4) {
      const merged = [];
      for (const p of parts) {
        if (merged.length && p.trim().length < avg * 0.35) {
          merged[merged.length - 1] += '\n\n' + p;
        } else {
          merged.push(p);
        }
      }
      parts = merged;
    }
  }

  if (parts.length > 1) {
    // ⚠️ 这里**必须**再过一遍 maxLen：超长章节不能原样放行（见 splitLongPart 注释）
    const out = [];
    for (const [i, p] of parts.entries()) {
      for (const c of splitLongPart(p, titleOf(p, i), maxLen)) {
        out.push({ index: out.length, title: c.title, text: c.text.trim(), part: c.part, partCount: c.partCount });
      }
    }
    return out;
  }

  // 没有章节标记 → 按定长切块（整篇一律视为"1 章"，便于范围选择）
  const chunks = [];
  const src = String(text);
  for (let i = 0; i < src.length; i += maxLen) {
    chunks.push({
      index: chunks.length,
      title: `第${chunks.length + 1}块`,
      text: src.slice(i, i + maxLen),
    });
  }
  return chunks;
}

/**
 * 章节概览（给 /api/chapters 用）。**不调用 LLM，纯字符串处理**。
 * 返回的 index **从 1 开始**，与 UI 和 chapterRange 的编号一致。
 */
export function listChapters(text, opts = {}) {
  const chapters = parseChapters(text, opts);
  return chapters.map(c => ({
    index: c.index + 1,
    title: c.title,
    chars: c.text.length,
  }));
}

/**
 * 切分章节并按 chapterRange 过滤。
 *
 * @param {string} text
 * @param {{maxLen?: number, minChapterLen?: number, mergeShort?: boolean, chapterRange?: string}} opts
 *   chapterRange 用 1-based 章号（'all' / '1-10' / '1,3,5-8'）。
 *   为空或 'all' → 全部处理。
 * @throws {Error} 选中章节为空时抛错（调用方据此给出可读提示）
 */
export function chunkText(text, { maxLen = 6000, minChapterLen = 100, mergeShort = true, chapterRange } = {}) {
  const all = parseChapters(text, { maxLen, minChapterLen, mergeShort });

  const raw = chapterRange === undefined || chapterRange === null ? '' : String(chapterRange).trim();
  if (!raw || raw === 'all') return all;

  const wanted = new Set(parseRange(raw, all.length));
  const selected = all.filter(c => wanted.has(c.index + 1));
  if (selected.length === 0) {
    throw new Error(`选中的章节为空（共 ${all.length} 章，范围「${raw}」没有命中任何章节）`);
  }
  return selected;
}

/**
 * 把 LLM 的返回**强制**取成数组。
 *
 * 为什么必须有这个：抽取类步骤都期望 JSON 数组，但真实模型经常把数组
 * 包在对象里再返回 —— `{"events":[...]}`、`{"worldbook":[...]}`、`{"list":[...]}`。
 * 原来的写法是 `Array.isArray(x) ? x : []`，遇上包裹形态就**静默变成空数组**，
 * 于是"事件 0 个 / 世界观 0 条"，而 EJS、变量树、导演指令全部空转，
 * 且一个字都不报错（实测：人物档案是单对象所以正常，事件/世界观是数组所以全丢）。
 *
 * 这里按已知的容器键逐个尝试；都拿不到再退化为"对象里第一个数组值"。
 * 返回值始终是数组。
 */
export function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === null || raw === undefined) return [];

  if (typeof raw === 'object') {
    // ① 先判断"这个对象本身是不是一个条目" —— 必须优先，否则会被下面的
    //    "第一个数组值" 规则误伤（实测：{name,content,keys} 被当成容器，
    //    content 是字符串、name 也是字符串，结果返回了 ["云京"]）
    const SELF_KEYS = [
      'name', 'raw', 'type', 'category', 'event', 'text', 'content',
      '内容', '名称', '事件名', '分类', '正文', 'title',
    ];
    const looksLikeSelf = SELF_KEYS.some(k => k in raw
      && (typeof raw[k] === 'string' || typeof raw[k] === 'number'));
    if (looksLikeSelf) return [raw];

    // ② 容器键：模型把数组包在对象里（{"events":[...]} / {"世界观":[...]}）
    const KEYS = [
      'items', 'list', 'data', 'result', 'results', 'array',
      'events', 'event', 'mentions', 'phases', 'deltas', 'worldbook',
      'world', 'characters', 'character', 'roster', 'entries',
      '事件', '时间提及', '阶段', '增量', '世界观', '人物', '名单', '条目',
    ];
    for (const k of KEYS) {
      if (Array.isArray(raw[k])) return raw[k];
    }
    // ③ 退一步：对象里第一个数组值（模型自创键名时兜底）
    for (const v of Object.values(raw)) {
      if (Array.isArray(v)) return v;
    }
    return [];
  }

  // 字符串：可能是 JSON 文本，或逗号/换行分隔的列表
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return asArray(parsed);
    } catch { /* 不是 JSON，按分隔符切 */ }
    return s.split(/[\n,，、;；]+/).map(x => x.trim()).filter(Boolean);
  }

  return [];
}

/**
 * 从**多任务合并返回**的对象里取指定键的数组。
 *
 * 为什么不能直接用 asArray：合并调用一次返回多个数组
 * （`{mentions:[...], events:[...]}` / `{worldbook:[...], items:[...]}`），
 * 而 asArray 的兜底是"对象里第一个数组值" —— 取 worldbook 时可能拿到 items，
 * 或者反过来，而且**静默**：条目数量看着正常，分类却全错了。
 *
 * 这里只认给定的键（含少量别名），拿不到就返回空数组，绝不猜。
 *
 * @param {any} raw 模型返回的对象（或它被包了一层的形态）
 * @param {string[]} keys 依次尝试的键名
 * @returns {any[]}
 */
export function pickArrayByKeys(raw, keys) {
  const keyList = Array.isArray(keys) ? keys.filter(Boolean) : [];
  if (!keyList.length) return [];

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of keyList) {
      const v = raw[k];
      if (Array.isArray(v)) return v;
      // 值是对象时可能是单条（{name,...}）也可能是又包了一层（{items:[...]}）
      if (v && typeof v === 'object') {
        const inner = asArray(v);
        if (inner.length) return inner;
      }
    }
    // 模型把结果包在外层键里（{result:{worldbook:[...]}}）—— 只在有唯一候选时下探一层
    const OBJ_KEYS = ['result', 'results', 'data', 'output', 'response'];
    for (const k of OBJ_KEYS) {
      const v = raw[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = pickArrayByKeys(v, keyList);
        if (inner.length) return inner;
      }
    }
    return [];
  }

  // 已经是数组：直接当结果（合并模式下不该出现，但兼容模型只返回了其中一类）
  if (Array.isArray(raw)) return raw;

  // 字符串：可能是 JSON 文本
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return [];
    try {
      const parsed = JSON.parse(s);
      if (parsed && typeof parsed === 'object') return pickArrayByKeys(parsed, keyList);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* 不是 JSON */ }
  }
  return [];
}

/** 把毫秒格式化成 1.2s / 2m03s */
export function formatDuration(ms) {  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/**
 * 生成 UUID v4（用于正则脚本 id 等需要稳定唯一标识的字段）。
 * 优先用 Node 内置 crypto.randomUUID，回退到手写实现以兼容老环境。
 */
export function generateUUID() {
  try {
    // 动态取，避免在某些宿主里没有 crypto
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* 回退到手写实现 */ }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

/** 安全文件名：去掉路径分隔符与非法字符 */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

/**
 * 把小说里抽出的名字（事件名 / 人物名 / 故事线名 / 阶段名）转成可安全用作变量键的形式。
 *
 * 为什么必须做：MVU 变量路径是靠 `.` 拼接的 ——
 *   `{{get_message_variable::stat_data.events.<事件名>.status}}`
 *   含 EJS 的 `getvar('stat_data.events.<事件名>.status')`
 * 名字里若带 `.`（轻小说常见的「剑圣·尤莉」被规范化成点号）或空白，路径就会被切错层，
 * 宏与 EJS 都取到 `undefined`。而 MVU 对取不到的路径只**静默跳过并记日志**
 * （`stat_data 中不存在路径"…"，已跳过 set 命令`），
 * 症状是"状态栏空白、AI 看不到变量、导演指令不推进"，且完全不报错 —— 极难排查。
 *
 * 只处理会破坏路径的字符（`.` 与空白），其余（`（）「」·-_` 等）在路径里合法，保持原样。
 * 显示用的名字（世界书注释、触发关键词）仍然用原始名字。
 */
export function varKey(name) {
  return String(name ?? '')
    .trim()
    .replace(/\./g, '-')
    .replace(/\s+/g, '-');
}
