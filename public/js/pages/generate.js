/** 生成流程页：文件、参数、实时步骤与日志 */

import { el, clear, fmtTime, fmtDuration, download, field, debounce } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, setConfig, setUI, toast, on } from '../core/store.js';
import { registerGenerate, runGenerate } from '../core/commands.js';
import { navigate } from '../core/router.js';
import * as run from '../core/active-run.js';
import { createModelPicker } from '../core/model-picker.js';
import { createChapterSelector } from '../core/chapter-selector.js';
import { renderSummaryPanel } from '../core/summary-view.js';
import {
  validatePreset, presetInfo, statusLine, setPreset, clearPreset, currentPreset,
  currentPresetText, exportPreset, importPresetFromFile, copyPreset,
  needsReplaceConfirm, confirmReplace, EXAMPLE_PRESET, presetMode,
  STEP_NAMES, STEP_LABELS,
} from '../core/preset-manager.js';

/** 流程步骤定义（顺序即进度） */
const STEPS = [
  { key: 'Init', label: '读入与切分', desc: '校验文本、按章节切块' },
  { key: 'Step 0.5', label: 'user 角色定位', desc: '判定主角 / 参与者 / 观察者' },
  { key: 'Step 1', label: '时间线', desc: '抽取时间提及、识别原点、求解时间轴' },
  { key: 'Step 2', label: '事件抽取', desc: '关键事件、故事线归并、原著压力' },
  { key: 'Step 3', label: '阶段划分', desc: '把事件序列切成 3–8 个阶段' },
  { key: 'Step 4', label: '人设增量', desc: '每阶段角色内在变化' },
  { key: 'Step 5', label: '世界观与人物', desc: '地图 / 体系 / 历史 / 人物档案' },
  { key: 'Step 6', label: '变量树', desc: '构建 MVU 变量与 user 命名空间' },
  { key: 'Step 8', label: '组装与校验', desc: 'A 包世界书 + B 包预设、token 校验' },
  { key: 'Done', label: '完成', desc: '写出产物文件' },
];

export function isGenerating() { return run.isRunning(); }

/**
 * 已选择的小说文件。
 * 放在模块作用域而不是页面里：用户切走再切回来时，页面会重建，
 * file input 里的选择会丢（浏览器不允许脚本回填 input.files），
 * 这里保留引用，并用文字提示当前选中的是哪个文件。
 */
let lastNovel = null;

/**
 * 断点续跑目标：从任务库点「继续未完成任务」跳过来时带 `?resume=<taskId>`。
 *
 * 放在模块作用域是因为它有生命周期：进页面时设置，用户点「不续跑」或
 * 真正开始一次新生成后清掉 —— 否则下一次生成会莫名其妙复用别人的批次。
 */
let resumeTarget = null;

export async function renderGenerate(mount, params) {
  const page = el('div', { class: 'page' });
  const cols = el('div', { class: 'grid split' });
  const left = el('div');
  const right = el('div');
  cols.append(left, right);
  page.appendChild(cols);
  mount.appendChild(page);

  // 本页面的清理钩子（离开页面时必须执行，否则定时器会泄漏）
  const cleanups = [];
  const onCleanup = (fn) => cleanups.push(fn);
  const cleanupHandler = () => { for (const fn of cleanups.splice(0)) { try { fn(); } catch {} } };
  document.addEventListener('dsh:route-leave', cleanupHandler, { once: true });

  // ---------- 操作按钮（提前声明，输出模式切换要改它的文案）----------
  const startBtn = el('button', { class: 'btn primary block lg', type: 'button', text: '▶ 开始生成' });
  const cancelBtn = el('button', { class: 'btn danger block', type: 'button', text: '■ 中止任务', style: { display: 'none' } });
  // 分批评析：长篇按批推进，暂停后已完成批次都在盘上，可随时继续
  const pauseBtn = el('button', {
    class: 'btn ghost block', type: 'button', text: '⏸ 暂停',
    title: '在当前批次结束后停下；已完成的批次已保存，可随时继续',
    style: { display: 'none' },
  });
  const resumeBtn = el('button', {
    class: 'btn ok block', type: 'button', text: '▶ 继续',
    title: '从上次暂停的批次继续，已完成批次不会重跑',
    style: { display: 'none' },
  });
  const detachBtn = el('button', { class: 'btn sm ghost', type: 'button', text: '转入后台', title: '只断开本页连接，服务端继续生成', style: { display: 'none' } });

  // ============================================================
  // 顶部：任务模式（从零生成 / 完善已有角色卡）
  //
  // 两个模式**共用**同一套章节选择组件、同一个 /api/chapters、
  // 同一个 chapterRange 参数；差异只在于最后打哪个接口、带哪些额外字段。
  // ============================================================
  const GEN_MODES = [
    { id: 'from_scratch', icon: '✨', title: '从零生成', desc: '上传小说，全量生成一张新角色卡' },
    { id: 'augment', icon: '🧩', title: '完善已有角色卡', desc: '导入已有卡 + 新剧情，对齐合并后输出更新卡' },
  ];
  let genMode = state.ui.genMode === 'augment' ? 'augment' : 'from_scratch';
  /** 增补专属的卡片（切到「从零生成」时隐藏）；在下面填充 */
  let augmentCards = null;
  let titleField = null;
  let imageField = null;
  let modeCard = null;      // 输出模式卡片（增补模式下无意义）

  const genModeRow = el('div', { class: 'mode-switch', role: 'radiogroup', 'aria-label': '任务模式' });
  const genModeCards = new Map();
  for (const m of GEN_MODES) {
    const card = el('button', {
      class: 'mode-card', type: 'button', id: `gen-mode-${m.id}`, name: 'genMode',
      role: 'radio', 'aria-checked': String(genMode === m.id),
      onclick: () => setGenMode(m.id),
    },
      el('div', { class: 'mode-icon', text: m.icon }),
      el('div', { class: 'mode-body' },
        el('div', { class: 'mode-title', text: m.title }),
        el('div', { class: 'mode-desc', text: m.desc }),
      ),
    );
    genModeCards.set(m.id, card);
    genModeRow.appendChild(card);
  }
  const genModeHint = el('div', { class: 'hint', style: { marginTop: '8px' } });
  const genModeCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '任务模式' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '章节选择两个模式共用' }),
    ),
    genModeRow,
    genModeHint,
  );

  function paintGenModes() {
    for (const [id, card] of genModeCards) {
      card.classList.toggle('active', id === genMode);
      card.setAttribute('aria-checked', String(id === genMode));
    }
    const aug = genMode === 'augment';
    genModeHint.textContent = aug
      ? '导入已有的 character_card.json，再给它喂新剧情：先做实体对齐，再按策略合并。'
      : '上传一部小说，从零抽取事件、人物、世界观并生成完整角色卡。';
    // 增补专属卡片显示/隐藏
    if (augmentCards) for (const c of augmentCards) c.style.display = aug ? '' : 'none';
    // 输出模式只对「从零生成」有意义
    if (modeCard) modeCard.style.display = aug ? 'none' : '';
    // 增补模式下标题/头像没有意义
    if (titleField) titleField.style.display = aug ? 'none' : '';
    if (imageField) imageField.style.display = aug ? 'none' : '';
    startBtn.textContent = aug ? '▶ 开始完善' : (outputMode === 'card' ? '▶ 生成完整角色卡'
      : outputMode === 'ab' ? '▶ 生成 A 包 + B 包' : '▶ 开始生成');
  }

  function setGenMode(id, { persist = true } = {}) {
    if (!GEN_MODES.some(m => m.id === id)) return;
    genMode = id;
    if (persist) setUI({ genMode: id });
    paintGenModes();
  }

  // ============================================================
  // 左栏：表单
  // ============================================================

  // ---------- 0. 输出模式（两种产物，两个按钮）----------
  const MODES = [
    {
      id: 'card',
      icon: '🎴',
      title: '完整 JSON 角色卡',
      desc: '导入 SillyTavern 一次即可，内含世界书、变量、更新规则、正则',
      badge: '推荐',
    },
    {
      id: 'ab',
      icon: '📚',
      title: 'A 包 + B 包',
      desc: 'worldbook.json（世界书）+ preset_fragment.json（预设片段），分开导入',
    },
    {
      id: 'both',
      icon: '📦',
      title: '两者都要',
      desc: '两套产物都产出，自己挑着用',
    },
  ];

  const initialMode = MODES.some(m => m.id === state.ui.outputMode) ? state.ui.outputMode : 'card';
  let outputMode = initialMode;

  const modeCards = new Map();
  const modeRow = el('div', {
    class: 'mode-switch',
    id: 'output-mode',
    role: 'radiogroup',
    'aria-label': '输出模式',
  });

  function paintModes() {
    for (const [id, node] of modeCards) {
      const active = id === outputMode;
      node.className = `mode-card${active ? ' active' : ''}`;
      node.setAttribute('aria-checked', active ? 'true' : 'false');
      node.tabIndex = active ? 0 : -1;
    }
    startBtn.textContent = outputMode === 'card' ? '▶ 生成完整角色卡'
      : outputMode === 'ab' ? '▶ 生成 A 包 + B 包'
      : '▶ 开始生成';
    modeHint.textContent = MODES.find(m => m.id === outputMode)?.desc || '';
    // 注意：这里不调 paintGenModes() —— 它依赖 titleField/imageField 等，
    // 那些控件在构造函数体后面才创建。挂载末尾会统一调一次。
  }

  function setMode(id, { persist = true } = {}) {
    if (!MODES.some(m => m.id === id)) return;
    outputMode = id;
    if (persist) setUI({ outputMode: id });
    paintModes();
  }

  for (const m of MODES) {
    const card = el('button', {
      class: 'mode-card',
      type: 'button',
      role: 'radio',
      id: `mode-${m.id}`,
      name: 'outputMode',
      'data-mode': m.id,
      'aria-checked': 'false',
      onclick: () => setMode(m.id),
    },
      el('span', { class: 'mc-icon', text: m.icon }),
      el('span', { class: 'mc-body' },
        el('span', { class: 'mc-title' },
          m.title,
          m.badge ? el('span', { class: 'mc-badge', text: m.badge }) : null),
        el('span', { class: 'mc-desc', text: m.desc }),
      ),
      el('span', { class: 'mc-check', text: '✓' }),
    );
    modeCards.set(m.id, card);
    modeRow.appendChild(card);
  }

  const modeHint = el('div', { class: 'hint', style: { marginTop: '8px' } });

  const modeCardEl = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '输出内容' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '选一种，或两者都要' }),
    ),
    modeRow,
    modeHint,
  );
  modeCard = modeCardEl;      // 供 paintGenModes 控制显隐（增补模式下无意义）

  // ---------- 1. 小说文件 ----------
  const novelInput = el('input', { type: 'file', accept: '.txt,.md,.text', id: 'f-novel', name: 'novel' });
  const imageInput = el('input', { type: 'file', accept: 'image/*', multiple: true, id: 'f-images', name: 'images' });
  const titleInput = el('input', { type: 'text', placeholder: '（默认取文件名）', value: state.lastRun?.title || '' });

  /**
   * 生成档位：基础版（默认，token 省）/ 完整版（人物与世界观写更细）。
   * 完整版通过 `detailLevel` 传给后端，pipeline 会追加更细的写作要求。
   */
  const levelSelect = el('select', { id: 'f-detail-level', name: 'detailLevel' },
    el('option', { value: 'basic', selected: true }, '基础版（默认，token 少）'),
    el('option', { value: 'full' }, '完整版（更细致，token 更多）'));

  /**
   * 角色卡版本：普通版（默认，不含成人内容）/ 成人版（完整包含成人内容）。
   *
   * 默认必须是普通版；成人版通过 `contentMode=adult` 传给后端，
   * 后端会在 prompt 层要求写具体、并强制"出场角色须成年"。
   */
  const contentModeSelect = el('select', { id: 'f-content-mode', name: 'contentMode' },
    el('option', { value: 'general', selected: true }, '普通版（默认，不含成人内容）'),
    el('option', { value: 'adult' }, '成人版（完整包含成人内容）'));

  const preview = el('div', { class: 'hint', style: { marginTop: '8px' } });

  /** 记住选中的文件；切页回来时用它继续（input.files 无法回填） */
  function showPickedFile() {
    clear(preview);
    if (!lastNovel) return;
    preview.appendChild(el('div', { class: 'row', style: { marginTop: '4px' } },
      el('span', { class: 'tag ok', text: `已选择：${lastNovel.name}` }),
      el('span', { class: 'tag', text: `${(lastNovel.size / 1024).toFixed(0)} KB` }),
      el('button', {
        class: 'btn sm ghost', type: 'button', text: '重新选择',
        onclick: () => novelInput.click(),
      }),
    ));
  }

  novelInput.addEventListener('change', async () => {
    const f = novelInput.files?.[0];
    if (!f) return;
    lastNovel = f;
    preview.append(el('span', { class: 'hint', text: '' }));
    clear(preview);
    preview.appendChild(el('span', { class: 'spin' }));
    preview.append(' 正在本地预估章节…');
    try {
      const text = await f.text();
      const r = await api.estimate({ text, chunkMaxLen: state.config.chunkMaxLen });
      clear(preview);
      preview.appendChild(el('div', { class: 'row', style: { marginTop: '4px' } },
        el('span', { class: 'tag ok', text: lastNovel.name }),
        el('span', { class: 'tag info', text: `${r.chars.toLocaleString()} 字` }),
        el('span', { class: 'tag', text: `≈${r.tokens.toLocaleString()} tok` }),
        el('span', { class: 'tag ok', text: `${r.chapters} 块` }),
      ));
      preview.appendChild(el('div', { class: 'hint', style: { marginTop: '6px' } },
        '前几块：' + r.preview.slice(0, 4).map(p => p.title).join(' · ')));
      if (r.chapters < 3) {
        preview.appendChild(el('div', { class: 'hint', style: { color: 'var(--warn)', marginTop: '4px' } },
          '章节数少于 3，阶段划分可能降级。'));
      }
    } catch (e) {
      clear(preview);
      preview.appendChild(el('span', { style: { color: 'var(--danger)' }, text: `预估失败：${e.message}` }));
    }
    if (!titleInput.value) titleInput.value = f.name.replace(/\.[^.]+$/, '');
  });

  // 切页回来时提示之前选的文件仍然有效
  showPickedFile();

  // ---------- 章节选择（两个模式共用同一套组件与同一个 /api/chapters）----------
  let lastChapterRange = 'all';
  let chapterInfo = null;
  const chapterSelector = createChapterSelector({
    upload: (file) => api.chapters(file),
    onChange: (range, info) => {
      lastChapterRange = range;
      chapterInfo = info;
    },
  });

  // 上传后把章节交给共用组件（两个模式走完全相同的这条路径）
  novelInput.addEventListener('change', async () => {
    const f = novelInput.files?.[0];
    if (f) await chapterSelector.loadFromFile(f);
  });

  const chapterCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '📖 章节列表' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '上传后自动出现' }),
    ),
    chapterSelector.root,
  );

  // ---------- 增补专属：已有角色卡 + 增补策略 ----------
  const cardInput = el('input', {
    type: 'file', accept: '.json,application/json', id: 'f-card', name: 'card',
  });
  const cardStatus = el('div', { class: 'card-load-status', style: { display: 'none' } });
  let lastCardFile = null;

  /** 载入角色卡后立刻把卡片名与条目数显示出来（本地解析，不请求后端） */
  async function showCardInfo(file) {
    lastCardFile = file;
    clear(cardStatus);
    cardStatus.style.display = '';
    cardStatus.appendChild(el('div', { class: 'row' },
      el('span', { class: 'spin' }), ` 正在读取 ${file.name}…`));
    try {
      const text = await file.text();
      const card = JSON.parse(text);
      const entries = card?.data?.character_book?.entries;
      if (!card?.data?.name) throw new Error('缺少 data.name');
      if (!Array.isArray(entries)) throw new Error('缺少 data.character_book.entries');
      const nChar = entries.filter(e => String(e.comment || '').startsWith('[character]')).length;
      const nEv = entries.filter(e => String(e.comment || '').startsWith('[event]')).length;
      const nWb = entries.filter(e => /^\[(map_|system_|history)/.test(String(e.comment || ''))).length;
      clear(cardStatus);
      cardStatus.appendChild(el('div', { class: 'row' },
        el('span', { class: 'tag ok', text: `已载入：${card.data.name}` }),
        el('span', { class: 'tag', text: `${entries.length} 个世界书条目` }),
        el('span', { class: 'tag info', text: `人物 ${nChar} · 事件 ${nEv} · 世界观 ${nWb}` }),
      ));
      cardStatus.appendChild(el('div', { class: 'hint', style: { marginTop: '6px' } },
        `版本 ${card.data.character_version || '—'} · `
        + `${card.data.extensions?.regex_scripts?.length || 0} 条卡内正则（原样保留）`));
    } catch (e) {
      clear(cardStatus);
      cardStatus.appendChild(el('div', { class: 'row' },
        el('span', { class: 'tag', style: { background: 'rgba(255,107,107,.15)', color: 'var(--danger)' },
          text: `无法解析：${e.message}` })));
      lastCardFile = null;
    }
  }

  cardInput.addEventListener('change', () => {
    const f = cardInput.files?.[0];
    if (f) showCardInfo(f);
  });

  const STRATEGIES = [
    { id: 'append', title: '仅新增', desc: '只把新抽到的实体加进去，已有条目一字不改' },
    { id: 'merge', title: '智能合并（推荐）', desc: '同实体合并正文（原文保留，新内容追加在后），keys 取并集' },
    { id: 'overwrite', title: '覆盖', desc: '同实体用新剧情抽到的内容替换旧条目正文' },
  ];
  let strategy = 'merge';
  const strategyRow = el('div', { class: 'mode-switch', role: 'radiogroup', 'aria-label': '增补策略' });
  const strategyCards = new Map();
  for (const s of STRATEGIES) {
    const c = el('button', {
      class: 'mode-card', type: 'button', id: `strategy-${s.id}`, name: 'strategy',
      role: 'radio', 'aria-checked': String(strategy === s.id),
      onclick: () => setStrategy(s.id),
    },
      el('span', { class: 'mc-body' },
        el('span', { class: 'mc-title', text: s.title }),
        el('span', { class: 'mc-desc', text: s.desc })),
      el('span', { class: 'mc-check', text: '✓' }),
    );
    strategyCards.set(s.id, c);
    strategyRow.appendChild(c);
  }
  const strategyHint = el('div', { class: 'hint', style: { marginTop: '8px' } });
  function paintStrategies() {
    for (const [id, c] of strategyCards) {
      c.className = `mode-card${id === strategy ? ' active' : ''}`;
      c.setAttribute('aria-checked', String(id === strategy));
    }
    strategyHint.textContent = STRATEGIES.find(s => s.id === strategy)?.desc || '';
  }
  function setStrategy(id) {
    if (!STRATEGIES.some(s => s.id === id)) return;
    strategy = id;
    paintStrategies();
  }

  const augmentCardCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '🧩 已有角色卡' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '必填' }),
    ),
    field({
      label: 'character_card.json',
      control: cardInput,
      id: 'f-card',
      name: 'card',
      hint: '原卡的正则、脚本、扩展、备选开场都会原样保留，只合并世界书条目',
    }),
    cardStatus,
  );

  const strategyCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '增补策略' })),
    strategyRow,
    strategyHint,
  );

  /**
   * 完善指令：用自然语言告诉这次要怎么完善。
   *
   * 指令会拼进**每个抽取步骤**的 prompt，并与「已有卡世界观摘要」一起生效 ——
   * 也就是说"要符合角色卡世界观"这件事不需要用户在指令里反复强调，
   * 抽取阶段已经默认按原卡口径走。
   */
  const instructionInput = el('textarea', {
    id: 'f-instruction', name: 'instruction', rows: '4',
    placeholder: '例如：只把小说里的角色并进已有卡，角色设定要符合原卡世界观；\n'
      + '地图与势力也一并纳入，但沿用原卡已有的地名与势力名。',
  });
  const instructionCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '完善指令（可选）' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '最多 2000 字' }),
    ),
    field({
      label: '这次想怎么完善',
      control: instructionInput,
      id: 'f-instruction',
      name: 'instruction',
      hint: '用自然语言写你的要求，会作为高优先级规则加进每个抽取步骤。'
        + '例如「只要角色，不要地图」「地图势力也要，但沿用原卡地名」。'
        + '留空则只按「符合已有卡世界观」的通用要求抽取。',
    }),
    el('div', { class: 'row tight', style: { flexWrap: 'wrap', gap: '6px', marginTop: '6px' } },
      ...[
        '只合并角色，角色设定必须符合原卡世界观',
        '把地图与势力也合并进去，沿用原卡已有的地名与势力名',
        '角色与世界观都要，新角色不要引入原卡没有的体系',
      ].map(t => el('button', {
        class: 'btn sm ghost', type: 'button', text: t.slice(0, 14) + '…',
        title: t,
        onclick: () => { instructionInput.value = t; },
      }))),
  );

  augmentCards = [augmentCardCard, strategyCard, instructionCard];
  paintStrategies();

  const fileCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '① 输入文件' })),
    field({ label: '小说文本（.txt / .md）', control: novelInput, id: 'f-novel', name: 'novel' }),
    preview,
    (imageField = field({
      label: '插图（可选，第一张作为头像）',
      control: imageInput,
      id: 'f-images',
      name: 'images',
      hint: '',
    })),
    (titleField = field({
      label: '任务标题（可选）',
      control: titleInput,
      id: 'f-title',
      name: 'title',
      hint: '留空则取文件名，用于在任务列表里辨认',
    })),
    field({
      label: '生成档位',
      control: levelSelect,
      id: 'f-detail-level',
      name: 'detailLevel',
      hint: '基础版：与之前一致，token 消耗少。完整版：人物档案字段更全、写得更长、'
        + '世界观条目更细、剧情概要更长 —— 代价是更多 token 与更久时间。',
    }),
    field({
      label: '角色卡版本',
      control: contentModeSelect,
      id: 'f-content-mode',
      name: 'contentMode',
      hint: '普通版：不含任何成人内容，成人字段整段省略。成人版：完整包含成人内容'
        + '（erotic_abilities / 私处细节描写 写具体）。成人版要求出场角色均为成年人；'
        + '资料显示未成年时不会写成人内容。',
    }),
  );

  // ---------- 断点续跑横幅 ----------
  //
  // 从任务库点「继续未完成任务」跳过来时（`?resume=<taskId>`），
  // 这里显式告诉用户"这一次会用哪个任务的批次"，并给一个不续跑的出口。
  // 不做静默续跑：复用批次意味着"这一次不会重跑那些章节"，
  // 用户必须知道自己拿到的不是全新结果。
  const resumeCard = el('div', { class: 'card', style: { display: 'none', borderColor: 'var(--warn)' } });
  async function setupResume(taskId) {
    if (!taskId) { resumeTarget = null; resumeCard.style.display = 'none'; return; }
    let info = null;
    try {
      info = await api.batches(taskId);
    } catch { /* 读不到就当没有可续跑的批次 */ }
    const pending = (info?.batches || []).filter(b => !b.complete).length;
    const total = info?.total || (info?.batches || []).length;
    if (!info || !total) {
      resumeTarget = null;
      resumeCard.style.display = 'none';
      toast('该任务没有已保存的批次，无法续跑', 'warn');
      return;
    }
    resumeTarget = { taskId, total, pending };
    resumeCard.style.display = '';
    clear(resumeCard);
    resumeCard.append(
      el('div', { class: 'card-head' },
        el('h3', { text: '⏯ 断点续跑' }),
        el('span', { class: 'spacer' }),
        el('button', {
          class: 'btn sm ghost', type: 'button', text: '不续跑，重新生成',
          onclick: () => {
            resumeTarget = null;
            clear(resumeCard);
            resumeCard.style.display = 'none';
            toast('已取消续跑，将作为新任务生成', 'warn');
          },
        }),
      ),
      el('div', { class: 'hint', style: { lineHeight: '1.7' } },
        el('div', {}, `本次将复用任务 `, el('code', { text: taskId }), ` 已保存的批次结果。`),
        el('div', {}, `已完成 ${total - pending} / ${total} 批`
          + (pending ? `，剩余 ${pending} 批会继续跑。` : '，全部批次都已完成，本次只会重跑后续步骤。')),
        el('div', { style: { marginTop: '6px', color: 'var(--warn)' } },
          '注意：续跑会沿用原任务的目录与设置。小说文件、章节范围、模型等参数以原任务为准 —— ',
          '换了小说文件也请点「不续跑」。'),
      ),
    );
    toast(`已载入续跑任务：${total - pending}/${total} 批已完成`, 'ok');
  }
  setupResume(params?.resume);

  // ---------- 2. 参数 ----------
  const modeSelect = el('select', { id: 'gen-mode', name: 'userMode' },
    option('auto', '自动判定（推荐）'),
    option('protagonist', '主角 — user 代入原著主角'),
    option('participant', '参与者 — user 进入世界，主角为 NPC'),
    option('observer', '观察者 — user 旁观剧情推进'),
  );
  modeSelect.value = state.config.userMode;

  const paramCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '② 生成参数' })),
    field({
      label: 'user 角色模式',
      control: modeSelect,
      id: 'gen-mode',
      name: 'userMode',
      hint: '主角：当成小说主角 · 参与者：穿越进世界 · 观察者：上帝视角',
    }),
    advancedPanel(),
  );

  function advancedPanel() {
    const nums = [
      ['concurrency', '并发请求数', 1, 8, '越高越快，也越容易触发 API 限流'],
      ['chunkMaxLen', '分块长度（字符）', 1000, 20000, '无章节标记时按此长度切分'],
      ['maxCharacters', '人物条目上限', 1, 40, '为前 N 位角色生成独立档案'],
      ['temperature', '采样温度', 0, 1.5, '越低越稳定，抽取任务建议 0.2–0.4'],
      ['charBatchSize', '档案批量人数', 1, 12, '每次调用为几个角色写档案（1 = 逐个写）'],
    ];
    const wrap = el('details', { class: 'advanced' },
      el('summary', { class: 'hint', style: { cursor: 'pointer', padding: '4px 0' }, text: '▸ 高级参数' }),
    );
    const body = el('div', { style: { paddingTop: '10px' } });
    for (const [key, label, min, max, hint] of nums) {
      const numInput = el('input', {
        type: 'number', min, max, step: key === 'temperature' ? 0.1 : 1,
        value: state.config[key],
      });
      numInput.addEventListener('change', () => {
        const v = Number(numInput.value);
        if (Number.isNaN(v)) return;
        setConfig({ [key]: v });
      });
      body.appendChild(field({ label, control: numInput, id: `gen-opt-${key}`, name: key, hint }));
    }

    /**
     * 合并调用开关（同一段正文只喂一次）。
     *
     * 默认全开 —— 实测能省掉约 43% 的输入字符（见 scripts/compare-merge-usage.mjs）。
     * 但保留开关是因为：合并后的**质量**只能在真实长篇上验证，沙箱里的假 LLM 证明不了
     * "一次抽 4 类"不比"分 4 次抽"差。真实使用中发现某一步产出变差时，
     * 可以只关那一个开关来定位是哪次合并的问题，而不必整体回退。
     */
    const merges = [
      ['mergeChapterCalls', '逐章合并（时间线 + 事件）', '一章正文只发一次，同时抽时间提及与剧情事件'],
      ['mergeWorldCalls', '逐批合并（世界观 + 物品）', '一批正文只发一次，同时抽世界观与物品'],
      ['mergeCharCalls', '档案批量（多角色共享抽样）', '同一份原文节选只发一次，一次写多个角色档案'],
    ];
    for (const [key, label, hint] of merges) {
      const cb = el('input', { type: 'checkbox', checked: state.config[key] !== false });
      cb.addEventListener('change', () => setConfig({ [key]: cb.checked }));
      body.appendChild(field({ label, control: cb, id: `gen-opt-${key}`, name: key, hint }));
    }

    wrap.appendChild(body);
    return wrap;
  }

  // ---------- 3. API ----------
  const baseUrlInput = el('input', { type: 'text', value: state.config.baseUrl, placeholder: 'https://api.deepseek.com/v1' });
  const keyInput = el('input', { type: 'password', value: state.config.apiKey, placeholder: 'sk-...' });
  const modelInput = el('input', { type: 'text', value: state.config.model, placeholder: 'deepseek-chat' });
  for (const i of [baseUrlInput, keyInput]) {
    i.setAttribute('autocomplete', 'off');
    i.setAttribute('autocapitalize', 'off');
    i.setAttribute('spellcheck', 'false');
  }

  // 模型选择：输入框 + 下拉面板，可自由输入、可过滤、可键盘选择
  const modelHint = el('div', { class: 'hint', text: '未拉取候选（可直接输入模型名）' });
  const modelPicker = createModelPicker({
    input: modelInput,
    loadModels: async () => {
      setConfig({
        baseUrl: baseUrlInput.value.trim(),
        apiKey: keyInput.value.trim(),
      });
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
    // endpoint 变了：丢弃上一个服务的候选列表
    modelPicker.invalidate(`${state.config.baseUrl}|${state.config.apiKey}`);
    paintModelHint();
  });
  keyInput.addEventListener('change', () => {
    setConfig({ apiKey: keyInput.value.trim() });
    modelPicker.invalidate(`${state.config.baseUrl}|${state.config.apiKey}`);
    paintModelHint();
  });
  modelInput.addEventListener('change', () => {
    setConfig({ model: modelInput.value.trim() });
    paintModelHint();
  });

  const pingBtn = el('button', {
    class: 'btn sm', type: 'button', text: '测试连接',
    onclick: async () => {
      pingBtn.disabled = true;
      pingBtn.textContent = '测试中…';
      try {
        const r = await api.ping({
          baseUrl: baseUrlInput.value.trim(),
          apiKey: keyInput.value.trim(),
          model: modelInput.value.trim(),
        });
        toast(`连接正常 · ${fmtDuration(r.ms)}`, 'ok');
      } catch (e) {
        toast(e.message, 'error', 5000);
      } finally {
        pingBtn.disabled = false;
        pingBtn.textContent = '测试连接';
      }
    },
  });

  const apiCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '③ API 配置' }),
      el('span', { class: 'spacer' }),
      pingBtn,
    ),
    field({ label: 'Base URL', control: baseUrlInput, id: 'gen-base-url', name: 'baseUrl' }),
    field({ label: 'API Key', control: keyInput, id: 'gen-api-key', name: 'apiKey' }),
    field({
      label: '模型',
      control: modelPicker.wrap,
      id: 'gen-model',
      name: 'model',
      hint: [modelHint],
    }),
    el('div', { class: 'hint', text: 'Key 只在本机使用：浏览器 → 本地服务 → LLM API，不落盘、不上传第三方。' }),
  );

  // ---------- 4. 生成预设 ----------
  const presetCard = buildPresetCard();

  function buildPresetCard() {
    const status = el('div', { class: 'preset-status' });
    const detail = el('div', { class: 'preset-detail' });

    const paint = () => {
      const info = presetInfo();
      const line = statusLine();
      clear(status);
      status.className = `preset-status ${line.tone}`;
      status.appendChild(el('span', { class: 'ps-dot' }));
      status.appendChild(el('span', { text: line.text }));

      clear(detail);
      if (info.active && !info.isEmpty) {
        detail.appendChild(el('div', { class: 'hint', style: { marginBottom: '6px' } },
          info.mode === 'replace'
            ? 'replace 模式：原始抽取指令被替换，下面列出替换来源'
            : 'append 模式：以下后缀追加到对应 Step 的 prompt 末尾'));
        for (const l of info.lines) {
          detail.appendChild(el('div', { class: 'preset-line', text: `· ${l}` }));
        }
        detail.appendChild(el('div', { class: 'row tight', style: { marginTop: '8px' } },
          el('button', {
            class: 'btn sm ghost', type: 'button', text: '预览实际 prompt',
            onclick: () => openPreview(),
          })));
      }
    };

    // 导入 / 导出 / 复制 / 清空
    const importBtn = el('button', {
      class: 'btn sm', type: 'button', text: '导入预设',
      onclick: async () => {
        const r = await importPresetFromFile();
        if (r.ok) {
          if (needsReplaceConfirm()) {
            // 导入即提示风险，但不回滚：用户可自行改回 append
            toast('该预设是 replace 模式，生成前会再次确认', 'warn', 5000);
          }
          editor.value = currentPresetText();
          paint();
        }
      },
    });

    const exportBtn = el('button', {
      class: 'btn sm', type: 'button', text: '导出当前预设',
      onclick: () => exportPreset(),
    });

    const copyBtn = el('button', {
      class: 'btn sm ghost', type: 'button', text: '复制 JSON',
      onclick: () => copyPreset(),
    });

    const clearBtn = el('button', {
      class: 'btn sm ghost', type: 'button', text: '清空',
      onclick: () => {
        if (!currentPreset()) return toast('当前没有预设', 'warn');
        if (!confirm('清空当前预设？')) return;
        clearPreset({ silent: true });
        editor.value = '';
        paint();
        toast('已清空预设', 'warn');
      },
    });

    const exampleBtn = el('button', {
      class: 'btn sm ghost', type: 'button', text: '填入示例',
      onclick: () => {
        editor.value = JSON.stringify(EXAMPLE_PRESET, null, 2);
        toast('已填入示例，改成你自己的内容后点「应用编辑」', 'ok', 4000);
      },
    });

    // 编辑器
    const editor = el('textarea', {
      id: 'preset-editor',
      name: 'presetJson',
      rows: 12,
      spellcheck: 'false',
      placeholder: '{"name":"...","mode":"append","steps":{"step2":{"system_suffix":"..."}}}',
      style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '12px' },
    });
    editor.value = currentPresetText();

    const editorMsg = el('div', { class: 'hint', id: 'preset-editor-msg', style: { minHeight: '18px' } });

    const validateEditor = (apply) => {
      const text = editor.value.trim();
      if (!text) {
        clearPreset({ silent: true });
        editorMsg.textContent = '已清空';
        editorMsg.style.color = 'var(--text-mute)';
        paint();
        return;
      }
      const v = validatePreset(text);
      if (!v.ok) {
        editorMsg.textContent = `✗ ${v.errors.join('；')}`;
        editorMsg.style.color = 'var(--danger)';
        return;
      }
      const warn = v.warnings.length ? `（${v.warnings.length} 条提示：${v.warnings[0]}）` : '';
      editorMsg.textContent = `✓ 合法：${v.stats.name} · ${v.stats.mode} · ${v.stats.stepCount} 个 Step 配置 ${warn}`;
      editorMsg.style.color = v.warnings.length ? 'var(--warn)' : 'var(--ok)';
      if (apply) {
        setPreset(text, { silent: true });
        toast(`已应用预设「${v.stats.name}」`, v.preset.mode === 'replace' ? 'warn' : 'ok');
        paint();
      }
    };

    editor.addEventListener('input', debounce(() => validateEditor(false), 400));

    const applyBtn = el('button', {
      class: 'btn sm primary', type: 'button', text: '应用编辑',
      onclick: () => validateEditor(true),
    });

    const card = el('div', { class: 'card' },
      el('div', { class: 'card-head' },
        el('h3', { text: '④ 生成预设' }),
        el('span', { class: 'spacer' }),
        el('span', { class: 'hint', text: '仅影响生成过程，不改动产物格式' }),
      ),
      el('div', { class: 'row tight', style: { marginBottom: '10px' } },
        importBtn, exportBtn, copyBtn, exampleBtn, clearBtn),
      status,
      detail,
      el('details', { style: { marginTop: '10px' } },
        el('summary', { class: 'hint', style: { cursor: 'pointer' }, text: '▸ 查看 / 编辑预设 JSON' }),
        el('div', { style: { marginTop: '10px' } },
          field({ label: '预设 JSON', control: editor, id: 'preset-editor', name: 'presetJson', hideLabel: true }),
          editorMsg,
          el('div', { class: 'row', style: { marginTop: '8px' } }, applyBtn,
            el('span', { class: 'hint', text: '编辑后需点「应用编辑」才生效；也可直接粘贴别人的预设' })),
        ),
      ),
      el('div', { class: 'hint hint-combo', style: { marginTop: '10px' } },
        '预设按 Step 区分（step0.5 / step1 … step5）：每个 Step 的任务差异很大，一套附加提示会污染其他 Step。'),
    );

    on('preset', () => {
      const text = currentPresetText();
      if (editor.value.trim() !== text.trim()) editor.value = text;
      paint();
    });

    paint();
    return card;
  }

  /** 预览某个 Step 的最终 prompt（走后端真实基线，保证与运行时一致） */
  async function openPreview() {
    const p = currentPreset();
    if (!p) return toast('当前没有预设', 'warn');
    const body = el('div', {});
    const mask = el('div', {
      class: 'palette-mask',
      onclick: (e) => { if (e.target === mask) mask.remove(); },
    }, el('div', { class: 'palette', style: { width: 'min(860px, 94vw)' } },
      el('div', { class: 'palette-input' },
        el('span', { class: 'chev', text: '👁' }),
        el('span', { style: { flex: '1', fontSize: '14px' }, text: `预设预览 · ${p.name || '未命名'}（${presetMode(p)}）` }),
        el('button', { class: 'btn sm', type: 'button', text: '关闭', onclick: () => mask.remove() }),
      ),
      body,
    ));
    document.body.appendChild(mask);

    const select = el('select', { id: 'preset-preview-step', name: 'presetPreviewStep' },
      STEP_NAMES.map(n => el('option', { value: n }, `${n} — ${STEP_LABELS[n]}`)));
    select.value = 'step2';

    const out = el('div', { style: { padding: '14px' } });
    body.append(
      el('div', { style: { padding: '12px 14px 0' } },
        field({ label: '预览 Step', control: select, id: 'preset-preview-step', name: 'presetPreviewStep' })),
      out,
    );

    /** 渲染某个 Step 的最终 prompt（走后端真实基线，保证与运行时一致） */
    const renderPreview = async () => {
      clear(out);
      out.appendChild(el('div', { class: 'hint' }, el('span', { class: 'spin' }), ' 读取中…'));
      try {
        const r = await api.presetPreview({ preset: p, step: select.value });
        clear(out);
        out.appendChild(el('div', { class: 'row tight', style: { marginBottom: '10px' } },
          el('span', { class: `tag ${r.changed ? 'ok' : ''}`, text: r.changed ? '预设已生效' : '该 Step 未受影响' }),
          el('span', { class: 'tag', text: `mode: ${r.mode}` }),
          r.warnings?.length ? el('span', { class: 'tag warn', text: `${r.warnings.length} 条提示` }) : null,
        ));
        out.appendChild(el('div', { class: 'hint', style: { marginBottom: '4px' }, text: 'system（上方为内置指令，--- 之后为你的后缀）' }));
        out.appendChild(el('pre', { class: 'code', style: { maxHeight: '260px' }, text: r.system }));
        out.appendChild(el('div', { class: 'hint', style: { margin: '10px 0 4px' }, text: 'user' }));
        out.appendChild(el('pre', { class: 'code', style: { maxHeight: '180px' }, text: r.user }));
      } catch (e) {
        clear(out);
        out.appendChild(el('div', { class: 'hint', style: { color: 'var(--danger)' }, text: `预览失败：${e.message}` }));
      }
    };

    select.addEventListener('change', renderPreview);
    renderPreview();
  }

  // ---------- 操作按钮绑定 ----------
  startBtn.addEventListener('click', () => runGenerate());
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    await run.cancel();
    cancelBtn.disabled = false;
    toast('已中止任务', 'warn');
  });
  pauseBtn.addEventListener('click', async () => {
    pauseBtn.disabled = true;
    const r = await run.pause();
    pauseBtn.disabled = false;
    if (!r.ok) toast(r.error || '暂停失败', 'danger');
    else toast('已请求暂停，会在当前批次结束后停下', 'warn');
  });
  resumeBtn.addEventListener('click', async () => {
    resumeBtn.disabled = true;
    const r = await run.resume();
    resumeBtn.disabled = false;
    if (!r.ok) toast(r.error || '继续失败', 'danger');
    else toast('已继续', 'ok');
  });
  detachBtn.addEventListener('click', () => {
    run.detach();
    toast('已转入后台，可随时回到本页查看进度', 'ok');
  });

  left.append(resumeCard, genModeCard, augmentCardCard, strategyCard, modeCardEl, fileCard, chapterCard, paramCard, apiCard, presetCard,
    el('div', { class: 'row', style: { gap: '8px' } },
      el('div', { style: { flex: '1' } }, startBtn),
      el('div', { style: { flex: '0 0 110px' } }, pauseBtn),
      el('div', { style: { flex: '0 0 110px' } }, resumeBtn),
      el('div', { style: { flex: '0 0 120px' } }, cancelBtn)),
    el('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '-6px' } },
      detachBtn,
      el('span', { class: 'hint' }, '底栏输入 ', el('code', { text: 'gen' }), ' 也能启动')),
  );

  // ============================================================
  // 右栏：进度（完全由 active-run 的持久状态渲染，切页回来也能恢复）
  // ============================================================
  const stepList = el('div', { class: 'steps' });
  const bar = el('i');
  const progressPct = el('span', { class: 'hint mono', text: '待开始' });
  const timer = el('span', { class: 'hint mono', text: '00:00' });
  const stateTag = el('span', { class: 'tag', id: 'gen-state-tag', text: '未开始' });
  const taskLine = el('div', { class: 'hint mono', style: { marginBottom: '10px' } });
  // 分批进度：长篇有十几批，只看总百分比看不出还剩多少
  const batchLine = el('div', { class: 'batch-line', style: { display: 'none' } });
  const batchBarFill = el('i');
  const logBox = el('div', { class: 'log' });
  const resultBox = el('div', { style: { display: 'none' } });

  const progressCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '生成进度' }),
      stateTag,
      el('span', { class: 'spacer' }),
      timer,
    ),
    el('div', { class: 'bar', style: { marginBottom: '8px' } }, bar),
    el('div', { class: 'row', style: { marginBottom: '10px' } }, progressPct),
    batchLine,
    taskLine,
    stepList,
    el('details', { style: { marginTop: '14px' } },
      el('summary', { class: 'hint', style: { cursor: 'pointer' }, text: '▸ 原始日志' }),
      el('div', { style: { marginTop: '8px' } }, logBox)),
    resultBox,
  );
  right.appendChild(progressCard);

  // 步骤骨架（只建一次，之后只改状态）
  const stepNodes = new Map();
  for (const s of STEPS) {
    const node = el('div', { class: 'step' },
      el('div', { class: 'mark', text: '·' }),
      el('div', { class: 'body' },
        el('div', { class: 'row tight' },
          el('span', { class: 'title', text: s.label }),
          el('span', { class: 't', text: '' }),
        ),
        el('div', { class: 'msg', text: s.desc }),
      ),
    );
    stepNodes.set(s.key, node);
    stepList.appendChild(node);
  }

  const MARK = { done: '✓', active: '●', error: '✗', warn: '!', pending: '·' };

  /** 计时器：由 startedAt 推算，切换页面后依然正确 */
  let clockTimer = null;
  function paintClock() {
    const d = run.derive();
    if (!d.task?.startedAt) { timer.textContent = '00:00'; return; }
    const end = d.running ? Date.now() : (d.meta?.finishedAt ? +new Date(d.meta.finishedAt) : Date.now());
    const ms = Math.max(0, end - d.task.startedAt);
    const s = Math.floor(ms / 1000);
    timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }
  function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(paintClock, 1000);
    onCleanup(() => { clearInterval(clockTimer); clockTimer = null; });
  }

  /** 全量渲染：状态 → DOM。幂等，随时可重复调用 */
  function paint() {
    const d = run.derive();

    // 状态标签
    const tagMap = {
      idle: ['未开始', ''],
      running: ['生成中', 'ok'],
      done: ['已完成', 'ok'],
      error: ['失败', 'danger'],
      cancelled: ['已取消', 'warn'],
    };
    const [tagText, tagCls] = tagMap[d.status] || tagMap.idle;
    stateTag.className = `tag ${tagCls}`;
    stateTag.textContent = tagText;

    // 进度条（单调用 Math.max 保证只增不减）
    const ratio = Math.max(0, Math.min(1, d.progress || 0));
    bar.style.width = `${ratio * 100}%`;
    progressPct.textContent = d.status === 'idle' ? '待开始' : `${Math.round(ratio * 100)}%`;

    // 分批进度（只在真的有批次信息时出现；短篇只有 1 批也照常显示）
    const b = d.batch;
    if (b && b.total > 0) {
      const idx = Math.min((b.index ?? 0) + 1, b.total);
      batchLine.style.display = '';
      clear(batchLine);
      batchLine.append(
        el('div', { class: 'batch-head' },
          el('span', { class: 'batch-label', text: `批次 ${idx} / ${b.total}` }),
          el('span', { class: 'hint', text: b.done ? '已完成' : '进行中' }),
          el('span', { class: 'spacer' }),
          el('span', { class: 'hint mono', text: `${b.chapters ?? 0} 章 · ${((b.chars ?? 0) / 10000).toFixed(1)} 万字` }),
        ),
        el('div', { class: 'bar thin' },
          (() => {
            batchBarFill.style.width = `${Math.round((b.done ? idx : idx - 1) / b.total * 100)}%`;
            return batchBarFill;
          })()),
      );
    } else {
      batchLine.style.display = 'none';
      clear(batchLine);
    }

    // 任务信息行
    clear(taskLine);
    if (d.task?.taskId) {
      taskLine.append(
        el('span', { text: d.task.taskId }),
        d.task.model ? el('span', { text: ` · ${d.task.model}` }) : null,
        d.running ? el('span', { text: ' · 可离开本页，任务会继续' }) : null,
      );
    } else {
      taskLine.append(el('span', { class: 'hint', text: '还没有开始生成' }));
    }

    // 步骤状态
    for (const s of STEPS) {
      const node = stepNodes.get(s.key);
      const st = d.steps.get(s.key);
      const cls = st?.status || 'pending';
      node.className = `step ${cls === 'pending' ? '' : cls}`;
      node.querySelector('.mark').textContent = MARK[cls] || '·';
      node.querySelector('.msg').textContent = st?.msg || s.desc;
      node.querySelector('.t').textContent = st?.ts && d.task?.startedAt
        ? fmtDuration(Math.max(0, st.ts - d.task.startedAt))
        : '';
    }

    // 日志（整块重建，保证与事件流一致）
    clear(logBox);
    for (const l of d.logs) {
      logBox.appendChild(el('div', { class: `log-line ${l.kind}` },
        el('span', { class: 'ts', text: fmtTime(l.ts) }),
        el('span', { class: 'step-tag', text: `[${l.step}]` }),
        el('span', { class: 'txt', text: l.msg }),
      ));
    }
    logBox.scrollTop = logBox.scrollHeight;

    // 按钮
    startBtn.disabled = d.running;
    startBtn.textContent = d.running ? '生成中…' : '▶ 开始生成';
    cancelBtn.style.display = d.running ? 'block' : 'none';
    detachBtn.style.display = d.running ? 'block' : 'none';
    // 暂停 / 继续只对分批评析有意义，但短篇任务点了也只是白点一下，
    // 所以不做"是否分批"的判断 —— 少一个会跟服务端状态不同步的开关。
    pauseBtn.style.display = d.running && !d.paused ? 'block' : 'none';
    resumeBtn.style.display = d.running && d.paused ? 'block' : 'none';
    pauseBtn.disabled = !!d.pausing;
    pauseBtn.textContent = d.pausing ? '暂停中…' : '⏸ 暂停';

    // 暂停时状态标签也换掉，否则看不出"停了但没结束"
    if (d.status === 'running' && (d.paused || d.pausing)) {
      stateTag.className = 'tag warn';
      stateTag.textContent = d.paused ? '已暂停' : '暂停中…';
    }

    // 计时
    if (d.running) startClock(); else paintClock();

    // 结果区
    if (d.files?.length && d.task?.taskId) showResult(d.task.taskId, d.files, d.meta);
    else if (!d.files?.length) { clear(resultBox); resultBox.style.display = 'none'; }
  }

  function showResult(taskId, files, meta) {
    clear(resultBox);
    resultBox.style.display = 'block';
    resultBox.appendChild(el('div', { class: 'card-head', style: { marginTop: '16px' } },
      el('h3', { text: meta ? '✓ 生成完成' : '任务已结束' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm primary', type: 'button', text: '↓ 打包下载',
        onclick: () => download(api.zipUrl(taskId), `${taskId}.zip`),
      }),
      el('button', {
        class: 'btn sm', type: 'button', text: '查看产物',
        onclick: () => navigate('/library', { task: taskId }),
      }),
    ));

    /**
     * 变更总结：直接回答"增加了什么、改了哪些地方"。
     *
     * 优先用 SSE `files` 事件里带回来的结构化总结（本次运行的真实数据，
     * 不必再请求一次）；没有就向后端要 —— 这样刷新页面、或看历史任务也有总结。
     */
    const summaryHost = el('div', { class: 'sum-host' });
    resultBox.appendChild(summaryHost);
    const inline = run.snapshot()?.summary;
    if (inline) {
      summaryHost.appendChild(renderSummaryPanel(inline));
    } else {
      summaryHost.appendChild(el('div', { class: 'hint', text: '正在读取总结…' }));
      api.summary(taskId).then((r) => {
        clear(summaryHost);
        if (r?.summary) summaryHost.appendChild(renderSummaryPanel(r.summary));
      }).catch(() => {
        clear(summaryHost);
        summaryHost.appendChild(el('div', { class: 'hint', text: '（总结读取失败，不影响产物）' }));
      });
    }

    if (meta?.counts) {
      resultBox.appendChild(el('div', { class: 'row', style: { marginBottom: '10px' } },
        el('span', { class: 'tag ok', text: `${meta.counts.chapters} 块` }),
        el('span', { class: 'tag', text: `${meta.counts.events} 事件` }),
        el('span', { class: 'tag', text: `${meta.counts.phases} 阶段` }),
        el('span', { class: 'tag', text: `${meta.counts.characters} 人物` }),
        el('span', { class: 'tag info', text: `A ${meta.tokens.a} / B ${meta.tokens.b} tok` }),
      ));
      if (meta.warnings?.length) {
        resultBox.appendChild(el('div', { style: { marginBottom: '8px' } },
          meta.warnings.map(w => el('div', { class: 'warn-item', text: `⚠ ${w}` }))));
      }
    }
    if (meta?.preset) {
      resultBox.appendChild(el('div', { class: 'hint', style: { marginBottom: '8px' } },
        `使用预设「${meta.preset.name || '未命名'}」（${meta.preset.mode}）`));
    }
    // 产物：完整角色卡放最上面并高亮，其余按原顺序排
    const PRIMARY = {
      'character_card.json': {
        name: '完整角色卡（推荐）',
        desc: '导入 SillyTavern 一次即可，内含世界书、变量、更新规则、正则',
        highlight: true,
      },
      'worldbook.json': { name: '世界书（高级）', desc: '仅世界书部分，需配合预设片段使用' },
      'preset_fragment.json': { name: '预设片段（高级）', desc: '酒馆助手预设片段，需手动粘贴' },
      'README.md': { name: '导入说明', desc: '各产物的用途与导入步骤' },
    };
    const ordered = [
      ...files.filter(f => f === 'character_card.json'),
      ...files.filter(f => f !== 'character_card.json'),
    ];

    const grid = el('div', { class: 'file-grid' });
    for (const f of ordered) {
      const meta2 = PRIMARY[f] || {};
      const highlight = !!meta2.highlight;
      const title = meta2.name || f;
      const desc = meta2.desc || '';

      // 高亮卡片做成带说明的大卡片，其余保持紧凑
      const chip = el('div', {
        class: `file-chip${highlight ? ' primary' : ''}`,
        role: 'button',
        tabindex: '0',
        title: `下载 ${f}`,
        onclick: () => download(api.downloadUrl(taskId, f), f),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); download(api.downloadUrl(taskId, f), f); }
        },
      },
        el('span', { class: 'fi', text: iconFor(f) }),
        el('span', { class: 'fc-body' },
          el('span', { class: 'fn', text: highlight ? title : f }),
          desc ? el('span', { class: 'fdesc', text: desc }) : null,
          highlight ? el('span', { class: 'fname', text: f }) : null,
        ),
        el('span', { class: 'fdl', text: '↓' }),
      );
      grid.appendChild(chip);
    }
    resultBox.appendChild(grid);
  }

  // ============================================================
  // 生成逻辑（命令层调用同一实现）
  // ============================================================
  registerGenerate(async function doGenerate() {
    if (run.isRunning()) {
      toast('已有任务在运行，可切到任何页面查看进度', 'warn');
      return false;
    }
    const novel = novelInput.files?.[0] || lastNovel;
    if (!novel) {
      toast('请先选择小说文件', 'error');
      navigate('/generate');
      return false;
    }
    const baseUrl = baseUrlInput.value.trim();
    const apiKey = keyInput.value.trim();
    const model = modelInput.value.trim();
    if (!baseUrl || !model) {
      toast('请填写 Base URL 与模型名', 'error');
      return false;
    }
    setConfig({ baseUrl, apiKey, model, userMode: modeSelect.value });

    // 预设：替换模式会覆盖内置抽取指令，必须让用户明确确认
    const preset = currentPreset();
    if (preset && !confirmReplace(preset)) {
      toast('已取消：未使用 replace 预设', 'warn');
      return false;
    }

    const augmenting = genMode === 'augment';
    if (augmenting) {
      const cf = cardInput.files?.[0] || lastCardFile;
      if (!cf) {
        toast('请先选择已有的 character_card.json', 'error');
        return false;
      }
    }

    const fd = new FormData();
    fd.append('novel', novel);
    if (augmenting) fd.append('card', cardInput.files?.[0] || lastCardFile);
    for (const img of imageInput.files || []) fd.append('images', img);
    fd.append('baseUrl', baseUrl);
    fd.append('apiKey', apiKey);
    fd.append('model', model);
    fd.append('userMode', modeSelect.value);
    fd.append('outputMode', outputMode);
    // 章节范围：两个模式共用同一个值（都由共用的章节组件产出）
    fd.append('chapterRange', chapterSelector.getRange());
    if (augmenting) fd.append('strategy', strategy);
    if (augmenting) {
      // 完善指令：会拼进每个抽取步骤的 prompt（服务端限 2000 字）
      const inst = instructionInput.value.trim();
      if (inst.length > 2000) {
        toast(`完善指令过长（${inst.length} 字，上限 2000 字）`, 'error');
        return false;
      }
      if (inst) fd.append('instruction', inst);
    }
    // 断点续跑：带上原任务 ID，服务端会（且只会）复用它 batches/ 下已完成的批次。
    // 不传时服务端照常新建任务目录，不会碰到任何旧批次。
    if (!augmenting && resumeTarget?.taskId) fd.append('resumeTaskId', resumeTarget.taskId);
    fd.append('title', titleInput.value.trim() || novel.name.replace(/\.[^.]+$/, ''));
    // 生成档位：basic / full（完善已有卡的路径不用它，那是另一套逻辑）
    fd.append('detailLevel', levelSelect.value === 'full' ? 'full' : 'basic');
    // 角色卡版本：general（默认）/ adult
    fd.append('contentMode', contentModeSelect.value === 'adult' ? 'adult' : 'general');
    fd.append('limits', JSON.stringify(state.config.limits));
    if (preset) fd.append('preset', JSON.stringify(preset));
    fd.append('options', JSON.stringify({
      concurrency: state.config.concurrency,
      chunkMaxLen: state.config.chunkMaxLen,
      maxCharacters: state.config.maxCharacters,
      temperature: state.config.temperature,
      worldProbeChars: state.config.worldProbeChars,
      charProbeChars: state.config.charProbeChars,
      // 分批评析参数（设置页可改；缺省时服务端用 10 章 / 3 万字）
      batchChapters: state.config.batchChapters,
      batchChars: state.config.batchChars,
      // 合并调用开关（默认全开）：同一段正文只喂一次
      mergeChapterCalls: state.config.mergeChapterCalls !== false,
      mergeWorldCalls: state.config.mergeWorldCalls !== false,
      mergeCharCalls: state.config.mergeCharCalls !== false,
      charBatchSize: state.config.charBatchSize,
    }));

    state.lastRun = {
      title: titleInput.value.trim(),
      fileName: novel.name,
      userMode: modeSelect.value,
      outputMode,
      genMode,
      chapterRange: chapterSelector.getRange(),
    };

    // 先把本地已知的标题/模型写进状态，服务端返回 start 后再补 taskId
    run.setTaskInfo({
      title: augmenting
        ? `完善：${(lastCardFile?.name || '').replace(/\.json$/i, '') || '已有角色卡'}`
        : (titleInput.value.trim() || novel.name.replace(/\.[^.]+$/, '')),
      model,
    });

    // 两个模式共用同一套 run.start（持久状态、切页不丢、可转入后台），
    // 只是 endpoint 不同：/api/generate 与 /api/augment 的 SSE 事件格式一致
    const r = await run.start(fd, { endpoint: augmenting ? '/api/augment' : '/api/generate' });
    if (!r.ok) {
      toast(r.error || '启动失败', 'error');
      return false;
    }
    // 续跑目标用完即清：否则用户改完文件再点一次「开始生成」，
    // 会再次复用上一次的批次，而那已经不是他想要的了。
    if (resumeTarget) {
      resumeTarget = null;
      resumeCard.style.display = 'none';
      navigate('/generate');
    }
    paint();
    return true;
  });

  // ============================================================
  // 挂载：重建 UI + 订阅后续变化；离开页面只退订，流继续
  // ============================================================
  paintModes();                       // 初始化输出模式按钮高亮与按钮文案
  paintGenModes();                    // 初始化任务模式高亮 + 增补专属卡片显隐
  const unsubscribe = run.subscribe(() => paint());
  onCleanup(unsubscribe);

  // 若当前已有任务（包括刷新后从服务端恢复的），先对齐再渲染
  const active = run.currentTaskId();
  if (active) await run.attach(active);
  paint();

  // 从任意页面跳回来看进度时，自动展开日志更省事
  if (run.isRunning()) startClock();

  // 页面被销毁时清理监听
  onCleanup(() => document.removeEventListener('dsh:route-leave', cleanupHandler));
}

function option(value, label) {
  return el('option', { value }, label);
}

function iconFor(name) {
  if (name.endsWith('.json')) return '⬡';
  if (name.endsWith('.md')) return '📄';
  if (/\.(png|jpg|jpeg|webp|gif)$/i.test(name)) return '🖼';
  return '📄';
}
