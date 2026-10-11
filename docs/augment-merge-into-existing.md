# 完善角色卡：内容为什么没有并进已有条目

用户报的问题：

> 「小说里的内容没有很好的合并到角色卡里，而是新建了几个条目用于存放小说世界观里的设定」

**这个判断是对的。** 根因是一个之前没发现的**结构性问题**，比之前修的那三个 bug 影响更大。

---

## 证据：那次完善任务做了什么

`output/task_1791670165907/augment_report.json`：

```
before:    { entries: 79, characters: 0, events: 0, worldbook: 0 }
extracted: { events: 3, characters: 0, worldbook: 21, phases: 3 }
matched:   0 条      ← 一条都没和已有条目对齐
updated:   0 条      ← 一条已有条目都没被修改
added:     21 条，全部是 worldbook（新建）
```

处理了 10 章 / 27,710 字，抽到 21 条世界观设定 —— **全部新建，一条都没并进已有条目**。

## 根因：对齐器"看不见"不用标准前缀的卡

`src/augment.js` 靠 `comment` 的**前缀约定**给条目分类：

```js
const isCharEntry  = (e) => isCharacterComment(e?.comment);         // 要 [character] 前缀
const isEventEntry = (e) => String(e?.comment).startsWith('[event]'); // 要 [event] 前缀
const isWorldEntry = (e) => /^\[(map_|system_|history)/.test(...);    // 要 [map_] 等前缀
```

那是**本工具生成卡**的写法。而用户这张卡**完全不用这套约定** —— 条目就叫
「游戏世界观」「角色规则」「地下城」「精灵森林」「香织」。实测：

```
这张卡：79 条目，带 [前缀] 的 0 条
extractCardStructure → characters: 0 / events: 0 / worldbook: 0
```

于是连锁反应：

1. `hasExisting` 判的是那三项长度之和 → **为 0**，等价于"已有卡是空的"
2. 送给对齐器的 `existing` 是空的 → 对齐器**无从匹配** → `matched: 0`
3. 所有新内容按"新实体"处理 → **全部堆成新条目**

**即使对齐阶段修好了，`mergeEntries` 也只按 `分类::名字` 匹配** —— 类型全为空，
依然并不进去。两处都依赖前缀约定，所以两步都失效。

---

## 修法

### ① 对齐阶段：看不见就退回"全部条目"

```js
export function pickAlignEntries(entries, structure) {
  const prefixed = [...structure.characters, ...structure.events, ...structure.worldbook];
  const useFallback = prefixed.length === 0;
  return { useFallback, entries: useFallback ? buildExistingIndex(entries) : prefixed };
}
```

`buildExistingIndex` 给**所有启用的条目**建索引，字段：

```js
{ index, name /* 已去前缀 */, keys, hint /* 内容前 80 字 */ }
```

`hint` 是关键 —— 对齐器要靠内容摘要判断"是不是同一件事"，
光看名字（「升级和技能」vs「等级体系」）判断不了。

**保守取舍**：用标准前缀的卡（本工具自己生成的）行为**完全不变**，
只补上原来完全失效的那一类卡。

### ② 合并阶段：名字匹配兜底

```js
const existing = byName.get(`${categoryOfType(m.type, result)}::${m.existingName}`)
  || result.find(e => typeOf(e) === m.type && extractName(e.comment) === m.existingName)
  || result.find(e => extractName(e.comment) === String(m.existingName || '').trim());  // ← 新增
```

第三条是补的：**名字才是稳定的对应关系，类型不该成为合并的前提**。

### ③ 提示词：明确"宁可匹配也不要重复建条目"

原来只给了 `existing: {characters, events, worldbook}` 三段结构，
没说明条目名可能不带前缀。现在改成扁平数组，并加了最要紧的一条：

> **最重要的一条**：`existing` 里可能包含任意语言的任意命名条目，
> 它们的名字不带 `[character]` 这类前缀。判断同一性要**看名字与 hint（内容摘要）**，
> 不要依赖命名约定的分类。
> **宁可匹配也不要重复建条目**：把新信息并进已有条目是首选。

---

## 验证（用用户真实卡，真实模型端到端）

同一次完善任务（同一张卡 + 同一段新剧情），修复前后对比：

| | 修复前 | 修复后 |
| --- | --- | --- |
| 匹配 | **0** | **9** |
| 修改已有条目 | **0** | **9** |
| 新增 | 13（全部新建） | 8 |
| 日志 | `[WARN] 对齐结果已降级为「全部新增」` | `已有卡不使用标准前缀——用全部 74 条已有条目参与对齐` |

合并进的**正是已有的**条目（都是你卡里原有的）：

```
character: 莉乃 / 香织 / 精灵女王 - 艾莉亚娜
worldbook: 地下城 / 精灵森林 / 矮人山脉 / 人类王国主城 / 冒险者协会
```

内容确实并进了已有条目的正文：

```
地下城    总长 1748  ← 追加了 389 字
莉乃      总长 3042  ← 追加了 1810 字
精灵森林   总长 1868  ← 追加了 330 字
香织      总长 2882  ← 追加了 1454 字
矮人山脉   总长 1168  ← 追加了 265 字
```

**没有产生重复条目。**

### 中途又被真实运行抓到一次

改完索引后跑真实端到端，日志仍然出现：

```
[WARN] 对齐结果已降级为「全部新增」
matched 0 / 新增 13
```

原因是 `alignEntities` 里的早退判据**还是旧的分类结果**：

```js
const hasExisting = existing.characters.length || existing.events.length || existing.worldbook.length;
if (!hasExisting) return nothingMatches();   // ← 分类恒为 0 → 直接降级
```

分类为 0 时它**在用到 `alignEntries` 之前就返回了**，改好的索引形同虚设。
判据改成 `existingList.length > 0`（即真正送进对齐器的那个列表）。

**单元测试当时没抓到这个**，因为它们直接调
`alignEntities({ alignEntries })` 并断言 `matched`，没有覆盖"分类为空"这条真实路径。
所以补了一条**必须传空分类 `existing`** 的断言，并验证过：
把代码改回旧写法时，这条新断言会失败（不是白加的）。

---

## 报告与总结的口径问题

修复后报告里 `before` 是 `{characters:0, events:0, worldbook:0}` ——
因为分类器数不出这张卡的类型（它不用前缀）。总结里显示"人物 0 → 0"，
**会被读成"一个人物都没有"**，那是口径失效而不是事实。

改成：卡不用标准前缀时，`before` 与 `after` **都只报总条目数**，总结里
按类型的行整行不显示、并加一句说明。

> 这里也踩了一次：一开始按"每次都数、为空就省键"来写，
> 结果 `before` 是 `{entries:79}`（省了），`after` 却成了
> `{entries:86, characters:0, events:4, worldbook:3}` ——
> 因为这次新增的事件带了 `[event]` 前缀，让 after 的分类"部分可信"了。
> **同一张对照表里两个口径，差值就没有意义。** 必须用统一标志位。

修复后：

```
前后: {"entries":79} → {"entries":87}      ← 口径统一
一句话变化: 总条目 +8 条                    ← 不再出现"人物 +0"
```

---

## 仍未验证 / 已知不足

- **`mergeEntries` 的合并是纯文本追加**，加 `【新增内容】` 分隔。
  它不重写、不整理，所以同一角色在条目里会有两套字段格式
  （原文的 `Title/Age` 与新增的 `name/title`）。信息不丢，但不够干净。
  要"真正融合"得让模型重写条目正文 —— 那会改写原设定，是另一个取舍。
- 判"同一实体"完全交给模型。你那张卡里「升级和技能」与新增的「等级体系」
  是否算同一件事，取决于模型判断，**没有确定性规则兜底**。
- 卡里 `enabled: false` 的条目**不参与对齐**（`buildExistingIndex` 默认跳过），
  所以新内容不会并进被禁用的条目，而是另建一条 —— 如果你希望并进禁用的条目，需要改这个默认值。


## 我之前判断错的两处（记录一下）

处理这张卡时我先做了两件错事，用户当场指出：

### ① 把「香织」两条当成"重复内容"

实际是**一条启用、一条禁用**。`optimizeCard` 完全没检查 `enabled` 字段，
把两张不同用途的条目当成同一内容的两份副本。**禁用的条目不该参与同名合并。**

### ② 只看内容长度，不看插入深度/顺序

条目还有 `position` / `insertion_order` / `extensions.depth` 这些字段，
它们决定内容注入到 prompt 的什么位置。我做同名合并时只比正文长度，
**根本没考虑这些** —— 合并会把两条不同深度的条目并成一条，
注入位置就错了。

这两点说明：**`optimizeCard` 对"成卡"做自动合并是有风险的**，
它缺少对 enabled / 注入位置的判断。真实有效的修法是上面那三处
（让对齐看得见全部条目、按名字匹配、提示词说明），而不是在成卡上自动去重。

---

## 测试

`tests/augment.mjs` 128 → **148**，新增一节【10】：

- 不用前缀的卡：结构分类为空（**这就是 bug 的来源**，钉住它）
- `pickAlignEntries` 退回全部条目、索引含内容摘要、跳过禁用条目
- 用标准前缀的卡**不退回**（保证原行为不变）
- 对齐器能看到已有条目并匹配上
- 合并时新内容并进已有条目、两边内容都在、无重复条目、记为 `updated`
- **分类为空时仍然调用对齐器**（`existing` 传空分类、`alignEntries` 非空）——
  这条正是真实端到端抓到的那个早退 bug，改回旧写法它会失败

`tests/summary.mjs` 52 → **64**：分类计数不可用时不能显示"人物 0"，
以及标准前缀卡照常显示。

`tests/card-doctor.mjs` **51 项**（新增套件，已接进 `npm test`）。

全量 **27 套件 / 2532 断言全绿**。

---

## 另一个顺手发现的 bug

`assembleCharacterCard` 的人物条目**直接读 `c.content`**，而
`image_card.js` 与 augment 的抽取结果用 **`content_yaml`** ——

```js
content: c.content      // ← content_yaml 形状的调用方拿到空串
```

于是产出**内容为空的人物条目**：keys 有（名字还在）、正文是空串，
角色"存在但没有任何信息"。**图片生成路径的人物条目全是空的。**

修法：改走 `pickContent(c)`（认 content_yaml / content / 正文 / yaml），
去重时的长度比较也一并改掉。`tests/card-doctor.mjs` 里有回归断言。

---

## 仍未验证

**修复后的真实端到端没有跑过。** 上面是：
- 用真实卡验证了「对齐器现在能看见已有条目、能匹配上」
- 用桩 LLM 验证了「匹配 → 合并进已有条目」的完整链路

但**没有用真实模型 + 真实小说重跑一遍**确认最终产出。
需要对同一张卡 + 一段真实新剧情再跑一次 `完善已有角色卡`，
看汇总里 `matched` / `updated` 是否不再是 0。
