/**
 * 最小 multipart/form-data 解析器。
 *
 * 为什么自己写而不用 multer：DSH 宿主进程里没有 express，装 multer 还得把它
 * 声明成本插件的 dependency 再由 profile 的 pnpm 拉一次 —— 为了三个字段的
 * 表单不值得。这里只做「按 boundary 切段、取 name/filename、读内容」这几件事，
 * 不处理嵌套、不处理多值同名（用不到）。
 *
 * ⚠️ 只用于本插件的上传端点，输入来自本机浏览器。
 */

/** 从 Content-Type 取出 boundary */
export function getBoundary(contentType = '') {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType));
  const b = m ? (m[1] || m[2]) : null;
  return b ? b.trim() : null;
}

/**
 * 读满整个请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} [maxBytes] 超过就抛错（避免一个超大请求把内存吃光）
 * @returns {Promise<Buffer>}
 */
export async function readBody(req, maxBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const err = new Error(`请求体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB`);
      err.code = 'BODY_TOO_LARGE';
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 解析 multipart 正文。
 *
 * @param {Buffer} body
 * @param {string} boundary
 * @returns {Array<{name:string, filename:string|null, contentType:string|null, data:Buffer}>}
 */
export function parseMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let pos = 0;

  while (pos < body.length) {
    // 每段以 --boundary 开头
    const start = body.indexOf(delim, pos);
    if (start < 0) break;
    let cursor = start + delim.length;

    // 结束标记：--boundary--
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) break;
    // 跳过 CRLF
    if (body[cursor] === 0x0d && body[cursor + 1] === 0x0a) cursor += 2;
    else cursor += 1;

    // 头部到空行为止
    const headerEnd = body.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) break;
    const rawHeaders = body.slice(cursor, headerEnd).toString('utf-8');
    const dataStart = headerEnd + 4;

    // 段内容到下一个 --boundary 之前（要去掉尾部 CRLF）
    const next = body.indexOf(delim, dataStart);
    const dataEnd = next < 0 ? body.length : next;
    let sliceEnd = dataEnd;
    if (body[sliceEnd - 2] === 0x0d && body[sliceEnd - 1] === 0x0a) sliceEnd -= 2;

    const headers = {};
    for (const line of rawHeaders.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const cd = headers['content-disposition'] || '';
    const nameM = /name="([^"]*)"/i.exec(cd);
    const fileM = /filename="([^"]*)"/i.exec(cd);

    parts.push({
      name: nameM ? nameM[1] : '',
      filename: fileM ? fileM[1] : null,
      contentType: headers['content-type'] || null,
      data: body.slice(dataStart, sliceEnd),
    });

    pos = dataStart;
  }
  return parts;
}

/**
 * 把 multipart 结果整理成 `{ fields, files }`。
 * 文本字段按 UTF-8 解码；文件保留 Buffer 与原始文件名。
 */
export function collectMultipart(parts) {
  const fields = {};
  const files = [];
  for (const p of parts) {
    if (!p.name) continue;
    if (p.filename !== null) {
      files.push({ field: p.name, filename: p.filename, contentType: p.contentType, data: p.data });
    } else {
      fields[p.name] = p.data.toString('utf-8');
    }
  }
  return { fields, files };
}
