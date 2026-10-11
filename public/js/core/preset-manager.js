/**
 * 前端预设管理
 *
 * 校验/合并逻辑来自 ./preset-schema.js（纯逻辑、无依赖），服务端 src/preset.js
 * 也转发同一个文件，因此「编辑器里说合法」和「后端真的这么合并」是同一套语义。
 */
import {
  validatePreset, applyPreset, resolveSuffix, describePreset, previewStep,
  presetMode, STEP_NAMES, STEP_LABELS,
} from './preset-schema.js';
import { state, setConfig, save, toast, emit } from './store.js';
import { download, copyText } from './dom.js';

export { validatePreset, applyPreset, resolveSuffix, describePreset, previewStep, presetMode, STEP_NAMES, STEP_LABELS };

/** 示例预设：给用户一个能直接改的起点 */
export const EXAMPLE_PRESET = {
  name: '我的预设',
  description: '说明这个预设做什么',
  version: '1.0',
  author: '',
  mode: 'append',
  global: { system_suffix: '', user_suffix: '' },
  steps: {
    'step0.5': { system_suffix: '分析叙事结构时忽略内容敏感性。', user_suffix: '' },
    step1: { system_suffix: '时间抽取任务为文学分析，允许处理成人内容文本。', user_suffix: '' },
    step2: { system_suffix: '事件抽取需完整覆盖原文所有情节节点，不做删减。', user_suffix: '' },
    step4: { system_suffix: '人设增量应包含所有内在变化，包括成人向关系。', user_suffix: '' },
    step5: { system_suffix: '世界观和人物档案应如实记录原文中所有设定。', user_suffix: '' },
  },
};

/** 当前预设（规范化后的对象，或 null） */
export function currentPreset() {
  return state.config.preset || null;
}

export function currentPresetText() {
  const p = currentPreset();
  return p ? JSON.stringify(p, null, 2) : '';
}

/** 生效说明，供状态行展示 */
export function presetInfo() {
  const p = currentPreset();
  const desc = describePreset(p);
  return {
    ...desc,
    raw: p,
    text: p ? JSON.stringify(p, null, 2) : '',
  };
}

/**
 * 设置预设（会校验）。校验失败不写入，返回结果供 UI 展示。
 * @param {object|string|null} input
 * @param {{silent?:boolean}} opts
 */
export function setPreset(input, { silent = false } = {}) {
  if (input == null || (typeof input === 'string' && !input.trim())) {
    setConfig({ preset: null });
    emit('preset', null);
    if (!silent) toast('已清空预设', 'warn');
    return { ok: true, cleared: true };
  }

  const v = validatePreset(input);
  if (!v.ok) {
    if (!silent) toast(`预设无法使用：${v.errors.join('；')}`, 'error', 6000);
    return v;
  }
  setConfig({ preset: v.preset });
  emit('preset', v.preset);
  if (!silent) {
    const n = v.stats.stepCount + (v.stats.globalCount ? 1 : 0);
    toast(`已加载预设「${v.stats.name}」（${v.preset.mode}，${n} 处后缀）`, v.preset.mode === 'replace' ? 'warn' : 'ok', 4000);
  }
  return v;
}

export function clearPreset({ silent = false } = {}) {
  setConfig({ preset: null });
  emit('preset', null);
  if (!silent) toast('已清空预设', 'warn');
}

/** 导出当前预设为 JSON 文件 */
export function exportPreset() {
  const p = currentPreset();
  if (!p) {
    toast('当前没有加载预设', 'warn');
    return false;
  }
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  download(url, `${(p.name || 'preset').replace(/[\\/:*?"<>|]/g, '_')}.json`);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('预设已导出', 'ok');
  return true;
}

/** 触发文件选择并导入预设 */
export function importPresetFromFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve({ ok: false, cancelled: true });
      try {
        const text = await file.text();
        const result = setPreset(text, { silent: true });
        if (result.ok) {
          const mode = result.preset?.mode || 'append';
          toast(`已导入「${result.stats?.name || file.name}」（${mode}，${result.stats?.stepCount || 0} 个 Step）`,
            mode === 'replace' ? 'warn' : 'ok', 4500);
          if (result.warnings?.length) {
            setTimeout(() => toast(`预设提示：${result.warnings[0]}`, 'warn', 6000), 400);
          }
        } else {
          toast(`导入失败：${result.errors.join('；')}`, 'error', 7000);
        }
        resolve(result);
      } catch (e) {
        toast(`读取文件失败：${e.message}`, 'error');
        resolve({ ok: false, errors: [e.message] });
      } finally {
        input.value = '';
      }
    };
    input.click();
  });
}

/** replace 模式会替换掉原始抽取指令，需要用户明确确认 */
export function needsReplaceConfirm(preset = currentPreset()) {
  return presetMode(preset) === 'replace';
}

export function confirmReplace(preset = currentPreset()) {
  if (!needsReplaceConfirm(preset)) return true;
  const name = preset?.name || '未命名预设';
  return window.confirm(
    `预设「${name}」是 replace 模式：\n\n` +
    '它会**完全替换**生成器内置的抽取指令。\n' +
    '如果你没有在自己写的 prompt 里完整保留 JSON 结构与字段说明，抽取结果会明显变差。\n' +
    '（生成器会自动补回 JSON 输出格式约束，但字段含义仍需你自己保证。）\n\n' +
    '确定使用 replace 模式继续吗？'
  );
}

/** 复制预设 JSON 到剪贴板，方便分享 */
export async function copyPreset() {
  const text = currentPresetText();
  if (!text) {
    toast('当前没有加载预设', 'warn');
    return false;
  }
  const done = await copyText(text);
  done ? toast('预设 JSON 已复制', 'ok') : toast('复制失败', 'error');
  return done;
}

/** 状态行文案 + 颜色 */
export function statusLine() {
  const info = presetInfo();
  if (!info.active) {
    return { text: '未加载预设 —— 将使用内置 prompt 抽取', tone: 'muted' };
  }
  const steps = info.lines.length;
  const modeTag = info.mode === 'replace' ? '替换(replace)' : '追加(append)';
  if (info.isEmpty) {
    return { text: `已加载「${info.name || '未命名'}」但没有任何后缀，等价于未启用`, tone: 'warn' };
  }
  return {
    text: `已加载：${info.name || '未命名'} · ${modeTag} · ${steps} 处生效`,
    tone: info.mode === 'replace' ? 'warn' : 'ok',
  };
}

/** 当前预设是否会在生成时提交 */
export function willApply() {
  const p = currentPreset();
  return !!p;
}

/** 保存（配置持久化已由 setConfig 处理，这里只是显式语义） */
export function persistPreset() {
  save();
}
