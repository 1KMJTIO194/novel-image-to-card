/**
 * 图片生成角色卡页
 *
 * 与「生成流程」页的定位差异：
 *   · 生成流程：小说文本 → 大批量抽取 → 世界书 + 变量树 + 完整卡
 *   · 本页：若干张图 → 视觉抽取人物外貌 → 同一套装配 → 同样的卡
 *
 * 后端 /api/image-card 的 SSE 事件与 /api/generate 完全一致，
 * 所以进度展示、取消、切页不丢都直接复用 active-run，不需要另建一套。
 */

import { el, clear, field, truncate, fmtBytes } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, toast, setConfig, on } from '../core/store.js';
import { navigate } from '../core/router.js';
import { createModelPicker } from '../core/model-picker.js';
import { renderSummaryPanel } from '../core/summary-view.js';
import * as run from '../core/active-run.js';

/** 与后端 MAX_IMAGE_BYTES 保持一致（只用于前端提前提示） */
const MAX_MB = 8;
/**
 * 与后端 MAX_IMAGES 保持一致。
 *
 * 原来这里是 8 —— 长漫画一话就有 15-25 页，8 张根本不够。
 * 后端已支持分批送模型（每批 6 张），所以这里放宽到 60。
 */
const MAX_IMAGES = 60;
/** 每批送模型多少张（与后端 DEFAULT_VISION_BATCH 一致，仅用于进度提示） */
const VISION_BATCH = 6;
const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';

/** 允许的扩展名（与后端 validateImages 一致） */
const OK_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return (m?.[1] || '').toLowerCase();
}

export async function renderImageCard(mount) {
  const page = el('div', { class: 'page' });
  mount.appendChild(page);

  /** 已选图片：{file, url, ok, reason} */
  let picked = [];
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);
  const detach = () => { for (const f of cleanups) { try { f(); } catch {} } };
  document.addEventListener('dsh:route-leave', detach, { once: true });

  // ============================================================
  // 1. 说明卡
  // ============================================================
  page.appendChild(el('div', { class: 'card' },
    el('h2', { text: '图片 → 角色卡' }),
    el('div', { class: 'hint', style: { marginTop: '6px', lineHeight: '1.7' } },
      '上传若干张人物图，模型会读取外貌、服饰、气质与场景，生成与「小说 → 角色卡」',
      '结构完全一致的角色卡（变量树 / 状态栏 / 正则体系 / 世界书）。'),
    el('div', { class: 'hint', style: { marginTop: '8px', lineHeight: '1.7' } },
      el('strong', { text: '两点必须知道：' }),
      el('div', { text: '① 需要**支持视觉**的模型。实测 deepseek-flash 可以看图；若模型不支持，任务会失败并说明原因，不会静默产出空壳卡。' }),
      el('div', { text: '② 图片只能给出外貌与服饰；姓名、身份、经历属于**推断**，卡里都标注了「（据画面推断）」或「图片未提供」，不会假装是图里读出来的。' })),
  ));

  // ============================================================
  // 2. 图片选择
  // ============================================================
  const listBox = el('div', { class: 'grid thumbs', style: { marginTop: '10px' } });
  const summaryEl = el('div', { class: 'hint' });
  const fileInput = el('input', {
    type: 'file', id: 'image-card-files', name: 'images',
    accept: ACCEPT, multiple: true, style: { display: 'none' },
  });
  const dropZone = el('div', {
    class: 'dropzone',
    style: {
      border: '1px dashed var(--border)', borderRadius: '10px', padding: '22px',
      textAlign: 'center', cursor: 'pointer', transition: 'border-color .15s',
    },
  },
    el('div', { style: { fontSize: '22px' }, text: '🖼' }),
    el('div', { style: { marginTop: '6px' }, text: '点击选择图片，或把图片拖到这里' }),
    el('div', { class: 'hint', text: `支持 ${OK_EXT.join(' / ')}，单张不超过 ${MAX_MB}MB，最多 ${MAX_IMAGES} 张` }),
    el('div', { class: 'hint', text: `超过 ${VISION_BATCH} 张会自动分批送给模型（长漫画按话导入即可）` }),
  );

  const refresh = () => {
    clear(listBox);
    const okOnes = picked.filter(p => p.ok);
    for (const [i, p] of picked.entries()) {
      const badge = p.ok ? null : el('div', {
        class: 'hint', style: { color: 'var(--danger)' }, text: p.reason,
      });
      listBox.appendChild(el('div', {
        class: 'card tight',
        style: { padding: '8px', opacity: p.ok ? '1' : '.55' },
      },
        el('img', {
          src: p.url, alt: p.file.name,
          style: { width: '100%', height: '150px', objectFit: 'cover', borderRadius: '6px', display: 'block' },
        }),
        el('div', { class: 'hint', style: { marginTop: '6px' }, text: `${i + 1}. ${truncate(p.file.name, 26)}` }),
        el('div', { class: 'hint', text: fmtBytes(p.file.size) }),
        badge,
        el('button', {
          class: 'btn sm ghost', type: 'button', style: { marginTop: '6px' },
          text: '移除',
          onclick: () => {
            URL.revokeObjectURL(p.url);
            picked = picked.filter(x => x !== p);
            refresh();
          },
        }),
      ));
    }
    const bad = picked.filter(p => !p.ok).length;
    summaryEl.textContent = picked.length
      ? `已选 ${okOnes.length} 张可用${bad ? `，${bad} 张不可用（见上方红字）` : ''}`
      : '还没有选择图片';
    summaryEl.style.color = bad ? 'var(--danger)' : 'var(--text-mute)';
  };

  const addFiles = (files) => {
    for (const f of files) {
      const ext = extOf(f.name);
      let ok = true;
      let reason = '';
      if (!OK_EXT.includes(ext)) {
        ok = false;
        reason = `格式不支持（${ext || '无扩展名'}）`;
      } else if (f.size > MAX_MB * 1024 * 1024) {
        ok = false;
        reason = `超过 ${MAX_MB}MB（${fmtBytes(f.size)}）`;
      } else if (picked.filter(p => p.ok).length >= MAX_IMAGES) {
        ok = false;
        reason = `最多 ${MAX_IMAGES} 张`;
      }
      picked.push({ file: f, url: URL.createObjectURL(f), ok, reason });
    }
    refresh();
  };

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--accent)';
  });
  dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.style.borderColor = 'var(--border)';
    addFiles([...(e.dataTransfer?.files || [])]);
  });
  fileInput.addEventListener('change', () => {
    addFiles([...fileInput.files]);
    fileInput.value = '';
  });

  const imageCard = el('div', { class: 'card' },
    el('h3', { text: '① 选择图片' }),
    el('div', { class: 'hint', text: '第 1 张会同时作为角色卡头像（avatar）' }),
    dropZone, fileInput, listBox, summaryEl,
  );

  /**
   * 「选文件夹」——直接选一话的目录，一次把这几十张图加进来。
   *
   * 相比让用户一张张点选，这是**最省事**的路径；
   * 而且它走的是普通文件上传（`webkitdirectory` 是浏览器能力），
   * 不需要服务端去读盘 —— 所以换到任何机器/部署都能用。
   * 只把这一层目录下的图片加进来（子目录不递归，和 CLI 规则一致）。
   */
  const folderInput = el('input', {
    type: 'file', id: 'image-card-folder', name: 'imageFolder',
    webkitdirectory: true, directory: true, multiple: true,
    style: { display: 'none' },
  });
  folderInput.addEventListener('change', () => {
    const all = [...folderInput.files];
    // webkitdirectory 会给目录下所有文件（含子目录），这里只留图片，避免一堆 txt 报"格式不支持"
    const imgs = all.filter(f => OK_EXT.includes(extOf(f.name)));
    const skipped = all.length - imgs.length;
    if (imgs.length) addFiles(imgs);
    if (skipped > 0) toast(`已忽略 ${skipped} 个非图片文件（只收 ${OK_EXT.join(' / ')}）`, 'info');
    else if (!imgs.length) toast('这个文件夹里没有图片', 'warn');
    folderInput.value = '';
  });
  imageCard.appendChild(el('div', { class: 'row', style: { marginTop: '8px' } },
    el('button', {
      class: 'btn', type: 'button',
      text: '📁 选一个文件夹（整话一次导入）',
      onclick: () => folderInput.click(),
    }),
    folderInput));

  /**
   * 「从本机目录生成」。
   *
   * 为什么加这个：漫画一话常常是几十上百张图，一张张点选很麻烦
   *（用户原话：「我翻文件找有点麻烦」）。这里直接填目录路径，
   * 由**本机服务**去扫（浏览器拿不到目录列表）。
   *
   * 安全性：服务端只接受**回环地址**的请求，且只收图片扩展名。
   */
  const dirInput = el('input', {
    type: 'text', id: 'image-card-dir', name: 'dirPath',
    placeholder: 'D:\\漫画\\某作品\\第1话',
  });
  imageCard.appendChild(el('div', { style: { marginTop: '12px' } },
    field({
      label: '或：填一个本机图片目录（不用一张张选）',
      control: dirInput,
      id: 'image-card-dir', name: 'dirPath',
      hint: '填绝对路径。会按文件名自然序读取该目录下的 png/jpg/webp/gif（最多 60 张），'
        + '图片会复制一份进任务目录再分析。填了这里就不用上面的选图。',
    })));
  page.appendChild(imageCard);

  // ============================================================
  // 3. 设定与参数
  // ============================================================
  const titleInput = el('input', {
    type: 'text', id: 'image-card-title', name: 'title',
    placeholder: '（默认「图片生成的角色卡」）',
  });
  const hintInput = el('textarea', {
    id: 'image-card-hint', name: 'hint', rows: '3',
    placeholder: '可选。例如：这是修仙世界；她是主角的师姐；两人是同门。留空则完全从图片推断。',
  });
  const worldToggle = el('input', {
    type: 'checkbox', id: 'image-card-world', name: 'wantWorldbook', checked: true,
  });
  /** 主要角色外观精修（默认开；关掉可省每个主要角色一次带图请求） */
  const refineToggle = el('input', {
    type: 'checkbox', id: 'image-card-refine', name: 'refineMainAppearance', checked: true,
  });

  /**
   * 生成档位：基础版（默认，token 省）/ 完整版（人物与世界观写更细）。
   * 完整版会让总结要求更长的字段、更多角色做外观精修。
   */
  const levelSelect = el('select', {
    id: 'image-card-level', name: 'detailLevel',
  },
  el('option', { value: 'basic', selected: true }, '基础版（默认，token 少）'),
  el('option', { value: 'full' }, '完整版（更细致，token 更多）'));

  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '② 设定（都可选）' }),
    field({ label: '角色卡名称', control: titleInput, id: 'image-card-title', name: 'title' }),
    field({
      label: '生成档位', control: levelSelect,
      id: 'image-card-level', name: 'detailLevel',
      hint: '基础版：与之前一致，token 消耗少。完整版：人物字段更全、外貌服装分层更细、'
        + '世界观条目更多更长、会精修更多主要角色 —— 代价是更多 token 与更久时间。',
    }),
    field({
      label: '文字补充设定', control: hintInput, id: 'image-card-hint', name: 'hint',
      hint: '写在这里的设定优先于图片推断，并会记进 notes。图片给不了剧情，填一段能显著提升可用性。',
    }),
    el('label', { class: 'check', style: { display: 'flex', gap: '8px', alignItems: 'center' } },
      worldToggle,
      el('span', { text: '生成世界观条目（世界概览 + 画面中出现的场景）' })),
    el('div', { class: 'hint', style: { marginTop: '4px' },
      text: '图片只能推出很粗的世界观（场景、题材线索），条目会明确标注"由图片推断"。' }),

    /**
     * 主要角色外观精修开关（默认开）。
     *
     * 为什么值得多花这几次请求：外观与服装是**图片独有的信息**，
     * 但一次总结里要做人物 + 世界观 + 舞台，注意力被摊薄，
     * 主要角色的外貌往往只剩一句"黑色长发、深色外套"。
     * 打开后会对 主角 / 主要NPC 分别再跑一次「只看外观」的请求，
     * 每个主要角色多一次请求。
     */
    el('label', { class: 'check', style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px' } },
      refineToggle,
      el('span', { text: '✨ 主要角色外观精修（推荐）' })),
    el('div', { class: 'hint', style: { marginTop: '4px' },
      text: '对分辨出的 主角 / 主要NPC，各再跑一次只看外观与服装的请求，把发色发型、五官、'
        + '服装层次与配饰写细。每个主要角色多 1 次带图请求；关掉则沿用总结里那一句。' }),
  ));

  // ============================================================
  // 3b. 分批设置（长漫画用）
  // ============================================================
  const batchInput = el('input', {
    type: 'number', id: 'image-card-batch', name: 'batchSize',
    value: String(VISION_BATCH), min: '1', max: '12', step: '1',
    style: { width: '90px' },
  });
  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '③ 分批设置' }),
    field({
      label: '每批送给模型的张数', control: batchInput,
      id: 'image-card-batch', name: 'batchSize',
      hint: `图片会按这个张数分批分析（默认 ${VISION_BATCH}）。张数越少每张图的分析越细、但请求更多；`
        + '张数太多会让模型对每张图的注意力变差。长漫画一般保持默认即可。',
    }),
  ));

  // ============================================================
  // 4. API 配置
  // ============================================================
  const baseUrlInput = el('input', { type: 'text', id: 'image-card-baseurl', name: 'baseUrl', value: state.config.baseUrl, placeholder: 'https://api.deepseek.com/v1' });
  const keyInput = el('input', { type: 'password', id: 'image-card-apikey', name: 'apiKey', value: state.config.apiKey, placeholder: 'sk-...' });
  const modelInput = el('input', { type: 'text', id: 'image-card-model', name: 'model', value: state.config.model, placeholder: 'deepseek-flash / gpt-4o / qwen-vl-max' });
  for (const i of [baseUrlInput, keyInput]) {
    i.setAttribute('autocomplete', 'off');
    i.setAttribute('autocapitalize', 'off');
    i.setAttribute('spellcheck', 'false');
  }

  const modelHint = el('div', { class: 'hint', text: '未拉取候选（可直接输入模型名）' });
  const modelPicker = createModelPicker({
    input: modelInput,
    loadModels: async () => {
      setConfig({ baseUrl: baseUrlInput.value.trim(), apiKey: keyInput.value.trim() });
      const r = await api.models({ baseUrl: state.config.baseUrl, apiKey: state.config.apiKey });
      return r.models || [];
    },
    onPick: () => setConfig({ model: modelInput.value.trim() }),
    autoLoad: true,
    emptyHint: '还没有候选列表',
  });
  onCleanup(() => modelPicker.destroy());

  const paintModelHint = () => {
    modelHint.textContent = modelPicker.summary();
    modelHint.style.color = modelPicker.status === 'error' ? 'var(--danger)'
      : modelPicker.status === 'ready' ? 'var(--ok)' : 'var(--text-mute)';
  };
  modelInput.addEventListener('focus', () => setTimeout(paintModelHint, 400));
  modelPicker.panel.addEventListener('click', () => setTimeout(paintModelHint, 50));

  baseUrlInput.addEventListener('change', () => {
    setConfig({ baseUrl: baseUrlInput.value.trim().replace(/\/+$/, '') });
    baseUrlInput.value = state.config.baseUrl;
    modelPicker.invalidate(`${state.config.baseUrl}|${state.config.apiKey}`);
    paintModelHint();
  });
  keyInput.addEventListener('change', () => {
    setConfig({ apiKey: keyInput.value.trim() });
    modelPicker.invalidate(`${state.config.baseUrl}|${state.config.apiKey}`);
    paintModelHint();
  });
  modelInput.addEventListener('change', () => setConfig({ model: modelInput.value.trim() }));

  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '③ API 配置' }),
    el('div', { class: 'hint', style: { marginBottom: '8px' } },
      el('strong', { text: '需要支持视觉的模型。' }),
      ' 实测 deepseek-flash 可以看图；不支持视觉的模型会返回「看不到图片」，',
      '任务会失败并给出提示 —— 不会静默产出一张空壳卡。'),
    el('div', { class: 'row' },
      el('div', { style: { flex: '1 1 240px' } }, field({ label: 'Base URL', control: baseUrlInput, id: 'image-card-baseurl', name: 'baseUrl' })),
      el('div', { style: { flex: '1 1 200px' } }, field({ label: 'API Key', control: keyInput, id: 'image-card-apikey', name: 'apiKey' })),
      el('div', { style: { flex: '1 1 200px' } }, field({ label: '模型', control: modelInput, id: 'image-card-model', name: 'model', hint: '' })),
    ),
    modelHint,
  ));

  // ============================================================
  // 5. 提交 + 进度
  // ============================================================
  const startBtn = el('button', { class: 'btn primary', type: 'button', text: '开始生成' });
  const cancelBtn = el('button', { class: 'btn ghost', type: 'button', text: '取消', style: { display: 'none' } });
  const progressBox = el('div', { class: 'card', style: { display: 'none' } });
  const logBox = el('pre', {
    class: 'code',
    style: { maxHeight: '240px', overflow: 'auto', marginTop: '8px', whiteSpace: 'pre-wrap' },
  });
  progressBox.append(el('h3', { text: '④ 进度' }), logBox);

  /** 总结区：任务完成后显示"这次产出了什么" */
  const summaryHost = el('div', { class: 'sum-host' });
  progressBox.appendChild(summaryHost);

  const paintSummary = () => {
    const snap = run.snapshot();
    if (snap?.status === 'running') { clear(summaryHost); return; }
    const inline = snap?.summary;
    if (inline) {
      clear(summaryHost);
      summaryHost.appendChild(renderSummaryPanel(inline));
      return;
    }
    // 刷新页面后 SSE 的 summary 已经丢了 → 向后端要一次
    const taskId = snap?.taskId;
    if (!taskId || summaryHost.dataset.task === taskId) return;
    summaryHost.dataset.task = taskId;
    clear(summaryHost);
    summaryHost.appendChild(el('div', { class: 'hint', text: '正在读取总结…' }));
    api.summary(taskId).then((r) => {
      clear(summaryHost);
      if (r?.summary) summaryHost.appendChild(renderSummaryPanel(r.summary));
    }).catch(() => { clear(summaryHost); });
  };

  /** 把 active-run 的事件流画到页面上（切页回来也能继续显示） */
  const paint = () => {
    const snap = run.snapshot();
    const active = snap?.status === 'running';
    startBtn.disabled = active;
    startBtn.textContent = active ? '生成中…' : '开始生成';
    cancelBtn.style.display = active ? '' : 'none';
    if (snap?.status === 'idle') { summaryHost.innerHTML = ''; return; }
    progressBox.style.display = '';
    paintSummary();
    const lines = (run.events || [])
      .filter(e => e.event === 'progress' || e.event === 'error')
      .map(e => {
        if (e.event === 'error') {
          const msg = String(e.data?.message || '');
          /**
           * 旧版服务端不认识目录参数：它只看到"没有上传文件"，
           * 于是返回「未上传图片…」。这时真正的病根是**后端没重启**，
           * 但用户看到的却是"我明明填了目录" —— 所以在这里点破，
           * 不然只能盲猜。
           */
          if (dirInput.value.trim() && /未上传图片/.test(msg)) {
            return `❌ ${msg}\n   ↳ 服务端仍是旧代码（不认识目录参数）：请关掉正在运行的服务窗口，重新 npm start 后再试`;
          }
          return `❌ ${msg}`;
        }
        const step = e.data?.step || '';
        const warn = step === 'WARN' ? '⚠ ' : '';
        return `[${step}] ${warn}${e.data?.msg || ''}`;
      });
    logBox.textContent = lines.slice(-40).join('\n') || '（等待事件…）';
    logBox.scrollTop = logBox.scrollHeight;
  };
  on('run', paint);

  startBtn.addEventListener('click', async () => {
    const usable = picked.filter(p => p.ok);
    const dirPath = dirInput.value.trim();
    // 目录模式和选图模式二选一：填了目录就不需要选图
    if (!usable.length && !dirPath) {
      toast('请先选择至少 1 张可用图片，或填一个本机图片目录', 'warn');
      return;
    }
    if (!baseUrlInput.value.trim() || !modelInput.value.trim()) {
      toast('请填写 Base URL 与模型名', 'warn');
      return;
    }
    setConfig({
      baseUrl: baseUrlInput.value.trim().replace(/\/+$/, ''),
      apiKey: keyInput.value.trim(),
      model: modelInput.value.trim(),
    });

    const fd = new FormData();
    for (const p of usable) fd.append('images', p.file, p.file.name);
    if (dirPath) fd.append('dirPath', dirPath);
    fd.append('baseUrl', state.config.baseUrl);
    fd.append('apiKey', state.config.apiKey);
    fd.append('model', state.config.model);
    fd.append('title', titleInput.value.trim() || '图片生成的角色卡');
    fd.append('hint', hintInput.value.trim());
    fd.append('wantWorldbook', worldToggle.checked ? 'true' : 'false');
    // 生成档位：basic / full
    fd.append('detailLevel', levelSelect.value === 'full' ? 'full' : 'basic');
    // 主要角色外观精修（服务端 options.refineMainAppearance）
    fd.append('options', JSON.stringify({ refineMainAppearance: refineToggle.checked }));
    // 分批张数：长漫画可调；后端会 clamp 到 1..12
    fd.append('batchSize', String(Math.max(1, Math.min(12, Number(batchInput.value) || VISION_BATCH))));

    progressBox.style.display = '';
    logBox.textContent = '（正在提交…）';
    const r = await run.start(fd, { endpoint: '/api/image-card' });
    if (!r.ok) toast(r.error || '启动失败', 'err');
    paint();
  });

  cancelBtn.addEventListener('click', () => {
    run.cancel?.();
    toast('已请求取消', 'warn');
  });

  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '④ 生成' }),
    el('div', { class: 'row' }, startBtn, cancelBtn,
      el('button', {
        class: 'btn ghost', type: 'button', text: '查看任务与产物',
        onclick: () => navigate('/library'),
      })),
  ));
  page.appendChild(progressBox);

  refresh();
  paint();
}
