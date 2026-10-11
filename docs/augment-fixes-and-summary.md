# 完善角色卡：三个静默 bug + 变更总结

用户反馈两件事：

1. 「完善已有角色卡」导入已有卡 + 新剧情后**好像没有效果**
2. 希望生成后能**总结增加了什么、改了哪些地方**

第 1 件查出来是**三个静默 bug**（都不报错、只是悄悄丢数据）；第 2 件是新做的功能。

---

## 第一部分：为什么「完善」看起来没效果

`tests/augment.mjs` 的 107 项断言**全部通过** —— 因为它们是纯逻辑测试，
而这三个 bug 都在"LLM 返回值的解析契约"上。只有真跑一遍才会暴露。

### Bug ①：事件返回被包在对象里 → 全部静默丢失

模型实际返回：

```json
{ "type": "json_object", "events": [ { "name": "真法一重圆满", … } ] }
```

而旧代码写的是：

```js
const arr = await llm.chatJSON(S.STEP_2_EVENTS, …);
return Array.isArray(arr) ? arr : [];   // ← 对象 → 返回 []
```

后果：**新事件恒为 0 个**。日志只有一句「新事件 0 个」，
看不出是"模型没抽到"还是"解析失败了"。

值得一提的是：`/api/generate` 那条路径**早就修过同一个坑**，注释里明确写着

> catch 又把真实错误吞掉，于是 0 事件 → 阶段/变量树/世界书事件条目/导演指令全部空转

它用的是 `asArray`。**augment 是当时漏改的那一处。**

修法：抽出 `parseEventsResponse()`，先查容器键（`events`/`items`/`data`/`list`），
再交给 `asArray` 兜底。

> ⚠️ 顺序不能反：外层对象带 `type` 字段，而 `asArray` 的规则是
> "含 name/type/content 的对象视为**单条**条目"，先调它会把整个外壳当成一条事件返回
> （测试抓到了：期望 2 条、实际 1 条）。

### Bug ②：人物档案字段名写错 → 档案恒为 0 份

`STEP_5_CHARACTER` 的模板返回 `{name, keys, content_yaml}`，而旧代码判的是 `content`：

```js
if (!item?.content) return null;      // ← content_yaml 永远不满足
return { name: r.name, keys: […], content: item.content };
```

后果：**新人物档案恒为 0 份**。而且模型明明生成了完整档案
（日志里能看到它返回了 `content_yaml`）。完善角色卡时**一个角色都加不进去**。

修法：抽出 `parseCharacterProfile()`，兼容 `content_yaml` / `content` / `text` / `yaml`。

### Bug ③：事件列表传了空数组 → 事件一条都进不了卡

```js
const wb = assembleWorldbook(timeline, [], characters, worldbookItems, …);
//                                     ↑ 抽取到的事件在这里被丢掉
```

后果：即使前面两个 bug 修好了、事件抽出来了，**`added.event` 仍然是 0**，
卡里 `[event]` 系列始终是原卡那几条。用户感受到的就是"完善了但剧情没推进"。

修法：传真实事件，并把 `storylines` 一起传进去（故事线是按线触发的分段条目）。

### 修复前后对比（同一份新剧情、同一张卡）

| | 修复前 | 修复后 |
| --- | --- | --- |
| 新事件 | **0 个** | **7 个** |
| 新阶段 | 0 个 | 3 个 |
| 新人物档案 | **0 份** | 5 份 |
| 世界观 | 6 条 | 8 条 |
| 卡内 `[event]` 条目 | 7（原卡未变） | **14**（+7） |
| 总条目 | 44 → 50 | 44 → **64** |

### 加了三组回归测试

这三个 bug 都埋在 `runAugment` 内部、只能靠真实调用暴露，
所以把两处易错解析**抽成导出函数**，再用断言钉死：

- `parseEventsResponse`：裸数组 / `{events}` / `{items}` / `{data}` / 空对象 / null / 字符串
- `parseCharacterProfile`：`content_yaml` / `content` / `text` / 纯空白 / null
- `assembleWorldbook(timeline, events, …)` 生成 `[event]` 条目，
  并**反证**传空数组时一条都没有（那就是 bug 的形态）

`tests/augment.mjs` 107 → **128**。

---

## 第二部分：变更总结

用户要看的是「增加了什么、修改了哪些地方」，而不是一串产物文件名。

### 一份渲染器，三种任务共用

`src/summary.js`：

```
summarizeAugment(report)   ← 完善：有 before/after，做真实差异
summarizeGenerate(meta)    ← 从零生成：没有基线，列产出
renderSummaryMarkdown(s)   ← 落盘 SUMMARY.md / 复制 / 展示共用
```

图片生成路径也接进来了，所以**三种任务的总结长得一样、字段一样**，
前端只需要一套展示代码（`public/js/core/summary-view.js`）。

### 完善总结长这样

```markdown
# 完善总结：示例小说 B

- 策略 merge / 处理 3 章（516 字）

## 改动前后

| 项目 | 改动前 | 改动后 | 变化 |
| --- | --- | --- | --- |
| 总条目 | 44 | 64 | +20 |
| 人物 | 11 | 16 | +5 |
| 事件 | 7 | 14 | +7 |
| 世界观 | 11 | 19 | +8 |

## 一句话变化

人物 +5 人 · 事件 +7 个 · 世界观 +8 条 · 总条目 +20 条

## 新增内容（20 项）

- **人物（5）**：叶诺、张婷婷、谢讲师、钱鸿志、张元
- **事件（7）**：闭关功成出关、张元留玉简、谢讲师赠玉镯、解围救钱鸿志、获准炼心路…
- **世界观（8）**：西荒、求道谷、太一宗本宗、炼心路、藏经阁…

## 处理范围（3 章）
## 抽取统计
> 卡片版本 1.0 → 1.1
```

### `after` 统计是必须补的

原来报告里**只有 `before`**，于是"改了多少"只能靠 `added.length` 间接猜 ——
而合并策略下有些内容是**改写**而不是新增，那些变化就看不见了。

现在 `runAugment` 在写完卡之后用 `extractCardStructure(finalCard)` 数一遍最终卡
（**与 `before` 同一口径**，否则差值没有意义）。

### 零变化时说清原因

一份空总结等于没说。所以零新增时会给出具体原因：

| 情况 | 提示 |
| --- | --- |
| 什么都没抽到 | 新剧情里没有抽到任何可入库的内容 —— 检查是否传了正文，或换更强的模型 |
| 抽到了但全重复 | 抽到了内容但全部与已有条目重复（策略为 merge 时会这样） |
| 缺 `after` | 「改动后」的统计缺失，无法给出条目差值 |
| 对齐降级 | 本次未做同名匹配，可能出现重复条目 |

### 展示位置

- **生成页 / 图片生成页**：跑完自动出现在结果区顶部
  （优先用 SSE `files` 事件带回的总结，不必再请求一次）
- **任务与产物页**：新增「变更总结」页签，并放在**第一个** ——
  用户最关心"这次改了什么"，而不只是文件列表
- 支持**复制 Markdown** 与**下载 SUMMARY.md**

历史任务也能看总结：`/api/tasks/:id/summary` 优先读已落盘的 `summary.json`，
旧任务没有就**现场推算**（完善走 `augment_report.json`，生成走 `meta.json`），
所以不需要重跑任务。

### 落盘

三条路径都会写 `summary.json`（结构化，给程序用）+ `SUMMARY.md`（给人看）：

```
output/<taskId>/
  summary.json      结构化总结（前端直接渲染）
  SUMMARY.md        可读 Markdown
```

---

## 测试

| 套件 | 变化 |
| --- | --- |
| `tests/augment.mjs` | 107 → **128**（三个静默 bug 的回归） |
| `tests/summary.mjs` | **新增 52 项**（三种来源、零变化提示、真实报告字段对齐、渲染细节） |

全量 **26 套件 / 2450 断言全绿**。

---

## 一个操作失误，记下来

追加总结的 CSS 时我用了 PowerShell 的 `Add-Content`，**把中文注释写成了无效 UTF-8**
（`read` 工具直接报 "invalid UTF-8 text"）。这是项目里早先记录过的坑，不该再犯。

修法是按**字节**处理：定位损坏的注释块，替换成 ASCII 注释，不动其它内容。
**教训：改项目里的文本文件一律用 `write`/`edit` 工具，不要用 PowerShell 重定向。**
