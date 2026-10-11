# 常驻开销与剧情组织

三条改动的落地记录。核心发现是：**变量树里有很大一块"没人读的状态"，而被每轮都塞进 prompt**。

## 一、最大的发现：B2 的 status 块占了 92%

`buildVariableUpdateRule`（原 B2）会把**每一个变量路径**写进
`<status_current_variables>`，而那个块**每轮都发**。

实测（40 个事件 + 15 个人物，长篇的典型规模）：

```
B2 总长 12139 字符
其中 <status_current_variables> 块 11191 字符 = 92.2%（158/184 行）
```

B 包预算才 3507 tok（≈5000 字符）—— **光这一个块就超预算两倍**。

这才是"把所有剧情都打包到变量中"的真实代价：不是初始变量多大，
而是它们被**每轮**摊进 prompt。

### 改法：`condenseVariablePaths`

- `events` —— 只展开**当前剧情**：ongoing 的那个 + 下一个 pending，其余只列名字
- 其余命名空间 —— 全部展开，但整体行数设上限（80 行），超了折叠成名单

实测结果：

| | 改前 | 改后 | |
| --- | --- | --- | --- |
| B2 总长 | 12,139 | 4,033 | **-67%** |
| status 块 | 11,191 | 3,085 | **-72%** |
| 行数 | 184 | 71 | -61% |

events 段现在长这样：

```
events:
  事件3.status: {{...}}          ← ongoing
  事件3.deviation: {{...}}
  事件3.pressure: {{...}}
  事件1.status: {{...}}          ← 下一个 pending
  事件1.deviation: {{...}}
  事件1.pressure: {{...}}
  # 其余 38 个事件（不在当前剧情里，需要时再查）：事件2、事件4、…
```

**AI 仍知道后面有哪些事件**（名单），但不必每轮复核每一个的
status/deviation —— 那正是用户说的"events 只显示当前剧情就好了"。

⚠️ 顺序要紧：先把 ongoing 收进来，再从**不在集合里**的 pending 里取下一个。
直接取"列表第一个 pending"会把未必是下一个的那个也收进来（第一版就写错了）。

## 二、事件变量：我核实后**没有**动结构

上一轮我评估"events 只放当前剧情"时说收益 5%，结论是前提不成立。这轮又核实了一遍：

- 状态栏的「因缘簿」是**人物关系**分组（`affinity`），**不读 events**
- events 只服务 B3 导演指令（找 ongoing / pending）与 B2 更新循环

所以按事件的裁剪要动的是**上面那个 status 块**，而不是变量树本身。
变量树保持完整是有意的：AI 需要知道完整事件列表才能正确推进与跳转。

## 三、故事线搬进世界书

`custom.storylines` 每线存 `{events, stage, deviation, core}`，其中：

- `stage` 是 `groupByStoryline` 里**硬编码的 `'起点'`**，没有任何代码消费它，
  只有 B2 的更新规则让 AI 去写（写了也没人看）
- `deviation` 是线级汇总，而事件的偏离度已在 `events.<名>.deviation`

等于每张卡都在变量树里供着一份**没有人读的状态**。

### 改法

- `buildVariables` 不再产出 `custom.storylines`
- 新增 `[storyline]` 世界书条目（`constant: false`，**按线触发**）：
  - 触发词 = 线名 + 该线所有事件名
  - 正文给出事件顺序 + 日期 + 压力，便于 AI 理解"这条线走到哪了"
- 清掉两处悬空引用：
  - `templates.js` 的 B2 更新规则不再教 AI 更新
    `custom.storylines.<线名>.deviation/.stage`
  - `step75_statusbar.js` 的 `META_KEYWORDS` 去掉 `storylines`

实测条目：

```
[storyline] 入城立足
  keys: [入城立足, 开篇入城, 初见沈砚]
[storyline] 旧案真相
```

## 四、原著剧情简介

事件条目只讲"某个节点发生了什么"，没有一条讲"整部作品在讲什么"，
AI 写人设与对话容易跑偏。

### 位置与约束

**常驻条目**（`constant: true`，`insertion_order: 2`），因为扮演时每轮都要参考。
常驻 = 每轮都占预算，所以：

- prompt 里限 600–1000 字
- 代码侧再兜一道硬上限 `SYNOPSIS_MAX_CHARS = 1200`

### 不额外花钱

剧情简介需要的信息（事件清单 + 原文节选）与事件条目**完全一样**，
所以搭同一次调用：新增 `STEP_5_EVENT_WITH_SYNOPSIS`，返回
`{events: [...], synopsis: "..."}`，取代原来的纯数组形态。

拆成两次调用等于把同一段原文发两遍。开关 `mergeSynopsisCalls`（默认开），
关掉就走原来的单任务 prompt（此时不产出简介）。

## 五、测试

| 套件 | 变化 |
| --- | --- |
| `tests/robustness.mjs` | "storylines 不为空" → "变量树里**没有** storylines" + "能生成世界书条目" |
| `tests/character-card.mjs` | 路径规范化断言改为不依赖 events 全展开（事件现在折叠成名单） |
| `tests/e2e.mjs` | 新增：[synopsis] 条目存在/常驻/有实质内容/不超上限；storyline 条目存在/带触发词/不常驻；`custom.storylines` 已移除 |

全量 **24 套件 / 2200 断言全绿**。

## 六、未能验证的

- **B2 压缩后的实际效果**：只验证了字符数与结构。AI 在"只看到当前事件详情 +
  其余事件名单"时，是否仍能正确推进（比如把某个远期事件提前触发）——需要真实对话验证。
  若发现 AI 忘了后续事件，把 `condenseVariablePaths` 的 live 集合放宽即可。
- **剧情简介的质量**：假 LLM 只能证明"条目产出了、长度合规"，
  证明不了梗概是否准确覆盖了原著脉络。
- **简介占用预算的体感**：600–1000 字的常驻条目约 400–700 tok。
  B 包上限 3507 tok，实测单卡 B 包约 1579–2132 tok，加上后仍在预算内；
  但**剧情条目特别多**的卡可能顶到上限，届时需要调小 `SYNOPSIS_MAX_CHARS`。
