/**
 * 测试共用工具：从条目正文里提取 MVU 变量路径，并按 `.` 逐层解析。
 *
 * 单独抽出来是因为之前两处测试各写了一遍正则，写法还不一致：
 * 用 `[^\s}]+` 会在路径含 `{` / `}` 时被截断（如 `characters.{大括号}.affinity`
 * 被截成 `characters.{大括号`），于是测试误报"路径取不到"。
 * 宏本身是 `{{get_message_variable::路径}}`，路径里可以合法地含 `{}`，
 * 所以必须用非贪婪匹配到 `}}` 为止。
 */

/** 提取 `{{get_message_variable::stat_data.x.y}}` 里的 `x.y` */
export function extractMvuPaths(text) {
  return [...String(text ?? '').matchAll(/\{\{get_message_variable::stat_data\.(.+?)\}\}/g)]
    .map(m => m[1]);
}

/** 提取 EJS 里 `getvar('stat_data.x.y')` 的 `x.y` */
export function extractGetvarPaths(text) {
  return [...String(text ?? '').matchAll(/getvar\(\s*['"`]stat_data\.([^'"`]+)['"`]/g)]
    .map(m => m[1]);
}

/** 按 `.` 逐层在变量树里取值；取不到返回 undefined（与 MVU 行为一致） */
export function resolvePath(tree, path) {
  let cur = tree;
  for (const seg of String(path).split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 找出取不到值的路径，返回路径数组 */
export function unreachablePaths(tree, paths) {
  return paths.filter(p => resolvePath(tree, p) === undefined);
}
