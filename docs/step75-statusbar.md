# Step 7.5 · 状态栏生成器 + 正则体系 · 实现设计文档

> 本文件是需求方的设计文档原文（v1.0），实现时以本文件为准。
> 实现位置：`src/step75_statusbar.js`，在 Pipeline 的 Step 7（图片）之后、Step 8（组装）之前调用。
> 落地状态与偏差记录见文末「附录 · 实现说明」。

---

## 一、定位与概述

### 1.1 在 Pipeline 中的位置

```text
Step 6  变量树生成
Step 7  图片处理
Step 7.5  状态栏 + 正则生成   ← 本文档
Step 8  组装为 character_card.json
```

### 1.2 它解决什么问题

没有 Step 7.5 时：

- AI 输出 `<update>` 标签，用户看到一堆裸文本
- 变量散落在对话里，用户无法直观查看
- 无正文美化，阅读体验平淡
- 用户需手动写正则、配 CSS

有了 Step 7.5 后：

- AI 只需输出一个占位符 `<StatusPlaceHolderImpl/>`
- 正则自动渲染为精美的 HTML 状态栏
- `<update>` 等元信息被隐藏
- 正文被包裹在带背景的卡片里
- 用户导入即用，零配置

### 1.3 用户视角

```text
上传小说 → 一键生成 → 下载 character_card.json → ST 导入 → 开始玩
```

---

## 二、输入 / 输出

### 2.1 输入

```typescript
interface Step75Input {
  variables: VariableTree;       // Step 6 的变量树
  genre: string;                 // 作品类型（auto 判定或用户指定）
  worldName: string;             // 作品/世界名（用于标题）
  characterName?: string;        // protagonist 模式下的主角名
  uiLanguage?: 'zh-CN' | 'en';   // 默认 zh-CN
}
```

### 2.2 输出

```typescript
interface Step75Output {
  statusbar: {
    html: string;              // 完整 HTML 面板（替换占位符）
    plainText: string;         // 纯文本降级版
    theme: string;             // 使用的主题名
    layout: 'single' | 'tabs'; // 布局类型
    tabCount: number;          // 标签页数量
  };
  regexScripts: RegexScript[]; // 正则脚本数组（写入卡片 extensions）
  placeholder: string;         // 占位符字符串，默认 <StatusPlaceHolderImpl/>
  bodyWrapper: {
    open: string;              // 正文起始标签，默认 <zhengwen>
    close: string;             // 正文结束标签，默认 </zhengwen>
  };
}
```

---

## 三、状态栏生成

### 3.1 字段识别

从变量树里筛选"需要展示"的字段：

| 判定 | 说明 | 示例 |
| --- | --- | --- |
| ✅ 展示 | 主角自身状态 | 姓名、年龄、等级、位置、时间 |
| ✅ 展示 | 资源/物品列表 | 物品栏、宠兽、技能、装备 |
| ✅ 展示 | 关系/人际列表 | 好感度、关系类型 |
| ✅ 展示 | 数值型进度 | 修炼进度、任务完成度 |
| ❌ 隐藏 | 元信息 | custom.storylines、events.*.deviation |
| ❌ 隐藏 | 内部状态 | events.*.status、events.*.pressure |
| ❌ 隐藏 | 空值字段 | 值为 null / undefined / [] |

伪代码：

```typescript
function selectDisplayFields(variables: VariableTree): DisplayField[] {
  const fields: DisplayField[] = [];

  for (const [ns, content] of Object.entries(variables)) {
    // 跳过内部命名空间
    if (ns === 'custom' || ns === 'events') continue;

    // 字段可能是对象、数组或原始值
    if (isPlainObject(content)) {
      for (const [key, value] of Object.entries(content)) {
        if (isDisplayable(key, value)) {
          fields.push({
            namespace: ns,
            key,
            path: `stat_data.${ns}.${key}`,
            label: toLabel(key),
            valueType: inferType(value),
            group: mapToGroup(ns, key),
          });
        }
      }
    } else if (Array.isArray(content)) {
      fields.push({
        namespace: ns,
        key: ns,
        path: `stat_data.${ns}`,
        label: toLabel(ns),
        valueType: 'list',
        group: mapToGroup(ns, ns),
      });
    }
  }

  return fields;
}
```

`isDisplayable` 判定：

```typescript
function isDisplayable(key: string, value: any): boolean {
  // 排除元信息关键词
  const metaKeywords = ['deviation', 'pressure', 'status', 'core', 'events'];
  if (metaKeywords.some(k => key.toLowerCase().includes(k))) return false;

  // 排除空值
  if (value === null || value === undefined) return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'string' && value.trim() === '') return false;

  return true;
}
```

### 3.2 分组映射

| 命名空间/关键词 | 分组 | 显示名 |
| --- | --- | --- |
| 角色信息 / world / 角色档案 | profile | 角色档案 |
| 角色职业 / 修炼 / 境界 | class | 职业/修炼 |
| 物品栏 / 背包 / 装备 | items | 行囊 |
| 宠兽 / 灵宠 / 宠物 | pets | 灵兽录 |
| 人际关系 / 关系 / 好感度 | relations | 因缘簿 |
| 技能 / 功法 / 掌握忍术 | skills | 技能 |
| 任务 / 任务日志 | missions | 任务 |
| 其他 | misc | 其他 |

### 3.3 布局决策

```typescript
function decideLayout(fields: DisplayField[]): {
  layout: 'single' | 'tabs';
  tabCount: number;
  tabs: Tab[];
} {
  const groups = groupFields(fields);
  const groupCount = Object.keys(groups).length;

  if (groupCount <= 1) {
    return { layout: 'single', tabCount: 1, tabs: [{ id: 'main', label: '状态', fields }] };
  }

  if (groupCount <= 3) {
    return { layout: 'tabs', tabCount: groupCount, tabs: ... };
  }

  // 超过 3 组：合并小组，标签页数控制在 3-5
  const merged = mergeSmallGroups(groups, { minFieldsPerTab: 2 });
  return { layout: 'tabs', tabCount: merged.length, tabs: merged };
}
```

### 3.4 主题选择

```typescript
const THEMES = {
  // 修仙/仙侠/御兽
  xianxia: {
    bg: '#1e2a1f',
    accent: '#b7b06b',
    secondary: '#7c9a6e',
    text: '#f5f0e0',
    pattern: 'leaf',  // SVG 叶子纹理
    font: "'Segoe UI', '华文楷书', 'Microsoft YaHei', serif",
    title: '灵兽天工·御兽宝鉴',
  },
  // 都市/现代
  urban: {
    bg: '#0d1117',
    accent: '#64ffda',
    secondary: '#7c4dff',
    text: '#c9d1d9',
    pattern: 'grid',
    font: "'Segoe UI', 'Microsoft YaHei', sans-serif",
    title: '状态面板',
  },
  // 校园/青春
  campus: {
    bg: '#f0f7ff',
    accent: '#4a90e2',
    secondary: '#7ed321',
    text: '#2c3e50',
    pattern: 'circle',
    font: "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
    title: '校园档案',
  },
  // 悬疑/暗黑
  mystery: {
    bg: '#1a1a1a',
    accent: '#c9302c',
    secondary: '#444',
    text: '#e0e0e0',
    pattern: 'noise',
    font: "'Courier New', 'SimSun', monospace",
    title: '调查档案',
  },
  // 科幻/未来
  scifi: {
    bg: '#0a0e27',
    accent: '#00d4ff',
    secondary: '#a855f7',
    text: '#e2e8f0',
    pattern: 'hexagon',
    font: "'Segoe UI', 'Roboto', sans-serif",
    title: '系统终端',
  },
  // 奇幻/西幻
  fantasy: {
    bg: '#2a1f3d',
    accent: '#f6c453',
    secondary: '#9d4edd',
    text: '#f0e6d2',
    pattern: 'star',
    font: "'Georgia', 'SimSun', serif",
    title: '冒险者手册',
  },
  // 默认（同 urban）
  default: { /* 同 urban */ },
};

function pickTheme(genre: string): Theme {
  const lower = genre.toLowerCase();
  if (/修仙|仙侠|武侠|御兽|灵兽/.test(lower)) return THEMES.xianxia;
  if (/校园|青春|日常|恋爱/.test(lower)) return THEMES.campus;
  if (/悬疑|推理|恐怖|暗黑/.test(lower)) return THEMES.mystery;
  if (/科幻|未来|赛博/.test(lower)) return THEMES.scifi;
  if (/奇幻|西幻|魔法|异世界/.test(lower)) return THEMES.fantasy;
  if (/都市|现代|职场/.test(lower)) return THEMES.urban;
  return THEMES.default;
}
```

### 3.5 HTML 模板

模板中的占位符：

| 占位符 | 生成器填入 |
| --- | --- |
| `{theme.*}` | 主题色值 |
| `{#each tabs}` | 标签页循环展开 |
| `{tab.fieldsJson}` | 该标签页的字段数组 JSON |
| `{renderFields(tab.fields)}` | 该标签页的 HTML 结构 |

> 完整 HTML/CSS/JS 骨架见需求方原始文档；实现时由生成器按主题与标签页填充。

**HTML 结构要点**

- `<html><head>` 里放主题 CSS 变量（`--bg-panel` / `--accent-primary` / `--accent-secondary` / `--text-light` / `--text-muted` / `--border-color` / `--card-bg` / `--pattern`）
- `body::before` 铺 SVG 底纹（`opacity: .15`）
- `.panel-container` 为玻璃拟态容器；`.header-info-bar` 显示所在地与时间
- `.tabs-navigation` + `.tab-button-nav` + `.tab-pane-content` 组成标签页
- `.card-grid` / `.info-card` / `.data-row` / `.list-item` 组成内容卡片
- 响应式：`@media (max-width: 680px)` 单列

**JS 要求**

- 用 `<script type="module">`
- 工具函数：`getVal(path, defaultValue)`、`escapeHtml(str)`、`parseList(raw)`
- 标签切换：`openTab(tabId)`
- 渲染：`render()` → `renderTab(tabId, fields)` → `renderListItem(field, item)`
- 初始化：`waitGlobalInitialized('Mvu').then(render).catch(render)`，外层 `$(errorCatched(init))`
- 字段取值一律用 ST 宏 `{{get_message_variable::stat_data.xxx}}`

---

## 四、正则体系

### 4.1 正则清单（共 7 条）

| # | scriptName | 作用 | placement | markdownOnly | promptOnly |
| --- | --- | --- | --- | --- | --- |
| 1 | 思维链隐藏 | 隐藏 `<disclaimer>` | [2] | true | true |
| 2 | 变量更新隐藏 | 隐藏 `<update>` | [2] | true | true |
| 3 | 状态栏美化 | 占位符 → HTML | [1, 2] | true | false |
| 4 | 状态栏纯文本 | 占位符 → 文本 | [2] | true | false |
| 5 | 状态栏prompt隐藏 | 占位符在 prompt 中隐藏 | [2] | false | true |
| 6 | 正文美化 | `<zhengwen>` → HTML | [1, 2] | true | false |
| 7 | 正文prompt隐藏 | `<zhengwen>` 深层隐藏 | [1, 2] | true | true |

`placement`：`1` = 用户输入（User Input），`2` = AI 输出（AI Output）。
`markdownOnly: true` → 只在渲染时替换，不修改 prompt；
`promptOnly: true` → 只在发送 prompt 时替换/删除，不影响显示。

### 4.2 逐条定义

**正则 1 · 思维链隐藏**

```json
{
  "id": "regex_thinking_hide",
  "scriptName": "思维链隐藏",
  "findRegex": "/<disclaimer>([\\s\\S]*?)<\\/disclaimer>/gsi",
  "replaceString": "",
  "trimStrings": [],
  "placement": [2],
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": true,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": null
}
```

**正则 2 · 变量更新隐藏**

```json
{
  "id": "regex_update_hide",
  "scriptName": "变量更新隐藏",
  "findRegex": "/<update(?:variable)?>(?:(?!.*<\\/update(?:variable)?>).*$|.*<\\/update(?:variable)?>)/gsi",
  "replaceString": "",
  "trimStrings": [],
  "placement": [2],
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": true,
  "runOnEdit": false,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": null
}
```

**正则 3 · 状态栏美化**

```json
{
  "id": "regex_statusbar_html",
  "scriptName": "状态栏美化",
  "findRegex": "<StatusPlaceHolderImpl/>",
  "replaceString": "```\n{生成的 HTML}\n```",
  "trimStrings": [],
  "placement": [1, 2],
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": false,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": 3
}
```

> `replaceString` 必须用 ` ``` ` 包裹 HTML，否则 ST 会当作 Markdown 文本渲染。

**正则 4 · 状态栏纯文本（降级）**

```json
{
  "id": "regex_statusbar_text",
  "scriptName": "状态栏纯文本",
  "findRegex": "<StatusPlaceHolderImpl/>",
  "replaceString": "{生成的纯文本版}",
  "trimStrings": [],
  "placement": [2],
  "disabled": true,
  "markdownOnly": true,
  "promptOnly": false,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": 3
}
```

默认 `disabled: true`，用户想用纯文本版时手动开启。纯文本版格式：

```text
━━━━━━━━━━━━━━━━━━
【角色信息】
姓名：{{get_message_variable::stat_data.角色信息.姓名}}
种族：{{get_message_variable::stat_data.角色信息.种族}}
...
━━━━━━━━━━━━━━━━━━
【宠兽】
【名称】：{{get_message_variable::stat_data.宠兽.0.名称}}
...
```

**正则 5 · 状态栏 prompt 隐藏**

```json
{
  "id": "regex_statusbar_prompt_hide",
  "scriptName": "状态栏prompt隐藏",
  "findRegex": "<StatusPlaceHolderImpl/>",
  "replaceString": " ",
  "trimStrings": [],
  "placement": [2],
  "disabled": false,
  "markdownOnly": false,
  "promptOnly": true,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": null
}
```

> 作用：发往 LLM 时占位符被替换为空格，避免 AI 把它当范例。

**正则 6 · 正文美化**

```json
{
  "id": "regex_body_beautify",
  "scriptName": "正文美化",
  "findRegex": "<zhengwen>([\\s\\S]*?)<\\/zhengwen>",
  "replaceString": "```\n<!DOCTYPE html>…（.pm-card-container / .pm-card-content 卡片）…\n```",
  "trimStrings": [],
  "placement": [1, 2],
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": false,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": null,
  "maxDepth": 8
}
```

背景图：用户上传了场景图 → 用该图 URL；未上传 → 按 genre 用内置占位图（纯色渐变）。

**正则 7 · 正文 prompt 隐藏**

```json
{
  "id": "regex_body_prompt_hide",
  "scriptName": "正文prompt隐藏",
  "findRegex": "<zhengwen>([\\s\\S]*?)<\\/zhengwen>",
  "replaceString": "",
  "trimStrings": [],
  "placement": [1, 2],
  "disabled": false,
  "markdownOnly": true,
  "promptOnly": true,
  "runOnEdit": true,
  "substituteRegex": 0,
  "minDepth": 8,
  "maxDepth": null
}
```

> 深度超过 8 的历史楼层，把 `<zhengwen>` 标签从 prompt 中移除，只保留文本。

### 4.3 执行顺序

ST 的正则按数组顺序执行，写入 `extensions.regex_scripts` 的顺序：

```text
1. 思维链隐藏
2. 变量更新隐藏
3. 正文prompt隐藏
4. 状态栏prompt隐藏
5. 正文美化
6. 状态栏美化
7. 状态栏纯文本（disabled）
```

---

## 五、与 MVU / 酒馆助手的对接

### 5.1 必须的依赖声明

`creator_notes` 须写入：

```text
【使用前提】
1. 需安装「酒馆助手」扩展（4.2.0+）
   - 世界书条目里的 EJS 指令由它渲染
   - 未安装时卡片仍可用，但会看到 <%_ ... _%> 原文
2. 需安装「MVU」变量框架
   - 状态栏、变量更新、导演指令的推进都依赖它

【导入后必须做的三件事】
① 导入内嵌世界书（弹窗点"是"）
② 保持 "[initvar]勿启用" 条目为关闭状态
③ 放行卡内嵌的正则（弹窗点"是"）
```

### 5.2 `[initvar]` 条目的生成

```json
{
  "comment": "[initvar]勿启用",
  "content": "{变量树的 YAML 序列化}",
  "constant": true,
  "enabled": false,
  "position": "before_char",
  "insertion_order": 2,
  "extensions": {
    "position": 0,
    "depth": 4,
    "prevent_recursion": true
  }
}
```

> 关键：`enabled: false` —— 不参与 prompt 注入，只供 MVU 读取。

### 5.3 酒馆助手脚本注册

`extensions.tavern_helper.scripts` 注册 MVU：

```json
{
  "type": "script",
  "enabled": true,
  "name": "mvu",
  "id": "a86260a6-5f82-4c84-b9ad-564442540716",
  "content": "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js';",
  "info": "",
  "button": { "enabled": true, "buttons": [] },
  "data": {},
  "export_with": { "data": true, "button": true }
}
```

> 这是 MVU 的 CDN 地址，生成器不需要自己实现变量框架。

---

## 六、降级方案

### 6.1 场景 A · 无酒馆助手

- `regex_statusbar_html` 失效（EJS 无法渲染）
- `regex_statusbar_text` 生效（纯文本）
- 输出：两条正则都写入，HTML 版 `disabled: true`，纯文本版 `disabled: false`

### 6.2 场景 B · 无 MVU

- `getAllVariables()` 返回空
- 状态栏全部显示默认值，变量不更新
- 输出：在 `creator_notes` 里明确警告

### 6.3 场景 C · 无 ST 或非 ST 平台

- 所有正则失效
- 用户仍可拿到 `character_card.json`
- 输出：README 里说明

---

## 七、校验清单

Step 7.5 完成后，Step 8 应校验：

| # | 检查项 | 级别 |
| --- | --- | --- |
| 1 | 状态栏 HTML 能通过基本语法检查 | 错误 |
| 2 | 状态栏引用的所有 `stat_data.*` 路径存在于变量树 | 错误 |
| 3 | 7 条正则都有 `id` 和 `scriptName` | 错误 |
| 4 | 每条正则的 `placement` 是 `[1]` / `[2]` / `[1,2]` | 错误 |
| 5 | 状态栏美化正则的 `replaceString` 含 ` ``` ` 包裹 | 警告 |
| 6 | 状态栏纯文本正则 `disabled: true` | 警告 |
| 7 | `[initvar]` 条目 `enabled: false` | 错误 |
| 8 | HTML 里没有未转义的 `{{` / `}}`（会被 ST 误替换） | 错误 |
| 9 | HTML 里的 `<script>` 用 `type="module"` | 警告 |
| 10 | `escapeHtml` 函数已定义 | 错误 |

> `{{ }}` 是 ST 的宏语法，会被优先替换。HTML 里所有 `{{ }}` 必须都是 ST 宏。

---

## 八、完整示例（御兽世界）

输入：

```typescript
{
  genre: 'xianxia',
  worldName: '御兽世界',
  variables: {
    角色信息: { 姓名, 种族, 性别, 年龄, 位置, 时间, 天气 },
    角色职业: { 御兽师天赋, 御兽师等级, 御兽空间等级 },
    物品栏: [...],
    宠兽: [...],
    人际关系: [...],
  }
}
```

输出：

- 状态栏主题 `xianxia`（青绿 + 竹叶纹），布局 `tabs`，4 个标签页：
  御者铭文（角色信息 + 角色职业）/ 灵兽录（宠兽）/ 行囊（物品栏）/ 因缘簿（人际关系）
- HTML 约 450 行，纯文本约 40 行
- 正则 7 条，全部默认配置
- `[initvar]` 条目写入变量树的 YAML 序列化

---

## 九、给 AI 的实现指令

```text
任务：实现 Step 7.5 · 状态栏生成器 + 正则体系

位置：Pipeline 中 Step 7（图片处理）之后，Step 8（组装）之前。

输入：
  - variables：Step 6 生成的变量树
  - genre：作品类型
  - worldName：作品名
  - characterName：（可选）主角名

输出：
  - statusbar.html：完整 HTML 面板
  - statusbar.plainText：纯文本降级版
  - regexScripts：7 条正则脚本数组
  - placeholder：占位符字符串（默认 <StatusPlaceHolderImpl/>）
  - bodyWrapper：正文包裹标签（默认 <zhengwen>...</zhengwen>）

实现要求：

1. 新建 src/step75_statusbar.js，导出 async generateStatusbar(input) 函数。

2. 字段识别：
   - 遍历变量树，排除 events / custom 命名空间
   - 排除元信息关键词：deviation / pressure / status / core
   - 排除空值
   - 剩余字段按 group 归类（profile / class / items / pets / relations / skills / missions / misc）

3. 布局决策：
   - group 数 ≤ 1：单页
   - group 数 2-3：标签页
   - group 数 > 3：合并小组，标签页数控制在 3-5

4. 主题选择：
   - 按 genre 匹配 xianxia / urban / campus / mystery / scifi / fantasy
   - 默认 urban
   - 每个主题包含：bg / accent / secondary / text / pattern / font / title

5. HTML 生成：
   - 按模板填充主题色值、标签页、字段
   - 字段用 {{get_message_variable::stat_data.xxx}} 取值
   - JS 用 type="module"
   - 用 waitGlobalInitialized('Mvu') 等待变量加载
   - 用 errorCatched 包装
   - 用 escapeHtml 防 XSS
   - 生成纯文本降级版

6. 正则生成：
   - 按文档第四节逐条生成 7 条正则
   - 状态栏美化正则的 replaceString 用 ``` 包裹 HTML
   - 状态栏纯文本正则 disabled: true
   - 所有正则写入 extensions.regex_scripts

7. 与 Step 8 的对接：
   - Step 8 把 statusbar.placeholder 写入 B5-5 输出纪律：
     "每次回复末尾必须输出 <StatusPlaceHolderImpl/>"
   - Step 8 把 bodyWrapper 写入 B5-5：
     "正文必须包裹在 <zhengwen>...</zhengwen> 内"
   - Step 8 把 regexScripts 写入 character_card.extensions.regex_scripts
   - Step 8 把 [initvar] 条目写入 character_book.entries

8. 校验：
   - HTML 语法检查
   - 所有 stat_data.* 路径存在于变量树
   - 7 条正则都有 id 和 scriptName
   - [initvar] 条目 enabled: false

9. 测试：
   - tests/statusbar.mjs：
     * 字段识别正确
     * 布局决策正确
     * 主题选择正确
     * HTML 生成无语法错误
     * 7 条正则都生成
     * 纯文本降级版正确

不要做的：
- 不要为了 UI 好看而引入外部 CSS/JS 库
- 不要在 HTML 里使用除 ST 宏以外的 {{ }} 语法
- 不要修改变量树的字段名或结构
- 不要生成用户看不见的内部字段
```

---

## 附录 · 实现说明（实现方补充，非需求原文）

### 与本项目现状的差异（需处理）

1. **`genre` 参数不存在**。pipeline 里没有 genre 判定步骤，只有 `cardFields.tags`（如 `['古风','悬疑','女性主角']`）。
   实现时按 `tags.join(' ') + 卡名` 匹配主题。

2. **变量树命名空间是英文的**：`world` / `events` / `characters` / `custom` / `user`。
   `3.2` 的中文键在"从小说生成"的场景下命中率低，需要同时匹配英文键。

3. **变量树里没有数组**。`buildVariables` 产出的是 record（`characters.沈砚.{affinity,state}`），
   不是 list。`valueType: 'list'` 与 `renderListItem` 需要按 record 形态渲染。

4. **文档 3.5 的 `{#each}`/`{tab.fieldsJson}` 是伪模板语法**，实现时由生成器用真实 JS 字符串拼接替换。

5. **占位符会作为 B1 固化**。若把 `<StatusPlaceHolderImpl/>` 写进 B5-5 输出纪律，
   它就是一个**固定内容的静态面板**（每次渲染同一套字段），
   而字段列表在 Step 7.5 时已确定 —— 这与"永远显示最新变量值"并不冲突
   （取值本身是运行时宏），但与"按角色成长动态增减字段"冲突。需确认可接受。

6. **`<script>` 能否在 ST 消息渲染里执行**：ST 默认对消息做 sanitize，
   `type="module"` + `waitGlobalInitialized` 的写法依赖酒馆助手允许脚本执行。
   实现后会做 HTML 结构校验，但**无法在本沙箱内验证真机渲染**。

7. **校验项 10「`escapeHtml` 函数已定义」** 与需求描述有出入：
   需求写的是"HTML 里所有 `{{ }}` 必须是 ST 宏"，本文档按此执行。

---

### 落地记录（已实现，含实现期间修正的三个设计缺陷）

实现位置：`src/step75_statusbar.js`（新增）、`src/pipeline.js`（Step 7.5 接线 +
`makeStatusbarPreview`）、`src/templates.js`（`buildOutputDiscipline(sb)`）、
`tests/statusbar.mjs`（新增 226 项断言）、`tests/e2e.mjs`（第 5.6 节真实产物校验）。

**缺陷 1 · 正则替换产物里的 `<script>` 不会执行 —— 已改为纯宏 + CSS 实现**

原设计（3.5 节）在面板里放 `<script type="module">`，用 JS 读 MVU 变量。
但状态栏 HTML 是 ST **正则替换**的产物，ST 会对替换结果做消毒，脚本会被摘掉；
即使留着，模块脚本也不会执行。结果会是：面板结构在、数值全空，且不报错。

改为：
- 取值全部用 ST 宏 `{{get_message_variable::stat_data.…}}`（酒馆助手在渲染时替换，
  [官方文档确认该宏存在](https://n0vi028.github.io/JS-Slash-Runner-Doc/)）；
- 标签页切换改为 CSS 单选按钮 + `:checked ~ …` 兄弟选择器，**零 JavaScript**；
- `<script>` 保留但降级为"可选增强"：只负责把宏没替换上的空位兜底成 `—`。

副作用：`escapeHtml` 不再是渲染必需，校验项 10 由「错误」降级为「警告」。

**缺陷 2 · `<disclaimer>` 在本项目里从未被声明过 —— 正则 1 扩成同时吃 `<thinking>`**

正则 1 按文档原样写是 `/<disclaimer>([\s\S]*?)<\/disclaimer>/gsi`，
但全项目搜索 `<disclaimer>` 零命中：B5-5 让 AI 输出的是 `<thinking>`。
照原文写这条正则会匹配不到任何东西（用户会看到大段内心独白）。
现模式为 `/<(?:disclaimer|thinking)>([\s\S]*?)<\/(?:disclaimer|thinking)>/gsi`，
条数仍是 7 条，`id` / `scriptName` 不变。

**缺陷 3 · 分组规则照文档实现会让面板只剩"其他" —— 需要中英三层匹配**

文档 3.2 的关键词是中文命名空间（`角色信息`/`物品栏`/`宠兽`），
而本项目 `buildVariables` 产出 `world`/`characters`/`user`。
按原文实现时，`characters.沈砚` 会落进 `misc`，整块面板只剩一个"其他"页。

现为三层匹配，顺序不可颠倒（两处都是被中文分词的现实逼出来的）：

1. 命名空间正配：`characters` → relations（即文档的"人际关系"）；
2. **键名**规则，从窄到宽；
3. 命名空间兜底。

两个坑记在这里免得再犯：
- `profile` 规则必须排**最后**。`角色信息` 是中文卡最常见的总括命名空间，
  排前面会把行囊、宠兽、关系全吞掉。
- 规则里**不能收「位置」**：`物品栏` 里正好含这两个字，中文没有词边界。

**其他落地细节**

- **布局合并**：7 个组只分得出 2 个"大组"时，直接"把小组合并进主组"会塌成 2 页
  （文档要求 3-5 页）。现为：先合并小组，块数不足时再拆开最大的合并块补足页数；
  拆的时候必须把该组字段从原块里摘掉，只 push 不删会让字段显示两遍。
- **`static_fields` 与 `initvar_placeholder`（用户已确认）**：只展示变量树里真实存在的字段，
  不注入 `位置`/`天气` 这类字段，也不改变量树本身。所以"从小说生成"的真实产物
  字段数是 3（`world.time`/`world.phase`/`user.name`）到 6（再加 `characters.*`），
  面板偏空 —— 这是变量树本身的内容决定的，不是面板的问题。
- **`tavern_helper.variables` 被移除**：MVU 只读 `[initvar]` 世界书条目，
  该字段无消费方，留着只会误导。
- **`buildOutputDiscipline(sb)`**：新增可选参数。不传时返回原 `B5_5` 原文
  （A/B 包与老测试不受影响）；传了就把占位符与 `<zhengwen>` 纪律追加进去。

**实测验证（本沙箱内可做的部分）**

- 19 个测试套件、1658 项断言全绿（含新增 226 项）。
- 真实 SSE 端到端跑通：产物新增 `statusbar.json` / `regex_scripts.json` /
  `statusbar_preview.html`；卡片里 7 条正则、MVU 脚本注册、
  输出纪律条目含占位符与正文包裹标签、`creator_notes` 含降级说明。
- 卡片内嵌的状态栏 HTML 抽出后用 jsdom 解析：标签全部闭合、
  `{{ }}` 全是 ST 宏、radio/label/pane 数量一致。
- 模拟 ST 宏替换后渲染，面板可见文本为
  `状态面板 · <卡名> | 时间 开场 | 状态 时间/阶段/姓名`，无残留宏。

**本沙箱内无法验证、需真机确认**

- 真机 SillyTavern 导入与渲染效果（正则是否被放行、宏是否被替换、CSS 单选按钮是否可用）。
- 面板脚本在 ST 消毒后是否还能存活（即使被摘掉，面板主体仍然可用）。
- 酒馆助手版本下限：MVU bundle 要求 ≥ 3.4.17，文档 5.1 写的是 4.2.0+，按文档保留。
- 正则 2 按本项目 B5-5 声明的 `<update>` 形态匹配（已确认项目内 6 处声明全是 `<update>`，
  与正则一致）；但当前 MVU 文档主要描述 `<UpdateVariable>`，两种形态是否都被支持
  未能在源码层确认，故正则在写卡侧保留为原样。

