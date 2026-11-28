> 本文是项目 [README](../README.md) 的展开说明；文档索引见 [docs/README.md](README.md)。

# 文本编码自动检测

中文小说常见 **GBK / GB2312 / Big5** 编码，直接按 UTF-8 读取会整篇乱码 ——
LLM 会把人物名读成"无法辨认"、抽取到的事件数骤降。生成器现在会自动识别并转码。

判定优先级（`src/encoding.js`）：

1. **BOM**（UTF-8 / UTF-16LE / UTF-16BE）—— 最可靠，据此解码并剥除 BOM
2. **严格 UTF-8 校验** —— 合法即 UTF-8（中文 UTF-8 很容易被 jschardet 误判成别的编码）
3. **jschardet 检测 + iconv-lite 解码** —— 覆盖 GBK/GB2312/Big5/Shift_JIS/EUC 等
4. **兜底** —— 回退 UTF-8 并记警告，不抛错、不中断生成

细节：

- 置信度 < 0.7 时**仍然解码**，但记一条警告，提示可能出现乱码
- 无法识别 / 编码不支持 / 转码抛错，一律回退 UTF-8 并说明原因
- 转码后自检替换字符比例，超过 2% 会警告"编码可能判断有误"
- `readNovelText()` 返回 `{text, encoding, originalEncoding, confidence, source, bomStripped, transcoded, bytes, warnings}`

生成日志会明确说明处理方式：

```
[Init] 读入 42496 字（73626 字节）
[Init] 检测到编码：GB2312（置信度 0.99），已自动转码
```

结果写入 `meta.json` 的 `sourceEncoding`（编码名、置信度、是否转码、字节数），便于事后排查。

## 上传文件名乱码

multipart 的 `filename` 按 RFC 是 latin1 字节串，multer/busboy 逐字节映射后，
中文名会变成 `é«è´µä»å­...`。生成器会修正它。

但**不是无条件** `latin1 → utf8`：若某天 multer 已按 UTF-8 正确解码，
无条件转换反而会把「测试」破坏成乱码。所以先判断字符串是否"看起来像被 latin1 展开的 UTF-8"
（只含 ≤ 0xFF、转回 UTF-8 后无替换字符、且确实含多字节序列），满足才转码。

`POST /api/upload/name-probe` 可自检：上传任意文件，返回服务端实际收到的名字与修正结果。
