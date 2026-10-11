/** 设置页：API、生成参数、外观、数据与系统信息 */

import { el, clear, fmtDuration, download, field } from '../core/dom.js';
import { api } from '../core/api.js';
import { state, setConfig, setUI, toast, applyTheme } from '../core/store.js';
import { emit } from '../core/store.js';
import { createModelPicker } from '../core/model-picker.js';

const PRESETS = [
  { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-72B-Instruct' },
  { label: 'Ollama（本地）', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b' },
];

export async function renderSettings(mount) {
  const page = el('div', { class: 'page' });
  mount.appendChild(page);

  // ============================================================
  // API 配置
  // ============================================================
  const baseUrl = input('text', state.config.baseUrl, 'https://api.deepseek.com/v1');
  const apiKey = input('password', state.config.apiKey, 'sk-...');
  const model = input('text', state.config.model, 'deepseek-chat');

  // 技术类输入框关掉浏览器的自动更正/记忆，避免被塞进奇怪的值
  for (const i of [baseUrl, apiKey]) {
    i.setAttribute('autocomplete', 'off');
    i.setAttribute('autocapitalize', 'off');
    i.setAttribute('spellcheck', 'false');
  }

  // 模型选择：输入框 + 下拉面板（可过滤、可键盘操作、有加载/失败状态）
  const modelPicker = createModelPicker({
    input: model,
    loadModels: async () => {
      saveApi();
      const r = await api.models({ baseUrl: state.config.baseUrl, apiKey: state.config.apiKey });
      return r.models || [];
    },
    onPick: () => saveApi(),
    emptyHint: '还没有候选列表',
  });

  const saveApi = () => {
    setConfig({
      baseUrl: baseUrl.value.trim().replace(/\/+$/, ''),
      apiKey: apiKey.value.trim(),
      model: model.value.trim(),
    });
  };
  // endpoint 变了就丢弃旧候选，避免拿着上一个服务的模型列表
  const syncPicker = () => {
    saveApi();
    modelPicker.invalidate(`${state.config.baseUrl}|${state.config.apiKey}`);
  };
  baseUrl.addEventListener('change', syncPicker);
  apiKey.addEventListener('change', syncPicker);
  model.addEventListener('change', saveApi);

  const pingBtn = el('button', {
    class: 'btn', type: 'button', text: '测试连接',
    onclick: async () => {
      saveApi();
      pingBtn.disabled = true;
      pingBtn.textContent = '测试中…';
      try {
        const r = await api.ping({
          baseUrl: state.config.baseUrl, apiKey: state.config.apiKey, model: state.config.model,
        });
        const name = state.config.model || r.model;
        toast(`✓ 连接正常 · ${name} · ${fmtDuration(r.ms)}`, 'ok', 4000);
        if (r.warn) paintUrlWarn(r.warn);
      } catch (e) {
        toast(`✗ ${e.message}`, 'error', 6000);
        if (e.data?.warn) paintUrlWarn(e.data.warn);
      } finally {
        pingBtn.disabled = false;
        pingBtn.textContent = '测试连接';
      }
    },
  });

  const listBtn = el('button', {
    class: 'btn', type: 'button', text: '拉取模型列表',
    onclick: async () => {
      saveApi();
      listBtn.disabled = true;
      listBtn.textContent = '拉取中…';
      try {
        const n = await modelPicker.load();
        if (modelPicker.status === 'error') {
          toast(modelPicker.error || '拉取失败', 'error', 6000);
        } else {
          toast(`找到 ${n} 个模型，点输入框右侧箭头即可选择`, 'ok');
        }
      } catch (e) {
        toast(e.message, 'error', 6000);
      } finally {
        listBtn.disabled = false;
        listBtn.textContent = '拉取模型列表';
      }
      statusHint.textContent = modelPicker.summary();
      statusHint.style.color = modelPicker.status === 'error' ? 'var(--danger)'
        : modelPicker.status === 'ready' ? 'var(--ok)' : 'var(--text-mute)';
    },
  });

  const statusHint = el('div', { class: 'hint', text: modelPicker.summary() });
  /** Base URL 配置提示（例如漏写 /v1），由接口返回或本地判断 */
  const urlWarn = el('div', { class: 'hint', style: { display: 'none', whiteSpace: 'pre-line' } });

  /** 只做本地形状检查，不发请求：漏写 /v1 是最常见的坑 */
  function paintUrlWarn(extra) {
    const raw = baseUrl.value.trim();
    let msg = extra || '';
    if (!msg && raw) {
      try {
        const u = new URL(raw);
        if (!u.pathname.replace(/\/+$/, '')) {
          msg = `当前地址没有路径段，请求会发到 ${u.origin}/chat/completions\n`
            + `多数服务需要以 /v1 结尾，例如：${u.origin}/v1`;
        }
      } catch {
        msg = `Base URL 不是合法地址：${raw}`;
      }
    }
    if (msg) {
      urlWarn.textContent = `⚠ ${msg}`;
      urlWarn.style.display = '';
      urlWarn.style.color = 'var(--warn)';
    } else {
      urlWarn.style.display = 'none';
    }
  }
  baseUrl.addEventListener('input', () => paintUrlWarn());
  paintUrlWarn();

  const presetRow = el('div', { class: 'row tight', style: { marginBottom: '12px' } },
    el('span', { class: 'hint', text: '快速填充：' }),
    ...PRESETS.map(p => el('button', {
      class: 'btn sm ghost', type: 'button', text: p.label,
      onclick: () => {
        baseUrl.value = p.baseUrl;
        model.value = p.model;
        saveApi();
        modelPicker.invalidate(`${p.baseUrl}|${state.config.apiKey}`);
        statusHint.textContent = modelPicker.summary();
        statusHint.style.color = 'var(--text-mute)';
        toast(`已填入 ${p.label} 配置`, 'ok');
      },
    })),
  );

  page.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: 'API 配置' })),
    presetRow,
    field({
      label: 'Base URL',
      control: baseUrl,
      id: 'api-base-url',
      name: 'baseUrl',
      hint: [
        '兼容 OpenAI 格式即可：DeepSeek / OpenAI / 硅基流动 / Ollama / LM Studio',
        urlWarn,
      ],
    }),
    field({
      label: 'API Key',
      control: apiKey,
      id: 'api-key',
      name: 'apiKey',
      hint: '只保存在本机浏览器 localStorage，仅通过本地服务转发给 LLM API。本地模型可留空。',
    }),
    field({
      label: '模型名',
      control: modelPicker.wrap,
      id: 'api-model',
      name: 'model',
      hint: [statusHint],
    }),
    el('div', { class: 'row', style: { marginTop: '6px' } }, pingBtn, listBtn),
  ));

  // ============================================================
  // 生成参数
  // ============================================================
  const paramCard = el('div', { class: 'card' },
    el('div', { class: 'card-head' },
      el('h3', { text: '生成参数' }),
      el('span', { class: 'spacer' }),
      el('button', {
        class: 'btn sm ghost', type: 'button', text: '恢复默认',
        onclick: () => {
          setConfig({
            userMode: 'auto', concurrency: 3, chunkMaxLen: 6000, maxCharacters: 15,
            worldProbeChars: 15000, charProbeChars: 10000, temperature: 0.3,
            batchChapters: 10, batchChars: 30000,
            // 合并调用开关的默认值：全开、每组 6 人
            mergeChapterCalls: true, mergeWorldCalls: true, mergeCharCalls: true, charBatchSize: 6,
            limits: { maxA: 2000, maxB: 3500 },
          });
          toast('已恢复默认参数', 'ok');
          location.reload();
        },
      }),
    ),
  );

  const modeSelect = el('select', { id: 'gen-user-mode', name: 'userMode' });
  for (const [v, label] of [
    ['auto', '自动判定（推荐）'],
    ['protagonist', '主角 — user 代入原著主角'],
    ['participant', '参与者 — user 进入世界，主角为 NPC'],
    ['observer', '观察者 — user 旁观剧情推进'],
  ]) modeSelect.appendChild(el('option', { value: v }, label));
  modeSelect.value = state.config.userMode;
  modeSelect.addEventListener('change', () => setConfig({ userMode: modeSelect.value }));
  paramCard.appendChild(field({
    label: 'user 角色模式',
    control: modeSelect,
    id: 'gen-user-mode',
    name: 'userMode',
    hint: '决定 B3/B5-2 的推进规则与变量树中的 user 命名空间',
  }));

  const numFields = [
    ['concurrency', '并发请求数', 1, 8, 1, '同时发起的 LLM 请求数；越高越快，但容易触发限流'],
    ['temperature', '采样温度', 0, 1.5, 0.1, '抽取类任务建议 0.2–0.4，过高会导致 JSON 不合法'],
    ['chunkMaxLen', '分块长度（字符）', 1000, 20000, 500, '无章节标记时按此长度切块'],
    ['maxCharacters', '人物条目上限', 1, 40, 1, '为时间线中前 N 位角色生成独立档案'],
    ['worldProbeChars', '世界观抽样字符数', 2000, 40000, 1000, '送进世界观抽取的原文长度'],
    ['charProbeChars', '人物抽样字符数', 2000, 40000, 1000, '每个角色送进抽取的原文长度'],
    // 分批评析：长篇按批抽取，逐批落盘。两个上限先到者为准。
    ['batchChapters', '每批章节数', 1, 50, 1, '长篇每批最多处理多少章；越小越省上下文，但批次更多'],
    ['batchChars', '每批字数上限', 3000, 200000, 1000, '每批最多多少字，与章节数先到者为准'],
    // 合并调用：同一段正文只喂一次。实测省约 43% 输入字符。
    ['charBatchSize', '档案批量人数', 1, 12, 1, '每次调用为几个角色写档案（1 = 逐个写，最费 token）'],
  ];
  const numRow = el('div', { class: 'grid cols-2' });
  for (const [key, label, min, max, step, hint] of numFields) {
    const i = input('number', state.config[key]);
    i.min = min; i.max = max; i.step = step;
    i.addEventListener('change', () => {
      const v = Number(i.value);
      if (Number.isNaN(v)) return;
      setConfig({ [key]: Math.min(max, Math.max(min, v)) });
      i.value = state.config[key];
    });
    numRow.appendChild(field({ label, control: i, id: `gen-${key}`, name: key, hint }));
  }
  paramCard.appendChild(numRow);

  /**
   * 合并调用开关（同一段正文只喂一次）。
   *
   * 默认全开：实测同一部 30 章小说输入字符 479,567 → 271,698（省 43.3%），
   * 请求 90 → 46 次（见 scripts/compare-merge-usage.mjs）。
   * 之所以给出开关：合并后的**质量**只能在真实长篇上验证，
   * 沙箱里的假 LLM 证明不了"一次抽多类"不比"分多次抽"差。
   * 哪一步产出变差就单独关掉那一个，便于定位。
   */
  const mergeRow = el('div', { class: 'grid cols-2' });
  for (const [key, label, hint] of [
    ['mergeChapterCalls', '逐章合并（时间线 + 事件）', '一章正文只发一次，同时抽时间提及与剧情事件'],
    ['mergeWorldCalls', '逐批合并（世界观 + 物品）', '一批正文只发一次，同时抽世界观与物品'],
    ['mergeCharCalls', '档案批量（共享抽样）', '同一份原文节选只发一次，一次写多个角色档案'],
  ]) {
    const cb = input('checkbox', state.config[key] !== false);
    cb.addEventListener('change', () => setConfig({ [key]: cb.checked }));
    mergeRow.appendChild(field({ label, control: cb, id: `gen-${key}`, name: key, hint }));
  }
  paramCard.appendChild(el('div', { class: 'hint', style: { marginTop: '10px' }, text: '省 token：同一段正文只喂一次' }));
  paramCard.appendChild(mergeRow);

  const limA = input('number', state.config.limits.maxA);
  const limB = input('number', state.config.limits.maxB);
  const saveLimits = () => setConfig({
    limits: { maxA: Number(limA.value) || 2000, maxB: Number(limB.value) || 3500 },
  });
  limA.addEventListener('change', saveLimits);
  limB.addEventListener('change', saveLimits);
  paramCard.appendChild(el('div', { class: 'grid cols-2' },
    field({
      label: 'A 包常驻 token 上限', control: limA, id: 'limit-maxA', name: 'limitMaxA',
      hint: '超出会在结果里给出警告，不影响生成',
    }),
    field({
      label: 'B 包常驻 token 上限', control: limB, id: 'limit-maxB', name: 'limitMaxB',
      hint: '预设片段过大时建议拆分',
    }),
  ));
  page.appendChild(paramCard);

  // ============================================================
  // 外观与交互
  // ============================================================
  const themeSelect = el('select', { id: 'ui-theme', name: 'theme' });
  themeSelect.append(el('option', { value: 'dark' }, '深色'), el('option', { value: 'light' }, '浅色'));
  themeSelect.value = state.ui.theme;
  themeSelect.addEventListener('change', () => {
    setUI({ theme: themeSelect.value });
    applyTheme();
  });

  const applyInput = input('text', '', 'dashboard / generate / library / card / preset / settings');
  const applyBtn = el('button', {
    class: 'btn sm ghost', type: 'button', text: '立即应用',
    onclick: () => {
      const id = applyInput.value.trim();
      if (!id) return toast('请输入页面 id，如 card', 'warn');
      emit('command', `go ${id}`);
    },
  });

  page.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '外观与交互' })),
    el('div', { class: 'grid cols-2' },
      field({ label: '主题', control: themeSelect, id: 'ui-theme', name: 'theme' }),
      field({
        label: '跳转页面（go 命令）',
        control: el('div', { class: 'row' }, applyInput, applyBtn),
        id: 'go-page-input',
        name: 'goPage',
      }),
    ),
  ));

  // ============================================================
  // 数据管理
  // ============================================================
  page.appendChild(el('div', { class: 'card' },
    el('div', { class: 'card-head' }, el('h3', { text: '数据管理' }),
      el('span', { class: 'spacer' }),
      el('span', { class: 'hint', text: '配置存在本机浏览器，产物存在服务端 output/' })),
    el('div', { class: 'row' },
      el('button', {
        class: 'btn sm', type: 'button', text: '导出配置',
        onclick: () => emit('command', 'save'),
      }),
      el('button', {
        class: 'btn sm', type: 'button', text: '导入配置',
        onclick: () => emit('command', 'load'),
      }),
      el('button', {
        class: 'btn sm danger', type: 'button', text: '清空本地配置',
        onclick: () => {
          if (!confirm('清空浏览器中的 API 配置与偏好？服务端产物不会被删除。')) return;
          try { localStorage.removeItem('n2c.state.v1'); } catch {}
          toast('已清空，正在重载…', 'warn');
          setTimeout(() => location.reload(), 600);
        },
      }),
      el('button', {
        class: 'btn sm danger', type: 'button', text: '清空命令历史',
        onclick: () => {
          try { localStorage.removeItem('n2c.cmd.history.v1'); } catch {}
          toast('命令历史已清空', 'warn');
        },
      }),
    ),
  ));

  // ============================================================
  // 系统信息
  // ============================================================
  const sysCard = el('div', { class: 'card' }, el('h3', { text: '系统信息' }));
  try {
    const sys = await api.system();
    state.system = sys;
    sysCard.appendChild(el('div', { class: 'kv', style: { marginTop: '10px' } },
      el('div', { class: 'k', text: '服务地址' }), el('div', { class: 'v', text: `http://127.0.0.1:${sys.port}` }),
      el('div', { class: 'k', text: 'Node' }), el('div', { class: 'v', text: `${sys.node} · ${sys.platform}` }),
      el('div', { class: 'k', text: '运行时长' }), el('div', { class: 'v', text: `${Math.round(sys.uptimeSec / 60)} 分钟` }),
      el('div', { class: 'k', text: '上传目录' }), el('div', { class: 'v', text: sys.uploads }),
      el('div', { class: 'k', text: '产物目录' }), el('div', { class: 'v', text: sys.outputs }),
      el('div', { class: 'k', text: '运行中任务' }), el('div', { class: 'v', text: sys.running.length ? sys.running.join(', ') : '无' }),
    ));
  } catch (e) {
    sysCard.appendChild(el('div', { class: 'hint', style: { color: 'var(--danger)' }, text: `读取失败：${e.message}` }));
  }
  page.appendChild(sysCard);

  // ============================================================
  // 关于
  // ============================================================
  page.appendChild(el('div', { class: 'card' },
    el('h3', { text: '关于' }),
    el('div', { class: 'hint', style: { marginTop: '8px', lineHeight: '1.9' } },
      el('div', { text: '小说 → 角色卡生成器 v1.1 · 本地运行，数据不出本机（除调用你自己配置的 LLM API）。' }),
      el('div', { text: '产出的 A 包（世界书）与 B 包（酒馆助手预设）面向 SillyTavern + 酒馆助手 MVU。' }),
      el('div', { text: '界面提供 7 个页面与一套命令行：底栏输入、Ctrl+K 面板、命令参考页三处入口共用同一套命令。' }),
    ),
  ));
}

function input(type, value, placeholder) {
  return el('input', { type, value: value ?? '', placeholder: placeholder || '' });
}