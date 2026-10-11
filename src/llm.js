/**
 * LLM 客户端：兼容 OpenAI Chat Completions 协议。
 * 支持 DeepSeek / OpenAI / SiliconFlow / Ollama / LM Studio 等。
 *
 * 支持按 Step 应用用户预设（append / replace），见 src/preset.js。
 */
import { parseJSON } from './utils.js';
import { applyPreset, presetMode } from './preset.js';
import { readFileSync } from 'node:fs';

const DEFAULT_TIMEOUT = 180_000; // 单次请求 3 分钟

/**
 * 一张图在记账里折算成多少"字符"。
 *
 * 我们按**字符数**记账（见 usage 注释）。图片没有字符，但视觉请求的成本主要就在图上，
 * 不计进去会让"输入/正文比"这类指标完全失真。
 * 取 1500 是因为实测一张 768px JPEG（约 40KB）的 prompt_tokens 在 1000 上下，
 * 中文字符约 1 字 ≈ 0.7 token，反推 ≈ 1400-1500 字符。**只为记账，不影响请求。**
 */
const IMAGE_CHAR_EQUIVALENT = 1500;

/**
 * @param {object} config { baseUrl, apiKey, model, requestTimeout }
 * @param {object|null} presetArg 显式传入的预设；不传则取 config.preset
 */
/**
 * 从文件路径/数据 URL 推断图片 MIME。
 *
 * 上游（实测 api.deepseek.com）对格式挑得很严：只接受
 * `webp / png / jpeg / gif`，其它一律报 "unsupported image"。
 * 所以这里保守推断，认不出的一律按 png 处理并交给上游报错 ——
 * 至少错误信息来自上游的真实判断，而不是我们猜错格式。
 */
export function inferImageMime(src) {
  const s = String(src || '');
  const data = /^data:([^;,]+)[;,]/.exec(s);
  if (data) return data[1];
  const m = /\.([a-z0-9]+)(?:\?|#|$)/i.exec(s.split(/[\\/]/).pop() || '');
  const ext = (m?.[1] || '').toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}

/**
 * 把一张图片转成 data URL。
 *
 * @param {string|Buffer|{data:Buffer,mime:string}} img
 *   · 字符串：文件路径（含 `path`）或已是 data URL / http(s) URL
 *   · Buffer：需要配合 `opts.images` 里的 `{data, mime}` 形式
 */
function toDataUrl(img) {
  if (typeof img === 'string') {
    if (/^(data:|https?:)/i.test(img)) return img;
    return `data:${inferImageMime(img)};base64,${readFileSync(img).toString('base64')}`;
  }
  if (img && typeof img === 'object' && img.data) {
    return `data:${img.mime || 'image/png'};base64,${Buffer.from(img.data).toString('base64')}`;
  }
  throw new Error('无法识别的图片输入（需要文件路径、data URL 或 {data, mime}）');
}

/**
 * 构造多模态 user 内容。
 *
 * OpenAI 兼容协议里有两种写法，**必须用对象形式**：
 *
 *     ✅ { type:'image_url', image_url: { url: 'data:...' } }
 *     ❌ { type:'image_url', image_url: 'data:...' }      → 上游 422
 *
 * 实测踩过：字符串形式会被网关拒绝（"invalid type: string"），
 * 而且错误信息不会告诉你是这里的写法问题。
 *
 * @param {string} text 文本部分
 * @param {Array} images 图片列表
 * @param {boolean} appendTextAfter 是否把文本也放到图片之后
 *   （多数视觉模型建议图片在前、指令在后，这样指令不会被长图"冲淡"）
 */
function buildMultimodalContent(text, images, appendTextAfter = true) {
  const parts = [];
  for (const img of images) {
    parts.push({ type: 'image_url', image_url: { url: toDataUrl(img) } });
  }
  if (text && !appendTextAfter) parts.push({ type: 'text', text });
  if (text && appendTextAfter) parts.push({ type: 'text', text });
  return parts;
}

export function makeLLM(config, presetArg = undefined) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
  const { apiKey, model } = config;
  const preset = presetArg !== undefined ? presetArg : (config.preset || null);
  const timeout = Number(config.requestTimeout) > 0 ? Number(config.requestTimeout) : DEFAULT_TIMEOUT;

  /**
   * 用量统计：每次请求的**字符数**。
   *
   * 上游不一定返回 `usage`（本地模型、部分网关都不给），而"token 花在哪了"
   * 是排查成本问题的第一个问题。所以这里按字符数记账
   * （中文约 1 字 ≈ 0.7 token，足够看出占比结构），结果挂在 `llm.usage` 上。
   * 只做计数，不改变任何请求行为。
   */
  const usage = {
    /** 每次调用一条：{step, systemChars, userChars, replyChars, ms, ok} */
    calls: [],
    /** 按 step 汇总 */
    byStep: {},
    reset() {
      this.calls.length = 0;
      for (const k of Object.keys(this.byStep)) delete this.byStep[k];
      return this;
    },
    /** 送出去的输入字符总数（system + user） */
    get inputChars() { return this.calls.reduce((s, c) => s + c.systemChars + c.userChars, 0); },
    get outputChars() { return this.calls.reduce((s, c) => s + c.replyChars, 0); },
  };
  const recordCall = (step, systemChars, userChars, replyChars, ms, ok) => {
    usage.calls.push({ step, systemChars, userChars, replyChars, ms, ok });
    const agg = usage.byStep[step] || (usage.byStep[step] = { calls: 0, systemChars: 0, userChars: 0, replyChars: 0, ms: 0 });
    agg.calls++;
    agg.systemChars += systemChars;
    agg.userChars += userChars;
    agg.replyChars += replyChars;
    agg.ms += ms;
  };

  /**
   * 兼容旧的 (system, user, opts) 调用习惯：第三个参数是对象时视为 opts。
   *
   * stepName 允许是**数组**（一次调用合并了多个 Step，例如逐章合并版同时是
   * step1 + step2）。数组时保留数组继续往下传 —— 预设后缀要按每个 Step 逐个追加，
   * 但用量记账按 `step1+step2` 合成一个键，避免同一笔开销被拆成两行。
   */
  const splitArgs = (stepName, opts) => {
    if (Array.isArray(stepName)) {
      const names = stepName.filter(Boolean);
      if (!names.length) return { stepName: 'unknown', opts: opts || {} };
      return { stepName: names.length === 1 ? names[0] : names, opts: opts || {} };
    }
    if (stepName && typeof stepName === 'object') return { stepName: 'unknown', opts: stepName };
    return { stepName: stepName || 'unknown', opts: opts || {} };
  };

  /** 记账用的键：数组合成 `a+b`，其余原样 */
  const stepKey = (step) => (Array.isArray(step) ? step.join('+') : String(step || 'unknown'));

  async function chat(system, user, stepName, opts) {
    const args = splitArgs(stepName, opts);
    const { temperature = 0.3, retries = 3, maxTokens, json = false, images = null } = args.opts;
    const step = args.stepName;
    // replace 模式下原指令被整段替换，输出格式约束必须补回来，否则 JSON 解析必失败
    const guardJson = json || presetMode(preset) === 'replace';

    const finalSystem = applyPreset(system, preset, step, 'system', { json: guardJson });
    const finalUser = applyPreset(user, preset, step, 'user', { json: guardJson });

    /**
     * 多模态：有图片时 user 的 content 变成内容块数组。
     *
     * ⚠️ 预设替换（applyPreset）作用在**文本**上，图片另挂 ——
     * 所以这里是先算好文本、再拼图片，而不是把图片塞进 applyPreset。
     * 否则 replace 模式会把图片一起替换掉（图上就没有输入了）。
     */
    const hasImages = Array.isArray(images) && images.length > 0;
    const userContent = hasImages ? buildMultimodalContent(finalUser, images) : finalUser;

    let lastErr;
    const t0 = Date.now();
    for (let i = 0; i < retries; i++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const body = {
          model,
          messages: [
            { role: 'system', content: finalSystem },
            { role: 'user', content: userContent },
          ],
          temperature,
        };
        if (maxTokens) body.max_tokens = maxTokens;
        if (json) body.response_format = { type: 'json_object' };

        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const err = await res.text().catch(() => '');
          const hint = res.status === 401 || res.status === 403
            ? '（API Key 无效或没有权限）'
            : res.status === 404
              ? '（路径不存在，检查 Base URL 是否需要以 /v1 结尾）'
              : res.status === 429
                ? '（触发限流，稍后重试或降低并发）'
                : '';
          throw new Error(`HTTP ${res.status}${hint}: ${err.slice(0, 200)}`);
        }
        const data = await res.json().catch(() => {
          // 上游返回的不是 JSON —— 多半是 Base URL 指到了网关/登录页/HTML 错误页
          throw new Error(
            '接口返回的不是 JSON。请检查 Base URL 是否指向 OpenAI 兼容端点，' +
            '通常需要以 /v1 结尾（例如 https://api.deepseek.com/v1、http://localhost:11434/v1）'
          );
        });
        const reply = data.choices?.[0]?.message?.content || '';
        // 记账：图片也要计入"送出去的输入" —— 否则视觉任务的成本会被算成 0，
        // 而图片恰恰是这类请求里最贵的部分（实测一张 768px JPEG ≈ 1000+ token）
        const imgChars = hasImages ? images.length * IMAGE_CHAR_EQUIVALENT : 0;
        recordCall(stepKey(step), finalSystem.length, finalUser.length + imgChars, String(reply).length, Date.now() - t0, true);
        return reply;
      } catch (e) {
        lastErr = e.name === 'AbortError' ? new Error(`请求超时（${Math.round(timeout / 1000)}s）`) : e;
        if (i === retries - 1) {
          // 失败的请求也记账（重试会把输入重发一遍，这正是浪费的一部分）
          const imgChars = hasImages ? images.length * IMAGE_CHAR_EQUIVALENT : 0;
          recordCall(stepKey(step), finalSystem.length, finalUser.length + imgChars, 0, Date.now() - t0, false);
          break;
        }
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async function chatJSON(system, user, stepName, opts) {
    const args = splitArgs(stepName, opts);
    // chatJSON 天然要求 JSON 输出，因此把 json 标记传下去（replace 模式下会补回格式约束）
    const text = await chat(system, user, args.stepName, { ...args.opts, json: true });
    try {
      return parseJSON(text);
    } catch {
      throw new Error(`JSON 解析失败：${String(text).slice(0, 150)}...`);
    }
  }

  return {
    chat,
    chatJSON,
    baseUrl,
    model,
    // 用量记账（按字符数）：排查"token 花在哪了"用，见 usage 的注释
    usage,
    // 便于上层展示与调试
    preset: preset || null,
    presetMode: presetMode(preset),
    get presetActive() { return !!preset; },
  };
}

/**
 * Base URL 合理性检查。
 *
 * 最常见的配置坑：只写主机名（如 http://localhost:11434、https://api.deepseek.com），
 * 于是请求打到 /chat/completions 而不是 /v1/chat/completions。
 * 这里给出可操作的提示，但不阻止请求 —— 有些自建网关确实不带 /v1。
 *
 * @returns {{warn:string|null, hint:string|null}}
 */
export function checkBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return { warn: '缺少 Base URL', hint: null };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { warn: `Base URL 不是合法地址：${raw}`, hint: '需形如 https://api.deepseek.com/v1' };
  }
  const pathname = u.pathname.replace(/\/+$/, '');
  const lines = [];
  if (!pathname) {
    lines.push(`当前地址没有路径段（${u.origin}），请求会发到 ${u.origin}/chat/completions`);
    lines.push('多数服务需要以 /v1 结尾，例如：');
    lines.push(`  ${u.origin}/v1`);
  }
  return {
    warn: lines.length ? lines.join('\n') : null,
    hint: lines.length ? '如果确认该地址就是不带路径的，可以忽略此提示' : null,
  };
}

/** 拉取 /v1/models 列表，用于“设置”页一键选择模型 */
export async function listModels({ baseUrl, apiKey }, timeout = 20_000) {
  const url = `${String(baseUrl || '').replace(/\/+$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? '（API Key 无效或没有权限）'
        : res.status === 404 ? '（路径不存在，检查 Base URL 是否需要以 /v1 结尾）'
        : '';
      throw new Error(`HTTP ${res.status}${hint}`);
    }
    const data = await res.json().catch(() => {
      throw new Error(`接口返回的不是 JSON，请检查 Base URL 是否指向 OpenAI 兼容端点（通常需要 /v1 结尾）`);
    });
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return list.map(m => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('连接超时') : e;
  } finally {
    clearTimeout(timer);
  }
}

/** 连通性测试：发一条极短的对话，返回耗时与回显（不应用预设） */
export async function testConnection(config) {
  const t0 = Date.now();
  const llm = makeLLM({ ...config, requestTimeout: 30_000 }, null);
  const reply = await llm.chat(
    '你是一个连通性测试助手，只回复两个字：正常',
    '请回复：正常',
    'ping',
    { temperature: 0, retries: 1, maxTokens: 16 }
  );
  return { ok: true, ms: Date.now() - t0, model: config.model, reply: String(reply).trim().slice(0, 80) };
}
