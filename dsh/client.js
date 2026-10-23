/**
 * DSH 插件（浏览器侧）：小说 / 图片 → 角色卡 的工作面板。
 *
 * 格式约束（见 DSH 插件文档 ui-plugin.md）：
 *   · 必须注册成 `window.__ModuleLoader__.load({ id, factory })`，**id 等于包名**
 *   · React 从宿主模块表取（`require('react')`），不打包自己的 React
 *   · 不能 require 任何 `@deepseek-ai/dsh-client-ui-*`（版本会变，抛错会让整个 slot 崩掉）
 *   · 不用 JSX（没有构建步骤），一律 React.createElement
 *   · 容器与控件只用主题 token `--dsw-alias-*`
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-novel2card',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    /** 与插件的宿主路由前缀保持一致 */
    const API = '/novel2card';

    // ---------- 样式（组件内渲染，卸载即消失） ----------
    const CSS = `
.n2c-root{font:13px/1.6 var(--dsw-font-family,system-ui,sans-serif);color:var(--dsw-alias-text-primary,#e6e6e6);display:flex;flex-direction:column;gap:10px;padding:12px;height:100%;box-sizing:border-box}
.n2c-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.n2c-col{display:flex;flex-direction:column;gap:6px}
.n2c-label{font-size:12px;color:var(--dsw-alias-text-secondary,#9aa4b2)}
.n2c-input,.n2c-textarea,.n2c-select{background:var(--dsw-alias-bg-input,rgba(255,255,255,.04));color:inherit;border:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));border-radius:6px;padding:6px 8px;font:inherit;width:100%;box-sizing:border-box}
.n2c-textarea{min-height:150px;resize:vertical;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}
.n2c-btn{background:var(--dsw-alias-bg-button,rgba(255,255,255,.08));color:inherit;border:1px solid var(--dsw-alias-border,rgba(255,255,255,.16));border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer}
.n2c-btn:hover:not(:disabled){background:var(--dsw-alias-bg-button-hover,rgba(255,255,255,.14))}
.n2c-btn:disabled{opacity:.5;cursor:not-allowed}
.n2c-btn-primary{background:var(--dsw-alias-accent,#3b82f6);border-color:transparent;color:#fff}
.n2c-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));padding-bottom:6px}
.n2c-tab{padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--dsw-alias-text-secondary,#9aa4b2)}
.n2c-tab[data-on="1"]{background:var(--dsw-alias-bg-button,rgba(255,255,255,.1));color:var(--dsw-alias-text-primary,#e6e6e6)}
.n2c-log{flex:1;min-height:120px;max-height:38vh;overflow:auto;background:var(--dsw-alias-bg-code,rgba(0,0,0,.25));border-radius:6px;padding:8px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;white-space:pre-wrap;word-break:break-word}
.n2c-err{color:var(--dsw-alias-danger,#ef4444)}
.n2c-ok{color:var(--dsw-alias-success,#22c55e)}
.n2c-hint{font-size:11.5px;color:var(--dsw-alias-text-tertiary,#7b8794)}
.n2c-bar{height:3px;background:var(--dsw-alias-bg-button,rgba(255,255,255,.1));border-radius:3px;overflow:hidden}
.n2c-bar>i{display:block;height:100%;background:var(--dsw-alias-accent,#3b82f6);transition:width .3s ease}
.n2c-card{border:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));border-radius:8px;padding:10px;display:flex;flex-direction:column;gap:6px}
.n2c-file{display:flex;justify-content:space-between;gap:8px;font-size:12px}
.n2c-pill{font-size:11px;padding:1px 7px;border-radius:99px;background:var(--dsw-alias-bg-button,rgba(255,255,255,.1))}
.n2c-panel-icon{display:inline-flex;align-items:center;justify-content:center;line-height:1;border-radius:6px;opacity:.72}
.n2c-panel-icon[data-active="1"]{opacity:1;background:var(--dsw-alias-bg-button,rgba(255,255,255,.12))}
`;

    function useStyles() {
      useEffect(() => {
        const el = document.createElement('style');
        el.setAttribute('data-novel2card', '1');
        el.textContent = CSS;
        document.head.appendChild(el);
        return () => { try { el.remove(); } catch (_) { /* 已移除 */ } };
      }, []);
    }

    const Field = (props) => h('label', { className: 'n2c-col' },
      h('span', { className: 'n2c-label' }, props.label),
      props.children);

    /** 三种指令快捷按钮 */
    const INSTRUCTION_PRESETS = [
      '只合并角色，角色设定必须符合原卡世界观',
      '把地图与势力也合并进去，沿用原卡已有的地名与势力名',
      '角色与世界观都要，新角色不要引入原卡没有的体系',
    ];

    /**
     * 「完善已有卡」的输入区。
     *
     * 抽成独立组件的原因很实际：这段嵌在三层三元里时括号极难数对
     * （我在这里连续数错过两次，客户端的语法错会让整个 slot 崩掉）。
     * 独立出来既好写也好读。
     */
    function AugmentFields(props) {
      const { cardRef, text, setText, instruction, setInstruction, strategy, setStrategy } = props;

      const cardField = h(Field, { label: '已有角色卡（character_card.json）' },
        h('input', { className: 'n2c-input', type: 'file', accept: '.json', ref: cardRef }));

      const novelField = h(Field, { label: '新剧情文本' },
        h('textarea', {
          className: 'n2c-textarea', value: text,
          onChange: e => setText(e.target.value),
          placeholder: '粘贴新增的章节内容…',
        }));

      // 完善指令：会拼进每个抽取步骤，并与「已有卡世界观摘要」一起生效
      const instructionField = h(Field, { label: '完善指令（可选，最多 2000 字）' },
        h('textarea', {
          className: 'n2c-textarea', style: { minHeight: '76px' },
          value: instruction, onChange: e => setInstruction(e.target.value),
          placeholder: '例如：只把小说里的角色并进已有卡，角色设定要符合原卡世界观；'
            + '地图与势力也纳入，但沿用原卡已有的地名与势力名。',
        }));

      const strategySelect = h('select', {
        className: 'n2c-select', value: strategy, onChange: e => setStrategy(e.target.value),
      },
      h('option', { value: 'merge' }, 'merge（默认，追加进已有条目）'),
      h('option', { value: 'append' }, 'append（只新增，不动已有）'),
      h('option', { value: 'overwrite' }, 'overwrite（替换已有条目）'));

      const presetButtons = INSTRUCTION_PRESETS.map(t => h('button', {
        key: t, className: 'n2c-btn', type: 'button', title: t,
        onClick: () => setInstruction(t),
      }, t.slice(0, 14) + '…'));

      return h('div', { className: 'n2c-col' },
        cardField,
        novelField,
        instructionField,
        h('div', { className: 'n2c-row' }, h(Field, { label: '合并策略' }, strategySelect)),
        h('div', { className: 'n2c-hint' },
          '指令会作为高优先级规则加进事件 / 世界观 / 人物 / 档案四个抽取步骤；'
          + '已有卡的世界观摘要也会一并喂进去（所以"符合原卡世界观"是默认行为）。'),
        h('div', { className: 'n2c-row', style: { flexWrap: 'wrap', gap: '6px' } }, presetButtons));
    }

    // ---------- 主面板 ----------
    function Panel() {
      useStyles();
      const [tab, setTab] = useState('generate');
      const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
      const [apiKey, setApiKey] = useState('');
      const [model, setModel] = useState('deepseek-flash');
      const [title, setTitle] = useState('');
      const [text, setText] = useState('');
      const [strategy, setStrategy] = useState('merge');
      const [chapterRange, setChapterRange] = useState('all');
      /** 完善指令：会拼进每个抽取步骤的 prompt */
      const [instruction, setInstruction] = useState('');

      const [running, setRunning] = useState(false);
      const [taskId, setTaskId] = useState(null);
      const [logs, setLogs] = useState([]);
      const [pct, setPct] = useState(0);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [artifacts, setArtifacts] = useState([]);
      const [tasks, setTasks] = useState([]);
      /** 本任务的产物目录（绝对路径），用于"打开目录 / 复制路径" */
      const [outDir, setOutDir] = useState('');

      const esRef = useRef(null);
      const cardRef = useRef(null);
      const imgRef = useRef(null);
      const novelRef = useRef(null);
      const logRef = useRef(null);

      /**
       * 写一行日志。
       *
       * 放在最前面（而不是紧挨着使用处）：`openFolder` / `copyPath` 的
       * `useCallback` 依赖数组会**立即求值** `pushLog`，声明在后会踩 TDZ
       *（ReferenceError: Cannot access 'pushLog' before initialization）。
       */
      const pushLog = (line) => setLogs(prev => [...prev.slice(-300), line]);

      // 结束时拉产物
      const loadArtifacts = useCallback(async (id) => {
        try {
          const r = await fetch(`${API}/task?id=${encodeURIComponent(id)}`);
          const j = await r.json();
          setArtifacts(j.artifacts || []);
          if (j.outDir) setOutDir(j.outDir);
          if (j.status) setStatus(j.status);
          if (j.error) setError(j.error);
        } catch (_) { /* 忽略 */ }
      }, []);

      /**
       * 在系统文件管理器里打开产物目录。
       *
       * 为什么要做：用户反馈「dsh 上生成的角色卡都保存在了哪里，我翻文件找有点麻烦」——
       * 插件的数据目录在 `~/.dsh/novel2card/output/task_<时间戳>/` 下，
       * 每层都带时间戳，手动找确实难受。这个按钮直接把它打开。
       */
      const openFolder = useCallback(async () => {
        if (!taskId) return;
        try {
          const r = await fetch(`${API}/reveal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId }),
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          pushLog(`已在文件管理器中打开：${j.outDir || outDir}`);
        } catch (e) {
          // 打不开不是致命错误：路径仍然显示在面板上，可以复制
          pushLog(`打开目录失败（可直接复制路径）：${e.message}`);
        }
      }, [taskId, outDir, pushLog]);

      /** 复制产物目录路径到剪贴板 */
      const copyPath = useCallback(async () => {
        if (!outDir) return;
        try {
          await navigator.clipboard.writeText(outDir);
          pushLog(`已复制路径：${outDir}`);
        } catch {
          pushLog(`复制失败，请手动选择：${outDir}`);
        }
      }, [outDir, pushLog]);

      useEffect(() => {
        // 记住上次填的接口配置，省得每次重输
        try {
          const saved = JSON.parse(localStorage.getItem('novel2card.llm') || 'null');
          if (saved) {
            if (saved.baseUrl) setBaseUrl(saved.baseUrl);
            if (saved.apiKey) setApiKey(saved.apiKey);
            if (saved.model) setModel(saved.model);
          }
        } catch (_) { /* 忽略 */ }
        fetch(`${API}/tasks`).then(r => r.json()).then(j => setTasks(j.tasks || [])).catch(() => {});
        return () => { try { esRef.current?.close(); } catch (_) { /* 忽略 */ } };
      }, []);

      useEffect(() => {
        try { localStorage.setItem('novel2card.llm', JSON.stringify({ baseUrl, apiKey, model })); } catch (_) { /* 忽略 */ }
      }, [baseUrl, apiKey, model]);

      useEffect(() => {
        if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
      }, [logs]);

      const openStream = useCallback((id) => {
        const es = new EventSource(`${API}/stream?id=${encodeURIComponent(id)}`);
        esRef.current = es;
        es.addEventListener('progress', (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch (_) { /* 忽略 */ }
          pushLog(`[${d.step || ''}] ${d.step === 'WARN' ? '⚠ ' : ''}${d.msg || ''}`);
          setPct(p => Math.max(p, Math.min(95, p + 4)));
        });
        es.addEventListener('error', (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch (_) { /* 忽略 */ }
          if (d.message) { pushLog(`❌ ${d.message}`); setError(d.message); }
        });
        es.addEventListener('files', (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch (_) { /* 忽略 */ }
          pushLog(`✓ 产出 ${(d.files || []).length} 个文件`);
        });
        es.addEventListener('done', (ev) => {
          let d = {};
          try { d = JSON.parse(ev.data); } catch (_) { /* 忽略 */ }
          setPct(100);
          setRunning(false);
          setStatus(d.status);
          if (d.error) setError(d.error);
          es.close();
          loadArtifacts(id);
          fetch(`${API}/tasks`).then(r => r.json()).then(j => setTasks(j.tasks || [])).catch(() => {});
        });
        es.onerror = () => { es.close(); setRunning(false); };
      }, [loadArtifacts]);

      const start = useCallback(async () => {
        setError(null); setLogs([]); setPct(3); setArtifacts([]); setStatus(null);
        if (!baseUrl.trim() || !model.trim()) { setError('请填写 Base URL 与模型名'); return; }
        if (tab === 'image-card' && !(imgRef.current?.files?.length)) { setError('图片任务需要先选择图片'); return; }
        if (tab === 'augment' && !cardRef.current?.files?.[0]) { setError('完善任务需要先选择已有的 character_card.json'); return; }
        if (tab !== 'image-card' && !text.trim() && !novelRef.current?.files?.[0]) {
          setError('请粘贴小说文本或选择 .txt 文件'); return;
        }

        setRunning(true);
        try {
          const fd = new FormData();
          fd.append('kind', tab);
          fd.append('baseUrl', baseUrl.trim());
          fd.append('apiKey', apiKey.trim());
          fd.append('model', model.trim());
          fd.append('title', title.trim() || (tab === 'augment' ? '完善后的角色卡' : 'DSH 生成的角色卡'));
          fd.append('chapterRange', chapterRange || 'all');
          if (tab === 'augment') {
            fd.append('strategy', strategy);
            fd.append('novelText', text);
            fd.append('card', cardRef.current.files[0], cardRef.current.files[0].name);
            // 完善指令（服务端也会再校验一次长度）
            const inst = instruction.trim();
            if (inst) fd.append('instruction', inst);
          } else if (tab === 'image-card') {
            for (const f of imgRef.current.files) fd.append('images', f, f.name);
          } else {
            if (novelRef.current?.files?.[0]) fd.append('novel', novelRef.current.files[0], novelRef.current.files[0].name);
            else fd.append('novelText', text);
          }
          const r = await fetch(`${API}/generate`, { method: 'POST', body: fd });
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
          setTaskId(j.taskId);
          pushLog(`任务 ${j.taskId} 已创建（${j.kind}）`);
          openStream(j.taskId);
        } catch (e) {
          setError(e.message);
          setRunning(false);
        }
      }, [tab, baseUrl, apiKey, model, title, text, strategy, chapterRange, instruction, openStream]);

      const cancel = useCallback(async () => {
        if (!taskId) return;
        try {
          await fetch(`${API}/cancel`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId }),
          });
          pushLog('已请求取消');
        } catch (e) { setError(e.message); }
      }, [taskId]);

      const TAB_LABEL = { generate: '小说 → 卡', augment: '完善已有卡', 'image-card': '图片 → 卡' };

      return h('div', { className: 'n2c-root' },
        h('div', { className: 'n2c-tabs' },
          ['generate', 'augment', 'image-card'].map(t =>
            h('div', {
              key: t, className: 'n2c-tab', 'data-on': tab === t ? '1' : '0',
              onClick: () => { if (!running) { setTab(t); setError(null); } },
            }, TAB_LABEL[t]))),

        // 接口配置（折叠，避免占满面板）
        h('details', null,
          h('summary', { className: 'n2c-hint' }, '模型接口设置'),
          h('div', { className: 'n2c-col', style: { marginTop: 6 } },
            h(Field, { label: 'Base URL' }, h('input', {
              className: 'n2c-input', value: baseUrl, onChange: e => setBaseUrl(e.target.value),
              placeholder: 'https://api.deepseek.com/v1', spellCheck: false,
            })),
            h(Field, { label: 'API Key' }, h('input', {
              className: 'n2c-input', type: 'password', value: apiKey,
              onChange: e => setApiKey(e.target.value), placeholder: 'sk-...',
              autoComplete: 'off', spellCheck: false,
            })),
            h(Field, { label: '模型' }, h('input', {
              className: 'n2c-input', value: model, onChange: e => setModel(e.target.value),
              placeholder: 'deepseek-flash', spellCheck: false,
            })),
            h('div', { className: 'n2c-hint' },
              '插件用你在这里填的接口，不读取 DSH 的模型配置（两者可能指向不同的服务商）。'))),

        h(Field, { label: '角色卡名称（可选）' },
          h('input', { className: 'n2c-input', value: title, onChange: e => setTitle(e.target.value) })),

        // 按任务类型给对应输入
        tab === 'augment'
          ? h(AugmentFields, {
            cardRef, text, setText, instruction, setInstruction, strategy, setStrategy,
          })
          : tab === 'image-card'
            ? h('div', { className: 'n2c-col' },
              h(Field, { label: '图片（最多 60 张，超过 6 张自动分批）' },
                h('input', { className: 'n2c-input', type: 'file', accept: 'image/*', multiple: true, ref: imgRef })))
            : h('div', { className: 'n2c-col' },
              h(Field, { label: '小说文本' },
                h('textarea', {
                  className: 'n2c-textarea', value: text,
                  onChange: e => setText(e.target.value),
                  placeholder: '粘贴小说正文…（文件较大时建议用下面的 .txt 上传，可自动识别 GBK 等编码）',
                })),
              h(Field, { label: '或上传 .txt（支持 GBK / Big5，自动检测编码）' },
                h('input', { className: 'n2c-input', type: 'file', accept: '.txt,text/plain', ref: novelRef }))),

        // 章节范围（生成 / 完善用）
        tab !== 'image-card'
          ? h(Field, { label: '章节范围（all / 1-10 / 1,3,5）' },
            h('input', {
              className: 'n2c-input', value: chapterRange,
              onChange: e => setChapterRange(e.target.value), placeholder: 'all',
            }))
          : null,

        h('div', { className: 'n2c-row' },
          h('button', {
            className: 'n2c-btn n2c-btn-primary', type: 'button',
            disabled: running, onClick: start,
          }, running ? '生成中…' : '开始'),
          running ? h('button', { className: 'n2c-btn', type: 'button', onClick: cancel }, '中止') : null,
          h('span', { className: 'n2c-hint' }, status === 'done' ? '✓ 已完成'
            : status === 'error' ? '✗ 失败'
              : status === 'cancelled' ? '已取消' : (running ? `${pct}%` : ''))),

        h('div', { className: 'n2c-bar' }, h('i', { style: { width: `${pct}%` } })),

        error ? h('div', { className: 'n2c-err' }, error) : null,
        h('div', { className: 'n2c-log', ref: logRef }, logs.join('\n') || '（等待事件…）'),

        // 产物
        artifacts.length
          ? h('div', { className: 'n2c-card' },
            h('div', { className: 'n2c-label' }, `产物（${artifacts.length}）`),
            artifacts.map((a) => {
              const dl = a.name === 'character_card.json'
                ? h('a', {
                  className: 'n2c-btn',
                  style: { textDecoration: 'none' },
                  href: `${API}/file?id=${encodeURIComponent(taskId)}&name=${encodeURIComponent(a.name)}`,
                  download: a.name,
                }, '下载')
                : null;
              return h('div', { key: a.name, className: 'n2c-file' },
                h('span', null, a.name),
                h('span', { className: 'n2c-row' },
                  h('span', { className: 'n2c-hint' }, `${(a.size / 1024).toFixed(1)} KB`),
                  dl));
            }),
            // 产物目录：直接给出绝对路径 + 打开 / 复制（省得去翻文件夹）
            outDir
              ? h('div', { className: 'n2c-col', style: { marginTop: 8, gap: 4 } },
                h('div', { className: 'n2c-label' }, '产物目录'),
                h('div', {
                  className: 'n2c-hint',
                  style: {
                    fontFamily: 'ui-monospace,Consolas,monospace',
                    fontSize: 11, wordBreak: 'break-all', userSelect: 'all',
                  },
                }, outDir),
                h('div', { className: 'n2c-row', style: { gap: 6, flexWrap: 'wrap' } },
                  h('button', {
                    type: 'button', className: 'n2c-btn', onClick: openFolder,
                  }, '📂 打开目录'),
                  h('button', {
                    type: 'button', className: 'n2c-btn', onClick: copyPath,
                  }, '复制路径')))
              : null)
          : null,
        // 历史任务
        tasks.length > 1
          ? h('details', null,
            h('summary', { className: 'n2c-hint' }, `历史任务（${tasks.length}）`),
            h('div', { className: 'n2c-col', style: { marginTop: 6 } },
              tasks.slice(0, 20).map(t => h('div', { key: t.taskId, className: 'n2c-file' },
                h('span', null, `${t.title || '未命名'}`),
                h('span', { className: 'n2c-pill' }, t.status)))))
          : null,
      );
    }

    /**
     * 只声明 `slots`。
     *
     * `layout`（`ctx.layout.selectPanel` 等）**不放进 inject** —— 那样在没有 layout
     * 服务的组合里整个条目都不会激活，侧栏图标也不会出现。真正必需的是 slots。
     * 需要 layout 时用 `ctx.layout` 直接读，并用 try/catch 兜住。
     */
    return {
      inject: ['slots'],
      apply(ctx) {
        /**
         * 面板 key。
         *
         * ⚠️ 这个字符串**必须同时**用于 `main` 槽位的 key 与 `sidebar.panellist`
         * 条目的 id —— DSH 的机制就是这样把两者对起来的：
         *   main（keyed）：「Central panel selected by sidebar entry id」
         *   sidebar.panellist（list）：「Each list id addresses the matching main panel;
         *                              the sidebar owns the button」
         */
        const PANEL_KEY = 'novel2card';

        /**
         * 侧栏图标。
         *
         * ownerProps 提供 `{ size, active }` —— 只需画一个方形图标，
         * 按钮本体（点击、选中态、tooltip）由 sidebar 自己渲染。
         */
        function SidebarIcon(props) {
          useStyles();
          const size = (props && props.size) || 20;
          const active = !!(props && props.active);
          return h('span', {
            className: 'n2c-panel-icon',
            'data-active': active ? '1' : '0',
            style: { width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.85) + 'px' },
            'aria-hidden': true,
          }, '🃏');
        }

        // ① 中央面板（main 是 keyed 槽位，key 必须与侧栏条目的 id 一致）
        ctx.slots.inject('main', () => ctx.slots.register(
          { name: 'main', key: PANEL_KEY },
          Panel,
        ));

        // ② 侧栏图标（id = 上面那个 key，点了由 sidebar 切到对应面板）
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_KEY,
            order: 20,
            // label 用 thunk：每次投影都重读，便于以后接 locale
            label: () => '角色卡生成',
          },
          SidebarIcon,
        ));

        /**
         * 兜底：如果这个版本的 sidebar 不认 id → main key 的对应关系，
         * 至少让 `ctx.layout.selectPanel()` 可用（用户可以从命令或后续 UI 调用）。
         * 这里不做多余的自动切换，避免和 sidebar 自己的行为打架。
         */
        try {
          if (ctx.layout && typeof ctx.layout.selectPanel !== 'function') {
            console.warn('[novel2card] ctx.layout.selectPanel 不可用；面板已注册到 main，'
              + '但侧栏按钮可能无法切换过去');
          }
        } catch { /* 忽略 */ }
      },
    };
  },
});
