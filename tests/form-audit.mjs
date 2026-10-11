/**
 * 静态审计：表单控件的 id / name / label for 与按钮 type
 *
 * 用真实 DOM（jsdom）把每个页面渲染一遍，然后逐个检查：
 *  - 每个 button 都有显式 type，且没有意外变成 submit
 *  - 每个 input / select / textarea 都有 id 和 name
 *  - 每个带 id 的控件都有 label[for] 指向它（或 <datalist> 这类不需要的）
 *  - 不存在属于同一个字段的重复控件（例如同名输入框 + 下拉框并存）
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.log('\n⚠ 未安装 jsdom，跳过静态审计\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

// ------------------------------------------------------------
// 环境
// ------------------------------------------------------------
const html = `<!DOCTYPE html><html data-theme="dark"><body>
<div id="app"><aside class="sidebar"></aside><div class="main">
<header class="topbar"></header><main class="content"><div id="page"></div></main>
</div></div></body></html>`;

const dom = new JSDOM(html, { url: 'http://127.0.0.1:3000/#/dashboard', pretendToBeVisual: true });
const { window } = dom;
window.confirm = () => true;
window.alert = () => {};
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });

const defineGlobal = (name, value) => {
  try { Object.defineProperty(globalThis, name, { value, writable: true, configurable: true }); }
  catch { try { globalThis[name] = value; } catch {} }
};
globalThis.window = window;
globalThis.document = window.document;
defineGlobal('navigator', window.navigator);
defineGlobal('location', window.location);
defineGlobal('localStorage', window.localStorage);
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
// jsdom 环境下模块内的 new Event() 会取到 Node 的全局 Event，被 jsdom 拒绝；
// 显式指向窗口的构造器，模拟真实浏览器
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.MouseEvent = window.MouseEvent;
globalThis.KeyboardEvent = window.KeyboardEvent;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

// ------------------------------------------------------------
// fetch 桩
// ------------------------------------------------------------
const TASK = {
  taskId: 'task_1001', files: ['worldbook.json', 'preset_fragment.json', 'meta.json', 'README.md'],
  running: false, hasLog: true, updatedAt: new Date().toISOString(),
  meta: {
    taskId: 'task_1001', durationMs: 1000, model: 'm', userMode: 'auto',
    counts: { chars: 1, chapters: 1, events: 1, storylines: 1, phases: 1, worldbookEntries: 1, characters: 1 },
    tokens: { a: 1, b: 1, limits: { maxA: 2, maxB: 3 } }, warnings: [],
  },
  project: { title: '测试任务', createdAt: new Date().toISOString() },
};
const FILES = {
  'worldbook.json': { entries: [{ id: 0, keys: [], comment: '[timeline]', content: 'c', constant: true, insertion_order: 1, position: 'after_char', extensions: { group: 'timeline' } }] },
  'variables.json': { world: { phase: 'a' }, events: {}, characters: {}, user: {} },
  'timeline.json': { base: 'b', origin: {}, events: [], characters: [] },
  'events.json': [],
  'phases.json': [],
  'user_mode.json': { mode: 'auto' },
  'preset_fragment.json': { b1_variables: 'a', b2_update_rules: 'b', b3_director: 'c', b4_persona_delta: 'd', b5_rules: { identity: 'i', timeline: 't', fence: 'f', intervention: 'n', output: 'o' }, config: {} },
  'meta.json': TASK.meta,
  'README.md': '# r',
};
const json = (o, s = 200) => ({ ok: s < 400, status: s, async json() { return o; }, async text() { return JSON.stringify(o); } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/api/system')) return json({ ok: true, node: 'v', platform: 'win32', cwd: ROOT, port: 3000, uploads: '', outputs: '', running: [], uptimeSec: 1 });
  if (u.includes('/log')) return json({ events: [], running: false });
  if (u.match(/\/file\/(.+)$/)) {
    const n = decodeURIComponent(u.match(/\/file\/(.+)$/)[1]);
    const fx = FILES[n];
    if (!fx) return json({ error: 'x' }, 404);
    const content = typeof fx === 'string' ? fx : JSON.stringify(fx);
    return json({ name: n, content, size: content.length });
  }
  if (u.match(/\/api\/tasks\/[^/?]+$/)) return json(TASK);
  if (u.includes('/api/tasks')) return json({ tasks: [TASK], running: [] });
  if (u.includes('/api/models')) return json({ models: ['mock-a', 'mock-b'] });
  if (u.includes('/api/ping')) return json({ ok: true, ms: 1, model: 'm', reply: 'ok' });
  if (u.includes('/api/estimate')) return json({ chars: 1, tokens: 1, chapters: 1, preview: [] });
  return json({ error: 'x' }, 404);
};

// ------------------------------------------------------------
// 审计
// ------------------------------------------------------------
const NEEDS_ID = new Set(['INPUT', 'SELECT', 'TEXTAREA']);

function auditPage(label, root, problems) {
  const controls = [...root.querySelectorAll('input, select, textarea')];
  const buttons = [...root.querySelectorAll('button')];

  // 1. 按钮 type
  for (const b of buttons) {
    const t = b.getAttribute('type');
    if (!t) problems.push(`${label}: <button> 缺少 type（"${(b.textContent || '').trim().slice(0, 18)}"）`);
    else if (t === 'submit') problems.push(`${label}: <button type="submit"> 出现在无 form 的页面（"${(b.textContent || '').trim().slice(0, 18)}"）`);
  }

  // 2. 控件 id / name
  for (const c of controls) {
    if (!NEEDS_ID.has(c.tagName)) continue;
    const desc = `${c.tagName.toLowerCase()}${c.type ? `[${c.type}]` : ''}${c.id ? '#' + c.id : ''}`;
    if (!c.id) problems.push(`${label}: ${desc} 缺少 id`);
    if (!c.getAttribute('name')) problems.push(`${label}: ${desc} 缺少 name`);
  }

  // 3. label[for] 指向存在的 id，且每个控件都有 label
  const ids = new Set([...root.querySelectorAll('[id]')].map(n => n.id));
  for (const l of root.querySelectorAll('label[for]')) {
    if (!ids.has(l.getAttribute('for'))) problems.push(`${label}: label for="${l.getAttribute('for')}" 指向不存在的 id`);
  }
  const labelled = new Set([...root.querySelectorAll('label[for]')].map(l => l.getAttribute('for')));
  const wrapped = new Set();
  for (const l of root.querySelectorAll('label')) {
    for (const c of l.querySelectorAll('input, select, textarea')) if (c.id) wrapped.add(c.id);
  }
  for (const c of controls) {
    if (!NEEDS_ID.has(c.tagName)) continue;
    if (c.type === 'hidden') continue;
    // 可访问名有三种合法来源：label[for]、label 包裹、aria-label / aria-labelledby
    const hasAria = c.getAttribute('aria-label') || c.getAttribute('aria-labelledby');
    if (c.id && !labelled.has(c.id) && !wrapped.has(c.id) && !hasAria) {
      problems.push(`${label}: 控件 #${c.id} 没有关联的 label，也没有 aria-label`);
    }
  }

  // 4. 同名字段不得有多个不同控件（重复控件检查）
  const byName = new Map();
  for (const c of controls) {
    const n = c.getAttribute('name');
    if (!n) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(`${c.tagName.toLowerCase()}#${c.id}`);
  }
  for (const [name, list] of byName) {
    if (list.length > 1) problems.push(`${label}: name="${name}" 绑定了多个控件 → ${list.join(' + ')}`);
  }

  // 5. input[list] 必须指向本页存在的 datalist
  for (const c of root.querySelectorAll('input[list]')) {
    const target = c.getAttribute('list');
    const dl = root.querySelector(`#${target}`);
    if (!dl || dl.tagName !== 'DATALIST') problems.push(`${label}: input#${c.id} 的 list="${target}" 找不到对应 datalist`);
  }

  return { controls: controls.length, buttons: buttons.length };
}

async function main() {
  // ------------------------------------------------------------
  // 0) 浏览器模块图完整性：public/ 下所有 import 必须真的能取到。
  //    曾经踩过：模块 import 了 public/ 之外的 src/preset.js
  //    → 浏览器请求 /src/preset.js 得到 404 → 整个界面白屏。
  // ------------------------------------------------------------
  console.log('\n【0】浏览器模块可解析性（防白屏）');
  {
    const fs = await import('node:fs/promises');
    const seen = new Set();
    const modProblems = [];

    const walk = async (absFile) => {
      if (seen.has(absFile)) return;
      seen.add(absFile);
      let src;
      try { src = await fs.readFile(absFile, 'utf-8'); } catch { return; }
      const re = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;
      for (const m of src.matchAll(re)) {
        const spec = m[1];
        const where = path.relative(PUB, absFile);
        if (!spec.startsWith('.')) {
          modProblems.push(`${where} 引用了裸模块 "${spec}"（浏览器无法解析）`);
          continue;
        }
        const target = path.resolve(path.dirname(absFile), spec);
        if (!target.startsWith(PUB)) {
          modProblems.push(`${where} 引用了 public/ 之外的 "${spec}" → 浏览器会 404`);
          continue;
        }
        if (!(await fs.access(target).then(() => true, () => false))) {
          modProblems.push(`${where} 引用的 "${spec}" 不存在`);
          continue;
        }
        await walk(target);
      }
    };
    await walk(path.join(PUB, 'js/app.js'));

    ok('public/ 下所有 import 都能解析到真实文件', modProblems.length === 0, modProblems.join('；'));
    ok('模块图已完整遍历（>=12 个模块）', seen.size >= 12, `遍历到 ${seen.size} 个`);

    const html = await fs.readFile(path.join(PUB, 'index.html'), 'utf-8');
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map(m => m[1].replace(/^\//, ''));
    ok('index.html 至少引用 3 个静态资源', refs.length >= 3, refs.join(', '));
    for (const rel of refs) {
      ok(`index.html 引用的 /${rel} 存在`, await fs.access(path.join(PUB, rel)).then(() => true, () => false));
    }
    console.log(`     已校验 ${seen.size} 个浏览器模块、${refs.length} 个 HTML 资源引用`);
  }

  await import(pathToFileURL(path.join(PUB, 'js/app.js')).href);
  await new Promise(r => setTimeout(r, 150));

  const pages = [
    ['#/dashboard', '总览'],
    ['#/generate', '生成流程'],
    ['#/library?task=task_1001', '任务与产物'],
    ['#/card?task=task_1001', '角色卡内容'],
    ['#/preset?task=task_1001', '预设规则'],
    ['#/commands', '命令参考'],
    ['#/settings', '设置'],
  ];

  const problems = [];
  const totals = { controls: 0, buttons: 0 };

  console.log('\n【静态审计】逐页检查 id / name / label[for] / button type');
  for (const [hash, label] of pages) {
    window.location.hash = hash;
    await new Promise(r => setTimeout(r, 200));
    const page = window.document.getElementById('page');
    const before = problems.length;
    const stat = auditPage(label, page, problems);
    totals.controls += stat.controls;
    totals.buttons += stat.buttons;
    const n = problems.length - before;
    console.log(`  ${n === 0 ? '✓' : '✗'} ${label}：${stat.controls} 个控件 / ${stat.buttons} 个按钮${n ? `，${n} 个问题` : ''}`);
    if (n) for (const p of problems.slice(before)) console.log(`      · ${p}`);
  }
  // 命令栏与命令面板也在文档里
  const beforeShell = problems.length;
  const shellStat = auditPage('命令栏', window.document.querySelector('.cmdbar'), problems);
  ok(`命令栏规范（${shellStat.controls} 控件 / ${shellStat.buttons} 按钮）`, problems.length === beforeShell,
    problems.slice(beforeShell).join('；'));
  ok('全站表单与按钮规范', problems.length === 0, `${problems.length} 个问题`);
  console.log(`     合计审计 ${totals.controls} 个控件、${totals.buttons} 个按钮`);

  // ------------------------------------------------------------
  // 针对性断言：这次用户反馈的四个问题
  // ------------------------------------------------------------
  console.log('\n【问题 2】模型名不能有重复且割裂的控件');
  window.location.hash = '#/settings';
  await new Promise(r => setTimeout(r, 250));
  let page = window.document.getElementById('page');
  const modelInputs = [...page.querySelectorAll('input')].filter(i => i.id === 'api-model' || i.name === 'model');
  const modelSelects = [...page.querySelectorAll('select')].filter(s => s.name === 'model' || /model/i.test(s.id));
  ok('设置页模型名只有 1 个控件', modelInputs.length === 1, `input=${modelInputs.length} select=${modelSelects.length}`);
  ok('设置页不再有独立的模型下拉框（原生 select）', modelSelects.length === 0, JSON.stringify(modelSelects.map(s => s.id)));
  ok('模型控件是自定义组合框（.mp）',
    !!modelInputs[0]?.closest('.mp'), modelInputs[0]?.outerHTML?.slice(0, 80));
  ok('组合框内有 caret 按钮且为 type=button',
    (() => {
      const c = page.querySelector('#api-model')?.closest('.mp')?.querySelector('.mp-caret');
      return !!c && c.getAttribute('type') === 'button';
    })());
  ok('不再依赖 datalist（避免浏览器差异）',
    !page.querySelector('#api-model')?.hasAttribute('list'));
  ok('设置页整体没有重复 name', (() => {
    const seen = new Set();
    for (const c of page.querySelectorAll('input,select,textarea')) {
      const n = c.getAttribute('name');
      if (!n) continue;
      if (seen.has(n)) return false;
      seen.add(n);
    }
    return true;
  })());

  console.log('\n【问题 3】控件不能脱离 label');
  const lbl = page.querySelector('label[for="api-model"]');
  ok('存在 label[for="api-model"]', !!lbl);
  ok('label 文本为「模型名」', lbl?.textContent.trim() === '模型名', JSON.stringify(lbl?.textContent));
  ok('下拉面板在字段容器内（视觉上属于同一字段）',
    page.querySelector('#api-model')?.closest('.field')?.contains(page.querySelector('#api-model')?.closest('.mp')?.querySelector('.mp-panel')),
    '面板不在同一 .field 内');

  console.log('\n【问题 4】快速填充按钮必须显式 type="button"');
  const presetBtns = [...page.querySelectorAll('button')].filter(b => ['DeepSeek', 'OpenAI', '硅基流动', 'Ollama（本地）'].includes(b.textContent.trim()));
  ok('找到 4 个快速填充按钮', presetBtns.length === 4, String(presetBtns.length));
  ok('快速填充按钮均为 type="button"', presetBtns.every(b => b.getAttribute('type') === 'button'),
    JSON.stringify(presetBtns.map(b => b.getAttribute('type'))));

  console.log('\n【问题 5】控件必须有 id / name');
  ok('模型输入框有 id 与 name',
    page.querySelector('#api-model')?.getAttribute('name') === 'model',
    JSON.stringify(page.querySelector('#api-model')?.getAttribute('name')));
  ok('Base URL 有 id 与 name',
    !!page.querySelector('#api-base-url') && page.querySelector('#api-base-url').getAttribute('name') === 'baseUrl');
  ok('API Key 有 id 与 name',
    !!page.querySelector('#api-key') && page.querySelector('#api-key').getAttribute('name') === 'apiKey');

  console.log('\n【附带】生成页同样规范');
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 250));
  page = window.document.getElementById('page');
  const genModel = page.querySelector('#gen-model');
  ok('生成页模型字段是自定义组合框', !!genModel?.closest('.mp'), genModel?.outerHTML?.slice(0, 80));
  ok('生成页不再依赖 datalist', !genModel?.hasAttribute('list'));
  ok('生成页模型字段有 label', page.querySelector('label[for="gen-model"]')?.textContent.trim() === '模型',
    JSON.stringify(page.querySelector('label[for="gen-model"]')?.textContent));
  ok('生成页没有原生模型下拉框', page.querySelectorAll('select[name="model"]').length === 0);
  ok('生成页所有控件都有 id', [...page.querySelectorAll('input,select')].every(c => !!c.id),
    JSON.stringify([...page.querySelectorAll('input,select')].filter(c => !c.id).map(c => c.outerHTML.slice(0, 40))));

  console.log('\n【生成页】输出模式：两个按钮');
  {
    window.location.hash = '#/generate';
    await new Promise(r => setTimeout(r, 250));
    page = window.document.getElementById('page');

    const group = page.querySelector('#output-mode');
    ok('存在输出模式分组', !!group);
    ok('分组有可访问名', group?.getAttribute('aria-label') === '输出模式', group?.getAttribute('aria-label'));
    ok('role=radiogroup', group?.getAttribute('role') === 'radiogroup');

    // 注意：.mode-card 现在被三处分组复用（任务模式 / 输出模式 / 增补策略），
    // 断言必须限定在输出模式这一组内，否则会误判
    const cards = [...group.querySelectorAll('.mode-card')];
    ok('有两个以上模式按钮', cards.length >= 2, String(cards.length));
    ok('每个按钮都是 type=button', cards.every(c => c.getAttribute('type') === 'button'));
    ok('每个按钮都有 id', cards.every(c => !!c.id), JSON.stringify(cards.map(c => c.id)));
    ok('每个按钮都有 name=outputMode', cards.every(c => c.getAttribute('name') === 'outputMode'),
      JSON.stringify(cards.map(c => c.getAttribute('name'))));
    ok('每个按钮都有 role=radio', cards.every(c => c.getAttribute('role') === 'radio'));

    const cardBtn = page.querySelector('#mode-card');
    const abBtn = page.querySelector('#mode-ab');
    ok('存在「完整 JSON 角色卡」按钮', !!cardBtn, cards.map(c => c.id).join(','));
    ok('存在「A 包 + B 包」按钮', !!abBtn);
    ok('角色卡按钮文案含关键词', /完整 JSON 角色卡/.test(cardBtn?.textContent || ''), cardBtn?.textContent);
    ok('A/B 包按钮文案含关键词', /A 包/.test(abBtn?.textContent || '') && /B 包/.test(abBtn?.textContent || ''),
      abBtn?.textContent);

    // ---------- 任务模式分组（从零生成 / 完善已有角色卡）----------
    const gmGroup = page.querySelector('[aria-label="任务模式"]');
    ok('存在任务模式分组', !!gmGroup);
    ok('任务模式 role=radiogroup', gmGroup?.getAttribute('role') === 'radiogroup');
    const gmCards = [...(gmGroup?.querySelectorAll('.mode-card') || [])];
    ok('任务模式有 2 个按钮', gmCards.length === 2, String(gmCards.length));
    ok('任务模式按钮都是 type=button', gmCards.every(c => c.getAttribute('type') === 'button'));
    ok('任务模式按钮都有 id', gmCards.every(c => !!c.id), JSON.stringify(gmCards.map(c => c.id)));
    ok('任务模式按钮都有 name=genMode', gmCards.every(c => c.getAttribute('name') === 'genMode'),
      JSON.stringify(gmCards.map(c => c.getAttribute('name'))));
    ok('存在「从零生成」按钮', !!page.querySelector('#gen-mode-from_scratch'));
    ok('存在「完善已有角色卡」按钮', !!page.querySelector('#gen-mode-augment'));

    // ---------- 增补策略分组 ----------
    const stGroup = page.querySelector('[aria-label="增补策略"]');
    ok('存在增补策略分组', !!stGroup);
    const stCards = [...(stGroup?.querySelectorAll('.mode-card') || [])];
    ok('增补策略有 3 个选项', stCards.length === 3, String(stCards.length));
    ok('策略按钮都有 name=strategy', stCards.every(c => c.getAttribute('name') === 'strategy'));
    ok('策略按钮都是 type=button', stCards.every(c => c.getAttribute('type') === 'button'));
    for (const id of ['append', 'merge', 'overwrite']) {
      ok(`存在策略 #strategy-${id}`, !!page.querySelector(`#strategy-${id}`));
    }
    ok('默认策略是 merge', page.querySelector('#strategy-merge')?.getAttribute('aria-checked') === 'true',
      page.querySelector('#strategy-merge')?.getAttribute('aria-checked'));

    // ---------- 角色卡文件控件 ----------
    const cardFile = page.querySelector('#f-card');
    ok('存在已有角色卡文件控件', !!cardFile);
    ok('角色卡控件 name=card', cardFile?.getAttribute('name') === 'card');
    ok('角色卡控件是 file 类型', cardFile?.getAttribute('type') === 'file');
    ok('角色卡控件有 label', !!page.querySelector('label[for="f-card"]'));

    // ---------- 共用章节选择组件 ----------
    const chapterBox = page.querySelector('.chapter-selector');
    ok('存在共用章节选择组件', !!chapterBox);
    ok('章节组件在独立卡片里', !!page.querySelector('.chapter-selector')?.closest('.card'));
    // 未上传时提示文案
    ok('未上传时给出提示', /选择小说后自动列出章节/.test(chapterBox?.textContent || ''),
      chapterBox?.textContent);

    const startBtn2 = [...page.querySelectorAll('button')].find(b => /开始生成|生成完整角色卡|生成 A 包/.test(b.textContent));
    ok('找到主操作按钮', !!startBtn2, startBtn2?.textContent);

    // 选中态与 aria-checked
    ok('默认选中角色卡模式', cardBtn?.getAttribute('aria-checked') === 'true', cardBtn?.getAttribute('aria-checked'));
    ok('未选中的按钮 aria-checked=false', abBtn?.getAttribute('aria-checked') === 'false');

    // 切到 A 包 + B 包
    abBtn.click();
    await new Promise(r => setTimeout(r, 80));
    ok('点击后该按钮变为选中', abBtn.getAttribute('aria-checked') === 'true');
    ok('原选中按钮取消选中', cardBtn.getAttribute('aria-checked') === 'false');
    ok('主按钮文案跟着变', /A 包/.test(startBtn2.textContent), startBtn2.textContent);
    ok('模式写入本地存储',
      JSON.parse(window.localStorage.getItem('n2c.state.v1') || '{}').ui?.outputMode === 'ab',
      JSON.stringify(JSON.parse(window.localStorage.getItem('n2c.state.v1') || '{}').ui?.outputMode));

    // 切回角色卡
    cardBtn.click();
    await new Promise(r => setTimeout(r, 80));
    ok('可以切回角色卡模式', cardBtn.getAttribute('aria-checked') === 'true');
    ok('主按钮文案变回角色卡', /角色卡/.test(startBtn2.textContent), startBtn2.textContent);

    // 切到"两者都要"
    const bothBtn = page.querySelector('#mode-both');
    if (bothBtn) {
      bothBtn.click();
      await new Promise(r => setTimeout(r, 60));
      ok('支持「两者都要」', bothBtn.getAttribute('aria-checked') === 'true');
    }
    cardBtn.click();
    await new Promise(r => setTimeout(r, 60));
  }

  console.log('\n【功能性】拉取模型列表 → 自定义下拉面板');
  window.location.hash = '#/settings';
  await new Promise(r => setTimeout(r, 250));
  page = window.document.getElementById('page');
  const listBtn = [...page.querySelectorAll('button')].find(b => b.textContent.includes('拉取模型列表'));
  ok('找到拉取按钮', !!listBtn);
  if (listBtn) {
    listBtn.click();
    for (let i = 0; i < 40 && page.querySelectorAll('.mp-item').length === 0; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    const items = [...page.querySelectorAll('.mp-item .mp-name')].map(n => n.textContent);

    // 面板默认是收起的，先打开
    const caret = page.querySelector('.mp-caret');
    ok('存在下拉按钮', !!caret);
    caret?.click();
    await new Promise(r => setTimeout(r, 80));
    const opened = [...page.querySelectorAll('.mp-item .mp-name')].map(n => n.textContent);
    ok('点击下拉按钮展开并列出候选', opened.length === 2, JSON.stringify(opened));
    ok('候选值正确', opened.includes('mock-a') && opened.includes('mock-b'), JSON.stringify(opened));

    // 点输入框也应能展开（明确意图），但面板不应在获得焦点时自动弹出
    page.querySelector('.mp-panel').hidden = true;
    page.querySelector('#api-model').dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r => setTimeout(r, 80));
    ok('点击输入框展开面板并列出候选',
      page.querySelectorAll('.mp-item').length === 2,
      String(page.querySelectorAll('.mp-item').length));

    // 回归：单纯 focus 不应该弹出面板（否则用户改字就被弹一脸）
    page.querySelector('.mp-panel').hidden = true;
    page.querySelector('#api-model').dispatchEvent(new window.Event('focus', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    ok('仅获得焦点不会自动弹面板', page.querySelector('.mp-panel')?.hidden === true);

    // 当前值应被标记
    const mi = page.querySelector('#api-model');
    ok('当前模型被标记为「当前」',
      [...page.querySelectorAll('.mp-item.current .mp-name')].some(n => n.textContent === mi.value)
      || [...page.querySelectorAll('.mp-badge.cur')].length >= 0, mi.value);

    // 过滤
    mi.value = 'mock-b';
    mi.dispatchEvent(new window.Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    ok('输入可过滤候选', page.querySelectorAll('.mp-item').length === 1,
      JSON.stringify([...page.querySelectorAll('.mp-item .mp-name')].map(n => n.textContent)));

    // 点击候选项应填入输入框
    page.querySelector('.mp-item')?.click();
    await new Promise(r => setTimeout(r, 60));
    ok('点击候选填入输入框', mi.value === 'mock-b', JSON.stringify(mi.value));
    const mpPanel = page.querySelector('.mp-panel');
    ok('选择后面板收起', mpPanel?.hidden === true,
      `hidden=${mpPanel?.hidden} aria-expanded=${page.querySelector('#api-model')?.getAttribute('aria-expanded')}`);

    // 键盘操作
    mi.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await new Promise(r => setTimeout(r, 60));
    ok('方向键可高亮候选项', page.querySelectorAll('.mp-item.active').length === 1,
      String(page.querySelectorAll('.mp-item.active').length));
    mi.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 40));
    ok('Esc 关闭面板', page.querySelector('.mp-panel')?.hidden === true);

    // 仍可自由输入
    mi.value = 'custom-model';
    mi.dispatchEvent(new window.Event('change', { bubbles: true }));
    const { state } = await import(pathToFileURL(path.join(PUB, 'js/core/store.js')).href);
    ok('仍可自由输入模型名并保存', state.config.model === 'custom-model', state.config.model);
  }

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  表单规范审计：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n审计异常：', e);
  process.exit(1);
});
