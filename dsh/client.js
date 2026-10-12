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

      const [running, setRunning] = useState(false);
      const [taskId, setTaskId] = useState(null);
      const [logs, setLogs] = useState([]);
      const [pct, setPct] = useState(0);
      const [status, setStatus] = useState(null);
      const [error, setError] = useState(null);
      const [artifacts, setArtifacts] = useState([]);
      const [tasks, setTasks] = useState([]);

      const esRef = useRef(null);
      const cardRef = useRef(null);
      const imgRef = useRef(null);
      const novelRef = useRef(null);
      const logRef = useRef(null);

      // 结束时拉产物
      const loadArtifacts = useCallback(async (id) => {
        try {
          const r = await fetch(`${API}/task?id=${encodeURIComponent(id)}`);
          const j = await r.json();
          setArtifacts(j.artifacts || []);
          if (j.status) setStatus(j.status);
          if (j.error) setError(j.error);
        } catch (_) { /* 忽略 */ }
      }, []);

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

      const pushLog = (line) => setLogs(prev => [...prev.slice(-300), line]);

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
      }, [tab, baseUrl, apiKey, model, title, text, strategy, chapterRange, openStream]);

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
          ? h('div', { className: 'n2c-col' },
            h(Field, { label: '已有角色卡（character_card.json）' },
              h('input', { className: 'n2c-input', type: 'file', accept: '.json', ref: cardRef })),
            h(Field, { label: '新剧情文本' },
              h('textarea', {
                className: 'n2c-textarea', value: text,
                onChange: e => setText(e.target.value), placeholder: '粘贴新增的章节内容…',
              })),
            h('div', { className: 'n2c-row' },
              h(Field, { label: '合并策略' }, h('select', {
                className: 'n2c-select', value: strategy, onChange: e => setStrategy(e.target.value),
              },
              h('option', { value: 'merge' }, 'merge（默认，追加进已有条目）'),
              h('option', { value: 'append' }, 'append（只新增，不动已有）'),
              h('option', { value: 'overwrite' }, 'overwrite（替换已有条目）')))))
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
            }))
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

    // 兼容导出：SidebarButton 与 Panel 都能用
    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        /**
         * 侧栏面板列表里放一个入口。
         *
         * 选 `sidebar.panellist` 的理由：它是**已分配空间**的列表项 slot，
         * 不需要自己算位置；点击后再用 layout 打开右侧栏面板。
         * 这里刻意用 try/catch 包住 —— 槽位名或 layout API 在不同 DSH 版本上可能不同，
         * 抛错会让整个 slot 条目崩掉（控制台会报 `slot entry crashed`）。
         */
        const layout = ctx.get ? ctx.get('layout') : null;

        function SidebarEntry() {
          useStyles();
          return h('div', {
            className: 'n2c-tab',
            role: 'button',
            title: '小说 / 图片一键生成角色卡',
            style: { cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 },
            onClick: () => {
              try {
                if (layout && typeof layout.openRightbar === 'function') {
                  layout.openRightbar(openPanel, false);
                } else {
                  // 没有 layout API 时退化成浮层 alert 式提示，不让点击变成静默失败
                  console.warn('[novel2card] layout.openRightbar 不可用，无法打开面板');
                }
              } catch (e) { console.warn('[novel2card] 打开面板失败', e); }
            },
          }, h('span', null, '🃏'), h('span', null, '角色卡生成'));
        }

        /** 右侧栏面板内容：用 track 注册，DSH 负责容器与标题栏 */
        function openPanel(track) {
          try {
            if (track && typeof track.open === 'function') track.open({ title: '小说 / 图片 → 角色卡' });
            if (track && typeof track.register === 'function') {
              return track.register(Panel);
            }
          } catch (e) { console.warn('[novel2card] 注册面板失败', e); }
          return null;
        }

        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'novel2card-entry', order: 20 },
          SidebarEntry,
        ));
      },
    };
  },
});
