/**
 * 便携版打包
 *
 * 产物结构（zip 根目录即 novel2card-便携版/）：
 *   novel2card-便携版.zip
 *     ├─ 启动.cmd          Windows 一键启动（纯 ASCII，避免 cmd 代码页问题）
 *     ├─ 启动.command      macOS 一键启动
 *     ├─ 启动.sh           Linux 一键启动
 *     ├─ 使用说明.txt       三平台说明 + 常见问题
 *     ├─ scripts/launcher.mjs  Windows 脚本调用的 Node 启动器（中文提示都在这里）
 *     ├─ server.js  src/  public/  package.json
 *
 * 启动脚本不在这里拼接成字符串，而是直接复制 scripts/ 下的真实文件 ——
 * 那些文件有测试覆盖（tests/launcher.mjs），内联成字符串就没法测了。
 */
import archiver from 'archiver';
import { createWriteStream, createReadStream } from 'node:fs';
import { cp, mkdir, rm, writeFile, readFile, chmod, copyFile, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { checkLauncherCall } from './src/launch-scripts.js';

const NAME = 'novel2card-便携版';
const DIST = 'dist';
const TARGET = path.join(DIST, NAME);
const ZIP_PATH = path.join(DIST, `${NAME}.zip`);

/** 需要一并放进 zip 的启动相关文件 */
const LAUNCH_FILES = ['启动.cmd', '启动.command', '启动.sh', '使用说明.txt', 'launcher.mjs'];

async function main() {
  console.log('🧹 清理旧构建...');
  await rm(DIST, { recursive: true, force: true });
  await mkdir(TARGET, { recursive: true });

  console.log('📁 复制源码...');
  await cp('src', path.join(TARGET, 'src'), { recursive: true });
  await cp('public', path.join(TARGET, 'public'), { recursive: true });
  await copyFile('server.js', path.join(TARGET, 'server.js'));

  // 改写 package.json（去掉 devDependencies 与测试脚本）
  const pkg = JSON.parse(await readFile('package.json', 'utf-8'));
  delete pkg.devDependencies;
  delete pkg.scripts.test;
  for (const k of Object.keys(pkg.scripts)) {
    if (k.startsWith('test')) delete pkg.scripts[k];
  }
  delete pkg.scripts['build:portable'];
  pkg.name = 'novel2card-portable';
  pkg.description = '小说 → 角色卡生成器（便携版）';
  await writeFile(path.join(TARGET, 'package.json'), JSON.stringify(pkg, null, 2));
  console.log('   package.json 已精简（移除 devDependencies 与测试脚本）');

  // ---------- 启动脚本 ----------
  console.log('📝 复制一键启动脚本...');
  await mkdir(path.join(TARGET, 'scripts'), { recursive: true });
  for (const f of LAUNCH_FILES) {
    const src = path.join('scripts', f);
    const dst = f === 'launcher.mjs'
      ? path.join(TARGET, 'scripts', f)      // 启动器放 scripts/
      : path.join(TARGET, f);                // 三平台脚本与说明放根目录
    await copyFile(src, dst);
    const size = (await stat(dst)).size;
    console.log(`   ${(f === 'launcher.mjs' ? 'scripts/' : '') + f}  (${size} B)`);
  }

  // 便携版不打包测试，但启动器里的自检提示仍指向根目录，无需改动

  // 可执行权限（macOS / Linux）；Windows 上 chmod 无效，忽略即可
  for (const f of ['启动.command', '启动.sh']) {
    try {
      await chmod(path.join(TARGET, f), 0o755);
      console.log(`   ${f} 已设为可执行 (755)`);
    } catch {
      console.log(`   ${f} 无法在本机设置可执行位（Windows 正常现象，zip 内已记录权限）`);
    }
  }

  // 校验：Windows 脚本必须纯 ASCII，否则 cmd 会按代码页解析出错
  const cmdText = await readFile(path.join(TARGET, '启动.cmd'), 'utf-8');
  const bad = [...cmdText].filter(c => c.codePointAt(0) > 127);
  if (bad.length) {
    throw new Error(`启动.cmd 含 ${bad.length} 个非 ASCII 字符，cmd 可能解析失败：${[...new Set(bad)].join('')}`);
  }
  console.log('   ✓ 启动.cmd 纯 ASCII 校验通过');

  // 校验：启动器位置必须唯一且正确。
  // 事故背景：有人看到报错 `scripts\scripts\launcher.mjs`（scripts 出现两次）。
  // 真正的成因是启动器被多套了一层，导致根目录算错、后续所有路径全错。
  // 这里在产物层面直接拦住：只允许 scripts/launcher.mjs 一个位置，且不能有嵌套。
  {
    const launcherAt = path.join(TARGET, 'scripts', 'launcher.mjs');
    const launcherRoot = path.join(TARGET, 'launcher.mjs');
    const nested = path.join(TARGET, 'scripts', 'scripts');
    if (!existsSync(launcherAt)) {
      throw new Error('启动器位置错误：缺少 scripts/launcher.mjs（启动脚本按这个相对路径调用它）');
    }
    if (existsSync(launcherRoot)) {
      throw new Error('启动器重复：根目录与 scripts/ 下同时存在 launcher.mjs，请只保留 scripts/launcher.mjs');
    }
    if (existsSync(nested)) {
      throw new Error('检测到 scripts/scripts/ 嵌套目录 —— 这正是"路径里 scripts 出现两次"的成因，请修正复制逻辑');
    }
    // 启动脚本里的路径必须真的能解析到启动器。
    //
    // ⚠️ 这里**不能**再写成 `/node\s+"scripts\\launcher\.mjs"/` 这种字面量匹配：
    //    它既不认 `%~dp0…` 这种正确写法，也分不清路径对不对 ——
    //    实际事故就是它把 `node "scripts\scripts\launcher.mjs"` 放过去了
    //    （子串能匹配上），却把正确的写法拦下来。
    //    现在统一交给 src/launch-scripts.js 按运行时语义解析后比对。
    const cmdText2 = await readFile(path.join(TARGET, '启动.cmd'), 'utf-8');
    const callCheck = checkLauncherCall(cmdText2, TARGET, [
      path.join(TARGET, 'scripts', 'launcher.mjs'),   // 便携布局的标准位置
      path.join(TARGET, 'launcher.mjs'),              // 兼容：启动器放根目录
    ]);
    if (!callCheck.ok) {
      throw new Error(`启动.cmd 无法正确找到启动器：${callCheck.reason}`);
    }
    console.log(`   ✓ 启动器调用校验通过（解析为 ${path.relative(TARGET, callCheck.target)}）`);
  }

  console.log('📦 打包为 zip...');
  await zipDirectory(TARGET, ZIP_PATH);

  // ---------- 打包后自检 ----------
  // 打包中途被中断时 zip 会残留 0 字节；这里直接校验，避免把坏包发出去
  const zipSize = (await stat(ZIP_PATH)).size;
  if (zipSize < 4096) {
    throw new Error(`zip 体积异常（${zipSize} B），打包可能被中断，请重新执行 npm run build:portable`);
  }
  const entryCount = await countZipEntries(ZIP_PATH);
  if (entryCount < 20) {
    throw new Error(`zip 条目数异常（${entryCount}），打包可能不完整`);
  }

  console.log(`\n✅ 打包完成`);
  console.log(`   文件夹：${TARGET}/`);
  console.log(`   压缩包：${ZIP_PATH} (${(zipSize / 1024 / 1024).toFixed(2)} MB，${entryCount} 个条目)`);
  console.log(`\n   解压后根目录：`);
  for (const f of [...LAUNCH_FILES.filter(f => f !== 'launcher.mjs'), 'scripts/', 'src/', 'public/', 'server.js', 'package.json']) {
    console.log(`     ${f}`);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`把 zip 发给朋友，附上这段话：`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`《小说 → 角色卡生成器》便携版\n`);
  console.log(`解压后（用 7-Zip / WinRAR，避免中文乱码）：`);
  console.log(`  • Windows：双击「启动.cmd」`);
  console.log(`  • macOS：右键「启动.command」→ 打开（首次需这样绕过安全提示）`);
  console.log(`  • Linux：终端运行 ./启动.sh（首次先 chmod +x 启动.sh）\n`);
  console.log(`首次运行会自动装依赖（需联网，等 30 秒~2 分钟），`);
  console.log(`装完浏览器自动打开，填自己的 API Key 即可使用。\n`);
  console.log(`详细说明见「使用说明.txt」。`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.on('warning', (w) => { if (w.code !== 'ENOENT') reject(w); });

    archive.pipe(output);
    addTree(archive, sourceDir, NAME).then(
      () => archive.finalize(),
      reject
    );
  });
}

/**
 * 递归加入目录。
 *
 * 不用 archive.directory()：它从文件系统 stat 读取权限位，
 * 而 Windows 上没有可执行位，chmod 无效 —— 打出来的 zip 里
 * 启动.command / 启动.sh 会是 0666，macOS/Linux 解压后无法直接执行。
 * 这里显式指定 mode，跨平台都能正确保留执行权限。
 */
async function addTree(archive, dir, prefix) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const name = `${prefix}/${e.name}`;
    if (e.isDirectory()) {
      // 目录条目：0755
      archive.append('', { name: `${name}/`, mode: 0o755, type: 'directory' });
      await addTree(archive, abs, name);
      continue;
    }
    if (!e.isFile()) continue;
    // 可执行脚本给 0755，其余 0644
    const mode = EXECUTABLE.has(e.name) ? 0o755 : 0o644;
    archive.append(createReadStream(abs), { name, mode });
  }
}

/** 需要带执行位的文件（macOS / Linux 双击运行） */
const EXECUTABLE = new Set(['启动.command', '启动.sh']);

/**
 * 数一数 zip 里有多少个条目（直接解析中央目录，不依赖外部命令）。
 * 用于打包后自检：条目太少说明打包没完成。
 */
async function countZipEntries(zipPath) {
  const buf = await readFile(zipPath);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return 0;
  return buf.readUInt16LE(eocd + 10);
}

main().catch(e => {
  console.error('\n❌ 打包失败：', e?.message || e);
  process.exit(1);
});
