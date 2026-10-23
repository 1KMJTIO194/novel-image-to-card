/**
 * 「从本机目录生成」测试
 *
 * 起因（用户原话）：
 *   「我翻文件找有点麻烦」
 *   「用这个漫画生成一个角色卡看看效果」（一话 23 张图，一张张点选不现实）
 *
 * 浏览器拿不到目录列表，所以这件事必须由**本机服务**做。既然服务要读任意目录，
 * 安全就变成第一位的：
 *   · 只允许**回环地址**发起的请求（即使 HOST 被设成 0.0.0.0）
 *   · 只收图片扩展名
 *   · 沿用 MAX_IMAGES 上限
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

// ============================================================
console.log('\n【1】扫描目录：只收图片、按页序、限量');
{
  const tmp = await mkdtemp(path.join(tmpdir(), 'n2c-dir-'));
  try {
    // 故意用 1/2/10 这种"字典序会错"的命名
    for (const n of ['1.jpg', '2.jpg', '10.jpg', 'cover.webp', 'note.txt', 'data.json', '.DS_Store']) {
      await writeFile(path.join(tmp, n), 'x', 'utf-8');
    }
    await mkdir(path.join(tmp, 'sub'), { recursive: true });

    const r = await IC.listImagesInDir(tmp);
    ok('ok', r.ok, JSON.stringify(r.errors));
    ok('只收图片扩展名（txt/json/DS_Store 被排除）',
      r.images.every(p => /\.(jpg|jpeg|png|webp|gif)$/i.test(p)), JSON.stringify(r.images.map(p => path.basename(p))));
    ok('按**自然序**（1,2,10 而不是 1,10,2）',
      r.images.map(p => path.basename(p)).join(',') === '1.jpg,2.jpg,10.jpg,cover.webp',
      r.images.map(p => path.basename(p)).join(','));
    ok('子目录不扫描但会提示',
      r.warnings.some(w => /子目录/.test(w)), JSON.stringify(r.warnings));

    // 上限
    const many = await mkdtemp(path.join(tmpdir(), 'n2c-many-'));
    try {
      for (let i = 0; i < 5; i++) await writeFile(path.join(many, `${i}.png`), 'x');
      const r2 = await IC.listImagesInDir(many, { max: 3 });
      ok('超过上限时报错并说明张数',
        !r2.ok && r2.errors.some(e => /5 张/.test(e) && /3/.test(e)), JSON.stringify(r2.errors));
    } finally { await rm(many, { recursive: true, force: true }).catch(() => {}); }

    // 空目录
    const empty = await mkdtemp(path.join(tmpdir(), 'n2c-empty-'));
    try {
      const r3 = await IC.listImagesInDir(empty);
      ok('空目录给出可读原因', !r3.ok && /没有图片/.test(r3.errors[0]), JSON.stringify(r3.errors));
    } finally { await rm(empty, { recursive: true, force: true }).catch(() => {}); }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  // 异常输入
  ok('不存在的目录 → 可读错误',
    (await IC.listImagesInDir('Z:\\definitely\\not\\here')).errors[0].includes('目录不存在'), '');
  ok('路径指向文件 → 报"不是一个目录"',
    (await IC.listImagesInDir(path.join(ROOT, 'package.json'))).errors[0].includes('不是一个目录'), '');
  ok('空字符串不崩', !(await IC.listImagesInDir('')).ok, '');
  ok('null 不崩', !(await IC.listImagesInDir(null)).ok, '');
}

// ============================================================
console.log('\n【2】服务端接线：只有本机能用，且只做图片');
{
  const srv = await readFile(path.join(ROOT, 'server.js'), 'utf-8');
  ok('import 了 listImagesInDir', /listImagesInDir/.test(srv), '');
  ok('接受 dirPath 参数', /dirPath/.test(srv), '');
  ok('**校验请求来自回环地址**（防 HOST=0.0.0.0 时被远程读盘）',
    /isLoopback/.test(srv) && /remoteAddress/.test(srv), '');
  ok('非本机请求被拒并说明原因',
    /「从本机目录生成」只允许本机访问/.test(srv), '');
  ok('目录里的图会**复制进任务目录**（产物不依赖原目录）',
    /dirImages/.test(srv) && /copyFile\(src, dest\)/.test(srv), '');
  ok('上传为空但给了目录时不报错',
    /!files\.length && !dirImages\.length/.test(srv), '');
  ok('进度里报出读了多少张', /从目录读取 \$\{dirImages\.length\} 张/.test(srv), '');
}

// ============================================================
console.log('\n【3】前端接线：有输入框，且二选一');
{
  const page = await readFile(path.join(ROOT, 'public/js/pages/image-card.js'), 'utf-8');
  ok('有目录输入框', /image-card-dir/.test(page) && /dirPath/.test(page), '');
  ok('输入框带 id/name/label（表单规范）',
    /id: 'image-card-dir', name: 'dirPath'/.test(page), '');
  ok('填了目录就不要求选图', /!usable\.length && !dirPath/.test(page), '');
  ok('目录会提交给服务端', /fd\.append\('dirPath', dirPath\)/.test(page), '');
}

// ============================================================
console.log('\n【4】命令行工具：同一份扫描逻辑');
{
  const cli = await readFile(path.join(ROOT, 'scripts/image-card-from-dir.mjs'), 'utf-8');
  ok('CLI 复用 listImagesInDir（不重复实现）', /listImagesInDir/.test(cli), '');
  ok('CLI 有 --dry-run（不花钱先看批次）', /dry-run/.test(cli), '');
  ok('CLI 从环境变量读 key（不落盘）',
    /N2C_API_KEY/.test(cli) && !/writeFile[^\n]*apiKey/.test(cli), '');
  ok('CLI 也走总结路径', /extractCardSummary/.test(cli), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  目录读取测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
