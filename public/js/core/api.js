/** 后端 API 封装 */

async function toJSON(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  /** 运行环境 */
  system: () => fetch('/api/system').then(toJSON),

  /** 任务列表 */
  tasks: () => fetch('/api/tasks').then(toJSON),

  /** 单个任务详情 */
  task: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}`).then(toJSON),

  /** 任务事件日志 */
  taskLog: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/log`).then(toJSON),

  /**
   * 生成 / 完善的**变更总结**（"增加了什么、改了哪里"）。
   * 返回 { summary, markdown, source }；source 为 saved（读已落盘）或 derived（旧任务现算）。
   */
  summary: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/summary`).then(toJSON),

  /** 运行中任务的内存缓冲 */
  taskBuffer: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/stream`).then(toJSON),

  /** 取消运行中的任务 */
  cancel: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(toJSON),

  /**
   * 暂停 / 恢复运行中的任务。
   * 语义是"在下一个批次边界停下"，不是立即中断：正在飞的那几个请求会跑完。
   * 已完成的批次都已落盘，所以暂停后刷新页面、甚至关掉服务都不丢进度。
   */
  pause: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' }).then(toJSON),
  resume: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' }).then(toJSON),

  /** 已落盘的批次清单（刷新页面后恢复"批次 N / 总批数"靠它） */
  batches: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/batches`).then(toJSON),

  /** 删除任务 */
  remove: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(toJSON),

  /** 读取产物文本 */
  file: (id, name) =>
    fetch(`/api/tasks/${encodeURIComponent(id)}/file/${encodeURIComponent(name)}`).then(toJSON),

  /** 在系统文件管理器中打开产物目录 */
  reveal: (id) => fetch(`/api/tasks/${encodeURIComponent(id)}/reveal`).then(toJSON),

  /** 产物下载 URL */
  downloadUrl: (id, name) => `/api/tasks/${encodeURIComponent(id)}/download/${encodeURIComponent(name)}`,

  /** 产物打包下载 URL */
  zipUrl: (id) => `/api/tasks/${encodeURIComponent(id)}/zip`,

  /** 模型列表 */
  models: (payload) =>
    fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(toJSON),

  /** 连通性测试 */
  ping: (payload) =>
    fetch('/api/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(toJSON),

  /** 本地章节切分预估 */
  estimate: (payload) =>
    fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(toJSON),

  /** 预设：可配置的 Step 列表 */
  presetSteps: () => fetch('/api/preset/steps').then(toJSON),

  /** 预设：用后端真实的 prompt 基线预览某个 Step 的最终内容 */
  presetPreview: (payload) =>
    fetch('/api/preset/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(toJSON),

  /**
   * 章节解析（**两个模式共用**）。
   * 纯字符串处理、不调用 LLM，上传后秒回。
   * @param {File} file
   */
  chapters(file) {
    const fd = new FormData();
    fd.append('novel', file, file.name || 'novel.txt');
    return fetch('/api/chapters', { method: 'POST', body: fd }).then(toJSON);
  },

  /**
   * 生成任务，事件流。
   * @param {FormData} formData
   * @param {{onEvent:(event:string,data:any)=>void, signal?:AbortSignal, endpoint?:string}} opts
   *   endpoint 默认 /api/generate；完善角色卡传 '/api/augment'。
   *   两个接口的 SSE 事件格式完全一致，所以共用这一段解析。
   */
  async generate(formData, { onEvent, signal, endpoint = '/api/generate' } = {}) {
    const res = await fetch(endpoint, { method: 'POST', body: formData, signal });
    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = j.error || j.message || msg;
      } catch {}
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let evt = null;
    let dataLines = [];

    const flush = () => {
      if (!evt) return;
      const raw = dataLines.join('\n');
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch {}
      onEvent?.(evt, parsed);
      evt = null;
      dataLines = [];
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith(':')) continue; // 心跳
        if (line.startsWith('event:')) {
          if (evt) flush();
          evt = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        } else if (line.trim() === '') {
          flush();
        }
      }
    }
    flush();
    return true;
  },
};
