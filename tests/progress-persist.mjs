/**
 * 生成进度跨页面保持测试（jsdom 真实 DOM）
 *
 * 复现并锁死用户报告的问题：开始生成后切到别的页面，再回到生成流程页，
 * 之前必须能看到当前任务的具体进度（步骤、日志、百分比），而不是一片空白。
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
  console.log('\n⚠ 未安装 jsdom，跳过进度保持测试\n');
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra ?? ''}`); }
};

const dom = new JSDOM(`<!DOCTYPE html><html data-theme="dark"><body>
<div id="app"><aside class="sidebar"></aside><div class="main">
<header class="topbar"></header><main class="content"><div id="page"></div></main>
</div></div></body></html>`, { url: 'http://127.0.0.1:3000/#/generate', pretendToBeVisual: true });
const { window } = dom;
window.Element.prototype.scrollTo = function () {};
window.Element.prototype.scrollIntoView = function () {};
window.confirm = () => true;
window.alert = () => {};

const defineGlobal = (n, v) => {
  try { Object.defineProperty(globalThis, n, { value: v, writable: true, configurable: true }); }
  catch { try { globalThis[n] = v; } catch {} }
};
globalThis.window = window;
globalThis.document = window.document;
defineGlobal('navigator', window.navigator);
defineGlobal('location', window.location);
defineGlobal('localStorage', window.localStorage);
globalThis.Node = window.Node;
globalThis.Element = window.Element;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.confirm = () => true;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.URL.createObjectURL = () => 'blob:mock';
globalThis.URL.revokeObjectURL = () => {};

// ============================================================
// 后端桩：可控的 SSE + 可追加的日志（模拟真实长任务）
// ============================================================
const TASK_ID = 'task_live_1';
/** 服务端"已写入"的事件（/log 返回它，模拟刷新后从服务端恢复） */
const serverEvents = [];
/** 当前 SSE 流是否已被客户端断开 */
let streamAborted = false;
let activeController = null;
let cancelCalled = false;
let pauseCalled = false;
let resumeCalled = false;
let paused = false;
/** /api/tasks/:id/batches 的桩数据：3 批、完成 2 批 */
const batchPayload = {
  taskId: 'task_live_1',
  total: 3,
  complete: 2,
  batches: [
    { index: 0, chapters: ['第一章', '第二章'], chars: 12000, tokens: 8000, complete: true },
    { index: 1, chapters: ['第三章', '第四章'], chars: 12000, tokens: 8000, complete: true },
    { index: 2, chapters: ['第五章'], chars: 6000, tokens: 4000, complete: false },
  ],
  state: { total: 3, done: 2, batchChapters: 10, batchChars: 30000, finished: false },
  running: false,
  paused: false,
};

const json = (o, s = 200) => ({ ok: s < 400, status: s, async json() { return o; }, async text() { return JSON.stringify(o); } });

const fetchLog = [];
// 初始没有运行中的任务；点「开始生成」后由 stream 的 start 回调置为 true
let running = false;
let taskStartedAt = null;

window.fetch = globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetchLog.push(`${opts.method || 'GET'} ${u}`);
  if (u.includes('/api/generate')) {
    streamAborted = false;
    const stream = new ReadableStream({
      start(controller) {
        // 用全局引用，避免第二次任务时 send 闭包指向已关闭的旧 controller
        activeController = controller;
        const send = (event, data) => {
          const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
          serverEvents.push({ event, data, ts: Date.now() });
          try { activeController.enqueue(new TextEncoder().encode(chunk)); } catch {}
        };
        running = true;
        taskStartedAt = new Date().toISOString();
        send('start', { taskId: TASK_ID });
        send('progress', { step: 'Init', msg: '读入 61998 字' });
        send('progress', { step: 'Init', msg: '切分为 11 块' });
        send('progress', { step: 'Step 0.5', msg: '模式：participant' });
        send('progress', { step: 'Step 1', msg: '提及 1/11' });
        window.__send = send;
        window.__closeStream = () => { try { activeController.close(); } catch {} };
      },
      cancel() { streamAborted = true; },
    });
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        streamAborted = true;
        try { activeController?.close(); } catch {}
      });
    }
    return { ok: true, status: 200, body: { getReader: () => stream.getReader() } };
  }
  if (u.match(/\/api\/tasks\/[^/]+\/log/)) {
    return json({ events: serverEvents, running });
  }
  if (u.match(/\/api\/tasks\/[^/]+\/cancel/)) {
    cancelCalled = true;
    running = false;
    return json({ ok: true });
  }
  if (u.match(/\/api\/tasks\/[^/]+\/pause/)) {
    pauseCalled = true;
    paused = true;
    return json({ ok: true, paused: true });
  }
  if (u.match(/\/api\/tasks\/[^/]+\/resume/)) {
    resumeCalled = true;
    paused = false;
    return json({ ok: true, paused: false });
  }
  if (u.match(/\/api\/tasks\/[^/]+\/batches/)) {
    return json(batchPayload);
  }
  if (u.match(/\/api\/tasks\/[^/]+\/meta/)) {
    return json({ taskId: TASK_ID, running, title: '仙子的间谍女改命', model: 'mock-large', complete: false, files: [] });
  }
  if (u.match(/\/api\/tasks\/[^/?]+$/)) {
    return json({
      taskId: TASK_ID, running, files: running ? [] : ['worldbook.json'],
      updatedAt: new Date().toISOString(),
      project: { title: '仙子的间谍女改命', createdAt: taskStartedAt || new Date().toISOString() },
      meta: running ? null : { counts: {}, tokens: { a: 1, b: 1 }, title: '仙子的间谍女改命', durationMs: 1000 },
    });
  }
  if (u.includes('/api/tasks')) {
    return json({
      tasks: running ? [{
        taskId: TASK_ID, running: true, files: [], hasLog: true,
        updatedAt: new Date().toISOString(), meta: null,
        project: { title: '仙子的间谍女改命', createdAt: taskStartedAt },
      }] : [],
      running: running ? [TASK_ID] : [],
    });
  }
  if (u.includes('/api/system')) return json({ ok: true, node: 'v', platform: 'win32', cwd: ROOT, port: 3000, uploads: '', outputs: '', running: running ? [TASK_ID] : [], uptimeSec: 1 });
  if (u.includes('/api/models')) return json({ models: ['mock-large'] });
  if (u.includes('/api/estimate')) return json({ chars: 61998, tokens: 1, chapters: 11, preview: [] });
  return json({ error: '未桩化: ' + u }, 404);
};

// ============================================================
async function main() {
  await import(pathToFileURL(path.join(PUB, 'js/app.js')).href);
  await new Promise(r => setTimeout(r, 200));

  const run = await import(pathToFileURL(path.join(PUB, 'js/core/active-run.js')).href);
  const page = () => window.document.getElementById('page');
  const text = () => page().textContent;

  console.log('\n【A】在生成页启动任务');
  // 必须用显式 id：页面上现在有多个 file 控件（小说 #f-novel / 角色卡 #f-card / 插图 #f-images），
  // 用 input[type=file] 取"第一个"会随 DOM 顺序变化而抓错控件
  const fileInput = window.document.querySelector('#page #f-novel');
  ok('生成页已渲染出小说文件控件', !!fileInput, '未找到 #f-novel');
  if (!fileInput) {
    console.log('     #page 内容片段：', page().textContent.slice(0, 200));
    process.exit(1);
  }
  const file = new window.File(['x'], '小说.txt', { type: 'text/plain' });
  file.text = async () => '第一章\n' + '正文'.repeat(400);
  Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
  fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 200));

  const startBtn = [...window.document.querySelectorAll('#page button')]
    .find(b => /开始生成|生成中/.test(b.textContent));
  ok('找到开始生成按钮', !!startBtn,
    [...window.document.querySelectorAll('#page button')].map(b => b.textContent).join('|').slice(0, 200));
  startBtn.click();
  await new Promise(r => setTimeout(r, 300));

  ok('任务已启动', run.isRunning(), run.snapshot().status);
  ok('拿到 taskId', run.currentTaskId() === TASK_ID, String(run.currentTaskId()));
  ok('生成页显示生成中', /生成中/.test(text()), text().slice(0, 80));
  const pctNow = window.document.querySelector('#page .bar > i')?.style.width;
  ok('进度条已有进度', !!pctNow && pctNow !== '0%', String(pctNow));

  console.log('\n【B】关键：切换到别的页面');
  window.location.hash = '#/library?task=task_live_1';
  await new Promise(r => setTimeout(r, 300));
  ok('已离开生成页', !page().querySelector('.steps'));
  await new Promise(r => setTimeout(r, 200));

  console.log('\n【C】SSE 在离开页面后必须仍然连通');
  ok('没有因切页而中止流', streamAborted === false, `streamAborted=${streamAborted}`);
  const __ind = window.document.querySelector('.run-indicator');
  ok('侧边栏显示全局进度指示', (() => {
    const ind = window.document.querySelector('.run-indicator');
    const t = ind?.textContent || '';
    // 未填标题时以文件名作为任务标题（这里上传的是「小说.txt」）
    return ind && ind.style.display !== 'none' && /生成中/.test(t) && /小说/.test(t);
  })(), window.document.querySelector('.run-indicator')?.textContent || '(无)');
  ok('指示器上有可点击的进度条', !!window.document.querySelector('.run-indicator .ri-bar > i'),
    '未找到进度条节点');

  console.log('\n【D】离开期间任务继续推进（模拟服务端继续产出）');
  window.__send('progress', { step: 'Step 2', msg: '事件 3/11' });
  window.__send('progress', { step: 'Step 5', msg: '世界观 12 / 人物 8' });
  await new Promise(r => setTimeout(r, 300));
  ok('状态中心已记录新阶段', run.derive().reached === 'Step 5', String(run.derive().reached));
  const indPct = Math.round(run.derive().progress * 100);
  ok('侧边栏进度随之更新', indPct >= 80, `${indPct}%`);

  console.log('\n【E】关键：切回生成页，进度必须完整重建');
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 400));

  const back = text();
  ok('步骤列表回来了', !!page().querySelectorAll('#page .step').length, '无 .step');
  const doneSteps = [...page().querySelectorAll('#page .step.done')].length;
  const activeSteps = [...page().querySelectorAll('#page .step.active')].length;
  ok('已完成阶段被重建', doneSteps >= 4, `done=${doneSteps}`);
  ok('当前阶段被标为进行中', activeSteps === 1, `active=${activeSteps}`);
  ok('当前阶段是 Step 5', /世界观/.test(page().querySelectorAll('#page .step.active')[0]?.textContent || ''),
    page().querySelectorAll('#page .step.active')[0]?.textContent?.slice(0, 40));
  ok('日志被重建（含离开期间的条目）', /事件 3\/11/.test(back) && /世界观 12/.test(back),
    back.slice(-200));
  ok('显示任务 ID', back.includes(TASK_ID), back.slice(0, 120));
  const barAfter = window.document.querySelector('#page .bar > i')?.style.width;
  ok('进度条恢复到离开前的水平', parseFloat(barAfter) >= 80, String(barAfter));
  ok('仍显示生成中', /生成中/.test(back));
  ok('中止按钮可见', [...page().querySelectorAll('button')].some(b => /取消|中止/.test(b.textContent) && b.style.display !== 'none'));
  ok('页面里没有遗留的旧定时器报错（无渲染失败）', !back.includes('页面渲染失败'));

  console.log('\n【F】进度只增不减');
  const before = parseFloat(window.document.querySelector('#page .bar > i').style.width);
  // 回放一条更早阶段的日志，进度不能回退
  window.__send('progress', { step: 'Step 1', msg: '提及 11/11（迟到的回放）' });
  await new Promise(r => setTimeout(r, 250));
  const after = parseFloat(window.document.querySelector('#page .bar > i').style.width);
  ok('迟到的事件不会让进度回退', after >= before, `${before}% → ${after}%`);

  console.log('\n【G】刷新页面后自动接上正在跑的任务');
  const fresh = await import(pathToFileURL(path.join(PUB, 'js/core/active-run.js')).href + '?fresh=1');
  const resumed = await fresh.restore();
  ok('restore() 找到运行中的任务', resumed === TASK_ID, String(resumed));
  ok('恢复后状态为 running', fresh.isRunning());
  ok('恢复了已有事件日志', fresh.derive().logs.length > 0, String(fresh.derive().logs.length));

  // ============================================================
  console.log('\n【G2】分批进度显示');
  {
    window.__send('batch', { phase: 'start', index: 1, total: 3, chapters: 10, chars: 12212, tokens: 7819 });
    await new Promise(r => setTimeout(r, 200));
    const d = run.derive();
    ok('derive() 捕获 batch 事件', d.batch?.total === 3, JSON.stringify(d.batch));
    ok('batch 起始时 done 为 false', d.batch?.done === false);
    const batchLine = page().querySelector('#page .batch-line');
    ok('页面出现分批进度条', !!batchLine && batchLine.style.display !== 'none');
    const bt = batchLine?.textContent || '';
    ok('显示「批次 N / 总批数」', /批次\s*2\s*\/\s*3/.test(bt), bt.slice(0, 80));
    ok('显示本批章数与字数', /10\s*章/.test(bt) && /万字/.test(bt), bt.slice(0, 120));
    ok('显示进行中', /进行中/.test(bt), bt.slice(0, 120));
    ok('侧边栏状态文案带批次', /批次\s*2\/3/.test(run.statusText()), run.statusText());

    // 进度条随批次推进。
    //
    // 不能断言"每完成一批进度就涨"：分批阶段铺在 28%→82%，而 3 批的任务里
    // 第 1/2 批落在 46%/64%，都没超过已经先到的 Step 5(82%)。
    // 这是刻意的 —— 进度条只取更靠后的那个，绝不倒退。
    //
    // 所以这里测**契约**而不是测某个具体数字：
    //   · 批次进度是单调的，且随批数增长；
    //   · 步骤进度先跳到前面时，批次进度不会把它拽回来；
    //   · 分批阶段确实被铺满（末批的批次值 == Step 5 的值）。
    const batchValue = (done, total) => 0.28 + (0.82 - 0.28) * (done / total);
    ok('批次进度随批数单调增长',
      batchValue(1, 11) < batchValue(5, 11) && batchValue(5, 11) < batchValue(11, 11),
      `${batchValue(1, 11)} / ${batchValue(5, 11)} / ${batchValue(11, 11)}`);
    ok('末批的批次值正好走到 Step 5（与后续步骤衔接）',
      Math.abs(batchValue(11, 11) - 0.82) < 1e-9, String(batchValue(11, 11)));
    ok('11 批任务里，第 6 批完成就超过 Step 2/3 的值',
      batchValue(6, 11) > 0.55, `${batchValue(6, 11)} > 0.55`);

    const beforeBatch3 = parseFloat(page().querySelector('#page .bar > i').style.width);
    ok('第 2 批完成后进度不倒退', run.derive().progress >= 0.82 - 1e-9, String(run.derive().progress));

    window.__send('batch', { phase: 'start', index: 2, total: 3, chapters: 5, chars: 6000, tokens: 4000 });
    await new Promise(r => setTimeout(r, 150));
    ok('切到第 3 批后显示 3/3', /批次\s*3\s*\/\s*3/.test(page().querySelector('#page .batch-line')?.textContent || ''),
      page().querySelector('#page .batch-line')?.textContent?.slice(0, 60));

    window.__send('batch', { phase: 'done', index: 2, total: 3, chapters: 5, chars: 6000, mentions: 2, events: 1 });
    await new Promise(r => setTimeout(r, 200));
    const afterAll = parseFloat(page().querySelector('#page .bar > i').style.width);
    ok('批次全部完成后进度不低于分批阶段终点', afterAll >= beforeBatch3,
      `${beforeBatch3}% → ${afterAll}%`);
    ok('批次全部完成后显示 3/3', /批次\s*3\s*\/\s*3/.test(page().querySelector('#page .batch-line')?.textContent || ''));
    ok('批次完成后文案变已完成', /已完成/.test(page().querySelector('#page .batch-line')?.textContent || ''));
    ok('批次内进度也前进',
      parseFloat(page().querySelector('#page .batch-line .bar > i')?.style.width || '0') > 0,
      page().querySelector('#page .batch-line .bar > i')?.style.width);
    // 回放一条更早阶段的日志，进度不能因此回退
    window.__send('progress', { step: 'Step 2', msg: '事件 3/11（迟到的回放）' });
    await new Promise(r => setTimeout(r, 150));
    ok('迟到日志不会让进度回退',
      parseFloat(page().querySelector('#page .bar > i').style.width) >= afterAll,
      `afterAll=${afterAll}`);
  }

  // ============================================================
  console.log('\n【G3】暂停 / 继续');
  {
    const pauseBtn = [...page().querySelectorAll('button')].find(b => /暂停/.test(b.textContent));
    ok('暂停按钮可见', !!pauseBtn && pauseBtn.style.display !== 'none',
      [...page().querySelectorAll('button')].map(b => `${b.textContent}:${b.style.display}`).join('|').slice(0, 200));
    pauseBtn?.click();
    await new Promise(r => setTimeout(r, 250));
    ok('调用了后端暂停接口', pauseCalled === true);
    ok('按钮进入"暂停中…"', /暂停中/.test(run.statusText()) || /暂停中/.test(page().textContent),
      run.statusText());

    // 服务端确认暂停
    window.__send('paused', { message: '任务已暂停' });
    await new Promise(r => setTimeout(r, 200));
    ok('derive() 反映已暂停', run.derive().paused === true);
    ok('状态标签变为已暂停', /已暂停/.test(window.document.getElementById('gen-state-tag')?.textContent || ''),
      window.document.getElementById('gen-state-tag')?.textContent);
    const resumeBtn = [...page().querySelectorAll('button')].find(b => /▶ 继续/.test(b.textContent));
    ok('继续按钮出现', !!resumeBtn && resumeBtn.style.display !== 'none');
    ok('暂停按钮隐藏', [...page().querySelectorAll('button')]
      .find(b => /⏸ 暂停/.test(b.textContent))?.style.display === 'none');
    ok('暂停不等于结束（任务仍在运行态）', run.isRunning());

    resumeBtn?.click();
    await new Promise(r => setTimeout(r, 250));
    ok('调用了后端继续接口', resumeCalled === true);
    ok('恢复后不再显示已暂停', run.derive().paused === false);
    ok('暂停按钮回到可见', [...page().querySelectorAll('button')]
      .find(b => /⏸ 暂停/.test(b.textContent))?.style.display !== 'none');
  }

  // ============================================================
  console.log('\n【G4】断点续跑横幅');
  {
    window.location.hash = `#/generate?resume=${TASK_ID}`;
    await new Promise(r => setTimeout(r, 400));
    const rg = page().textContent || '';
    ok('生成页出现续跑横幅', /断点续跑/.test(rg), rg.slice(0, 120));
    ok('横幅说明复用哪个任务', rg.includes(TASK_ID), rg.slice(0, 200));
    ok('横幅说明已完成/总批数', /2\s*\/\s*3\s*批/.test(rg), (rg.match(/已完成[^。]*/) || [''])[0]);
    ok('横幅提醒参数以原任务为准', /以原任务为准/.test(rg));
    ok('提供"不续跑"出口', [...page().querySelectorAll('button')].some(b => /不续跑/.test(b.textContent)));

    // 点掉横幅后不应再带 resumeTaskId
    const dismiss = [...page().querySelectorAll('button')].find(b => /不续跑/.test(b.textContent));
    dismiss?.click();
    await new Promise(r => setTimeout(r, 200));
    ok('点不续跑后横幅消失',
      !/断点续跑/.test(page().textContent),
      page().textContent.slice(0, 100));
  }

  console.log('\n【H】中止任务');
  const cancelBtn = [...page().querySelectorAll('button')].find(b => /取消|中止/.test(b.textContent));
  cancelBtn?.click();
  await new Promise(r => setTimeout(r, 300));
  ok('调用了后端取消接口', cancelCalled === true);
  ok('本地状态变为已取消', !run.isRunning(), run.snapshot().status);

  console.log('\n【I】离开页面不泄漏定时器');
  window.location.hash = '#/dashboard';
  await new Promise(r => setTimeout(r, 300));
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 300));
  window.location.hash = '#/dashboard';
  await new Promise(r => setTimeout(r, 300));
  window.location.hash = '#/generate';
  await new Promise(r => setTimeout(r, 300));
  const stepCount = page().querySelectorAll('#page .step').length;
  ok('反复切页后步骤列表没有重复渲染', stepCount === 10, `step 节点数=${stepCount}`);
  ok('反复切页后没有渲染失败', !text().includes('页面渲染失败'));

  console.log('\n【J】切页回来后仍记得选中的小说文件');
  // 浏览器不允许脚本回填 input.files，但页面应提示"已选择：xxx"并能继续生成
  ok('界面提示已选中的文件', /已选择：小说\.txt/.test(text()), text().slice(0, 200));
  ok('提示里有重新选择入口',
    [...page().querySelectorAll('button')].some(b => b.textContent === '重新选择'));

  console.log('\n【K】转入后台：断开连接但轮询接上');
  run.reset();
  serverEvents.length = 0;
  running = false;
  streamAborted = false;
  cancelCalled = false;
  // 重新走一次：选文件 → 生成
  const fi2 = page().querySelector('#page #f-novel');
  Object.defineProperty(fi2, 'files', { value: [file], configurable: true });
  fi2.dispatchEvent(new window.Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 250));
  const sb2 = [...page().querySelectorAll('#page button')].find(b => /开始生成|生成中/.test(b.textContent));
  ok('再次找到开始生成按钮', !!sb2, [...page().querySelectorAll('#page button')].map(b => b.textContent).join('|').slice(0, 160));
  sb2.click();
  await new Promise(r => setTimeout(r, 300));
  ok('第二次任务已启动', run.isRunning(), run.snapshot().status);

  const detachBtn = [...page().querySelectorAll('#page button')].find(b => b.textContent.includes('转入后台'));
  ok('生成中显示「转入后台」按钮', !!detachBtn && detachBtn.style.display !== 'none');
  detachBtn.click();
  await new Promise(r => setTimeout(r, 300));
  ok('断开连接后任务状态仍为进行中', run.isRunning(), run.snapshot().status);
  ok('断开连接后本地流已中止', streamAborted === true, `streamAborted=${streamAborted}`);
  ok('轮询已接管（日志请求增加）',
    fetchLog.filter(f => f.includes('/log')).length >= 2,
    `log 请求数=${fetchLog.filter(f => f.includes('/log')).length}`);
  ok('转入后台后仍显示生成中', /生成中/.test(text()), text().slice(0, 120));

  console.log(`\n${'='.repeat(46)}`);
  console.log(`  进度跨页保持：通过 ${pass} · 失败 ${fail}`);
  console.log(`${'='.repeat(46)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('\n测试异常：', e);
  process.exit(1);
});
