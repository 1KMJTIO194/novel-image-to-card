/**
 * 文档链接与精简度测试
 *
 * 背景：根 README 曾长到 1500+ 行（GitHub 首页要滚很久），所以把细节拆进了 docs/。
 * 拆分最怕两件事：
 *   ① 链接写错 → 读者点开 404
 *   ② README 又慢慢长回去
 * 这组测试把两件事都钉住：相对链接必须真实存在、README 必须保持精简。
 */
import path from 'node:path';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

/** 去掉代码围栏与行内代码，避免把示例里的 `](...)` 当成链接 */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
}

/** 提取相对链接并检查存在性；返回断链列表 */
async function brokenLinks(file) {
  const text = stripCode(await readFile(file, 'utf-8'));
  const dir = path.dirname(file);
  const bad = [];
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const target = raw.split('#')[0];
    if (!target) continue;
    const abs = path.resolve(dir, target);
    try {
      const st = await stat(abs);
      if (!st.isFile() && !st.isDirectory()) bad.push(raw);
    } catch {
      bad.push(raw);
    }
  }
  return bad;
}

const README = path.join(ROOT, 'README.md');
const DOCS = path.join(ROOT, 'docs');
const readme = await readFile(README, 'utf-8');
const readmeLines = readme.split(/\r?\n/).length;

// ============================================================
console.log('\n【1】README 保持精简');
{
  ok('根 README ≤ 300 行（拆分前 1500+ 行）', readmeLines <= 300, String(readmeLines));
  ok('README 指向文档索引 docs/README.md', /\(docs\/README\.md\)/.test(readme), '');
  const longSections = ['## 命令系统', '## 产物说明', '## 图片生成角色卡', '## 两个任务模式', '## 测试', '## 目录结构'];
  const left = longSections.filter(s => readme.includes(`${s}\n`));
  ok('长章节已移出 README（只留入口）', left.length === 0, left.join('、'));
  ok('README 仍包含快速开始与许可（落地页要素）',
    /## 快速开始/.test(readme) && /## 许可/.test(readme) && /\[LICENSE\]\(LICENSE\)/.test(readme), '');
}

// ============================================================
console.log('\n【2】文档文件齐全且非空');
{
  const need = ['LAUNCHER', 'ENCODING', 'WEB_UI', 'COMMANDS', 'PRESETS',
    'OUTPUT_AND_IMPORT', 'IMAGE_CARD', 'USAGE', 'DEVELOPMENT', 'README'];
  let missing = [];
  let empty = [];
  for (const n of need) {
    try {
      const st = await stat(path.join(DOCS, `${n}.md`));
      if (st.size < 200) empty.push(n);
    } catch { missing.push(n); }
  }
  ok('10 篇文档都存在', missing.length === 0, missing.join(','));
  ok('每篇都不是空壳（>200 字节）', empty.length === 0, empty.join(','));
  let noBack = [];
  for (const n of need.filter(x => x !== 'README')) {
    const t = await readFile(path.join(DOCS, `${n}.md`), 'utf-8');
    if (!/\]\(\.\.\/README\.md\)/.test(t)) noBack.push(n);
  }
  ok('每篇展开文档都有回链根 README', noBack.length === 0, noBack.join(','));
}

// ============================================================
console.log('\n【3】相对链接全部有效');
{
  const badReadme = await brokenLinks(README);
  ok('根 README 无断链', badReadme.length === 0, badReadme.join('、'));
  ok('根 README 链接的文档都存在', (await brokenLinks(README)).length === 0, '');

  const badDsh = await brokenLinks(path.join(ROOT, 'dsh/README.md'));
  ok('dsh/README 无断链', badDsh.length === 0, badDsh.join('、'));

  const docNames = (await readdir(DOCS)).filter(n => n.endsWith('.md'));
  const badDocs = [];
  for (const n of docNames) badDocs.push(...(await brokenLinks(path.join(DOCS, n))).map(l => `${n} → ${l}`));
  ok('docs/ 下全部文档无断链', badDocs.length === 0, badDocs.slice(0, 5).join('、'));

  const index = await readFile(path.join(DOCS, 'README.md'), 'utf-8');
  const usageDocs = ['LAUNCHER', 'ENCODING', 'WEB_UI', 'COMMANDS', 'PRESETS',
    'OUTPUT_AND_IMPORT', 'IMAGE_CARD', 'USAGE', 'DEVELOPMENT'];
  const unlisted = usageDocs.filter(n => !index.includes(`(${n}.md)`));
  ok('docs 索引列出全部使用文档', unlisted.length === 0, unlisted.join(','));

  const notes = ['batching', 'merged-calls', 'character-tiers', 'timeline-from-events',
    'step75-statusbar', 'statusbar-sanitization', 'dates-and-triggers', 'image-to-card',
    'image-card-batch-limits', 'variable-overhead-and-story', 'real-novel-findings',
    'worldview-merge-fixes', 'augment-fixes-and-summary', 'augment-merge-into-existing',
    'chapter-marker-formats'];
  const unlistedNotes = notes.filter(n => !index.includes(`(${n}.md)`));
  ok('docs 索引列出全部技术笔记', unlistedNotes.length === 0, unlistedNotes.join(','));
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  文档链接测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
