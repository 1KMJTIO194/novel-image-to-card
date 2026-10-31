/**
 * 一键启动器测试
 *
 * 说明：本沙箱禁止 spawn 子进程，因此不能由测试脚本去"运行启动器"。
 * 改为两条互补的验证：
 *   1. 静态检查：三平台脚本齐全、Windows 脚本纯 ASCII、Unix 脚本关键分支与结构
 *   2. 逻辑单测：直接 import launcher.mjs 的纯函数（依赖判定 / 端口探测 / 参数解析 / 版本校验）
 * 端到端"真的把服务拉起来"由手工/CI 运行 scripts/启动.cmd 覆盖（见 README）。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  mkdir, rm, writeFile, readFile, stat, mkdtemp,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import net from 'node:net';
// 调用路径的解析规则与 build-package.js 共用同一份实现，
// 避免"构建时校验一套、测试里另写一套"而再次分歧。
import { extractNodeCalls, resolveCmdTarget, checkLauncherCall } from '../src/launch-scripts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const exists = (p) => stat(p).then(() => true, () => false);

/** 占用端口，返回释放函数 */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(() => new Promise(r => srv.close(r))));
  });
}

/**
 * 直接解析 zip 的中央目录，取出「条目名 → Unix 权限位(3 位八进制)」。
 * 不调用外部命令（本环境禁止 spawn），也不引入额外依赖。
 */
function readZipModes(buf) {
  const out = new Map();
  // 从尾部找 End of Central Directory (0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // 中央目录起始偏移

  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // 中央目录头签名
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const name = buf.toString('utf-8', p + 46, p + 46 + nameLen);
    const mode = (externalAttrs >>> 16) & 0o7777;
    out.set(name, mode.toString(8).padStart(3, '0').slice(-3));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function main() {
  // ============================================================
  console.log('\n【A】三平台启动脚本齐全');
  for (const f of ['启动.cmd', '启动.command', '启动.sh', 'launcher.mjs']) {
    ok(`scripts/${f} 存在`, await exists(path.join(SCRIPTS, f)));
  }
  const cmd = await readFile(path.join(SCRIPTS, '启动.cmd'), 'utf-8');
  const command = await readFile(path.join(SCRIPTS, '启动.command'), 'utf-8');
  const sh = await readFile(path.join(SCRIPTS, '启动.sh'), 'utf-8');

  // ============================================================
  console.log('\n【B】Windows：启动.cmd 必须纯 ASCII（cmd 按代码页解析批处理）');
  {
    const nonAscii = [...cmd].filter(c => c.codePointAt(0) > 127);
    ok('不含非 ASCII 字符', nonAscii.length === 0,
      `发现 ${nonAscii.length} 个：${[...new Set(nonAscii)].slice(0, 12).join('')}`);
    ok('无 BOM', !cmd.startsWith('\uFEFF'));
    ok('设置了 UTF-8 代码页 chcp 65001', /chcp\s+65001/.test(cmd));
    ok('切换到脚本所在目录', /cd \/d "%~dp0"/.test(cmd));
    ok('检测 node（where node）', /where node/i.test(cmd));
    ok('未装 Node 分支存在', /:NO_NODE/.test(cmd));
    ok('未装 Node 时打开下载页', /nodejs\.org/.test(cmd));
    ok('调用 launcher.mjs', /launcher\.mjs/.test(cmd));
    ok('传递端口参数', /--port 3000/.test(cmd));
    ok('失败退出码非 0', /exit \/b 1/.test(cmd));
    ok('双击运行不闪退（pause）', /pause/.test(cmd));
  }

  // ============================================================
  console.log('\n【C】Unix：启动.command / 启动.sh 关键分支');
  for (const [f, body, opener] of [['启动.command', command, 'open'], ['启动.sh', sh, 'xdg-open']]) {
    ok(`${f} 有 bash shebang`, body.startsWith('#!/usr/bin/env bash'));
    ok(`${f} cd 到脚本目录（双击时工作目录不确定）`, /cd "\$\(dirname "\$0"\)"/.test(body));
    ok(`${f} 检测 node`, /command -v node/.test(body));
    ok(`${f} 检测 npm`, /command -v npm/.test(body));
    ok(`${f} Node 版本下限 18`, /NODE_MIN=18/.test(body));
    ok(`${f} 未装 Node 打开官网`, /nodejs\.org/.test(body));
    ok(`${f} 依赖标记 .deps-ok`, /DEPS_MARKER="\.deps-ok"/.test(body));
    ok(`${f} 区分首次运行提示`, /首次运行：正在安装依赖/.test(body));
    ok(`${f} 依赖不完整时另给提示`, /依赖似乎不完整/.test(body));
    ok(`${f} npm install 失败改用国内镜像`, /registry\.npmmirror\.com/.test(body));
    ok(`${f} 镜像也失败时给手动命令`, /npm config set registry/.test(body));
    ok(`${f} 端口占用提示`, /端口 \$PORT 被占用/.test(body));
    ok(`${f} 端口占用给替代方案`, /PORT=3005/.test(body));
    ok(`${f} 用 node server.js --port 启动`, /node server\.js --port/.test(body));
    ok(`${f} 设 NO_OPEN 避免重复开浏览器`, /NO_OPEN=1/.test(body));
    ok(`${f} 服务起来后再开浏览器`, /api\/system/.test(body));
    ok(`${f} 打开浏览器用 ${opener}`, new RegExp(opener).test(body));
    ok(`${f} 结束前等待回车`, /按回车键/.test(body));
    ok(`${f} 先保存退出码再判断`, /CODE=\$\?/.test(body));

    // 结构校验（本环境无 bash，用配对计数代替语法检查）
    const stripped = body.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
    for (const [o, c, label] of [['if', 'fi', 'if/fi'], ['case', 'esac', 'case/esac'], ['do', 'done', 'do/done']]) {
      const on = (stripped.match(new RegExp(`(^|[;&|(]|\\s)${o}\\s`, 'g')) || []).length;
      const cn = (stripped.match(new RegExp(`(^|\\s)${c}(\\s|;|$)`, 'gm')) || []).length;
      ok(`${f} ${label} 配对`, on === cn, `${o}=${on} ${c}=${cn}`);
    }
    ok(`${f} 双引号成对`, ((body.match(/"/g) || []).length % 2) === 0,
      `${(body.match(/"/g) || []).length} 个`);
    ok(`${f} 单引号成对`, ((body.match(/'/g) || []).length % 2) === 0,
      `${(body.match(/'/g) || []).length} 个`);
  }

  // ============================================================
  console.log('\n【C2】调用路径：启动脚本必须能找到同目录的 launcher.mjs');
  {
    /**
     * 这一节是为一个**真实事故**加的：用户双击启动时看到
     *   Error: Cannot find module 'D:\...\scripts\scripts\launcher.mjs'
     *
     * 成因不是"目录多套了一层"，而是两件事凑在一起：
     *   ① 启动脚本先 `cd /d "%~dp0"`（进到 scripts\），
     *   ② 然后又写 `node "scripts\launcher.mjs"`（再进一次 scripts\）。
     * 之前的测试只断言 `/launcher\.mjs/.test(cmd)` —— 而文件头的注释里
     * 本来就有 "scripts\launcher.mjs" 这几个字，所以那条断言恒真，
     * **从来没有验证过真正的调用行**。这里改成解析出调用行再算真实路径。
     */
    const check = checkLauncherCall(cmd, SCRIPTS, [
      path.join(SCRIPTS, 'launcher.mjs'),        // 仓库布局：同目录
      path.join(SCRIPTS, 'scripts', 'launcher.mjs'),
    ]);
    ok('启动.cmd 里恰有一行 launcher 调用', check.calls.length === 1, JSON.stringify(check.calls));
    ok('调用行解析到 scripts\\launcher.mjs（不是 scripts\\scripts\\…）',
      check.ok, check.reason || '');
    // 调用行可以直接写 %~dp0…，也可以写 %LAUNCHER% 再由赋值链解析出来；
    // 真正要保证的是**解析后的路径与工作目录无关**（含盘符的绝对路径）。
    ok('解析结果是绝对路径（不依赖工作目录）',
      !!check.target && path.isAbsolute(check.target), String(check.target));
    ok('解析结果不含 scripts\\scripts\\（cd 之后又拼一次 scripts 的经典错误）',
      !/scripts[\\/]scripts[\\/]/i.test(check.target || ''), String(check.target));
    ok('解析到的文件真实存在', check.target ? await exists(check.target) : false, String(check.target));
    ok('路径里 scripts 只出现一次',
      ((check.target || '').match(/scripts/gi) || []).length === 1, String(check.target));

    // 反向：老的错误写法必须被判失败（证明这套断言真的能拦住它）。
    // 换成字面量的裸相对路径，模拟修复前的 scripts\launcher.mjs。
    const brokenSrc = cmd.split('\n').map(l => {
      const t = l.trim();
      if (!/^\s*(REM\b|::)/i.test(t) && /^call\s+node\b/i.test(t)) {
        return 'call node "scripts\\launcher.mjs" --port 3000';
      }
      return l;
    }).join('\n');
    const brokenCheck = checkLauncherCall(brokenSrc, SCRIPTS, path.join(SCRIPTS, 'launcher.mjs'));
    ok('错误写法 scripts\\launcher.mjs 会被拦住（断言确实有效）',
      brokenCheck.ok === false, JSON.stringify({ ok: brokenCheck.ok, target: brokenCheck.target }));
    ok('错误写法解析出 scripts\\scripts\\…',
      /scripts[\\/]scripts[\\/]launcher\.mjs$/.test(brokenCheck.target || ''), String(brokenCheck.target));

    // 只注释里提到 launcher.mjs，不算调用行
    const commentOnly = 'REM All Chinese messages live in launcher.mjs\r\ncd /d "%~dp0"\r\n';
    ok('注释里的 launcher.mjs 不算调用行（这正是老断言失效的原因）',
      extractNodeCalls(commentOnly).length === 0,
      JSON.stringify(extractNodeCalls(commentOnly)));
    // 探测命令（where node / for /f … node -v）不算执行
    ok('where node / for /f 探测行不算调用',
      extractNodeCalls('where node >nul 2>nul\r\nfor /f "tokens=*" %%i in (\'node -v\') do set "V=%%i"\r\n')
        .length === 0,
      JSON.stringify(extractNodeCalls('where node >nul 2>nul\nfor /f "tokens=*" %%i in (\'node -v\') do set "V=%%i"\n')));

    ok('launcher.mjs 与 启动.cmd 在同一个目录（仓库布局）',
      await exists(path.join(SCRIPTS, 'launcher.mjs')));

    // ---- 便携包布局（若已构建）：根目录启动脚本 + scripts/launcher.mjs ----
    const portDir = path.join(ROOT, 'dist', 'novel2card-便携版');
    if (!(await exists(portDir))) {
      console.log('  · 未找到 dist/novel2card-便携版/，跳过便携布局校验（先执行 npm run build:portable）');
    } else {
      const pcmd = await readFile(path.join(portDir, '启动.cmd'), 'utf-8');
      const pcheck = checkLauncherCall(pcmd, portDir, path.join(portDir, 'scripts', 'launcher.mjs'));
      ok('便携包 启动.cmd 里恰有一行 launcher 调用', pcheck.calls.length === 1, JSON.stringify(pcheck.calls));
      ok('便携布局下解析到 scripts\\launcher.mjs', pcheck.ok, pcheck.reason || '');
      ok('便携布局下解析到的文件真实存在', pcheck.target ? await exists(pcheck.target) : false, String(pcheck.target));
      ok('便携包里启动器不在根目录（避免双份）',
        !(await exists(path.join(portDir, 'launcher.mjs'))));
    }
  }

  // ============================================================
  console.log('\n【D】逻辑单测：依赖判定');
  // 让 launcher.mjs 只导出纯函数，不执行主流程
  process.env.N2C_IMPORT_ONLY = '1';
  const launcher = await import(pathToFileURL(path.join(SCRIPTS, 'launcher.mjs')).href
    + `?t=${Date.now()}`);
  {
    ok('导出了纯函数', ['depsReady', 'portFree', 'parseArgs', 'versionOk', 'whoOwnsPort']
      .every(k => typeof launcher[k] === 'function'), Object.keys(launcher).join(','));

    ok('本项目根目录判定为"已就绪"', launcher.depsReady(ROOT) === true);
    ok('不存在的目录判定为"未就绪"', launcher.depsReady(path.join(ROOT, '.no-such-dir')) === false);

    const tmp = path.join(ROOT, '.tmp-deps');
    await rm(tmp, { recursive: true, force: true });
    await mkdir(path.join(tmp, 'node_modules', 'express'), { recursive: true });
    await mkdir(path.join(tmp, 'node_modules', 'multer'), { recursive: true });

    ok('有 node_modules 但无标记 → 未就绪（需重新确认依赖）', launcher.depsReady(tmp) === false);
    await writeFile(path.join(tmp, '.deps-ok'), 'ok\n');
    ok('标记 + 关键包齐全 → 已就绪', launcher.depsReady(tmp) === true);

    const tmp2 = path.join(ROOT, '.tmp-deps2');
    await rm(tmp2, { recursive: true, force: true });
    await mkdir(path.join(tmp2, 'node_modules', 'express'), { recursive: true });
    await mkdir(path.join(tmp2, 'node_modules', 'multer'), { recursive: true });
    await writeFile(path.join(tmp2, '.deps-ok'), 'ok\n');
    ok('标记 + 关键包齐全 → 已就绪', launcher.depsReady(tmp2) === true);

    // 缺 multer 应当判定未就绪（依赖不完整的典型情况）
    await rm(path.join(tmp2, 'node_modules', 'multer'), { recursive: true, force: true });
    ok('缺少关键包 multer → 未就绪', launcher.depsReady(tmp2) === false);

    await rm(tmp, { recursive: true, force: true });
    await rm(tmp2, { recursive: true, force: true });
  }

  // ============================================================
  console.log('\n【E】逻辑单测：端口探测');
  {
    const port = 3096;
    ok(`端口 ${port} 空闲`, await launcher.portFree(port) === true);

    const release = await holdPort(port);
    ok(`端口 ${port} 被占用时返回 false`, await launcher.portFree(port) === false);

    const owner = launcher.whoOwnsPort(port);
    ok('能识别占用者（或安全返回 null）', owner === null || typeof owner === 'string',
      String(owner));
    if (owner) console.log(`     占用者识别为：${owner}`);

    await release();
    ok(`释放后端口 ${port} 恢复空闲`, await launcher.portFree(port) === true);
  }

  // ============================================================
  console.log('\n【E2】端口被占用时的自救：向后找空闲端口');
  {
    /**
     * 用户反馈过「端口占用」。实测这台机器上 3000 被 C:\Aurabot 占着、
     * 3001 也被别的服务占着 —— 而原来的启动器只试一个 3001，于是直接卡死。
     * 现在改成向后扫一段，这里把扫描逻辑钉住。
     */
    ok('导出了扫描范围常量', typeof launcher.PORT_SCAN_RANGE === 'number' && launcher.PORT_SCAN_RANGE >= 5,
      String(launcher.PORT_SCAN_RANGE));
    ok('导出了 findFreePort', typeof launcher.findFreePort === 'function');

    const fake = (freeFrom) => async (p) => p >= freeFrom;
    ok('从起始端口开始找，跳过被占的', await launcher.findFreePort(3001, { max: 9, isFree: fake(3005) }) === 3005);
    ok('起始端口就空闲时直接用它', await launcher.findFreePort(3001, { max: 9, isFree: fake(3001) }) === 3001);
    ok('全被占用时返回 null', await launcher.findFreePort(3001, { max: 3, isFree: async () => false }) === null);
    ok('不越过高位端口边界',
      await launcher.findFreePort(65533, { max: 10, isFree: async (p) => p === 65534 }) === 65534);
    ok('max 会限制扫描个数', await launcher.findFreePort(3001, { max: 2, isFree: async () => false }) === null);

    // 真实探测：3097 起应当能立即拿到（该段没有服务）
    const real = await launcher.findFreePort(3097, { max: 3 });
    ok('真实探测能拿到空闲端口', typeof real === 'number' && real >= 3097 && real <= 3099, String(real));
  }

  // ============================================================
  console.log('\n【E3】识别端口上是不是本项目（双击两次启动脚本的场景）');
  {
    /**
     * 最常见的"端口被占用" = 用户双击了两次启动脚本。
     * 这时启动器应当认出来并提示"已在运行，直接打开浏览器"，
     * 而不是让用户换端口。
     *
     * 判据：`/api/system` 的 `cwd` 是否等于本项目根目录。
     */
    ok('导出了 probeRunningApp', typeof launcher.probeRunningApp === 'function');

    const port = 3098;
    const httpMod = await import('node:http');
    const srv = httpMod.createServer((req, res) => {
      if (req.url === '/api/system') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cwd: ROOT, port }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    await new Promise((r) => srv.listen(port, '127.0.0.1', r));
    try {
      const info = await launcher.probeRunningApp(port, { root: ROOT });
      ok('能识别出本项目（sameProject=true）', info?.sameProject === true,
        JSON.stringify(info));
      ok('带回了 cwd 与端口', info?.cwd === ROOT && info?.port === port, JSON.stringify(info?.cwd));

      // 换一个 root，应当识别为"不是本项目"
      const other = await launcher.probeRunningApp(port, { root: path.join(ROOT, 'dist') });
      ok('别的目录 → sameProject=false（不会误认成自己）', other?.sameProject === false,
        String(other?.sameProject));
    } finally {
      await new Promise((r) => srv.close(r));
    }

    // 没有服务时返回 null，且不能抛
    const none = await launcher.probeRunningApp(3099, { timeoutMs: 400 });
    ok('端口没服务时安全返回 null', none === null, String(none));
  }

  // ============================================================
  console.log('\n【F】逻辑单测：参数与版本');
  {
    ok('默认端口 3000', launcher.parseArgs([], {}).port === 3000);
    ok('--port 3010', launcher.parseArgs(['--port', '3010'], {}).port === 3010);
    ok('--port=3010', launcher.parseArgs(['--port=3010'], {}).port === 3010);
    ok('-p 3010', launcher.parseArgs(['-p', '3010'], {}).port === 3010);
    ok('环境变量 PORT 生效', launcher.parseArgs([], { PORT: '4010' }).port === 4010);
    ok('命令行优先于环境变量',
      launcher.parseArgs(['--port', '3011'], { PORT: '4010' }).port === 3011);
    ok('非法端口回落 3000', launcher.parseArgs(['--port', 'abc'], {}).port === 3000);
    ok('超范围端口回落 3000', launcher.parseArgs(['--port', '70000'], {}).port === 3000);
    ok('--no-pause 被识别', launcher.parseArgs(['--no-pause'], {}).noPause === true);
    ok('--no-browser 被识别', launcher.parseArgs(['--no-browser'], {}).noBrowser === true);
    ok('N2C_NO_PAUSE 环境变量被识别', launcher.parseArgs([], { N2C_NO_PAUSE: '1' }).noPause === true);

    ok('v24 满足下限', launcher.versionOk('v24.15.0') === true);
    ok('v18 满足下限', launcher.versionOk('v18.0.0') === true);
    ok('v16 不满足', launcher.versionOk('v16.20.0') === false);
    ok('v8 不满足', launcher.versionOk('v8.9.0') === false);
    ok('空版本号不满足', launcher.versionOk('') === false);
    ok('自定义下限生效', launcher.versionOk('v16.0.0', 16) === true);
  }

  // ============================================================
  console.log('\n【G】启动器自身可被解析且不误触发主流程');
  {
    const src = await readFile(path.join(SCRIPTS, 'launcher.mjs'), 'utf-8');
    ok('主流程有执行守卫（N2C_IMPORT_ONLY）', /N2C_IMPORT_ONLY/.test(src));
    ok('只用 Node 内置模块', !/from '(?!node:)/.test(src), '发现非内置 import');
    // 去掉注释行后再检查，避免注释里提到 shell:true 造成误判
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('用当前 Node 执行 npm-cli.js（避免 shell 与 DEP0190）', /npm-cli\.js/.test(code));
    ok('代码里不再使用 shell:true 拼参数', !/shell:\s*true/.test(code));
    ok('代码里不再依赖 shell: IS_WIN 的 npm 调用', !/shell:\s*IS_WIN/.test(code));
  }

  // ============================================================
  console.log('\n【H】打包产物（若已构建）');
  {
    const zipPath = path.join(ROOT, 'dist', 'novel2card-便携版.zip');
    if (!(await exists(zipPath))) {
      console.log('  · 未找到 dist/novel2card-便携版.zip，跳过（先执行 npm run build:portable）');
    } else {
      const modes = readZipModes(await readFile(zipPath));
      const names = [...modes.keys()];
      const find = (name) => names.find(n => n.endsWith(name));

      ok('zip 内包含 启动.cmd', !!find('启动.cmd'), names.join(',').slice(0, 200));
      for (const f of ['启动.command', '启动.sh']) {
        const name = find(f);
        ok(`zip 内 ${f} 带执行位 (755)`, name ? modes.get(name) === '755' : false,
          name ? `实际 ${modes.get(name)}` : '未找到');
      }
      for (const f of ['使用说明.txt', 'server.js', 'package.json', 'scripts/launcher.mjs']) {
        ok(`zip 内包含 ${f}`, !!find(f));
      }
      ok('zip 内不含测试目录', !find('tests/'), names.filter(n => n.includes('tests')).join(','));
      ok('zip 内不含 node_modules（首次运行自己装）', !find('node_modules'), '');
      ok('zip 根目录名为 novel2card-便携版/', names.every(n => n.startsWith('novel2card-便携版/')));

      const readme = await readFile(path.join(SCRIPTS, '使用说明.txt'), 'utf-8');
      ok('使用说明覆盖 Windows 启动', /启动\.cmd/.test(readme));
      ok('使用说明覆盖 macOS 启动', /启动\.command/.test(readme));
      ok('使用说明覆盖 Linux 启动', /启动\.sh/.test(readme));
      ok('使用说明写明首次运行要等依赖', /首次运行要等/.test(readme) && /30 秒到 2 分钟/.test(readme));
      ok('使用说明含国内镜像方案', /registry\.npmmirror\.com/.test(readme));
      ok('使用说明含端口占用方案', /端口 3000 被占用/.test(readme));
      ok('使用说明含 Node 未安装方案', /未检测到 Node\.js/.test(readme));
      console.log(`     已校验 zip 条目 ${modes.size} 个`);
    }
  }

  // ============================================================
  console.log('\n【I】启动前自检（--check）');
  {
    ok('导出了 collectChecks', typeof launcher.collectChecks === 'function',
      Object.keys(launcher).join(','));

    const checks = await launcher.collectChecks();
    ok('自检返回结果列表', Array.isArray(checks) && checks.length >= 8, String(checks.length));
    ok('每项都是 [级别, 说明]',
      checks.every(c => Array.isArray(c) && c.length === 2 && ['OK', 'WARN', 'FAIL'].includes(c[0])),
      JSON.stringify(checks.slice(0, 3)));
    ok('没有 FAIL 项', checks.every(c => c[0] !== 'FAIL'),
      JSON.stringify(checks.filter(c => c[0] === 'FAIL')));
    // 端口状态取决于本机此刻是否有服务在跑，三种都应被测到
    const portCheck = checks.find(c => /端口/.test(c[1]));
    ok('端口检查有结论', !!portCheck, JSON.stringify(checks.map(c => c[1])));
    ok('端口检查结论与实际监听状态一致', await (async () => {
      const held = !(await launcher.portFree(3000));       // 3000 是否被占
      const saysBusy = /被占用/.test(portCheck[1]);
      /**
       * 新增第三种情况：占用者是**本项目的生成器**（恰好本机开着服务）。
       * 这时自检给的是"端口 3000 上就是本项目的生成器（已在运行…）"，
       * 不是"被占用" —— 但它确实是被占着，所以两种情况都算一致。
       */
      const saysSelf = /本项目的生成器/.test(portCheck[1]);
      return held ? (saysBusy || saysSelf) : !(saysBusy || saysSelf);
    })(), portCheck?.[1]);

    // 用一个几乎不可能被占用的高位端口，验证全部 OK 的样子
    const clean = await launcher.collectChecks({ port: 45999 });
    ok('端口空闲时全部为 OK', clean.every(c => c[0] === 'OK'),
      JSON.stringify(clean.filter(c => c[0] !== 'OK')));
    ok('覆盖 Node / npm / 依赖 / 端口',
      checks.some(c => /Node\.js/.test(c[1])) && checks.some(c => /npm/.test(c[1]))
      && checks.some(c => /依赖/.test(c[1])) && checks.some(c => /端口/.test(c[1])));

    for (const f of ['server.js', 'package.json', 'public/index.html', 'public/js/app.js', 'src/pipeline.js', 'src/encoding.js']) {
      ok(`自检覆盖 ${f}`, checks.some(c => c[1].includes(f)), '');
    }

    // 指向不存在的目录 → 关键文件全部缺失
    const bogus = await launcher.collectChecks({ root: path.join(ROOT, '.no-such-root'), port: 3095 });
    const fails = bogus.filter(c => c[0] === 'FAIL');
    ok('目录不存在时报 FAIL', fails.length >= 6, JSON.stringify(fails.map(c => c[1]).slice(0, 3)));
    ok('缺失文件被逐个列出', fails.some(c => /server\.js/.test(c[1])));

    // ============================================================
    // 【I2】启动器自身位置必须对，且错位要能被发现
    //   事故背景：有人报错 `D:\...\scripts\scripts\launcher.mjs` —— 路径里 scripts 出现两次。
    //   根因是启动器被多套了一层（或根目录算错），不是拼接 bug。
    //   现在 locateRoot 向上找 server.js+package.json，所以放哪都能定位到根目录。
    // ============================================================
    const src = await readFile(path.join(SCRIPTS, 'launcher.mjs'), 'utf-8');
    console.log('\n【I2】启动器位置自检与根目录定位');
    {
      ok('导出了 locateRoot', typeof launcher.locateRoot === 'function', Object.keys(launcher).join(','));

      const tmp = await mkdtemp(path.join(tmpdir(), 'n2c-locate-'));
      // 用同步版建目录/写文件，测试里更直观（本就是 fs/promises 的同步对应）
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const mkRoot = (sub = '') => {
        const d = path.join(tmp, sub);
        mkdirSync(d, { recursive: true });
        writeFileSync(path.join(d, 'server.js'), '// stub\n');
        writeFileSync(path.join(d, 'package.json'), '{"name":"x"}\n');
        return d;
      };

      // ① 标准结构：<root>/scripts/launcher.mjs
      const r1 = mkRoot('a');
      mkdirSync(path.join(r1, 'scripts'), { recursive: true });
      const l1 = path.join(r1, 'scripts', 'launcher.mjs');
      writeFileSync(l1, src);
      ok('标准位置能定位到根目录', launcher.locateRoot(path.dirname(l1)).root === r1,
        launcher.locateRoot(path.dirname(l1)).root);
      ok('标准位置 hops=1', launcher.locateRoot(path.dirname(l1)).hops === 1);

      // ② 错位结构：<root>/scripts/scripts/launcher.mjs（就是报错里那个形状）
      const r2 = mkRoot('b');
      const nested = path.join(r2, 'scripts', 'scripts');
      mkdirSync(nested, { recursive: true });
      writeFileSync(path.join(nested, 'launcher.mjs'), src);
      const loc2 = launcher.locateRoot(nested);
      ok('多套一层时仍能定位到真正的根目录', loc2.root === r2, `${loc2.root} vs ${r2}`);
      ok('多套一层时 hops=2（说明是靠向上找标记定位，不是死算上一级）', loc2.hops === 2);
      ok('多套一层不会再拼出 scripts/scripts/launcher.mjs',
        path.join(loc2.root, 'scripts', 'launcher.mjs') !== path.join(nested, 'launcher.mjs'));

      // ③ 直接放在根目录
      const r3 = mkRoot('c');
      writeFileSync(path.join(r3, 'launcher.mjs'), src);
      ok('放在根目录也能定位', launcher.locateRoot(r3).root === r3, launcher.locateRoot(r3).root);
      ok('放在根目录时 hops=0', launcher.locateRoot(r3).hops === 0);

      // ④ 自检要能报出"多套一层"
      const nestedChecks = await launcher.collectChecks({ root: r2, port: 45997 });
      ok('自检发现 scripts/scripts/ 并给出提示',
        nestedChecks.some(c => /多套了一层|scripts.*scripts/.test(c[1])),
        JSON.stringify(nestedChecks.map(c => c[1]).slice(0, 4)));

      // ⑤ 根目录下没有 scripts/scripts/ 时不应误报
      ok('正常结构不误报多套一层',
        !checks.some(c => /多套了一层/.test(c[1])),
        JSON.stringify(checks.filter(c => /多套/.test(c[1])).map(c => c[1])));
      ok('自检里有启动器位置项', checks.some(c => /启动器/.test(c[1])),
        JSON.stringify(checks.map(c => c[1]).slice(0, 3)));

      await rm(tmp, { recursive: true, force: true });
    }

    // --check 必须无副作用（src 已在【I2】里读取）
    ok('--check 存在', /CHECK_ONLY/.test(src));
    ok('--check 提前返回，不调用 ensureDeps',
      /if \(CHECK_ONLY\) return checkOnly\(\);/.test(src),
      '缺少提前返回 —— --check 会触发依赖安装');
    const checkStart = src.indexOf('async function checkOnly');
    const checkFn = src.slice(checkStart, checkStart + 1600);
    ok('checkOnly 内部不安装依赖', !/ensureDeps|runNpmInstall/.test(checkFn));
    ok('checkOnly 只读取 collectChecks 结果', /collectChecks\(\)/.test(checkFn));
  }

  // ============================================================
  console.log('\n【J】交互读取不会永久挂住（管道/CI 场景）');
  {
    const src = await readFile(path.join(SCRIPTS, 'launcher.mjs'), 'utf-8');
    const askFn = src.slice(src.indexOf('function ask(prompt)'), src.indexOf('// 被测试 import 时'));
    ok('ask 有 NO_PAUSE 短路', /if \(NO_PAUSE\)/.test(askFn));
    ok('ask 区分 TTY 与非 TTY', /isTTY/.test(askFn));
    ok('非 TTY 用同步读取（不会 await 一个永不到来的事件）',
      /readSync\(/.test(askFn), '非 TTY 分支没有同步读取 —— 管道场景会永久挂住');
    ok('同步读取用 try/catch 兜住 EAGAIN/EOF', /catch \{/.test(askFn));
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  启动器测试：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
