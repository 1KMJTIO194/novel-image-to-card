/**
 * DSH 插件测试
 *
 * 覆盖三件在 Node 里能确证的事：
 *   ① multipart 解析器（纯逻辑，含二进制与边界用例）
 *   ② 清单/补丁/图标/语言包符合 DSH 的约定
 *   ③ **客户端 bundle 能在模拟的 `__ModuleLoader__` 环境里跑通**
 *      —— 这是最要紧的一条：client.js 有语法错或用了未定义的东西，
 *      在浏览器里会直接让整个 slot 崩掉（`slot entry crashed in '<slot>'`），
 *      而 Node 里完全看不出来。所以用 vm + 假 React 实际执行一遍。
 *
 * 不做的事：真的装进 DSH、真的跑生成（那需要模型与宿主，见 README 的说明）。
 */
import path from 'node:path';
import { readFile, stat, mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DSH = path.join(ROOT, 'dsh');

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name}${extra ? ' —— ' + extra : ''}`); console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};

// ============================================================
console.log('\n【1】multipart 解析器');
{
  const M = await import(pathToFileURL(path.join(DSH, 'lib/multipart.js')).href);

  const B = '----test123';
  // 造一个含文本字段 + 一个二进制文件（含 0x00 与 CRLF）的正文
  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]);
  const body = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="baseUrl"\r\n\r\nhttps://api.deepseek.com/v1\r\n`),
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="images"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
    bin,
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);

  const boundary = M.getBoundary('multipart/form-data; boundary=----test123');
  ok('能从 Content-Type 取出 boundary', boundary === B, String(boundary));
  ok('引号包裹的 boundary 也认',
    M.getBoundary('multipart/form-data; boundary="abc"') === 'abc');
  ok('没有 boundary 返回 null', M.getBoundary('application/json') === null);

  const parts = M.parseMultipart(body, B);
  const { fields, files } = M.collectMultipart(parts);
  ok('解析出 2 段', parts.length === 2, String(parts.length));
  ok('文本字段正确', fields.baseUrl === 'https://api.deepseek.com/v1', JSON.stringify(fields));
  ok('文件字段名正确', files[0]?.field === 'images', JSON.stringify(files.map(f => f.field)));
  ok('文件名正确', files[0]?.filename === 'a.png', String(files[0]?.filename));
  ok('content-type 正确', files[0]?.contentType === 'image/png', String(files[0]?.contentType));
  ok('二进制内容逐字节一致（含 0x00 与 CRLF）', Buffer.compare(files[0].data, bin) === 0,
    `${files[0].data.length} vs ${bin.length} 字节`);
  ok('尾部 CRLF 没被算进文件内容', files[0].data.length === bin.length, String(files[0].data.length));

  // 中文文本字段（UTF-8）
  const zhBody = Buffer.concat([
    Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="novelText"\r\n\r\n`),
    Buffer.from('第一章 归乡\n叶诺闭关三月。', 'utf-8'),
    Buffer.from(`\r\n--${B}--\r\n`),
  ]);
  const zh = M.collectMultipart(M.parseMultipart(zhBody, B));
  ok('中文文本字段不乱码', zh.fields.novelText.includes('叶诺闭关三月'),
    JSON.stringify(zh.fields.novelText));

  // 空正文
  ok('空正文返回空数组', M.parseMultipart(Buffer.alloc(0), B).length === 0);
  ok('只有结束标记返回空数组',
    M.parseMultipart(Buffer.from(`--${B}--\r\n`), B).length === 0);
}

// ============================================================
console.log('\n【2】清单与补丁符合 DSH 约定');
{
  const pkg = JSON.parse(await readFile(path.join(DSH, 'package.json'), 'utf-8'));

  ok('name 存在', !!pkg.name, pkg.name);
  ok('version 存在', !!pkg.version, pkg.version);
  ok('type 为 module', pkg.type === 'module', String(pkg.type));
  ok('exports["."] 指向宿主入口', pkg.exports?.['.'] === './index.js', String(pkg.exports?.['.']));
  ok('exports["./client"] 存在（UI 插件必需）',
    pkg.exports?.['./client'] === './client.js', String(pkg.exports?.['./client']));
  ok('dsh.bundle.patch 声明了补丁', !!pkg.dsh?.bundle?.patch, JSON.stringify(pkg.dsh));
  ok('dsh.client.platform = web', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client));
  ok('icon 是相对路径（绝对路径/URL 会被拒）',
    typeof pkg.icon === 'string' && pkg.icon.startsWith('./'), String(pkg.icon));
  ok('files 覆盖 client.js 与 patch', (pkg.files || []).includes('client.js')
    && (pkg.files || []).includes('cordis.patch.yml'), JSON.stringify(pkg.files));
  // 客户端 bundle 的 id 必须等于包名
  const client = await readFile(path.join(DSH, 'client.js'), 'utf-8');
  ok('client bundle 的 id 等于包名',
    client.includes(`id: '${pkg.name}'`) || client.includes(`id: "${pkg.name}"`),
    pkg.name);

  const patch = await readFile(path.join(DSH, 'cordis.patch.yml'), 'utf-8');
  ok('补丁含 insert', /^-\s*insert:/m.test(patch), patch.slice(0, 60));
  ok('补丁用了包名', patch.includes(pkg.name), patch);
  ok('补丁的 row id 是 novel2card', /id:\s*novel2card/.test(patch), patch);

  // 图标：SVG、≤256KiB
  const ico = await stat(path.join(DSH, 'icon.svg'));
  ok('图标 ≤256KiB', ico.size <= 256 * 1024, `${ico.size} 字节`);
  const svg = await readFile(path.join(DSH, 'icon.svg'), 'utf-8');
  ok('图标是 SVG', svg.trimStart().startsWith('<svg'), svg.slice(0, 40));
  ok('图标无外部引用（文档禁止 URL）',
    !/href\s*=\s*["'](https?:)?\/\//.test(svg), '');

  // 语言包
  for (const loc of ['zh', 'en']) {
    const j = JSON.parse(await readFile(path.join(DSH, `locale/${loc}.json`), 'utf-8'));
    ok(`locale/${loc}.json 有 meta.title 与 meta.description`,
      !!j?.meta?.title && !!j?.meta?.description, JSON.stringify(j?.meta));
  }
}

// ============================================================
console.log('\n【3】宿主入口导出形态');
{
  const HostMod = await import(pathToFileURL(path.join(DSH, 'index.js')).href);
  ok('导出 apply 函数', typeof HostMod.apply === 'function', typeof HostMod.apply);
  ok('导出 inject 数组', Array.isArray(HostMod.inject), JSON.stringify(HostMod.inject));
  ok('inject 声明了 webServer（缺它就保持不激活而不是抛错）',
    HostMod.inject.includes('webServer'), JSON.stringify(HostMod.inject));
  // host-plugin.md：两种导出形态不可混用 —— 有 apply 就不该有 default
  ok('没有同时使用 default 导出（两种形态不可混用）',
    HostMod.default === undefined, String(HostMod.default));

  // 用假 ctx 跑一遍 apply，确认它注册了路由且每个都有 disposer
  const registered = [];
  const effects = [];
  const fakeCtx = {
    webServer: { register: (r) => { registered.push(r); return () => {}; } },
    effect: (fn, label) => { effects.push(label); const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    logger: { info: () => {} },
  };
  HostMod.apply(fakeCtx);

  const paths = registered.map(r => r.path);
  ok('注册了多条路由', registered.length >= 6, `${registered.length} 条`);
  ok('全部挂在 /novel2card/ 命名空间下（重复 (kind,path) 会抛错）',
    paths.every(p => p.startsWith('/novel2card/')), JSON.stringify(paths));
  ok('路由 (kind,path) 无重复',
    new Set(registered.map(r => `${r.kind}:${r.path}`)).size === registered.length,
    JSON.stringify(registered.map(r => `${r.kind}:${r.path}`)));
  ok('每条路由都有 handler', registered.every(r => typeof r.handler === 'function'));
  ok('kind 只用 exact（前缀表留给别的插件）',
    registered.every(r => r.kind === 'exact'), JSON.stringify(registered.map(r => r.kind)));
  ok('每个注册都包在 ctx.effect 里（卸载即移除）', effects.length >= registered.length,
    `${effects.length} effects / ${registered.length} routes`);
  for (const need of ['/novel2card/meta', '/novel2card/generate', '/novel2card/task',
    '/novel2card/stream', '/novel2card/file', '/novel2card/tasks']) {
    ok(`有 ${need}`, paths.includes(need), JSON.stringify(paths));
  }
}

// ============================================================
console.log('\n【4】客户端 bundle 在模拟宿主里实际执行');
{
  const src = await readFile(path.join(DSH, 'client.js'), 'utf-8');

  // 假 React：只记录 createElement 的调用，不真的渲染
  const created = [];
  const fakeReact = {
    createElement: (type, props, ...children) => {
      created.push({ type, props, childCount: children.length });
      return { type, props, children };
    },
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  };

  let loaded = null;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(spec) { loaded = spec; },
      },
    },
    console: { warn: () => {}, error: () => {}, log: () => {} },
    document: { createElement: () => ({ setAttribute() {}, remove() {}, style: {} }), head: { appendChild() {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({ tasks: [] }) }),
    FormData: class { append() {} },
    EventSource: class { addEventListener() {} close() {} },
    URL: URL,
    setTimeout, clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  let thrown = null;
  try {
    vm.runInNewContext(src, sandbox, { filename: 'client.js' });
  } catch (e) { thrown = e; }
  ok('client.js 能执行（无语法错/未定义引用）', !thrown, thrown ? thrown.message : '');
  ok('注册到了 __ModuleLoader__', !!loaded, String(loaded));
  if (!loaded) { console.log('\n（client 没能加载，后面几条跳过）'); }

  if (loaded) {
    ok('bundle id 与包名一致', loaded.id === 'dsh-plugin-novel2card', String(loaded.id));
    ok('factory 是函数', typeof loaded.factory === 'function', typeof loaded.factory);

    const required = [];
    const mod = loaded.factory((name) => { required.push(name); return fakeReact; });
    ok('只 require react（不碰 DSH Client 包 —— 那会让 slot 崩掉）',
      required.length === 1 && required[0] === 'react', JSON.stringify(required));
    ok('返回 { inject, apply }', !!mod && typeof mod.apply === 'function' && Array.isArray(mod.inject),
      JSON.stringify(Object.keys(mod || {})));
    ok('inject 声明了 slots', mod.inject.includes('slots'), JSON.stringify(mod.inject));

    // 用假 ctx 跑 apply，确认注册进 slot
    const slotRegs = [];
    const fakeCtx = {
      get: () => null,
      slots: {
        inject: (owner, cb) => { ok('slots.inject 的 owner 是 sidebar.panellist', owner === 'sidebar.panellist', owner); cb(); },
        register: (opts, comp) => { slotRegs.push({ opts, comp }); return () => {}; },
      },
    };
    let applyThrown = null;
    try { mod.apply(fakeCtx); } catch (e) { applyThrown = e; }
    ok('apply 不抛错', !applyThrown, applyThrown ? applyThrown.message : '');
    ok('注册了 1 个 slot 条目', slotRegs.length === 1, String(slotRegs.length));
    ok('slot 名与注册名匹配',
      slotRegs[0]?.opts?.name === 'sidebar.panellist' && slotRegs[0]?.opts?.id === 'novel2card-entry',
      JSON.stringify(slotRegs[0]?.opts));
    ok('注册的是组件（函数）', typeof slotRegs[0]?.comp === 'function');

    // 渲染侧栏入口组件，确认产出真实的 React 元素树
    created.length = 0;
    try { slotRegs[0].comp(); } catch (e) { /* 记录 */ }
    ok('侧栏组件能调用且产出元素', created.length > 0, `${created.length} 个元素`);

    // 样式必须只用主题 token
    ok('样式只用 --dsw-* 主题 token（不用写死的背景色）',
      !/background\s*:\s*#/.test(src), '');
    ok('CSS 类都带 n2c- 前缀（避免与宿主样式冲突）',
      (src.match(/className:\s*'([^']+)'/g) || []).every(m => /n2c-/.test(m)),
      JSON.stringify((src.match(/className:\s*'([^']+)'/g) || []).slice(0, 5)));
    ok('没有写 document.body（文档明令禁止）', !/document\.body/.test(src), '');
    ok('没有用 iframe 承载宿主页面', !/<iframe/i.test(src), '');
  }
}

// ============================================================
console.log('\n【7】核心目录解析（安装位置不确定 + 中文路径）');
{
  const L = await import(pathToFileURL(path.join(DSH, 'lib/loader.js')).href);

  // ① 在仓库里（开发时 / pnpm link: 软链回仓库）
  const r1 = L.describeResolution();
  ok('在仓库里能解析到 src/', r1.srcDir === path.join(ROOT, 'src'), JSON.stringify(r1));
  const core = await L.importCore('utils.js');
  ok('能真的 import 核心模块（不是路径对但加载不了）',
    typeof core.chunkText === 'function', typeof core.chunkText);

  /**
   * ② 被复制到别处时应**明确失败**，而不是碰巧成功。
   *
   * 这条曾经抓到过一个设计缺陷：loader 里原本有 `process.cwd()/src` 兜底，
   * 而开发时 cwd 恰好是仓库根 —— 于是"复制安装"被误判成成功，
   * 测试全绿，到了真实宿主（cwd 与仓库无关）才找不到。
   * 所以刻意去掉了那个兜底。
   */
  {
    const tmp = await mkdtemp(path.join(tmpdir(), 'n2c-copy-'));
    try {
      const dest = path.join(tmp, 'dsh-plugin-novel2card');
      await cp(path.join(DSH), dest, { recursive: true });
      const m2 = await import(pathToFileURL(path.join(dest, 'lib/loader.js')).href + '?copy=1');
      const r2 = m2.describeResolution();
      ok('复制到别处后找不到 src（预期失败，不误判成功）',
        r2.srcDir === null, JSON.stringify(r2));
      let msg = '';
      try { await m2.importCore('pipeline.js'); } catch (e) { msg = e.message; }
      ok('报错说明了三条可操作办法',
        /NOVEL2CARD_SRC/.test(msg) && /软链/.test(msg), msg.split('\n').slice(0, 2).join(' / '));

      // ③ 环境变量兜底
      process.env.NOVEL2CARD_SRC = path.join(ROOT, 'src');
      const m3 = await import(pathToFileURL(path.join(dest, 'lib/loader.js')).href + '?env=1');
      const r3 = m3.describeResolution();
      ok('NOVEL2CARD_SRC 能兜底', r3.srcDir === path.join(ROOT, 'src') && r3.fromEnv === true,
        JSON.stringify(r3));
      const c3 = await m3.importCore('utils.js');
      ok('环境变量兜底后能真的加载', typeof c3.chunkText === 'function');
    } finally {
      delete process.env.NOVEL2CARD_SRC;
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * ④ 含非 ASCII 的路径。
   *
   * 这条是真 bug 的回归：`import(new URL('file://' + path))` 这种手工拼法
   * 在中文目录下直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
   * 而本项目最典型的路径就是 `D:\角色卡生成器`，必踩。
   * 修法是改用 `pathToFileURL`。
   *
   * 注意这里只放 `probe.js`（没有 pipeline.js），所以断言要针对 probe：
   * 加载器找的是「**包含当前要 import 的那个文件**」的目录，
   * 不是某个固定哨兵文件。
   */
  {
    const tmp = await mkdtemp(path.join(tmpdir(), 'n2c-中文路径-'));
    try {
      const repo = path.join(tmp, '仓库', '角色卡');
      await mkdir(path.join(repo, 'src'), { recursive: true });
      await mkdir(path.join(repo, 'dsh', 'lib'), { recursive: true });
      await writeFile(path.join(repo, 'src', 'probe.js'), 'export const ok = true;\n', 'utf-8');
      await cp(path.join(DSH, 'lib', 'loader.js'), path.join(repo, 'dsh', 'lib', 'loader.js'));
      const m4 = await import(pathToFileURL(path.join(repo, 'dsh/lib/loader.js')).href + '?zh=1');

      ok('中文路径下能定位到 probe.js 所在的 src/',
        m4.resolveSrcDir('probe.js') === path.join(repo, 'src'),
        JSON.stringify(m4.resolveSrcDir('probe.js')));
      const c4 = await m4.importCore('probe.js');
      ok('中文路径下能加载（手工拼 file:// 会在这里挂）', c4.ok === true, String(c4.ok));
      ok('没有的文件仍然报告找不到（不是"什么都算找到"）',
        m4.resolveSrcDir('pipeline.js') === null,
        JSON.stringify(m4.resolveSrcDir('pipeline.js')));
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
}

console.log(`\n${'='.repeat(46)}`);
console.log(`  DSH 插件测试：通过 ${pass} · 失败 ${fail}`);
console.log(`${'='.repeat(46)}\n`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
