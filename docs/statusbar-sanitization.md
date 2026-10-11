# 状态栏 / 正文美化的背景为什么是透明的

一次真实故障的完整排查记录。结论是 **SillyTavern 的消息消毒流程有两条会静默改写我们 CSS 的规则**，
我们的类名与选择器都踩了。

## 症状

卡导入 SillyTavern 后，状态栏与正文卡片**背景是透明的**，没有渐变、没有卡片底色。

## 复现与定位过程

### 第一步：确认 HTML 本身是对的

生成的状态栏 HTML 与 `statusbar_preview.html` 里背景渐变都在：

```
body{
  background:linear-gradient(145deg,#141414 0%,#232323 100%);   ← 看着没问题
}
```

所以问题不在生成侧，在**渲染侧**。

### 第二步：看注入位置

状态栏与正文美化的 HTML 都是**完整文档**（`<!DOCTYPE html><html><head><body>`），
但它们被作为 ST 正则的 `replaceString` 注入到 `.mes_text` 里。用 jsdom 验证：

```
当作消息内容解析后：
  .mes_text 内的 <div class="pm-card-container">: true
  .mes_text 内的 <body>: 0            ← body 标签被解析器丢掉
```

完整文档嵌套进已有文档时，`<html>/<head>/<body>` 会被解析器丢弃。

### 第三步：读 ST 源码，找到两条改写规则

`public/script.js` 的 `messageFormatting` 结尾：

```js
mes = encodeStyleTags(mes);                                  // <style> → <custom-style>（URL 编码）
mes = DOMPurify.sanitize(mes, config);
mes = decodeStyleTags(mes, { prefix: '.mes_text ' });         // ← 关键
```

**规则 A · class 被强行加前缀**（`chats.js` 的 `uponSanitizeAttribute`）：

```js
case 'class': {
  data.attrValue = data.attrValue.split(' ').map((v) => {
    if (v.startsWith('fa-') || v.startsWith('note-') || v === 'monospace') return v;
    return 'custom-' + v;          // ← 所有 class 变成 custom-<原名>
  }).join(' ');
}
```

**规则 B · 每个 CSS 选择器被加 `.mes_text ` 前缀**（`decodeStyleTags`）：

```js
rule.selectors[i] = prefix + sanitizeSelector(selector);   // prefix = '.mes_text '
```

### 第四步：两条规则各自造成的破坏

| 我们写的 | ST 改写后 | 结果 |
| --- | --- | --- |
| `class="panel-container"` | `class="custom-panel-container"` | CSS 里 `.panel-container` 选不到 → **面板全部样式丢失** |
| `.panel-container{...}` | `.mes_text .panel-container{...}` | 前缀后仍能匹配后代 ✓ |
| `body{background:...}` | `.mes_text body{...}` | `.mes_text` 里没有 `body` → **整页背景永不生效** |
| `:root{--accent-primary:...}` | `.mes_text :root{...}` | `:root` 是文档根、不可能是后代 → **所有 `var()` 落空** |

第四行是最隐蔽的：CSS 变量定义失效后，**所有**用到 `var(--accent-primary)` 的规则
（边框、标题色、底纹）一起失效，而 CSS 本身语法完全合法、控制台不报错。

## 修法

### 1. 所有 class 统一带 `custom-` 前缀

HTML 的 class 与 CSS 的选择器都写 `custom-xxx`，两种情况下都对：

- ST 加了前缀 → `custom-panel-container` === `.custom-panel-container` ✓
- ST 没加前缀 → 两边都是 `custom-panel-container` 自身 ✓

（不能只在一侧加：那样要么全丢、要么全不匹配。改动 class 必须两边同时改。）

### 2. 背景与 CSS 变量从 `body` / 文档根选择器挪到**容器**上

```css
/* 改前：前缀化后永不匹配 */
body{ background:linear-gradient(...) }
:root{ --accent-primary:#64ffda }

/* 改后：容器是 .mes_text 的后代，前缀化后正常匹配 */
.custom-panel-container{
  --accent-primary:#64ffda;
  background:linear-gradient(...);
}
.custom-panel-container::before{ /* 底纹 */ }
```

`buildBodyBeautify` 同样处理：背景、字体、颜色全部挂到 `.custom-pm-card-container`。

## 加了两道校验（防止再犯）

两条规则都不报错、只是静默失效，所以只能靠校验拦下来。
两者都接进了 `validateStatusbar`（**errors** 级）：

```js
checkClassPairing(html)        // HTML 用到的 class 在 CSS 里有没有同名选择器
checkPrefixedSelectors(html)   // 有没有 body / html / 文档根 这类前缀化后必死的选择器
```

`checkClassPairing` 上线后立刻抓出一个**真的无用 class**：`custom-record-card`
在 HTML 里挂了但 CSS 里从来没有它的规则 —— 已去掉。

## 测试

`tests/statusbar.mjs` 从 228 增至 **267** 项，逐主题断言：

- HTML 的 class 与 CSS 选择器一一对应
- 所有 class 都带 `custom-` 前缀
- 没有前缀化后永不匹配的选择器
- 背景渐变与 CSS 变量都挂在容器上
- 正文美化没有 `body` 选择器，背景/字体挂在容器上

全量 **24 套件 / 2239 断言全绿**。

## 未能验证的

- **真机效果**：沙箱里没有真实 SillyTavern，只做到了"按 ST 源码的规则推导 + 生成侧自检"。
  没有实际导入一张卡确认背景渲染出来。
- **ST 版本差异**：class 前缀与选择器前缀这两条规则读自本机 `release` 分支源码。
  其他版本若行为不同，`custom-` 前缀方案仍然成立（两边一致即可），
  但 `checkPrefixedSelectors` 的判据可能需要跟着调。
- **`DOMPurify` 是否放行 `<style>`**：配置里只 `ADD_TAGS: ['custom-style']`、
  没有 `FORBID_TAGS: ['style']`，所以按 DOMPurify 默认推断 `<style>` 是放行的。
  若某个版本禁止了 `<style>`，那整套内联样式方案都需要改成 style 属性 —— 这个没验证。
