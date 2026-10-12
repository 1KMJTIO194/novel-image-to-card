/**
 * 请求信任栅栏。
 *
 * 为什么必须加（实测）：
 *   DSH 自己的路由对非授权请求返回 401，而**插件注册的路由完全不受那套校验保护**。
 *   实测 `GET /` → 401 而 `GET /novel2card/meta` → 200，就是这个原因。
 *
 * 本插件的风险尤其实在：
 *   · `POST /novel2card/generate` 接收 **API Key**（baseUrl 也由调用方指定）
 *   · `GET /novel2card/file` 能读出已生成的角色卡（含用户的小说内容）
 *   如果 DSH 部署在非回环地址（反代 / 局域网 / `0.0.0.0`），
 *   任何能访问该端口的人都能借这台机器跑生成、并指定把请求发去哪里 —— 等于凭据外带。
 *
 * 策略（与社区插件 whale-widget 生产加固后的做法一致，三层）：
 *   ① 本机判定：Host 必须是回环 → **写请求强制**（读请求可由宿主栅栏放行）
 *   ② 跨站判定：`Sec-Fetch-Site: cross-site`、或 Origin 与 Host 不同源 → 一律拒
 *   ③ 委托宿主：`connection.requestRejection(req)`（它知道 DSH 自己的 --trusted-host）
 *
 * 全部 **fail-closed**：校验器自身出错时按拒绝处理，而不是静默放行。
 */

/** 写方法：改状态 / 花凭据的，必须来自本机 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 额外的可信主机（逗号分隔，可带端口）。
 * 默认空 —— 即"只允许本机"。部署在反代后面又确实需要时再显式声明。
 */
function trustedHosts() {
  return String(process.env.NOVEL2CARD_TRUSTED_HOSTS || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 是否回环主机名。
 *
 * ⚠️ 逐段校验 127.x.x.x，而不是 `startsWith('127.')` ——
 * 后者会放过 `127.0.0.1.evil.com` 这类相似域名。
 */
export function isLoopbackHostname(hn) {
  const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  if (Number(m[1]) !== 127) return false;
  return [m[2], m[3], m[4]].every(x => Number(x) <= 255);
}

/**
 * @param {object} req Node 请求
 * @param {{fenceAvailable?:boolean}} [opts] fenceAvailable：宿主栅栏此刻是否可用
 * @returns {number|null} 通过 → null；否则返回应当拒绝的 HTTP 状态码
 */
export function selfRejection(req, opts = {}) {
  try {
    const headers = (req && req.headers) || {};

    // Host 缺失或畸形 → 拒（fail-closed）
    let hostUrl;
    try { hostUrl = new URL(`http://${String(headers.host || '')}`); } catch { return 403; }
    const hostname = hostUrl.hostname;
    const authority = hostUrl.host;

    if (!isLoopbackHostname(hostname)) {
      const listed = trustedHosts().some(e => (e.includes(':') ? e === authority.toLowerCase() : e === hostname.toLowerCase()));
      // 非回环：显式声明过就放行；否则只有宿主栅栏可用时才"交给它判"
      if (!listed && !opts.fenceAvailable) return 403;
    }

    // 这两条与可信列表无关，任何情况都执行

    // ① 浏览器明确标记为跨站
    if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return 403;

    // ② Origin 与 Host 不同源（防"任意网页 fetch localhost"）
    const origin = headers.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      let originUrl;
      try { originUrl = new URL(origin); } catch { return 403; }
      if (originUrl.host.toLowerCase() !== authority.toLowerCase()) return 403;
    }

    return null;
  } catch {
    return 403;   // 校验器自身出错 → 拒绝，不静默放行
  }
}

/**
 * 写请求必须来自本机。
 *
 * 只读接口不受影响（局域网里仍能看），但"花凭据 / 改状态"的必须绑定"坐在这台机器前"。
 */
export function writeRejection(req) {
  try {
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (!WRITE_METHODS.has(method)) return null;

    let hostUrl;
    try { hostUrl = new URL(`http://${String((req.headers || {}).host || '')}`); } catch { return 403; }
    if (isLoopbackHostname(hostUrl.hostname)) return null;

    const authority = hostUrl.host.toLowerCase();
    const hostname = hostUrl.hostname.toLowerCase();
    if (trustedHosts().some(e => (e.includes(':') ? e === authority : e === hostname))) return null;

    if (!writeRejection.warned) {
      writeRejection.warned = true;
      try {
        console.warn(`[novel2card] 已拒绝一个来自非本机的写请求（Host=${authority}）。`
          + '生成接口接收 API Key 且可由调用方指定 baseUrl，所以改状态的请求只能在本机发起。'
          + '确需远端使用，请用环境变量 NOVEL2CARD_TRUSTED_HOSTS 声明允许的主机。');
      } catch { /* 忽略 */ }
    }
    return 403;
  } catch {
    return 403;
  }
}

/**
 * 组合判定：通过 → null，否则返回状态码。
 *
 * @param {object} req
 * @param {{fence?:object|null}} opts fence：`connection` 服务（含 requestRejection）
 */
export function requestRejection(req, { fence } = {}) {
  const fenceAvailable = !!(fence && typeof fence.requestRejection === 'function');

  // ① 自校验（回环 / 跨站 / 同源）
  const self = selfRejection(req, { fenceAvailable });
  if (self !== null) return self;

  // ② 写请求必须本机（与栅栏是否可用无关）
  const write = writeRejection(req);
  if (write !== null) return write;

  // ③ 没有栅栏可委托：自校验已经过了，放行
  if (!fenceAvailable) return null;

  // ④ 委托宿主信任栅栏；它抛异常按拒绝处理
  try {
    const code = fence.requestRejection(req);
    if (code === undefined || code === null || code === false) return null;
    return typeof code === 'number' ? code : 403;
  } catch (e) {
    try { console.warn(`[novel2card] 宿主信任栅栏抛异常，已按拒绝处理：${e.message}`); } catch { /* 忽略 */ }
    return 403;
  }
}
