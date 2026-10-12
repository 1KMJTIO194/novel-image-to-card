# DSH 插件：小说 / 图片 → 角色卡

把本仓库的核心能力做成一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
在 DSH 的 Web 界面里直接粘贴小说或上传图片，生成 SillyTavern 角色卡。

**核心 `src/` 一行没改** —— 插件复用同一套 `pipeline.js` / `augment.js` / `image_card.js`，
所以插件产物与本地 Web 版逐字节一致。

---

## 它长什么样

- 侧栏出现一个入口「🃏 角色卡生成」
- 点开是右侧栏面板，三个页签：**小说 → 卡** / **完善已有卡** / **图片 → 卡**
- 面板内：接口设置（可折叠）、角色卡名称、文本/文件输入、进度条与实时日志
- 跑完列出产物，`character_card.json` 可一键下载

技术形态（都是 DSH 插件的硬约束）：

| 部分 | 做法 |
| --- | --- |
| 宿主侧 `index.js` | `export const inject = ['webServer']` + `export function apply(ctx)`；路由走 `ctx.webServer.register({ kind:'exact', path, handler(req,res) })` |
| 客户端 `client.js` | `window.__ModuleLoader__.load({ id, factory })`，React 由宿主提供，**不用 JSX**（无构建步骤），UI 挂到 `sidebar.panellist` |
| 样式 | 只用主题 token `--dsw-alias-*`，类名统一 `n2c-` 前缀 |
| 生命周期 | 每个注册都在 `ctx.effect()` 里并返回 disposer；插件卸载后路由与 UI 一起消失 |

---

## 安装

DSH 的插件只能通过 **`plugin_manager` 工具**或 **Web 界面的插件页**安装
（`install_bundle` 会代劳装包与挂载，**不要**手写 profile 的 `package.json` 或 `cordis.patch.yml`）。

### 方式一：让 DSH agent 装（最省事）

在 DSH 里说：

> 把 `D:\角色卡生成器\dsh` 这个 bundle 装到当前 profile

它会调 `plugin_manager` 的 `install_bundle`，`target` 填该目录的绝对路径。

### 方式二：Web 界面插件页

侧栏 → 设置 → 插件 → 安装 bundle → 选 `D:\角色卡生成器\dsh` 目录。

---

## 路由

全部挂在 `/novel2card/` 前缀下。**命名空间是硬要求**：DSH 的路由表里重复 `(kind, path)` 会直接抛错。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/novel2card/meta` | 能力探测（版本、数据目录、支持的任务类型） |
| GET | `/novel2card/tasks` | 任务列表 |
| POST | `/novel2card/generate` | 建任务。JSON 或 multipart，`kind` = `generate` / `augment` / `image-card` |
| GET | `/novel2card/task?id=` | 任务状态 + 产物清单 |
| GET | `/novel2card/stream?id=` | **SSE 事件流**（start / progress / files / done） |
| GET | `/novel2card/file?id=&name=` | 下载单个产物（限定在任务目录内，防目录穿越） |
| POST | `/novel2card/cancel` | 协作式取消 |
| POST | `/novel2card/remove` | 删除任务记录与产物 |

SSE 之所以可行：`dsh-host-webserver` 的 gzip 过滤器**显式豁免 `text/event-stream`**，
且 handler 直接拥有 `res`（`route.handler(req, res)`）。

---

## 数据放在哪

```
$DSH_HOME/novel2card/
└── output/
    └── task_<时间戳>/          ← 与本地 Web 版同样的产物结构
        ├── character_card.json
        ├── worldbook.json / preset_fragment.json
        ├── summary.json / SUMMARY.md
        ├── meta.json / README.md
        └── ...
```

上传的小说/图片落在系统临时目录（`os.tmpdir()/novel2card-uploads`），插件卸载时清理。
**任务表在内存里**：插件重载后列表会清空，但产物仍在磁盘上。

---

## 与 DSH 的关系（设计取舍）

**模型接口用面板里填的，不用宿主的。** 理论上可以 `ctx.get('llm')` 复用 DSH 已配置的模型，
但那样插件就与 DSH 的 LLM 服务接口**强耦合** —— 那个接口没有公开文档保证，
换个 DSH 版本就可能失效。而本插件的核心（`src/pipeline.js`）本来就是
**OpenAI 兼容 HTTP 客户端**，所以在面板里填 Base URL / API Key / 模型最稳，
也允许你把角色卡生成指向与 DSH 对话不同的服务商（比如更强的视觉模型）。

面板会把填过的配置记在 `localStorage`，不用每次重输。

**没有做成 agent 工具。** 本可以再注册一个 `novel2card_generate` 工具让 agent 直接调用，
但那要动 `ctx.tools.register` —— 本机 4 个已装第三方插件**没有一个**用过它，
接口形状只有官方 README 与 DSH 自身编译产物为证，缺少实证。这一版先不冒险。

---

## 测试

```
node tests/dsh-plugin.mjs        # 64 项：解析器 / 清单 / 宿主导出 / 客户端 bundle
node tests/dsh-plugin-e2e.mjs    # 40 项：HTTP 端到端（含真跑一次完整生成）
```

**`dsh-plugin.mjs` 里最有价值的一条**：把 `client.js` 放进 `vm` + 假 React 里**实际执行一遍**。
客户端 bundle 要是有语法错或引用了未定义的东西，在浏览器里会直接让整个 slot 崩掉
（控制台：`slot entry crashed in '<slot>'`），而 Node 里完全看不出来 —— 所以必须真跑。

**`dsh-plugin-e2e.mjs`** 把插件的路由真挂到一个 HTTP 服务器上，再用一个**假的 OpenAI 兼容端点**
当 LLM，跑完整的「小说 → 角色卡」：

```
POST /novel2card/generate (multipart)
  → SSE: start → 20+ 条 progress → files → done
  → 产物含 character_card.json（结构校验通过）
  → 下载 / 目录穿越被拒 / 取消 / 删除
```

这一层抓到过一个真 bug：对**已完成**的任务订阅 SSE 时，
原来先 `res.end()` 再继续回放历史事件，抛出 `ERR_STREAM_WRITE_AFTER_END`
（未捕获会打挂宿主进程）—— 用户表现是"打开一个历史任务就崩"。
现在结束信号只由缓冲里的 `__end` 驱动，且幂等。

---

## 没验证的部分（诚实说明）

| 项 | 状态 |
| --- | --- |
| 装进真实 DSH profile | ❌ **没装过**。本会话审批被禁用，`plugin_manager` 的每个动作都被自动拒绝，装不了 |
| 浏览器里的实际渲染 | ❌ 没看过。侧栏入口与右侧栏面板在真实 DSH 里的样子、`sidebar.panellist` 的 props、`layout.openRightbar` 的可用性都**未经实证** |
| `ctx.webServer` 之外的服务名 | ⚠️ 只注入 `webServer`；`layout` 是运行时 `ctx.get('layout')` 取的，拿不到时点击不会打开面板（控制台有 warn） |
| 图片任务 | ⚠️ 路由与逻辑都写了，但端到端只测了小说路径 |
| 宿主进程里的 express/multer | ✅ 没用到 —— multipart 自己解析（`lib/multipart.js`），不新增依赖 |

**如果侧栏入口没出现或点不开**，最先要看浏览器控制台有没有
`slot entry crashed` 或 `layout.openRightbar 不可用` —— 前者说明 slot 名或组件有问题，
后者说明 `layout` 服务名不对。这两处是本插件最可能需要按版本微调的地方。
