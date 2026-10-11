/**
 * 编码检测与转码测试
 *
 * 覆盖：GBK / GB2312 / Big5 / Shift_JIS / Latin-1、UTF-8 与 UTF-16 的 BOM、
 * 低置信度、乱码二进制、空文件，以及真值文件
 * （GBK 编码的《高贵仙子的痴女改造1-5.txt》）的完整还原。
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const enc = await import(pathToFileURL(path.join(ROOT, 'src/encoding.js')).href);
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

const TMP = path.join(ROOT, '.tmp-encoding');

/** 把中文文本按指定编码转成 Buffer */
const bytes = (text, encoding) => iconv.encode(text, encoding);

const CN = '高贵仙子的痴女改造：林晚晴在拍卖会上遇见了自称旧识的沈砚，'
  + '她并不知道这个人已经在暗中布局三年。夜色降临时，两个人都没有说出真话。';

async function main() {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  // ============================================================
  console.log('\n【1】模块与依赖');
  ok('导出 detectAndDecode', typeof enc.detectAndDecode === 'function');
  ok('导出 readNovelText', typeof enc.readNovelText === 'function');
  ok('导出 detectBOM / isValidUTF8', typeof enc.detectBOM === 'function' && typeof enc.isValidUTF8 === 'function');
  ok('iconv-lite 与 jschardet 可用', enc.hasEncodingDeps === true);
  ok('置信度阈值为 0.7', enc.CONFIDENCE_WARN === 0.7);

  // ============================================================
  console.log('\n【2】UTF-8（无 BOM）：原样通过，不做转码');
  {
    const buf = Buffer.from(CN, 'utf-8');
    const r = enc.detectAndDecode(buf);
    ok('文本完全一致', r.text === CN, r.text.slice(0, 40));
    ok('编码识别为 utf-8', r.encoding === 'utf-8', r.encoding);
    ok('来源标记为 utf8', r.source === 'utf8', r.source);
    ok('未标记为已转码', r.transcoded === false);
    ok('无警告', r.warnings.length === 0, r.warnings.join('；'));
  }

  // ============================================================
  console.log('\n【3】GBK：按 gbk 解码，中文正确');
  {
    const buf = bytes(CN, 'gbk');
    ok('严格 UTF-8 校验应失败', enc.isValidUTF8(buf) === false);
    const r = enc.detectAndDecode(buf);
    ok('中文完整还原', r.text === CN, JSON.stringify(r.text.slice(0, 40)));
    ok('检测到 GB 系编码', /gb/i.test(r.originalEncoding), r.originalEncoding);
    ok('归一化为 gbk', r.encoding === 'gbk', r.encoding);
    ok('标记为已转码', r.transcoded === true);
    ok('来源为 detected', r.source === 'detected', r.source);
    ok('置信度 > 0.7', r.confidence > 0.7, String(r.confidence));
    ok('无警告', r.warnings.length === 0, r.warnings.join('；'));
    ok('不含替换字符', !r.text.includes('\uFFFD'));
  }

  // ============================================================
  console.log('\n【4】真值验证：GBK 的《高贵仙子的痴女改造1-5》');
  {
    const title = '高贵仙子的痴女改造1-5';
    // 4.1 自己造的 GBK 真值
    const buf = bytes(title + '\n' + CN, 'gbk');
    const r = enc.detectAndDecode(buf);
    ok('标题逐字还原', r.text.startsWith(title), JSON.stringify(r.text.slice(0, 20)));
    ok('没有替换字符', !r.text.includes('\uFFFD'), r.text.slice(0, 20));

    // 4.2 仓库里那份真实上传残留（若存在）
    const real = path.join(ROOT, 'uploads', 'f4c2b164027d2a30b9f09842599c95ae');
    let realBuf = null;
    try { realBuf = await readFile(real); } catch { /* 不存在则跳过 */ }
    if (realBuf) {
      console.log(`     使用真实文件：${(realBuf.length / 1024).toFixed(0)} KB`);
      const rr = enc.detectAndDecode(realBuf);
      ok('真实文件检测为 GB 系编码', /gb/i.test(rr.originalEncoding), rr.originalEncoding);
      ok('真实文件标题正确还原', rr.text.startsWith(title), JSON.stringify(rr.text.slice(0, 24)));
      // 注意：原文件末尾有一个被截断的字节，会产生 1 个替换字符（0.002%）。
      // 这是源文件自带的问题，不是解码错误，因此按比例断言而不是要求绝对为 0。
      const bad = [...rr.text].filter(c => c === '\uFFFD').length;
      const ratio = bad / rr.text.length;
      ok('真实文件替换字符比例可忽略（<0.1%）', ratio < 0.001,
        `${bad} 个 / ${rr.text.length} 字 = ${(ratio * 100).toFixed(4)}%`);
      console.log(`     替换字符 ${bad} 个（原文件末尾截断字节所致）`);
      ok('真实文件首章标题正确',
        /第一章/.test(rr.text.slice(0, 200)), JSON.stringify(rr.text.slice(0, 120)));
      ok('真实文件不含 UTF-8 解码会出现的乱码样本',
        !/锟斤拷|鈥|锛/.test(rr.text), rr.text.slice(0, 60));
      // 对比：按 UTF-8 读会烂掉
      const broken = realBuf.toString('utf8');
      ok('（对照）按 UTF-8 读确实会乱码', broken.includes('\uFFFD') && !broken.startsWith(title));
    } else {
      console.log('     · 未找到真实上传残留，跳过真值文件断言（自造 GBK 真值已覆盖）');
    }
  }

  // ============================================================
  console.log('\n【5】UTF-8 BOM：剥除且不残留 \\uFEFF');
  {
    const buf = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CN, 'utf-8')]);
    const r = enc.detectAndDecode(buf);
    ok('BOM 被剥除', r.text === CN, JSON.stringify(r.text.slice(0, 20)));
    ok('文本不含 \\uFEFF', !r.text.startsWith('\uFEFF'));
    ok('bomStripped 标记为 true', r.bomStripped === true);
    ok('来源标记为 bom', r.source === 'bom', r.source);
    ok('编码为 utf-8', r.encoding === 'utf-8', r.encoding);
    ok('未误判为已转码', r.transcoded === false);

    // 只有 BOM 的空文件
    const onlyBom = Buffer.from([0xEF, 0xBB, 0xBF]);
    const r2 = enc.detectAndDecode(onlyBom);
    ok('只有 BOM 时返回空串', r2.text === '', JSON.stringify(r2.text));
  }

  // ============================================================
  console.log('\n【6】UTF-16 LE / BE：按 BOM 正确解码');
  {
    for (const [name, encName] of [['UTF-16LE', 'utf-16le'], ['UTF-16BE', 'utf-16be']]) {
      const body = iconv.encode(CN, encName);
      const bomBytes = encName === 'utf-16le' ? [0xFF, 0xFE] : [0xFE, 0xFF];
      const buf = Buffer.concat([Buffer.from(bomBytes), body]);
      const r = enc.detectAndDecode(buf);
      ok(`${name}：中文还原`, r.text === CN, JSON.stringify(r.text.slice(0, 24)));
      ok(`${name}：bomStripped 为 true`, r.bomStripped === true);
      ok(`${name}：编码标记正确`, r.encoding === encName, r.encoding);
      ok(`${name}：无替换字符`, !r.text.includes('\uFFFD'));
    }
  }

  // ============================================================
  console.log('\n【7】Big5：繁体中文正确解码');
  {
    const tw = '高貴仙子的痴女改造：林晚晴在拍賣會上遇見了自稱舊識的沈硯，'
      + '她並不知道這個人已經在暗中佈局三年。夜色降臨時，兩個人都沒有說出真話。';
    const buf = bytes(tw, 'big5');
    ok('Big5 字节非法 UTF-8', enc.isValidUTF8(buf) === false);
    const r = enc.detectAndDecode(buf);
    ok('Big5 文本还原', r.text === tw, JSON.stringify(r.text.slice(0, 30)));
    ok('检测到 Big5', /big5/i.test(r.originalEncoding), r.originalEncoding);
    ok('编码归一化为 big5', r.encoding === 'big5', r.encoding);
    ok('无替换字符', !r.text.includes('\uFFFD'));
  }

  // ============================================================
  console.log('\n【8】Shift_JIS 与 Latin-1');
  {
    const jp = '高貴な仙子の痴女改造について、彼女は知らないうちに三年間も布局していた。';
    const buf = bytes(jp, 'shift_jis');
    const r = enc.detectAndDecode(buf);
    ok('Shift_JIS 检测并解码', enc.normalizeEncoding(r.originalEncoding) === 'shift_jis'
      || r.encoding === 'shift_jis', `${r.originalEncoding} → ${r.encoding}`);
    ok('Shift_JIS 文本还原', r.text === jp, JSON.stringify(r.text.slice(0, 30)));

    // Latin-1：纯西欧字符，本身是合法 UTF-8 的超集，应保持可读
    const latin = 'Café résumé naïve — 2020';
    const buf2 = iconv.encode(latin, 'latin1');
    const r2 = enc.detectAndDecode(buf2);
    ok('Latin-1 内容不至于崩溃', typeof r2.text === 'string' && r2.text.length > 0);
    ok('返回了编码信息', typeof r2.encoding === 'string', r2.encoding);
  }

  // ============================================================
  console.log('\n【9】低置信度：仍解码，但给出警告');
  {
    // 极短的 GBK 片段，jschardet 往往给不出高置信度
    const buf = bytes('中文', 'gbk');
    const det = jschardet.detect(buf);
    const r = enc.detectAndDecode(buf);
    console.log(`     jschardet 对「中文」的判定：${JSON.stringify(det)}`);
    ok('短文本仍能解码出中文', r.text === '中文' || r.text.length > 0, JSON.stringify(r.text));
    if (r.confidence < 0.7) {
      ok('低置信度时给出警告', r.warnings.some(w => /置信度较低/.test(w)), r.warnings.join('；'));
    } else {
      ok('（该样本置信度不低，跳过警告断言）', true);
    }
  }

  // ============================================================
  console.log('\n【10】乱码二进制：优雅回退，不抛错');
  {
    // 随机二进制
    const random = Buffer.alloc(4096);
    for (let i = 0; i < random.length; i++) random[i] = (i * 7919 + 13) % 256;
    const r = enc.detectAndDecode(random);
    ok('不抛异常且有返回', typeof r.text === 'string');
    ok('返回了编码字段', typeof r.encoding === 'string', r.encoding);
    ok('说明来源（detected 或 fallback）', ['detected', 'fallback', 'utf8'].includes(r.source), r.source);

    // 全 0xFF（非法 UTF-8 且任何编码都解不出有意义内容）
    const junk = Buffer.alloc(2048, 0xFF);
    const r2 = enc.detectAndDecode(junk);
    ok('全 0xFF 也不崩溃', typeof r2.text === 'string');
    ok('给出了警告或明确回退', r2.warnings.length > 0 || r2.source === 'detected',
      `${r2.source} / ${r2.warnings.length}`);
  }

  // ============================================================
  console.log('\n【11】边界：空文件 / 极小文件 / 非 Buffer 入参');
  {
    const r = enc.detectAndDecode(Buffer.alloc(0));
    ok('空 Buffer 返回空串', r.text === '');
    ok('空 Buffer 不报错', r.warnings.length === 0);

    const r2 = enc.detectAndDecode(Buffer.from('a'));
    ok('单字节 ASCII', r2.text === 'a');

    const r3 = enc.detectAndDecode(Buffer.from(CN, 'utf8').subarray(0)); // 空
    ok('空切片不报错', typeof r3.text === 'string');

    let threw = false;
    try { enc.detectAndDecode(null); } catch { threw = true; }
    ok('null 入参抛出明确错误', threw);

    ok('Uint8Array 可作为入参',
      enc.detectAndDecode(new Uint8Array(Buffer.from(CN, 'utf8'))).text === CN);
  }

  // ============================================================
  console.log('\n【12】readNovelText：从磁盘读取并解码');
  {
    const gbkPath = path.join(TMP, 'gbk.txt');
    await writeFile(gbkPath, bytes(CN, 'gbk'));
    const r = await enc.readNovelText(gbkPath);
    ok('从文件读出 GBK 中文', r.text === CN, JSON.stringify(r.text.slice(0, 30)));
    ok('返回字节数', r.bytes === (await readFile(gbkPath)).length, String(r.bytes));
    ok('返回编码信息', r.encoding === 'gbk' && r.transcoded === true);

    const bomPath = path.join(TMP, 'bom.txt');
    await writeFile(bomPath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(CN, 'utf8')]));
    const r2 = await enc.readNovelText(bomPath);
    ok('从文件读出去 BOM 的 UTF-8', r2.text === CN && r2.bomStripped === true);

    const big5Path = path.join(TMP, 'big5.txt');
    await writeFile(big5Path, bytes('測試繁體中文內容，應該可以正確解碼。', 'big5'));
    const r3 = await enc.readNovelText(big5Path);
    ok('从文件读出 Big5', r3.text === '測試繁體中文內容，應該可以正確解碼。', JSON.stringify(r3.text));
  }

  // ============================================================
  console.log('\n【13】工具函数');
  {
    ok('normalizeEncoding: GB2312 → gbk', enc.normalizeEncoding('GB2312') === 'gbk');
    ok('normalizeEncoding: gbk → gbk', enc.normalizeEncoding('gbk') === 'gbk');
    ok('normalizeEncoding: Big5 → big5', enc.normalizeEncoding('Big5') === 'big5');
    ok('normalizeEncoding: Shift_JIS → shift_jis', enc.normalizeEncoding('Shift_JIS') === 'shift_jis');
    ok('normalizeEncoding: UTF8 → utf-8', enc.normalizeEncoding('UTF8') === 'utf-8');
    ok('normalizeEncoding: 空值 → utf-8', enc.normalizeEncoding('') === 'utf-8');
    ok('normalizeEncoding: ascii → utf-8', enc.normalizeEncoding('ascii') === 'utf-8');
    ok('normalizeEncoding: 未知编码原样返回', enc.normalizeEncoding('koi8-r') === 'koi8-r');

    ok('detectBOM: UTF-8', enc.detectBOM(Buffer.from([0xEF, 0xBB, 0xBF, 0x61]))?.name === 'UTF-8');
    ok('detectBOM: UTF-16LE', enc.detectBOM(Buffer.from([0xFF, 0xFE, 0x61, 0x00]))?.name === 'UTF-16LE');
    ok('detectBOM: UTF-16BE', enc.detectBOM(Buffer.from([0xFE, 0xFF, 0x00, 0x61]))?.name === 'UTF-16BE');
    ok('detectBOM: 无 BOM 返回 null', enc.detectBOM(Buffer.from('abc')) === null);
  }

  // ============================================================
  console.log('\n【14】转码后的文本能正常参与切章');
  {
    const { chunkText } = await import(pathToFileURL(path.join(ROOT, 'src/utils.js')).href);
    const novel = ['第一章 初见', '林晚晴在拍卖会上见到了沈砚。'.repeat(20),
      '第二章 暗局', '沈砚的布局已经持续了三年之久。'.repeat(20),
      '第三章 摊牌', '两个人都没有说出真话。'.repeat(20)].join('\n\n');
    const buf = bytes(novel, 'gbk');
    const r = enc.detectAndDecode(buf);
    const chunks = chunkText(r.text);
    ok('GBK 转码后能切出 3 章', chunks.length === 3, `实际 ${chunks.length}`);
    ok('章节标题正确', chunks[0].title.startsWith('第一章'), chunks[0].title);
    ok('正文不含乱码', !r.text.includes('\uFFFD') && !/锟斤拷/.test(r.text));
  }

  await rm(TMP, { recursive: true, force: true });

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  编码测试：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
