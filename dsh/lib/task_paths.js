/**
 * 任务产物路径规则 —— HTTP 路由与 Agent 工具共用一份实现。
 *
 * 为什么单独抽出来：
 *   插件有两条调用路径：面板（HTTP）和 DSH 聊天里的工具。两边都要
 *   "由 taskId 定位产物目录、只允许读白名单文件"。这种安全边界**不能有第二份实现**，
 *   否则一边修了另一边漏。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 任务 id 的形态：`task_<毫秒时间戳>`（见 lib/tasks.js 的 newTaskId） */
export const TASK_ID_RE = /^task_\d{6,}$/;

/**
 * 任务目录下允许被定位/读取的文件名。
 *
 * 刻意用白名单：taskId 只挡目录穿越，文件名还得再挡一次 ——
 * 否则 `../`、`C:\`、UNC、无扩展名文件都可能被读出来。
 */
export const SAFE_FILE_RE = /^[\w.\-]+\.(json|jsonl|md|html|txt|yaml|yml|webp|png|jpe?g)$/i;

/**
 * 由 taskId 解析出产物目录（不依赖内存里的 job）。
 *
 * 插件重载后内存任务表是空的，但产物仍躺在磁盘上 —— 用户仍然要能
 * "看看刚才生成的角色卡在哪"，工具也要能读旧任务。
 *
 * @param {string} baseDir 插件数据根目录
 * @param {string} taskId
 * @returns {string|null} 绝对路径；id 形态不合法 / 不在数据根下 / 目录不存在时返回 null
 */
export function resolveTaskDir(baseDir, taskId) {
  const id = String(taskId || '').trim();
  if (!TASK_ID_RE.test(id)) return null;
  const root = path.resolve(baseDir);
  const dir = path.join(root, 'output', id);
  if (!dir.startsWith(root + path.sep)) return null;
  return existsSync(dir) ? dir : null;
}

/**
 * 校验并解析"产物文件"的绝对路径。
 *
 * @param {string} baseDir
 * @param {string} taskId
 * @param {string} file
 * @returns {string} 绝对路径
 */
export function resolveArtifactPath(baseDir, taskId, file) {
  const name = String(file || '').trim();
  if (!SAFE_FILE_RE.test(name)) throw new Error(`文件名不在允许清单内：${name || '(空)'}`);
  const dir = resolveTaskDir(baseDir, taskId);
  if (!dir) throw new Error(`找不到任务产物目录：${taskId || '(空)'}`);
  const target = path.resolve(dir, name);
  if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error('非法文件名');
  if (!existsSync(target)) throw new Error(`产物文件不存在：${name}`);
  return target;
}
