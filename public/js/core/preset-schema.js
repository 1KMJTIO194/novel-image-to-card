/**
 * 生成预设（prompt 附加/替换）—— 纯逻辑，无任何依赖
 *
 * 位置说明：放在 public/ 下是为了让浏览器能直接 import；服务端通过 src/preset.js
 * 转发同一个文件。前后端因此共用一份实现，不会出现「前端校验通过、后端却按
 * 另一套规则合并」的错位。
 *
 * 结构：
 * {
 *   "name": "我的破甲预设",
 *   "description": "...",
 *   "version": "1.0",
 *   "author": "...",
 *   "mode": "append" | "replace",
 *   "global": { "system_suffix": "", "user_suffix": "" },
 *   "steps": {
 *     "step0.5": { "system_suffix": "", "user_suffix": "" },
 *     "step1":   { ... }
 *   }
 * }
 *
 * 合并顺序：global.system_suffix → steps.<name>.system_suffix（依次追加）
 * 模式：
 *   append  追加到原 prompt 末尾（默认、安全）
 *   replace 完全替换原 prompt（高级用法；仍会保留 JSON 输出格式约束，否则解析必崩）
 */

/** 流水线里可配置的 Step 名（与 pipeline.js 中传入的 stepName 一一对应） */
export const STEP_NAMES = ['step0.5', 'step1', 'step2', 'step3', 'step4', 'step5', 'step-batch', 'step8.5'];

/** Step 名的中文说明，用于 UI 与报错信息 */
export const STEP_LABELS = {
  'step0.5': 'user 角色定位',
  step1: '时间线抽取',
  step2: '事件抽取',
  step3: '阶段划分',
  step4: '人设增量',
  step5: '世界观与人物',
  // 分批评析：每批结束时写一段摘要喂给下一批。关掉分批时这个 Step 不会被调用。
  'step-batch': '分批摘要',
  'step8.5': '角色卡字段',
};

/** replace 模式下必须保留的输出格式约束（否则返回不是 JSON，解析必失败） */
const JSON_FORMAT_GUARD = [
  '【输出格式仍必须遵守】',
  '- 只输出合法的 JSON，不要输出任何解释、寒暄或 Markdown 代码围栏',
  '- 字段名、类型与上面要求的 JSON 结构完全一致',
].join('\n');

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const asStr = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 校验预设，返回规范化结果与问题列表。
 * 未知 Step 名只警告（允许跨版本共用预设），结构错误才判为不可用。
 *
 * @returns {{ok:boolean, preset:object|null, errors:string[], warnings:string[], stats:object}}
 */
export function validatePreset(input) {
  const errors = [];
  const warnings = [];

  if (input == null || (typeof input === 'string' && !input.trim())) {
    return { ok: false, preset: null, errors: ['预设为空'], warnings, stats: emptyStats() };
  }

  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { ok: false, preset: null, errors: [`JSON 解析失败：${e.message}`], warnings, stats: emptyStats() };
    }
  }

  if (!isPlainObject(raw)) {
    return { ok: false, preset: null, errors: ['预设必须是 JSON 对象'], warnings, stats: emptyStats() };
  }

  // 至少要有 name / steps / global 之一
  if (!raw.name && !raw.steps && !raw.global) {
    errors.push('预设格式不正确：至少需要 name / steps / global 之一');
  }

  let mode = raw.mode === 'replace' ? 'replace' : 'append';
  if (raw.mode && !['append', 'replace'].includes(raw.mode)) {
    warnings.push(`mode "${raw.mode}" 无法识别，已按 append 处理`);
  }

  const pickSuffixes = (node, where) => {
    const out = {};
    if (node == null) return out;
    if (!isPlainObject(node)) {
      errors.push(`${where} 必须是对象`);
      return out;
    }
    for (const key of ['system_suffix', 'user_suffix']) {
      const v = node[key];
      if (v == null || v === '') continue;
      if (typeof v !== 'string') {
        errors.push(`${where}.${key} 必须是字符串`);
        continue;
      }
      if (v.trim()) out[key] = v;
    }
    const unknown = Object.keys(node).filter(k => !['system_suffix', 'user_suffix'].includes(k));
    if (unknown.length) warnings.push(`${where} 中未识别的字段被忽略：${unknown.join(', ')}`);
    return out;
  };

  const global = pickSuffixes(raw.global, 'global');

  const steps = {};
  if (raw.steps != null) {
    if (!isPlainObject(raw.steps)) {
      errors.push('steps 必须是对象');
    } else {
      for (const [name, node] of Object.entries(raw.steps)) {
        const key = String(name).trim();
        if (!STEP_NAMES.includes(key)) {
          warnings.push(`未知 Step "${key}"（可用：${STEP_NAMES.join(', ')}），该项不会生效`);
          continue;
        }
        const suffix = pickSuffixes(node, `steps.${key}`);
        if (Object.keys(suffix).length) steps[key] = suffix;
      }
    }
  }

  const stats = {
    name: asStr(raw.name) || '未命名预设',
    mode,
    globalCount: Object.keys(global).length,
    stepCount: Object.keys(steps).length,
    steps: Object.keys(steps),
    hasGlobalOnly: Object.keys(global).length > 0 && Object.keys(steps).length === 0,
  };

  if (!stats.globalCount && !stats.stepCount) {
    warnings.push('预设里没有任何 suffix，等价于未启用');
  }
  if (mode === 'replace') {
    warnings.push('replace 模式会替换掉生成器原有的抽取指令，只建议在你自带完整 prompt 时使用');
  }

  const preset = {
    name: asStr(raw.name) || null,
    description: asStr(raw.description) || null,
    version: raw.version == null ? null : String(raw.version),
    author: asStr(raw.author) || null,
    mode,
    global,
    steps,
  };

  return { ok: errors.length === 0, preset: errors.length ? null : preset, errors, warnings, stats };
}

function emptyStats() {
  return { name: '未命名预设', mode: 'append', globalCount: 0, stepCount: 0, steps: [], hasGlobalOnly: false };
}

/**
 * 计算某个 Step 的最终后缀；无内容时返回空串。
 *
 * `stepName` 可以是字符串，也可以是**数组** —— 后者用于"一次调用合并了多个 Step"的场景
 * （例如逐章合并版同时承担 step1 时间线 + step2 事件）。
 * 用户在某个 Step 上配的后缀不能因为调用被合并就静默失效，
 * 所以按数组顺序逐个追加，global 只加一次。
 *
 * @param {object|null} preset
 * @param {string|string[]} stepName
 * @param {'system'|'user'} kind
 */
export function resolveSuffix(preset, stepName, kind) {
  if (!preset) return '';
  const key = kind === 'system' ? 'system_suffix' : 'user_suffix';
  const parts = [];
  const g = preset.global?.[key];
  if (g && String(g).trim()) parts.push(String(g).trim());
  const names = Array.isArray(stepName) ? stepName : [stepName];
  for (const name of names) {
    if (!name) continue;
    const s = preset.steps?.[name]?.[key];
    // 去重：同一个 Step 名重复出现时不要追加两遍（合并配置里手滑就会这样）
    if (s && String(s).trim() && !parts.includes(String(s).trim())) parts.push(String(s).trim());
  }
  return parts.join('\n\n');
}

/** 规范化 mode */
export function presetMode(preset) {
  return preset?.mode === 'replace' ? 'replace' : 'append';
}

/**
 * 把预设作用到一条消息上。
 * @param {string} base 原始 prompt
 * @param {object|null} preset
 * @param {string|string[]} stepName 单个 Step，或"本次调用覆盖的多个 Step"
 * @param {'system'|'user'} kind
 * @param {{json?:boolean}} opts json=true 时 replace 模式会补回输出格式约束
 */
export function applyPreset(base, preset, stepName, kind, { json = false } = {}) {
  const original = String(base ?? '');
  if (!preset) return original;
  const suffix = resolveSuffix(preset, stepName, kind);
  if (!suffix) return original;

  if (presetMode(preset) === 'replace') {
    return json ? `${suffix}\n\n${JSON_FORMAT_GUARD}` : suffix;
  }
  return `${original}\n\n---\n${suffix}`;
}

/**
 * 生成「预设如何生效」的说明，供 UI 展示。
 * 让用户能验证预设确实被应用、应用到了哪些 Step。
 */
export function describePreset(preset) {
  if (!preset) return { active: false, lines: [], mode: 'append', name: null };
  const lines = [];
  const gs = !!preset.global?.system_suffix;
  const gu = !!preset.global?.user_suffix;
  if (gs || gu) {
    lines.push(`global：${[gs && 'system', gu && 'user'].filter(Boolean).join(' + ')} 后缀`);
  }
  for (const name of STEP_NAMES) {
    const node = preset.steps?.[name];
    if (!node) continue;
    const kinds = [node.system_suffix && 'system', node.user_suffix && 'user'].filter(Boolean);
    if (kinds.length) lines.push(`${name}（${STEP_LABELS[name]}）：${kinds.join(' + ')} 后缀`);
  }
  return {
    active: !!preset,
    name: preset.name,
    mode: presetMode(preset),
    replaces: presetMode(preset) === 'replace',
    lines,
    isEmpty: lines.length === 0,
  };
}

/**
 * 预览某个 Step 的最终 prompt（截断显示，避免 UI 卡死）。
 * @returns {{step:string, system:string, user:string, changed:boolean}}
 */
export function previewStep({ preset, stepName, system, user, json = false, maxLen = 1200 }) {
  const finalSystem = applyPreset(system, preset, stepName, 'system', { json });
  const finalUser = applyPreset(user, preset, stepName, 'user', { json });
  const cut = (s) => (s.length > maxLen ? `${s.slice(0, maxLen)}\n…（已截断，共 ${s.length} 字符）` : s);
  return {
    step: stepName,
    system: cut(finalSystem),
    user: cut(finalUser),
    changed: finalSystem !== system || finalUser !== user,
  };
}
