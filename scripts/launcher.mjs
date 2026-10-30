/**
 * 一键启动器（Node 实现）
 *
 * 为什么用 Node 而不是纯批处理：
 *   cmd.exe 按"控制台代码页"解析 .bat 内容，UTF-8 的中文批处理在部分系统上会被
 *   吃掉字节导致语法错乱；chcp 65001 在旧版 conhost 里中文又会乱码。
 *   把逻辑放在 Node 里可以稳定输出 UTF-8，Windows / macOS / Linux 三平台共用同一套实现。
 *
 * 因此：
 *   Windows → 启动.cmd（纯 ASCII，只负责找 node）→ 本文件
 *   macOS   → 启动.command（bash，原生 UTF-8）
 *   Linux   → 启动.sh（bash，原生 UTF-8）
 *
 * 依赖：仅 Node 内置模块。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import net from 'node:net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 定位项目根目录 —— **对自身被放错位置也免疫**。
 *
 * 原本只写 `__dirname/..`，这依赖"本文件一定在 <root>/scripts/ 下"这个约定。
 * 一旦有人把启动器多套了一层（<root>/scripts/scripts/launcher.mjs）
 * 或者直接放在根目录，ROOT 就会算错，后面所有路径（server.js / node_modules / .deps-ok）
 * 全部指错地方，报错信息还会呈现成 `scripts\scripts\launcher.mjs` 这种"路径重复"的样子
 * —— 看起来像拼接 bug，其实是根目录算错了。
 *
 * 所以这里改成**向上找根目录标记**（server.js + package.json 同时存在）：
 *   允许放在 <root>/scripts/、<root>/、甚至 <root>/任意/层/，
 *   找不到就退回 __dirname/.. 并给出明确提示，绝不静默用一个错的根目录。
 *
 * N2C_ROOT 仍可用于自动化测试（把启动器指到一份临时副本上）。
 */
const ROOT_MARKERS = ['server.js', 'package.json'];
export function locateRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (ROOT_MARKERS.every(f => existsSync(path.join(dir, f)))) return { root: dir, hops: i };
    const parent = path.dirname(dir);
    if (parent === dir) break;      // 到盘根了
    dir = parent;
  }
  return { root: path.resolve(startDir, '..'), hops: -1 };
}

const LOCATED = process.env.N2C_ROOT
  ? { root: path.resolve(process.env.N2C_ROOT), hops: 0 }
  : locateRoot(__dirname);
const ROOT = LOCATED.root;
/** 本文件相对于根目录的位置，仅用于自检输出 */
const SELF_REL = path.relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const IS_WIN = platform() === 'win32';
const NODE_MIN = 18;
const DEPS_MARKER = path.join(ROOT, '.deps-ok');
const MIRROR = 'https://registry.npmmirror.com';

// ============================================================
// 命令行参数
// ============================================================
const argv = process.argv.slice(2);
const argPort = (() => {
  const i = argv.findIndex(a => a === '--port' || a === '-p');
  const v = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const n = Number(v || process.env.PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000;
})();
const NO_PAUSE = argv.includes('--no-pause') || process.env.N2C_NO_PAUSE === '1';
const NO_BROWSER = argv.includes('--no-browser') || process.env.N2C_NO_BROWSER === '1';
/** 只做预检（Node / 依赖 / 端口），不启动服务；用于排查启动问题 */
const CHECK_ONLY = argv.includes('--check');

let PORT = argPort;

// ============================================================
// 输出
// ============================================================
const say = (...a) => console.log(...a);
const rule = (ch = '-') => say(ch.repeat(60));
const bigRule = () => say('='.repeat(60));
const blank = () => say('');

function banner() {
  blank();
  bigRule();
  say('   小说 → 角色卡生成器');
  bigRule();
  blank();
}

/** 结束前等待回车（双击运行时防止窗口一闪而过） */
function pause(code) {
  if (NO_PAUSE || !process.stdin.isTTY) return code;
  blank();
  process.stdout.write('按回车键关闭窗口...');
  try {
    const buf = Buffer.alloc(1);
    // 同步读到换行，避免异步收尾时进程提前退出
    for (let i = 0; i < 4096; i++) {
      const n = readSync(0, buf, 0, 1, null);
      if (n === 0 || buf[0] === 10 || buf[0] === 13) break;
    }
  } catch { /* 无交互输入，直接返回 */ }
  return code;
}

function exitWith(code) {
  process.exit(pause(code));
}

// ============================================================
// 纯逻辑（可被测试直接 import；命中 N2C_IMPORT_ONLY 时不执行主流程）
// ============================================================

/** 依赖是否就绪：node_modules + 安装标记 + 关键包 */
export function depsReady(root = ROOT) {
  const nm = path.join(root, 'node_modules');
  if (!existsSync(nm)) return false;
  if (!existsSync(path.join(root, '.deps-ok'))) return false;
  if (!existsSync(path.join(nm, 'express'))) return false;
  if (!existsSync(path.join(nm, 'multer'))) return false;
  return true;
}
/** 找出占用端口的进程（尽力而为，失败返回 null） */
export function whoOwnsPort(port, { isWin = IS_WIN } = {}) {
  try {
    if (isWin) {
      const out = spawnSync('netstat', ['-ano'], { encoding: 'utf-8', windowsHide: true }).stdout || '';
      const line = out.split('\n').find(l => new RegExp(`:${port}\\s+.*LISTENING`, 'i').test(l));
      const pid = line?.trim().split(/\s+/).pop();
      if (!pid) return null;
      const task = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf-8', windowsHide: true }).stdout || '';
      const name = task.split(',')[0]?.replace(/"/g, '').trim();
      return name ? `${name} (PID ${pid})` : `PID ${pid}`;
    }
    const lsof = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-F', 'cn'], { encoding: 'utf-8' });
    if (lsof.status === 0 && lsof.stdout) {
      const name = lsof.stdout.match(/^c(.+)$/m)?.[1];
      const pid = lsof.stdout.match(/^p(\d+)$/m)?.[1];
      return name ? `${name} (PID ${pid || '?'})` : null;
    }
    const ss = spawnSync('ss', ['-lptn', `sport = :${port}`], { encoding: 'utf-8' });
    const m = ss.stdout?.match(/users:\(\("([^"]+)",pid=(\d+)/);
    return m ? `${m[1]} (PID ${m[2]})` : null;
  } catch {
    return null;
  }
}

/**
 * 探测某个端口上跑的是不是**我们自己的生成器**。
 *
 * 为什么需要：最常见的"端口被占用"其实是**用户自己双击了两次启动脚本** ——
 * 上一次的生成器还在跑。这时最该给的提示不是"换个端口"，而是
 * "已经在运行，直接打开浏览器"。判断依据是 `/api/system` 返回的 `cwd`
 * 是否等于本项目根目录（别的程序不会有这个接口，更不会报出同样的路径）。
 *
 * @returns {Promise<object|null>} `/api/system` 的 JSON；端口没服务/不是我们时 null
 */
export async function probeRunningApp(port, { timeoutMs = 1200, root = ROOT } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system`, {
      signal: AbortSignal.timeout(Math.max(200, Number(timeoutMs) || 1200)),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j || j.ok !== true) return null;
    // cwd 必须是本项目（大小写/斜杠归一后比较，Windows 上不区分大小写）
    const same = typeof j.cwd === 'string'
      && path.resolve(j.cwd).toLowerCase() === path.resolve(root).toLowerCase();
    return { ...j, sameProject: same };
  } catch {
    return null;
  }
}

/** 端口是否空闲 */
export function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 默认向后扫描多少个端口（3000 被占时看 3001…3009） */
export const PORT_SCAN_RANGE = 10;

/**
 * 从 startPort 起向后找**第一个空闲端口**。
 *
 * 为什么不再只试一个 3001：
 *   原来 3000 被占时启动器只问"改成 3001 行不行"，而 3001 也常被别的常驻程序占着
 *   （实测这台机器上 3001 就有服务在监听），于是用户被卡死，只能自己去
 *   `set PORT=3005 && npm start`。向后扫一段能让双击启动继续走下去。
 *
 * @param {number} startPort 起始端口（含）
 * @param {{max?: number, isFree?: (p:number)=>Promise<boolean>, end?: number}} [opts]
 * @returns {Promise<number|null>} 找到的端口；扫完都没有则 null
 */
export async function findFreePort(startPort, opts = {}) {
  const {
    max = PORT_SCAN_RANGE,
    isFree = portFree,
    end = 65535,
  } = opts;
  const start = Math.max(1, Math.floor(Number(startPort) || 0));
  const limit = Math.min(Number(end) || 65535, start + Math.max(1, Number(max) || 1) - 1);
  for (let p = start; p <= limit; p++) {
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(p)) return p;
  }
  return null;
}

/** 命令行参数解析 */
export function parseArgs(argv, env = process.env) {
  const i = argv.findIndex(a => a === '--port' || a === '-p');
  const v = i >= 0 ? argv[i + 1] : argv.find(a => a.startsWith('--port='))?.split('=')[1];
  const n = Number(v || env.PORT);
  return {
    port: Number.isInteger(n) && n > 0 && n < 65536 ? n : 3000,
    noPause: argv.includes('--no-pause') || env.N2C_NO_PAUSE === '1',
    noBrowser: argv.includes('--no-browser') || env.N2C_NO_BROWSER === '1',
  };
}

/** 版本号是否满足下限 */
export function versionOk(version, min = NODE_MIN) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0]);
  return Number.isInteger(major) && major >= min;
}

// ============================================================
// 1. 检测 Node 版本（走到这里说明 node 已经存在）
// ============================================================
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  say(`  [OK] Node.js v${process.versions.node}`);
  if (major < NODE_MIN) {
    blank();
    say(`  [错误] Node.js 版本过低：v${process.versions.node}`);
    blank();
    say(`  本工具需要 ${NODE_MIN} 或更高版本（推荐最新 LTS）。`);
    blank();
    openUrl('https://nodejs.org/');
    exitWith(1);
  }
  if (!hasNpm()) {
    blank();
    say('  [错误] 找到了 Node.js，但没有找到 npm。');
    say('         请重新安装 Node.js LTS 版本（自带 npm）：https://nodejs.org/');
    exitWith(1);
  }
}

/**
 * 构造 npm 的调用方式。
 *
 * 这里踩过两个坑：
 *   1. Windows 上 npm 是 npm.cmd，shell:false 无法直接执行（需要 cmd /c 包装）；
 *      而 shell:true + 参数数组会把参数拼成字符串，Node 会抛 DEP0190 弃用警告。
 *   2. 直接 spawn('npm') 依赖 PATH，在部分环境（例如经 npx 启动）会找不到。
 * 最稳的做法：用当前 Node 执行 npm 自带的 CLI 入口，完全绕开 shell。
 */
function resolveNpm() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return { cmd: process.execPath, baseArgs: [c] };
  }
  // 回退：交给系统 PATH
  return IS_WIN
    ? { cmd: process.env.ComSpec || 'cmd.exe', baseArgs: ['/d', '/s', '/c', 'npm'] }
    : { cmd: 'npm', baseArgs: [] };
}

const NPM = resolveNpm();

function runNpm(args, opts = {}) {
  return spawnSync(NPM.cmd, [...NPM.baseArgs, ...args], {
    cwd: ROOT, windowsHide: true, ...opts,
  });
}

function hasNpm() {
  return runNpm(['--version'], { stdio: 'ignore' }).status === 0;
}

// ============================================================
// 2. 依赖检查（首次运行 / 后续运行 区分提示）
// ============================================================
function runNpmInstall(extraArgs = []) {
  const r = runNpm(['install', '--no-audit', '--no-fund', ...extraArgs], { stdio: 'inherit' });
  return r.status === 0;
}

function ensureDeps() {
  if (depsReady()) {
    say('  [OK] 依赖已就绪');
    return;
  }

  const hadModules = existsSync(path.join(ROOT, 'node_modules'));
  blank();
  rule();
  if (hadModules) {
    say('  依赖似乎不完整，正在重新安装...');
  } else {
    say('  首次运行：正在安装依赖');
  }
  blank();
  say('  * 需要联网，通常 30 秒到 2 分钟');
  say('  * 装完会自动打开浏览器，请不要关闭这个窗口');
  rule();
  blank();

  if (runNpmInstall()) {
    writeFileSync(DEPS_MARKER, 'ok\n');
    blank();
    say('  [OK] 依赖安装完成');
    return;
  }

  blank();
  rule();
  say('  [错误] 依赖安装失败');
  rule();
  blank();
  say('  常见原因：网络问题 / npm 源访问慢。');
  blank();
  say('  正在自动改用国内镜像重试一次...');
  blank();

  if (runNpmInstall([`--registry=${MIRROR}`])) {
    writeFileSync(DEPS_MARKER, 'ok\n');
    blank();
    say('  [OK] 使用国内镜像安装成功');
    return;
  }

  blank();
  say('  [错误] 国内镜像也失败了。请手动执行：');
  blank();
  say(`    npm config set registry ${MIRROR}`);
  say('    npm install');
  blank();
  if (IS_WIN) {
    say('  如果提示权限不足，请用管理员身份重新运行 启动.cmd。');
  } else {
    say('  若提示 EACCES 权限错误：npm config set prefix ~/.npm-global');
    say('  或用 sudo 运行本脚本。');
  }
  exitWith(1);
}

// ============================================================
// 4. 打开浏览器
// ============================================================
function openUrl(url) {
  if (NO_BROWSER) return;
  try {
    if (IS_WIN) {
      // start 是 cmd 内建命令，用 shell 调用
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (platform() === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    say(`  （未能自动打开浏览器，请手动访问 ${url}）`);
  }
}

/** 等服务真正起来再开浏览器（最多 20 秒） */
async function openWhenReady(port) {
  if (NO_BROWSER) return;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/system`, { signal: AbortSignal.timeout(1200) });
      if (res.ok) {
        openUrl(`http://localhost:${port}`);
        return;
      }
    } catch { /* 还没起来，继续等 */ }
    await new Promise(r => setTimeout(r, 500));
  }
}

// ============================================================
// 5. 启动服务
// ============================================================
function startServer(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js', '--port', String(port)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NO_OPEN: '1' }, // 浏览器由启动器负责，避免开两次
    });
    const forward = (sig) => () => { try { child.kill(sig); } catch {} };
    process.on('SIGINT', forward('SIGINT'));
    process.on('SIGTERM', forward('SIGTERM'));
    child.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
    child.on('error', (err) => {
      blank();
      say(`  [错误] 无法启动服务：${err.message}`);
      resolve({ code: 1 });
    });
  });
}

async function launch(port) {
  blank();
  bigRule();
  say('  正在启动服务...');
  say(`  浏览器会自动打开 http://localhost:${port}`);
  say('  用完请回到本窗口按 Ctrl+C 停止');
  bigRule();
  blank();

  openWhenReady(port);
  const { code } = await startServer(port);
  return code;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  if (CHECK_ONLY) return checkOnly();

  banner();
  checkNode();
  ensureDeps();   // 正常启动路径才会安装依赖

  // 启动前先探一次端口，给出比"服务报错"更清楚的提示
  if (!(await portFree(PORT))) {
    blank();
    rule();
    say(`  端口 ${PORT} 已被占用`);
    rule();
    blank();
    const owner = whoOwnsPort(PORT);
    if (owner) say(`  占用者：${owner}`);
    else say('  占用者：识别不到（可能是端口转发 / 容器 / 别的用户下的进程）');

    /**
     * 先判断占用者是不是**我们自己**（多半是用户双击了两次）。
     * 是的话最该做的不是换端口，而是直接打开那个已经在跑的界面。
     */
    const running = await probeRunningApp(PORT);
    if (running?.sameProject) {
      const url = `http://localhost:${PORT}`;
      blank();
      say(`  这其实就是**本项目已经在运行的生成器**（端口 ${PORT}）。`);
      say(`  不需要再启动一个，直接打开界面即可：${url}`);
      blank();
      const reuse = await ask('  现在打开浏览器？(Y/n) ');
      if (reuse === '' || /^y/i.test(reuse)) {
        if (NO_BROWSER) say(`  已禁用浏览器启动，请手动打开：${url}`);
        else openUrl(url);
      }
      exitWith(0);
    }

    blank();
    say('  可能是上一次的生成器还在运行，或别的程序占用了这个端口。');
    blank();

    /**
     * 向后扫一段找空闲端口。
     *
     * 原来只试一个 3001：3001 恰好也被占时就直接放弃，让用户自己 set PORT=。
     * 现在扫 3001…3009，找到哪个就用哪个（扫描区间会打印出来，不会悄悄换端口）。
     */
    const from = PORT + 1;
    const alt = await findFreePort(from, { max: PORT_SCAN_RANGE });
    if (!alt) {
      say(`  [错误] ${from}–${from + PORT_SCAN_RANGE - 1} 都被占用了。请手动指定空闲端口：`);
      say(IS_WIN ? '          set PORT=3005 && npm start' : '          PORT=3005 npm start');
      exitWith(1);
    }
    say(`  已自动找到空闲端口：${alt}`);
    const answer = await ask(`  是否改用端口 ${alt} 重试？(Y/n) `);
    if (answer === '' || /^y/i.test(answer)) {
      PORT = alt;
      say(`  改用端口 ${PORT} 启动...`);
    } else {
      blank();
      say('  已取消。换端口的办法：');
      say(IS_WIN ? '          set PORT=3005 && npm start' : '          PORT=3005 npm start');
      exitWith(1);
    }
  }

  const code = await launch(PORT);

  if (code === 0) {
    blank();
    say('  服务已停止。随时可以再次运行启动脚本。');
    exitWith(0);
  }

  blank();
  say(`  [错误] 服务异常退出（退出码 ${code}）。请把上面的报错信息发给开发者。`);
  exitWith(code);
}

/** 关键文件清单（自检用） */
const REQUIRED_FILES = [
  'server.js', 'package.json',
  'public/index.html', 'public/js/app.js',
  'src/pipeline.js', 'src/encoding.js',
];

/**
 * 收集自检结果（纯逻辑，可被测试直接调用）。
 * 只读文件系统、不开服务、不安装依赖。
 * @returns {Promise<Array<[('OK'|'WARN'|'FAIL'), string]>>}
 */
export async function collectChecks({ root = ROOT, port = PORT } = {}) {
  const results = [];

  // 0. 启动器自身位置（防"scripts\scripts\launcher.mjs"这类路径错位）
  const selfPath = path.relative(root, fileURLToPath(import.meta.url)).replace(/\\/g, '/');
  if (selfPath.startsWith('..')) {
    results.push(['WARN', `启动器不在项目目录内（${selfPath}）—— 若路径看起来重复，请检查是否把 scripts/ 多套了一层`]);
  } else if (selfPath === 'scripts/launcher.mjs') {
    results.push(['OK', '启动器位置正确（scripts/launcher.mjs）']);
  } else {
    results.push(['WARN', `启动器在非标准位置（${selfPath}），建议放在 scripts/launcher.mjs`]);
  }
  // 明确检测"多套一层"这种最坑的错位
  if (existsSync(path.join(root, 'scripts', 'scripts'))) {
    results.push(['WARN', `检测到 ${path.join('scripts', 'scripts')} 目录 —— 启动器可能被多套了一层，`
      + '建议删除该层，只保留 scripts/launcher.mjs']);
  }

  // 1. Node
  const major = Number(process.versions.node.split('.')[0]);
  results.push(major >= NODE_MIN
    ? ['OK', `Node.js v${process.versions.node}`]
    : ['FAIL', `Node.js v${process.versions.node} 低于要求的 ${NODE_MIN}`]);

  // 2. npm
  results.push(hasNpm() ? ['OK', 'npm 可用'] : ['FAIL', '找不到 npm']);

  // 3. 依赖（只检查，不安装 —— 自检不应有副作用）
  const hasModules = existsSync(path.join(root, 'node_modules'));
  if (depsReady(root)) {
    results.push(['OK', '依赖已就绪']);
  } else {
    results.push(['WARN', hasModules
      ? '依赖不完整，启动时会重新安装'
      : '尚未安装依赖，首次启动会自动安装（需联网）']);
  }

  // 4. 关键文件
  for (const f of REQUIRED_FILES) {
    results.push(existsSync(path.join(root, f)) ? ['OK', `存在 ${f}`] : ['FAIL', `缺少 ${f}`]);
  }

  // 5. 端口（被占用时顺带报出"下一个可用的是哪个"，省得用户自己试）
  const free = await portFree(port);
  if (free) {
    results.push(['OK', `端口 ${port} 可用`]);
  } else {
    const owner = whoOwnsPort(port);
    const running = await probeRunningApp(port);
    if (running?.sameProject) {
      // 最常见的情况：用户双击了两次启动脚本，上一次的还在跑
      results.push(['OK', `端口 ${port} 上就是本项目的生成器（已在运行，直接打开 http://localhost:${port} 即可）`]);
    } else {
      const alt = await findFreePort(port + 1, { max: PORT_SCAN_RANGE });
      results.push(['WARN',
        `端口 ${port} 被占用${owner ? `（${owner}）` : ''}`
        + (alt ? `；启动时会自动改用 ${alt}` : `；${port + 1}–${port + PORT_SCAN_RANGE} 也都被占用，需手动指定端口`)]);
    }
  }

  return results;
}

/**
 * 只做预检，不启动服务。
 * 用于排查"启动不起来"：把 Node / 依赖 / 端口一次性列清楚。
 */
async function checkOnly() {
  banner();
  const results = await collectChecks();

  blank();
  rule();
  say('  启动前自检');
  rule();
  for (const [level, msg] of results) {
    const mark = level === 'OK' ? '✓' : level === 'WARN' ? '!' : '✗';
    say(`  ${mark} ${msg}`);
  }
  blank();

  const failed = results.filter(r => r[0] === 'FAIL').length;
  const warned = results.filter(r => r[0] === 'WARN').length;
  say(`  目录：${ROOT}`);
  say(`  结论：${failed ? `${failed} 项失败，无法启动` : warned ? `可以启动（${warned} 项提醒）` : '一切正常，可以启动'}`);
  blank();
  exitWith(failed ? 1 : 0);
}

/**
 * 读一行。
 *
 * 三种情况都要能正常返回，绝不能永久挂住：
 *   1. --no-pause / 明确禁用交互 → 直接走默认分支
 *   2. stdin 不是 TTY（管道、CI、重定向）→ 试着同步读一次，读不到就用默认
 *   3. 交互终端 → 正常异步读取
 */
function ask(prompt) {
  return new Promise((resolve) => {
    if (NO_PAUSE) {
      process.stdout.write(`${prompt}(非交互模式，按默认处理)\n`);
      return resolve('');
    }

    if (!process.stdin.isTTY) {
      // 管道场景：可能有输入，也可能没有。同步读一次，读不到就默认。
      let answer = '';
      try {
        const buf = Buffer.alloc(256);
        const n = readSync(0, buf, 0, buf.length, null);
        answer = n > 0 ? buf.subarray(0, n).toString('utf-8').split(/[\r\n]/)[0].trim() : '';
      } catch {
        answer = '';   // EAGAIN / EOF 等都当作"无输入"
      }
      process.stdout.write(`${prompt}${answer || '(无输入，按默认处理)'}\n`);
      return resolve(answer);
    }

    process.stdout.write(prompt);
    let buf = '';
    const onData = (d) => {
      buf += d.toString('utf-8');
      const i = buf.search(/[\r\n]/);
      if (i < 0) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(buf.slice(0, i).trim());
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

// 被测试 import 时只取纯函数，不执行主流程
if (!process.env.N2C_IMPORT_ONLY) {
  main().catch((e) => {
    blank();
    say(`  [错误] 启动器异常：${e?.message || e}`);
    exitWith(1);
  });
}
