/**
 * 启动脚本解析（构建校验与测试共用）
 *
 * 存在理由：一个真实事故 —— 用户双击启动时看到
 *   Error: Cannot find module 'D:\...\scripts\scripts\launcher.mjs'
 *
 * 成因不是"目录多套了一层"，而是两件事凑在一起：
 *   ① 启动脚本先 `cd /d "%~dp0"`（进到 scripts\），
 *   ② 然后又写 `node "scripts\launcher.mjs"`（再进一次 scripts\）。
 *
 * 而当时的校验只断言 `/node\s+"scripts\\launcher\.mjs"/` 出现在文件里 ——
 * 它既不认 `%~dp0` 这种正确写法，也分不清"路径对不对"，只看字符串长什么样。
 * 现在改成：解析出调用行 → 按运行时语义算出**真实文件路径** → 断言它就是
 * 启动器该在的位置。这样两种布局（仓库 / 便携包）用同一套规则验证。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';

/**
 * 批处理里的注释行（REM / ::）—— 注释里的字样不能参与判定
 */
const isCmdComment = (line) => /^\s*(REM\b|::)/i.test(line);

/**
 * 模拟脚本里的 `set` 赋值链，算出运行时 VAR 最终是什么（已展开 `%~dp0` 与已定义变量）。
 *
 * 要处理两种赋值，缺一不可：
 *   · 无条件：`set "LAUNCHER=%~dp0scripts\launcher.mjs"`      ← 初始候选
 *   · 条件式：`if not exist "%LAUNCHER%" set "LAUNCHER=%~dp0launcher.mjs"`  ← 回退候选
 *
 * 不能"取最后一次赋值"：条件式赋值只在条件成立时执行。
 *   第一行的候选存在 → 第二行不跑 → 结果应是第一行的值。
 *   取最后一次会永远得到回退值，于是便携布局（启动器在 scripts\）被误判成"找不到启动器"。
 *
 * @param {string} cmdText
 * @param {string|null} baseDir  %~dp0 的展开值（脚本所在目录）；null 表示不展开
 * @param {((p:string)=>boolean)|null} fileExists 供测试注入；默认查真实文件系统
 * @returns {string|null} 最终值；脚本里没有这种赋值时为 null
 */
function resolveExistenceChain(cmdText, baseDir = null, fileExists = null) {
  const base = baseDir
    ? (String(baseDir).endsWith(path.sep) ? String(baseDir) : String(baseDir) + path.sep)
    : null;

  /**
   * 把一段**原始**值展开成具体路径。
   *
   * 必须只调用一次、不能对已展开的结果再展开：
   * 早期版本把变量表里存的**已展开**值又过了一遍 `expand`，于是 `%~dp0` 被替换两次，
   * 拼出 `...\scripts\scripts\launcher.mjs`，条件判定跟着全错。
   *
   * @returns {string|null} 具体路径；含未定义变量（如 %errorlevel%）时返回 null
   */
  const concretize = (raw) => {
    let v = String(raw || '').trim();
    if (base) v = v.replace(/%~dp0/gi, base);
    v = v.replace(/%(\w+)%/g, (m0, name) => vars.get(name.toUpperCase()) ?? m0);
    return v.includes('%') ? null : v;    // 还有 % 说明引用了我们不认识的变量
  };
  const exists = fileExists || ((p) => existsSync(p));

  // `set "VAR=值"`（带引号）优先；不带引号的 `set VAR=值` 兜底
  const parseSet = (line) => /\bset\s+"(\w+)=([^"]*)"/i.exec(line)
    || /\bset\s+(\w+)=(.+)$/i.exec(line);

  const vars = new Map();
  const assigned = new Set();   // 已经开过链的变量名
  let first = null;             // 第一个开链的变量 —— 它就是"定位启动器"的那个
  let chain = null;             // { name, raw, resolved }

  for (const rawLine of String(cmdText || '').split('\n')) {
    const line = rawLine.trim();
    if (isCmdComment(line)) continue;

    const isGuard = /^if\s+not\s+exist\b/i.test(line);
    if (isGuard) {
      // 守卫行里的 goto 不是赋值（`if not exist "X" goto NO_LAUNCHER` 末尾带引号，
      // 会被宽松的正则误当成 set），直接跳过
      if (!/\bset\b/i.test(line) || /\bgoto\b/i.test(line)) continue;
    } else if (!/^set\s/i.test(line)) {
      continue;
    }

    const m = parseSet(line);
    if (!m) continue;
    const name = m[1];
    const rawValue = m[2].trim();

    if (isGuard) {
      // 条件里的路径可能写成 `%~dp0xxx`、`%VAR%` 或引号字面量。
      // 不能写 /^if not exist "?([^"]+?)"?\s+set/ —— 懒惰匹配在第一个引号处就停，取成空串。
      const cond = /^if\s+not\s+exist\s+(?:"([^"]*)"|(%~dp0[^\s]*|%\w+%|\S+))\s+set\b/i.exec(line);
      if (!cond) continue;
      const condRaw = (cond[1] !== undefined && cond[1] !== '') ? cond[1] : (cond[2] || '');

      /**
       * 条件路径的解析**不能走 vars 表**：表里存的是已经展开好的值，
       * 再展开一次会把 `%~dp0` 替换两遍，拼出 `...\scripts\scripts\launcher.mjs`。
       * 正确做法是按语义分流：
       *   · `%VAR%`   —— 就是这个变量当前的值（已经是具体路径）直接拿来用；
       *   · 其它写法  —— 用 concretize 展开一次。
       */
      let condPath;
      const asVar = /^%(\w+)%$/.exec(condRaw.trim());
      if (asVar) {
        condPath = vars.get(asVar[1].toUpperCase()) ?? null;
      } else {
        condPath = concretize(condRaw);
      }
      // 候选文件存在 → 条件不成立，这条赋值不执行，链条到此为止
      if (condPath && !condPath.includes('%') && exists(condPath)) break;

      // 只把**同一个变量**的后续赋值看作回退候选
      if (!chain || chain.name !== name) continue;
      chain.raw = rawValue;
      chain.resolved = concretize(rawValue);
      vars.set(name.toUpperCase(), chain.resolved ?? rawValue);
      continue;
    }

    /**
     * 无条件赋值。
     *
     * ⚠️ 只认**每个变量名的第一次**，其余一律忽略 ——
     * 脚本后面还有 `set "CODE=%errorlevel%"`、`set "NODE_VERSION=…"` 这类
     * 与定位启动器毫不相干的赋值。早期版本让它们把 chain 重置了，
     * 于是 `resolveExistenceChain` 返回的是 `CODE` 的值（`%errorlevel%` → null），
     * 明明解析正确却报"找不到启动器"。
     */
    if (assigned.has(name)) continue;
    assigned.add(name);
    const entry = { name, raw: rawValue, resolved: concretize(rawValue) };
    vars.set(name.toUpperCase(), entry.resolved ?? rawValue);
    if (!first) { first = entry; chain = entry; }
  }

  return first ? first.resolved : null;
}

/**
 * 取出 .cmd 里所有真正执行 node 的行（已去注释、已 trim）。
 *
 * 只挑"以 call node / node / start node 开头"的行：
 *   · `where node >nul`、`for /f … in ('node -v')` 这类是探测，不是执行；
 *   · 调用行里可能写的是变量（`call node "%LAUNCHER%"`），**不含** launcher.mjs 字样，
 *     所以不能按名字筛行 —— 必须先取出候选行，再用 resolveCmdTarget 解析出真实路径。
 *     早期版本按 `launcher.mjs` 筛行，于是加了变量之后一行都筛不到。
 *
 * @param {string} cmdText
 * @returns {string[]}
 */
export function extractNodeCalls(cmdText) {
  return String(cmdText || '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => !isCmdComment(l))
    .filter(l => /^(call\s+|start\s+)?node(\.exe)?\s/i.test(l));
}

/** @deprecated 用 extractNodeCalls —— 旧名字会让人误以为能按 launcher.mjs 筛行 */
export const extractLauncherCalls = extractNodeCalls;

/**
 * 解析一行 node 调用**在运行时实际会打开哪个文件**。
 *
 * 三种写法按各自语义展开：
 *   · `%~dp0xxx`   —— 替换成"脚本所在目录"，与当前目录无关；
 *   · `%VAR%`      —— 取链式 `if not exist … set "VAR=…"` 里最后一次赋的值；
 *   · 裸相对路径   —— 相对"当前目录"，而当前目录由脚本里的 `cd /d "%~dp0"` 决定。
 *
 * @param {string} cmdText   批处理全文（用来找 cd 与变量赋值）
 * @param {string} scriptDir 该 .cmd 所在目录
 * @param {string} line      调用行
 * @returns {string|null} 绝对路径；调用行里没有 node 目标时为 null
 */
export function resolveCmdTarget(cmdText, scriptDir, line) {
  // %~dp0 在批处理里**永远展开成绝对路径**（含盘符，运行时由 cmd.exe 保证）。
  // 所以调用方给相对目录时必须先解析成绝对路径 —— 否则拼出来是相对路径，
  // 又被下面的 path.resolve 按当前工作目录锚定一次，路径就翻倍了
  //（实测：dist/xxx/dist/xxx/launcher.mjs）。
  const absScriptDir = path.resolve(scriptDir);
  const cdMatch = /cd\s+\/d\s+"([^"]+)"/i.exec(String(cmdText || ''));
  // 判据是"脚本是否先把当前目录切到自己所在目录"；
  // 本工具的三份启动脚本都这么做，换个 cd 目标这套模拟就不适用了。
  const cwd = cdMatch && /%~dp0/i.test(cdMatch[1]) ? absScriptDir : process.cwd();
  const m = /\bnode\b\s+(?:"([^"]+)"|(\S+))/.exec(String(line || ''));
  if (!m) return null;
  const raw = m[1] || m[2];

  const base = absScriptDir.endsWith(path.sep) ? absScriptDir : absScriptDir + path.sep;
  let expanded = raw;
  // 调用行写的是变量（`call node "%LAUNCHER%"`）时，赋值链解析出的**已经是具体路径**，
  // 不能再走下面的 %~dp0 替换 —— 对已展开的值再展开一次会拼出
  // `...\scripts\scripts\launcher.mjs`（实测踩过），于是"文件不存在"被误判。
  const varName = /^%(\w+)%$/.exec(expanded.trim());
  if (varName) {
    const assigned = resolveExistenceChain(cmdText, absScriptDir);
    if (assigned === null) return null;
    return path.resolve(assigned);
  }
  expanded = expanded.replace(/%~dp0/gi, base);
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded));
}

/**
 * 一次问清"这份 .cmd 会不会正确找到 launcher.mjs"。
 *
 * 启动器在两个布局里的位置不同，所以接受**候选列表**：
 * 解析结果命中其中任意一个（按大小写不敏感比较，Windows 路径不区分大小写）即算通过。
 * 只给一个候选就等于要求精确匹配。
 *
 * @param {string} cmdText       批处理全文
 * @param {string} scriptDir     该 .cmd 所在目录
 * @param {string|string[]} launcherCandidates 启动器允许在的绝对路径
 * @returns {{ok:boolean, reason?:string, calls:string[], target:string|null, matched?:string|null}}
 */
export function checkLauncherCall(cmdText, scriptDir, launcherCandidates) {
  const candidates = (Array.isArray(launcherCandidates) ? launcherCandidates : [launcherCandidates])
    .filter(Boolean)
    .map(p => path.resolve(p));

  // 只看"解析结果确实指向某个 launcher.mjs"的调用行；
  // node 执行其它脚本（或探测命令）不算，也不该影响判定。
  const nodeCalls = extractNodeCalls(cmdText);
  const calls = nodeCalls.filter(l => /launcher\.mjs/i.test(resolveCmdTarget(cmdText, scriptDir, l) || ''));
  if (calls.length === 0) {
    return {
      ok: false,
      reason: '没有找到会执行 launcher.mjs 的 node 调用行',
      calls: nodeCalls,
      target: null,
      matched: null,
    };
  }
  if (calls.length > 1) {
    return { ok: false, reason: `有 ${calls.length} 行 launcher 调用，应当只有一行`, calls, target: null, matched: null };
  }
  const target = resolveCmdTarget(cmdText, scriptDir, calls[0]);
  if (!target) {
    return { ok: false, reason: `调用行里解析不出 node 目标：${calls[0]}`, calls, target: null, matched: null };
  }
  const matched = candidates.find(c => c.toLowerCase() === target.toLowerCase()) || null;
  if (!matched) {
    return {
      ok: false,
      calls,
      target,
      matched: null,
      reason: `调用行解析到 ${target}，但启动器只可能在：${candidates.join(' 或 ')}`
        + '（别用裸相对路径 "scripts\\launcher.mjs" —— 仓库布局下会变成 scripts\\scripts\\launcher.mjs）',
    };
  }
  return { ok: true, calls, target, matched };
}
