/**
 * 生成预设（prompt 附加/替换）
 *
 * 实现放在 public/js/core/preset-schema.js —— 该模块是纯逻辑、无任何依赖，
 * 浏览器与 Node 都能直接加载，前后端因此共用**同一份**校验与合并代码，
 * 不会出现「前端说合法、后端却按另一种规则合并」的错位。
 *
 * 这里只做转发，保持服务端 `import ... from './preset.js'` 的路径稳定。
 */
export {
  STEP_NAMES,
  STEP_LABELS,
  validatePreset,
  resolveSuffix,
  presetMode,
  applyPreset,
  describePreset,
  previewStep,
} from '../public/js/core/preset-schema.js';
