> 本文是项目 [README](../README.md) 的展开说明；文档索引见 [docs/README.md](README.md)。

# 产物说明与导入步骤

## 推荐：一次导入

`character_card.json` 是完整的 **chara_card_v3** 角色卡，把世界书、EJS 更新规则、
事件系统、正则、MVU 变量全部装进一个文件。SillyTavern → 角色 → 导入，选它即可。

需要**酒馆助手扩展 + MVU 扩展**才能完整生效；只装原版 ST 也能用，
只是 EJS 会显示为纯文本（不会崩）。

## 导入后必须做的三件事（漏掉任何一件都会"静默失效"）

这三件事的共同点是：**不报错**，但效果明显不对，而且很难自己诊断。所以卡片会把这份清单写进
`data.creator_notes`，导入后在角色信息面板里就能看到。

| # | 做什么 | 漏掉的后果 |
| --- | --- | --- |
| ① | **打开角色面板时弹窗 → 点「是」**（`Would you like to import it now?`）导入内嵌世界书 | 时间线、变量更新规则、导演指令、事件/人物条目**一条都不会进提示词** → 模型完全不理原著、自己乱编。补救：More… 菜单 →「Import Card Lore」 |
| ② | 保持 `[initvar]勿启用` 条目**关闭** | 开启后它会被当作普通世界书条目发给 AI（MVU 是按条目名匹配读取的，不看开关） |
| ③ | **首次加载角色时弹窗 → 点「是」**放行卡内嵌正则（`Would you like to allow using them?`） | 回复末尾的 `<update>` 标签会原样留在上下文里发给模型，既占 token 又被当成范例模仿。补救：扩展面板 → Regex → 打开该角色的 Scoped 开关 |

两个弹窗**每个角色只出现一次**，点过「否」就不会再弹，所以第一次就要点对。
另外**群聊不执行角色自带的局部正则**，请用单人聊天。

一个常见的装错扩展：EJS 里的 `getvar('stat_data.…')` 用的是 MVU 的变量命名空间，
只有**酒馆助手**提供。换成 Prompt Template 等其它 EJS 扩展时，变量会全部读不到并静默走默认值
（时间显示"未知"、阶段恒为"起始"、事件永不推进），同样不报错。

| 部位 | 内容 |
| --- | --- |
| `data.character_book` | 世界书容器：`name` / `description` / `scan_depth` / `token_budget` / `recursive_scanning` / `entries`（与 ST 独立世界书 JSON 同一套字段约定） |
| `data.character_book.entries` | 全部世界书条目：时间线、变量更新规则、变量更新强调、导演指令、角色阶段、围栏与隔离、输出纪律、干预与偏离度、世界观常驻/触发、人物、事件 |
| `data.extensions.regex_scripts` | 1 条正则：从显示与提示词中隐藏 `<update>` 标签 |
| `data.extensions.tavern_helper` | 酒馆助手脚本与变量（`scripts` / `variables`） |
| `data.extensions.world` | 指向内嵌世界书名 |
| `data.creator_notes` | 导入说明（ST 会在角色信息面板展示）：需要哪些扩展、导入后要确认什么 |
| 顶层 ↔ `data.*` | `name` / `description` / `personality` / `scenario` / `first_mes` / `alternate_greetings` / `mes_example` / `tags` 两处保持一致（兼容只读顶层字段的老实现） |

三条硬约束（有测试守着）：

- **`[initvar]勿启用` 条目 `enabled: false`** —— 它只供 MVU 读取初始变量，不参与提示词；启用会污染上下文
- **EJS 不转义** —— 含 `<%_ ... _%>` 的条目内容原样保留（`JSON.stringify` 不转义 `<`、`>`），由酒馆助手运行时渲染
- **`first_mes` 不含状态栏 HTML** —— 状态栏由 AI 每轮输出

## 与 MVU 约定的对齐（易错点）

`[initvar]` 条目的 YAML **顶层直接就是变量名，不写 `stat_data` 包裹层**：

```yaml
world:
  time: 天启三年春
events:
  开篇入城:
    status: pending
```

而取值侧（EJS 的 `getvar()`、MVU 宏 `{{get_message_variable::…}}`）**必须带 `stat_data.` 前缀**——
`stat_data` 是 MVU 运行时的变量根，不是 YAML 里的一层。两侧写法不能对调。
本项目的测试会逐条核对：更新规则里的每条路径都能在 `[initvar]` 里真正取到。
依据：[络络《设置和初始化变量》](https://stagedog.github.io/络络/教程/手写mvu变量卡/设置和初始化变量/)（条目名须含 `[initvar]` 且必须处于禁用状态）、[《附.手写变量结构》](https://stagedog.github.io/络络/教程/手写mvu变量卡/手写变量结构/)。

## 条目顺序保证

`insertion_order` 在整卡内**全局唯一且单调递增**：内置规则 1–9 → 世界观常驻 11 起 → 人物 → 事件 →
世界观 key 触发条目（按 `CATEGORY_ORDER` 的相对次序平移）。

这样做的原因：`CATEGORY_ORDER` 的原始数值是 5~30，直接当 `insertion_order` 用会和内置条目撞号
（`map_world=5` 撞「导演指令」、`system_realm=6` 撞「角色阶段」、`system_faction=8` 撞「输出纪律」）。
ST 对同 `insertion_order` 的条目**没有稳定排序保证**，撞号会让常驻规则被挤乱、提示词超预算时"先丢谁"变成随机的。

## ⚠️ EJS 条目必须写在**单个**标签里（踩过的坑）

`<%_ ... _%>` 只是「去空白」的普通 EJS 标签，**每个标签内容仍是独立语句块**，
EJS 会在标签之间插入 `__append(...)` 输出语句。所以下面这种写法是**语法错误**：

```ejs
<%_ const 表 = { _%>
<%_   '起始': `无变化`, _%>
<%_ }; _%>
```

展开后是 `const 表 = { __append("\n") '起始': `无变化`, __append("\n") };`
→ `SyntaxError: Unexpected token ';' while compiling ejs`（真实 ejs 3.1.9 实测）。

「角色阶段」条目曾经就是这么写的，而且是 `constant: true` 常驻条目 ——
装上酒馆助手后每次组装提示词都会抛错。**所有静态断言都测不出来**（它们只检查 `<%_` 没被转义），
所以现在 `tests/character-card.mjs` 会用真实 EJS 引擎把每条 EJS 条目**实际渲染一遍**。

正确写法是把整个字面量放进一个标签，并用 `JSON.stringify` 生成纯 JSON
（顺带让阶段名里的引号 / 反引号 / 反斜杠 / `${}` 都不再可能破坏编译）。

## 世界书名每张卡唯一

世界书名叫 `生成的世界设定集 · <卡片名>`，而不是固定的 `生成的世界设定集`。
原因：ST 会按 `data.character_book.name` 把内嵌世界书落盘成 `worlds/<名字>.json`，
并把 `data.extensions.world` 绑到这个名字上。若所有卡共用同一个名字，
**导入第二张卡会直接覆盖第一张卡的世界书**，而第一张卡仍指向这个名字——
于是它开始加载第二部小说的时间线、变量与人物（ST 自己也会提示
`It will overwrite the World/Lorebook with the same name`）。
A 包的 `worldbook.json` 用的是同一个世界书名，同样会互相覆盖。

## 规范对齐说明

| 项 | 取值 | 依据 |
| --- | --- | --- |
| `spec` / `spec_version` | `chara_card_v3` / `"3.0"` | 当前 ST 导出 PNG 时就强制写这对值（`character-card-parser.js`），v3 是正式格式而非实验格式 |
| `talkativeness` | 数字 `0.5` | ST 类型契约 `@property {number} talkativeness`，缺失时补的默认值也是数字 |
| `avatar` | `"none"` | ST 自己写的就是这个值，导入时会被真实文件名覆盖 |
| `enabled`（条目） | 卡内写 `enabled` | ST 内部字段叫 `disable`，卡格式里是 `enabled` |
| `placement`（正则） | `[1, 2]` = 用户输入 + AI 输出 | 必须是数组 |
| `data.extensions.talkativeness` | 数字 | ST 的 `readFromV2` 会把它 `_.set` 到 `char.talkativeness` |
| 顶层 8 个字段 | 与 `data.*` **逐字一致** | ST 两层值不同时打 `has Spec v2 data mismatch` 警告，并以 `data.*` 为准 |
| `group_only_greetings` | `[]` | v3 规范标注为 MUST be present（群聊专属开场，本工具不生成） |
| `character_book.extensions` | `{}` | ST 的 `TavernCardValidator` 要求 world book 同时具备 `extensions` 与 `entries` |

顶层那 8 个字段属于 v1 时代的规范外冗余（v3 规范里顶层合法成员只有
`spec` / `spec_version` / `data`）。保留是因为 ST 生态的历史惯例——
只认 v1 字段的老工具仍能读到名字，而 ST 明确以 `data.*` 为准。

## 数据层：名字、时间线、世界观

这三块的数据质量决定了卡"能不能真的用"。它们都栽过跟头，现在有测试守着：

**人物名单是唯一入口。** 曾经直接拿「时间提及里 `type='age'` 的 `subject`」当人物名单，
于是抽出来的"人物"全是「小女孩」「女人」「中年女人」「青年」这类**描述性称呼**，
连锁导致三种废数据：

| 症状 | 真实产物里的样子 |
| --- | --- |
| keys 变成字段名 | `keys: ["本名","别名","称号"]` —— LLM 照抄了 prompt 里的字段名 |
| 同一人拆成多条 | 凯特一个人占了 4 条：`小女孩` / `小女孩儿` / `凯瑟琳` / `凯瑟琳·埃德森（凯特）` |
| 原文没有的角色被"补"出档案 | 条目正文自己写着 *"在提供的原文节选中，并未出现名为「鲁曼·怀特」的角色"* |

现在改为：**独立的人物名单抽取步骤** → `sanitizeRoster()` 逐字回原文校验
（原文查无此人、描述性称呼、机构名、字段名一律剔除）→ 才交给档案抽取器。
`name` 与 `keys` 由名单决定，LLM 无权改写。

**时间线要分清"故事线"和"历史背景"。** 曾经 20 条时间线里 12 条是历史年份
（二战、某动画片出产、古巴导弹危机），把主角的情节节点淹没了；顺序也是乱的
（`1960 → 60年代 → 二战 → 1955 → 1964`）。现在：

- 时间提及带 `scope`（`story` / `history`），**原点只能从 `story` 里选** ——
  否则会拿"百年前魔道东来"当年，整条轴错位；
- 历史背景单独成节，标注"仅作设定参考，不作为情节节点"；
- 排序 = **叙事顺序**：先按章节序（来自 `chunkText` 的块顺序，不靠标题字符串反推），
  同章内保证「锚点 → 由它推出的相对时间」有序。

**长篇要全文采样。** 世界观和人物抽取以前是 `text.slice(0, 15000)` / `slice(0, 10000)`，
长过这个长度的作品，**后半本的势力、地点、境界体系一条都抽不到**。
现在用 `sampleAcrossText()` 做分层采样（40% 开头 + 60% 等距铺满全文）。
有个坑：末尾窗口必须**贴住文本结尾**，只靠等比步长最容易漏掉的恰恰是最后一章
（实测 40 章的文本只覆盖到第 26 章，结局部分完全没进样本）。
数据不足以拼出实质概览时宁可不加条目，也不放占位符。
