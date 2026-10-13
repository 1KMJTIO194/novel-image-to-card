/**
 * 超长图片切片测试
 *
 * 背景（实测，用户报告"较大的图片无法读取文字"）：
 *   一张 720x6269 的手机长截图（宽高比 1:8.7）原样发给视觉模型时，
 *   **只读到了帖子的小头像，正文一个字没读到**。
 *   原因：整图被缩到模型的视觉尺寸上限，6269px 被压到约 1/5.4，
 *   字号等效于 133px 显示高度 —— 无法辨认。
 *
 *   实测确认：按 720x1152 切 6 片后，每一片里的中文都**清晰可读**。
 *
 * 这里钉住的是"切法"本身：切错的表现是"图切了但还是读不到字"，
 * 从日志里完全看不出来，所以必须用断言固定住几何关系。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rm, stat } from 'node:fs/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

const S = await import(pathToFileURL(path.join(ROOT, 'src/image_slice.js')).href);
const IC = await import(pathToFileURL(path.join(ROOT, 'src/image_card.js')).href);

const hasSharp = !!S.loadSharp();

// ============================================================
console.log('\n【1】planSlices：该切才切');
{
  // 实测那张：720x6269
  const r = S.planSlices({ width: 720, height: 6269 });
  ok('720x6269 需要切', r.slices.length > 1, `${r.slices.length} 片`);
  ok('片数在 maxSlices 内', r.slices.length <= S.SLICE_DEFAULTS.maxSlices, String(r.slices.length));
  ok('每片高度不超过上限',
    r.slices.every(s => s.height <= S.SLICE_DEFAULTS.maxSliceHeight),
    JSON.stringify(r.slices.map(s => s.height)));
  ok('最后一片正好吃到底（不留尾巴）',
    r.slices[r.slices.length - 1].top + r.slices[r.slices.length - 1].height === 6269,
    JSON.stringify(r.slices[r.slices.length - 1]));
  ok('第一片从 0 开始', r.slices[0].top === 0, String(r.slices[0].top));
  ok('区间中间没有缝隙（重叠不算缝隙）', (() => {
    for (let i = 1; i < r.slices.length; i++) {
      if (r.slices[i].top > r.slices[i - 1].top + r.slices[i - 1].height) return false;
    }
    return true;
  })(), JSON.stringify(r.slices));

  // 窄长比例
  ok('720x2160（1:3）不切（正好在阈值上）',
    S.planSlices({ width: 720, height: 2160 }).slices.length === 0, '');
  ok('720x2161（略超阈值）要切',
    S.planSlices({ width: 720, height: 2161 }).slices.length > 1, '');

  // 普通图不切
  ok('1080x991 不切', S.planSlices({ width: 1080, height: 991 }).slices.length === 0, '');
  ok('887x1920（1:2.2 手机截图）不切', S.planSlices({ width: 887, height: 1920 }).slices.length === 0, '');
  ok('不切时给出原因（不能静默）', S.planSlices({ width: 1080, height: 991 }).reason.length > 0, '');

  // 横向长图：竖切无意义（要横切，不在本功能范围）
  ok('2000x300 横向长图不切',
    S.planSlices({ width: 2000, height: 300 }).slices.length === 0, '');
  ok('横向图的原因说明是"竖切无意义"',
    /横向/.test(S.planSlices({ width: 2000, height: 300 }).reason), '');

  // 极端长图受 maxSlices 保护
  const ext = S.planSlices({ width: 200, height: 40000 });
  ok('极端长图受 maxSlices 限制', ext.slices.length <= S.SLICE_DEFAULTS.maxSlices, String(ext.slices.length));

  // 边界与异常输入
  ok('0 尺寸返回空', S.planSlices({ width: 0, height: 0 }).slices.length === 0, '');
  ok('null 不崩', S.planSlices(null).slices.length === 0, '');
  ok('undefined 不崩', S.planSlices(undefined).slices.length === 0, '');
  ok('缺字段不崩', S.planSlices({ width: 100 }).slices.length === 0, '');

  // 参数可覆盖（阈值不是写死的）
  const custom = S.planSlices({ width: 720, height: 2160 }, { maxAspect: 2 });
  ok('maxAspect 可配置', custom.slices.length > 1, `${custom.slices.length} 片`);
  const capped = S.planSlices({ width: 200, height: 40000 }, { maxSlices: 3 });
  ok('maxSlices 可配置', capped.slices.length <= 3, String(capped.slices.length));
}

// ============================================================
console.log('\n【2】切片目标比例要落在"可读"区间');
{
  const r = S.planSlices({ width: 720, height: 6269 });
  const ratios = r.slices.map(s => s.height / 720);
  ok('每片宽高比都 ≤ targetAspect（不会又变成细长条）',
    ratios.every(x => x <= S.SLICE_DEFAULTS.targetAspect + 0.01),
    JSON.stringify(ratios.map(x => x.toFixed(2))));
  ok('每片宽高比不会太扁（≥1，否则切了也没提升）',
    ratios.every(x => x >= 1), JSON.stringify(ratios.map(x => x.toFixed(2))));
  ok('标注宽高比与原图一致（720x1152 实测值）',
    Math.abs(ratios[0] - 1.6) < 0.01, String(ratios[0]));
}

// ============================================================
console.log('\n【3】切片重叠：防止正好切在文字行中间');
{
  const o = S.SLICE_DEFAULTS.overlap;
  ok('默认重叠比例在合理区间（2%~20%）', o >= 0.02 && o <= 0.2, String(o));
  const r = S.planSlices({ width: 720, height: 6269 });
  const step = r.slices[1].top - r.slices[0].top;
  const overlapPx = r.slices[0].height - step;
  ok('相邻片确实有重叠像素', overlapPx > 0, String(overlapPx));
  ok('重叠量与 overlap 设置相符',
    Math.abs(overlapPx - Math.round(r.slices[0].height * o)) <= 1,
    `${overlapPx} vs ${Math.round(r.slices[0].height * o)}`);
}

// ============================================================
console.log('\n【4】normalizeCharacterProfiles：切片段要映射回原图下标');
{
  // 模拟：4 张原图，第 1 张被切成 3 片 → 发给模型 6 个文件
  const map = [0, 0, 0, 1, 2, 3];
  const raw = { characters: [
    { imageIndex: 4, name: '甲' },   // 文件5 → 原图2
    { imageIndex: 0, name: '乙' },   // 文件1 → 原图0
    { imageIndex: 3, name: '丙' },   // 文件4 → 原图1
    { imageIndex: 5, name: '丁' },   // 文件6 → 原图3
  ] };
  const p = IC.normalizeCharacterProfiles(raw, { imageCount: 6, imagePaths: map });
  const byName = Object.fromEntries(p.map(x => [x.name, x.imageIndex]));
  ok('文件4 → 原图2（映射正确）', byName['甲'] === 2, String(byName['甲']));
  ok('文件0 → 原图0', byName['乙'] === 0, String(byName['乙']));
  ok('文件3 → 原图1', byName['丙'] === 1, String(byName['丙']));
  ok('文件5 → 原图3', byName['丁'] === 3, String(byName['丁']));

  // 无映射表时保持既有语义：局部下标 + imageOffset = 全局图号
  const p2 = IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 2, name: '戊' }] },
    { imageCount: 6, imageOffset: 10 });
  ok('无映射表时按 offset 平移（局部 2 + offset 10 = 12）', p2[0].imageIndex === 12, String(p2[0].imageIndex));

  /**
   * ⚠️ 有映射表时**不能**再叠加 offset。
   *
   * 映射表里存的已经是全局下标（切片时算好），再平移一次就会把「（图N）」
   * 指到不存在的图上。这不是假想问题 —— 第一版实现就漏了这条，
   * 两个循环同时生效导致双重平移，是这个测试抓出来的。
   */
  const p2b = IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 0, name: '戊二' }] },
    { imageCount: 6, imageOffset: 10, imagePaths: map });
  ok('有映射表时**不**叠加 offset（不会双重平移）', p2b[0].imageIndex === 0, String(p2b[0].imageIndex));

  // 越界下标要夹住，不能产生不存在的图号
  const p3 = IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 99, name: '己' }] },
    { imageCount: 6, imagePaths: map });
  ok('越界下标被夹回映射表范围', p3[0].imageIndex === 3, String(p3[0].imageIndex));

  const p4 = IC.normalizeCharacterProfiles({ characters: [{ imageIndex: -5, name: '庚' }] },
    { imageCount: 6, imagePaths: map });
  ok('负数下标被夹到 0', p4[0].imageIndex === 0, String(p4[0].imageIndex));

  ok('空映射表退回原行为',
    IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 1, name: '辛' }] },
      { imageCount: 3, imagePaths: [] })[0].imageIndex === 1, '');
  ok('imagePaths 为 null 不崩',
    IC.normalizeCharacterProfiles({ characters: [{ imageIndex: 1, name: '壬' }] },
      { imageCount: 3, imagePaths: null })[0].imageIndex === 1, '');
}

// ============================================================
console.log('\n【5】真的切一张图（几何 + 产物，需要 sharp）');
if (!hasSharp) {
  console.log('  （未安装 sharp，跳过 —— 回落行为见【6】）');
} else {
  const sharp = S.loadSharp();
  const dir = path.join(ROOT, 'tests', '_tmp-slice-test');
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });

  try {
    // 造一张 400x2000 的图（宽高比 1:5，必然要切）
    const src = path.join(dir, 'tall.jpg');
    await sharp({ create: { width: 400, height: 2000, channels: 3, background: '#345' } })
      .jpeg().toFile(src);

    const r = await S.sliceTallImage(src, path.join(dir, 'out'));
    ok('切片成功', r.sliced, r.reason);
    ok('片数与计划一致', r.pieces.length === S.planSlices({ width: 400, height: 2000 }).slices.length,
      `${r.pieces.length}`);
    ok('每片文件确实写出来了', (await Promise.all(r.pieces.map(p => stat(p.path).then(() => true, () => false)))).every(Boolean), '');

    // 每片的实际尺寸要和计划一致（宽度不能变，高度要吻合）
    for (const p of r.pieces) {
      const m = await sharp(p.path).metadata();
      ok(`片 ${p.sliceIndex + 1} 宽度保持 400`, m.width === 400, String(m.width));
      ok(`片 ${p.sliceIndex + 1} 高度与计划一致`, m.height === p.height, `${m.height} vs ${p.height}`);
    }

    // 缝合后的覆盖要完整：不能有没被任何片覆盖的像素
    const covered = new Array(2000).fill(false);
    for (const p of r.pieces) for (let y = p.top; y < p.top + p.height; y++) covered[y] = true;
    ok('原图每一行都被至少一片覆盖（无漏切）', covered.every(Boolean),
      `未覆盖 ${covered.filter(x => !x).length} 行`);

    // 短图不该切
    const short = path.join(dir, 'short.jpg');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: '#345' } })
      .jpeg().toFile(short);
    const rs = await S.sliceTallImage(short, path.join(dir, 'out2'));
    ok('短图不切且不产生产物', !rs.sliced && rs.pieces.length === 0, rs.reason);

    // 坏文件要优雅失败，不能抛
    const bad = path.join(dir, 'bad.jpg');
    await writeFile(bad, 'not an image', 'utf-8');
    const rb = await S.sliceTallImage(bad, path.join(dir, 'out3'));
    ok('非图片文件优雅失败（不抛异常）', !rb.sliced, rb.reason);
    ok('失败原因可读', /失败/.test(rb.reason), rb.reason);

    // 批量：混合长短图
    const r2 = await S.sliceAllForVision([
      { index: 0, path: src, label: '图片1' },
      { index: 1, path: short, label: '图片2' },
    ], path.join(dir, 'out4'));
    ok('批量切片只切需要切的', r2.slicedCount === 1, String(r2.slicedCount));
    ok('映射表长度等于文件数', r2.mapping.length === r2.files.length, `${r2.mapping.length} vs ${r2.files.length}`);
    ok('映射表里第一张图的所有片段都指向 0',
      r2.mapping.slice(0, r2.files.length - 1).every(x => x === 0),
      JSON.stringify(r2.mapping));
    ok('短图映射到自己的下标 1', r2.mapping[r2.mapping.length - 1] === 1, String(r2.mapping[r2.mapping.length - 1]));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================================
console.log('\n【6】sharp 缺失时优雅回落（不能把任务搞挂）');
{
  const saved = S.loadSharp();
  try {
    S.__setSharpForTest(null);
    const r = await S.sliceTallImage('whatever.jpg', 'whatever', {});
    ok('无 sharp 时不抛异常', r.sliced === false, '');
    ok('无 sharp 时说明原因（含"未安装"）', /sharp 未安装/.test(r.reason), r.reason);

    const r2 = await S.sliceAllForVision(
      [{ index: 0, path: 'nonexistent.jpg', label: '图片1' }], 'tmp');
    ok('批量在无 sharp 时退回原图', r2.files.length === 1 && r2.slicedCount === 0, JSON.stringify(r2.files));
    ok('映射表仍然可用（恒等）', r2.mapping[0] === 0, JSON.stringify(r2.mapping));
    ok('把"没切"写进 notes 让用户能看到', r2.notes.some(n => /未安装/.test(n)), JSON.stringify(r2.notes));
  } finally {
    S.__setSharpForTest(saved);
  }
}

// ============================================================
console.log('\n【7】接线：image_card 里真的用了切片，且映射传到了归一化');
{
  const src = await readFile(path.join(ROOT, 'src/image_card.js'), 'utf-8');
  ok('import 了 sliceAllForVision', /import \{ sliceAllForVision \}/.test(src), '');
  ok('在发图前调用了切片', /sliceAllForVision\(images/.test(src), '');
  ok('按发送文件数切批（不是按原图数）', /visionFiles\.length/.test(src), '');
  ok('每批带 sliceOf 映射', /sliceOf:\s*visionMap\s*\?/.test(src), '');
  ok('映射传进了 normalizeCharacterProfiles', /imagePaths: sliceOf/.test(src), '');
  ok('切完清理临时切片', /rm\(sliceDir/.test(src), '');
  ok('切片失败不中断任务（有 catch 回退）', /长图切片失败，改用原图/.test(src), '');
  ok('prompt 里说明了"多段属于同一张图，别重复登记"', /同一张超长截图/.test(src), '');
  ok('结果里带 slicing 诊断字段', /slicing: visionMap \?/.test(src), '');
  ok('sharp 是可选加载（不 import 顶层）', !/^import .*sharp/m.test(src), '');
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  图片切片测试：通过 ${pass} · 失败 ${fail}${hasSharp ? '' : '（未装 sharp，部分跳过）'}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
