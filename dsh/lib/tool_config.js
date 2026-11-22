/**
 * Agent 工具用的模型接口配置。
 *
 * 为什么需要单独一份：
 *   面板把 baseUrl / apiKey / model 存在浏览器 localStorage 里 —— 那只对"人点面板"有效。
 *   DSH 聊天里的工具调用发生在宿主进程，**读不到浏览器的 localStorage**。
 *   所以用户需要在面板点一次「保存为工具默认配置」，把这三项落到插件数据目录，
 *   工具侧再从这里读。
 *
 * 安全：
 *   · 文件落在插件自己的数据根下（`~/.dsh/novel2card/tool-config.json`），
 *     不进 profile 的 cordis.patch.yml（那是用户文件，别的插件也在用）。
 *   · 写文件时用 0600（Windows 上不生效，但至少 Linux/macOS 收紧了权限）。
 *   · 日志 / 工具结果里只回显 **hasApiKey**，绝不回显 key 本身。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 配置文件名（在插件数据根目录下） */
export const TOOL_CONFIG_FILE = 'tool-config.json';

export function toolConfigPath(baseDir) {
  return path.join(baseDir, TOOL_CONFIG_FILE);
}

/** 读配置；不存在/损坏时返回 null（不抛错，调用方决定怎么提示） */
export async function readToolConfig(baseDir) {
  try {
    const raw = await readFile(toolConfigPath(baseDir), 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') return null;
    return {
      baseUrl: String(cfg.baseUrl || '').trim(),
      apiKey: String(cfg.apiKey || '').trim(),
      model: String(cfg.model || '').trim(),
    };
  } catch {
    return null;
  }
}

/** 保存配置（只存这三个字段），返回脱敏视图 */
export async function writeToolConfig(baseDir, input = {}) {
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(input.apiKey || '').trim();
  const model = String(input.model || '').trim();
  if (!baseUrl) throw new Error('baseUrl 不能为空');
  if (!model) throw new Error('model 不能为空');
  await mkdir(baseDir, { recursive: true });
  await writeFile(toolConfigPath(baseDir), JSON.stringify({ baseUrl, apiKey, model }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return maskToolConfig({ baseUrl, apiKey, model });
}

/** 脱敏视图（可以安全地回给客户端 / 工具结果） */
export function maskToolConfig(cfg) {
  if (!cfg || (!cfg.baseUrl && !cfg.model)) return { configured: false };
  return {
    configured: true,
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    hasApiKey: !!cfg.apiKey,
  };
}

/** 是否指向本机服务（本机服务通常不需要 key） */
function looksLocal(baseUrl) {
  return /^(https?:\/\/)?(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)(:|\/|$)/i
    .test(String(baseUrl || '').trim());
}

/**
 * 解析一次工具调用实际要用的接口配置。
 *
 * 优先级：工具参数 > 保存的默认配置 > 环境变量。
 * 这是"显式覆盖"的常见直觉：调用方指定了就按它来。
 *
 * @param {object} args 工具参数（可含 baseUrl / apiKey / model）
 * @param {object|null} fileCfg 保存的默认配置
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{baseUrl:string, apiKey:string, model:string}}
 */
export function resolveLLMConfig(args = {}, fileCfg = null, env = process.env) {
  const baseUrl = String(args.baseUrl || fileCfg?.baseUrl || env.NOVEL2CARD_BASE_URL || '')
    .trim().replace(/\/+$/, '');
  const apiKey = String(args.apiKey || fileCfg?.apiKey || env.NOVEL2CARD_API_KEY || '').trim();
  const model = String(args.model || fileCfg?.model || env.NOVEL2CARD_MODEL || '').trim();

  if (!baseUrl || !model) {
    throw new Error(
      '没有可用的模型接口配置。请在面板「模型接口设置」里点「保存为工具默认配置」，'
      + '或给工具传 baseUrl / model（本机服务可免 apiKey）。',
    );
  }
  if (!apiKey && !looksLocal(baseUrl)) {
    throw new Error(
      '缺少 API Key：请在面板「模型接口设置」里点「保存为工具默认配置」，'
      + '或给工具传 apiKey。',
    );
  }
  return { baseUrl, apiKey, model };
}
