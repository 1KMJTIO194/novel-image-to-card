# DSH 插件：小说 / 图片 → 角色卡

把本仓库的核心能力做成一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：
在 DSH 的 Web 界面里直接粘贴小说或上传图片，生成 SillyTavern 角色卡。

**核心 `src/` 一行没改** —— 插件复用同一套 `pipeline.js` / `augment.js` / `image_card.js`，
所以插件产物与本地 Web 版逐字节一致。

---

## 它长什么样

- 侧栏出现一个「🃏」图标，标签「角色卡生成」
- 点它切到**中央面板**，三个页签：**小说 → 卡** / **完善已有卡** / **图片 → 卡**
- 「完善已有卡」页签里有 **完善指令** 多行框（可选，≤2000 字）+ 三个快捷按钮
- 面板内：接口设置（可折叠）、角色卡名称、文本/文件输入、进度条与实时日志
- 跑完列出产物，`character_card.json` 可一键下载

### 图片 → 卡的路径

图片路径走「**总结图片里的信息 → 设定**」：先看图抽出画面事实与转录文字，
再把那些信息归纳成人物 / 地点 / 势力 / 体系 / 舞台设定。

**不写画面描述**（不出现「图片中/画面里/头像/像素」），**也不抽剧情事件** ——
用户明确要求过「不是图片里面怎么怎么样，图片里发生了什么剧情」。
细节见仓库根 README「图片生成角色卡 → 总结图片里的信息」。

### 完善指令

用自然语言说明这次要怎么并，例如：

> 只把小说里的角色并进已有卡，角色设定要符合原卡世界观；
> 地图与势力也纳入，但沿用原卡已有的地名与势力名。

它会被拼进**四个抽取步骤**（事件 / 世界观 / 人物名单 / 人物档案），
并与**已有卡的世界观摘要**一起生效 —— 所以"符合原卡世界观"不需要在指令里反复强调，
指令更适合写**取舍**（哪些要、哪些不要、往哪个方向靠）。

摘要与措辞的细节见仓库根的 README「完善角色卡 → 完善指令」一节；
核心逻辑在 `src/augment_context.js`（插件与本地版共用同一份）。

面板上的三个生成选项（与 Web 版本一致，都默认"安全/兼容的一档"）：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 生成档位 | 基础版 | 完整版：人物档案更细、世界观更细、概要更长，token 更高 |
| 角色卡版本 | 普通版 | 普通版不含任何成人内容（成人字段由代码删除）；成人版完整包含，且要求出场角色均为成年 |
| 角色卡格式 | 完整卡 | 完整卡带状态栏美化与变量树（需「酒馆助手」+「MVU」）；普通卡两者都无，纯 ST 原生、导入即用，还省一次状态栏请求 |

三者都通过表单字段传给路由，再透传到 `pipeline.js` / 图片路径；完善已有卡的任务不显示这三个选项
（那是改用户已有的卡，不该改变它的性质）。

技术形态（都是 DSH 插件的硬约束）：

| 部分 | 做法 |
| --- | --- |
| 宿主侧 `index.js` | `export const inject = ['webServer']` + `export function apply(ctx)`；路由走 `ctx.webServer.register({ kind:'exact', path, handler(req,res) })` |
| 客户端 `client.js` | `window.__ModuleLoader__.load({ id, factory })`，React 由宿主提供，**不用 JSX**（无构建步骤） |
| UI 接线 | `main`（中央面板，keyed）+ `sidebar.panellist`（侧栏图标，list），两者用**同一个字符串**对接（见下） |
| 样式 | 只用主题 token `--dsw-alias-*`，类名统一 `n2c-` 前缀 |
| 生命周期 | 每个注册都在 `ctx.effect()` 里并返回 disposer；插件卸载后路由与 UI 一起消失 |

### UI 接线（踩过的坑，写清楚）

DSH 的面板**不是**靠"打开右侧栏"实现的，而是靠两条注册 + 一个共享标识。官方槽位目录原文：

| 槽位 | 类型 | 原文 |
| --- | --- | --- |
| `main` | keyed | Central panel **selected by sidebar entry id** |
| `sidebar.panellist` | list | Each list **id addresses the matching main panel**；the sidebar owns the button |

所以必须这样接：

```js
const PANEL_KEY = 'novel2card';

// ① 中央面板
ctx.slots.inject('main', () => ctx.slots.register(
  { name: 'main', key: PANEL_KEY }, Panel));

// ② 侧栏图标（id = 上面那个 key）
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
  { name: 'sidebar.panellist', id: PANEL_KEY, order: 20, label: () => '角色卡生成' },
  SidebarIcon));
```

> **第一版就是在这里错的**：只注册了 `sidebar.panellist`，id 还随便起了个
> `novel2card-entry`，然后用 `ctx.layout.openRightbar(openPanel, false)` 想"打开右侧栏"。
> 而真实签名是 `openRightbar(track: boolean, fullscreen: boolean)` ——
> 第一个参数是**布尔值**（"普通宽度是否占一个网格轨道"），传进去的函数被塞进布尔字段，
> **没有任何东西会渲染**。用户看到的就是：侧栏有图标，点开全空。
>
> 现在有测试钉住这条契约：**`main.key` 必须等于 `sidebar.panellist.id`**。

`inject` 只声明 `slots` —— `layout` **不放进 inject**，否则在没有 layout 服务的组合里
整个条目都不会激活，侧栏图标也不会出现。

---

## 安装

DSH 的插件只能通过 **`plugin_manager` 工具**或 **Web 界面的插件页**安装
（`install_bundle` 会代劳装包与挂载，**不要**手写 profile 的 `package.json` 或 `cordis.patch.yml`）。

### 方式一：Web 界面插件页（最直观）

侧栏 → 设置 → 插件 → 安装，在输入框里填**本地目录路径**：

```
D:\角色卡生成器\dsh
```

> ⚠️ **要填 `dsh` 子目录，不是仓库根目录。**
> bundle 的清单（`package.json` 里的 `dsh.bundle.patch`）在 `dsh/` 里；
> 仓库根的 `package.json` 没有 `dsh` 字段，填根目录会报"不是 bundle"。

安装源有「默认 / 中国大陆镜像源」两个选项 —— 本地目录安装不联网，选哪个都一样。

### 方式二：让 DSH agent 装

在 DSH 里说：

> 把 `D:\角色卡生成器\dsh` 这个 bundle 装到当前 profile

它会调 `plugin_manager` 的 `install_bundle`，`target` 填该目录的绝对路径。

---

## 一个必须知道的依赖：插件要能找到仓库的 `src/`

插件**复用**仓库的核心流程（`src/pipeline.js` / `augment.js` / `image_card.js`），
而不是复制一份。所以它得知道 `src/` 在哪。`lib/loader.js` 按优先级找：

| 顺序 | 候选 | 适用场景 |
| --- | --- | --- |
| ① | `<插件>/../../src` | 插件还在仓库里（**pnpm 对本地目录默认用 `link:` 软链**，真实路径仍在仓库） |
| ② | `<插件>/../src` | 插件被复制到别处，但 `src/` 就在它旁边 |
| ③ | `$NOVEL2CARD_SRC` | 环境变量显式指定 |

**刻意没有做 `process.cwd()/src` 兜底。** 试过，然后去掉了：开发时 cwd 恰好是仓库根，
于是"复制安装"也会被误判成成功 —— 测试全绿，到真实宿主里（cwd 与仓库无关）才找不到。
宁可明确失败，也不要一个碰巧能用的假象。

**怎么判断有没有找到**：`GET /novel2card/meta` 会报出来（也可以在 DSH 里直接访问该地址）：

```json
{
  "core": {
    "pluginDir": "D:\\角色卡生成器\\dsh",
    "srcDir": "D:\\角色卡生成器\\src",
    "ok": true
  }
}
```

`ok: false` 时 `hint` 会给出三条可操作办法。任务报错也会直接说清是哪个文件、该怎么做，
而不是一个看不懂的 `ENOENT`。

> **本机这次的情况**：`install_bundle` 对本地目录用 pnpm 的 `link:`，
> 所以插件真实路径仍在 `D:\角色卡生成器\dsh`，①命中了，`src/` 正常。

### 万一被复制了（②③ 都没命中）

任选其一：

1. 设环境变量 `NOVEL2CARD_SRC=D:\角色卡生成器\src`
2. 把仓库的 `src/` 复制到插件目录旁（即 `<插件>/../src`）
3. 改用软链安装，让插件目录留在仓库内

---

## 信任栅栏（安全）

**DSH 自己的路由对非授权请求返回 401，但插件注册的路由不受那套校验保护。** 实测：

```
GET /                    → 401   ← DSH 应用路由
GET /novel2card/meta     → 200   ← 插件路由，默认没人看门
```

本插件的风险很实在：`POST /generate` 接收 **API Key** 且 `baseUrl` 由调用方指定，
`GET /file` 能读出已生成的角色卡（含你小说里的内容）。
若 DSH 部署在非回环地址（反代 / 局域网 / `0.0.0.0`），
任何能访问该端口的人都能借这台机器跑生成并把请求发往自己的服务器 —— **等于凭据外带**。

所以每条路由都过 `lib/guard.js`，三层判定，全部 **fail-closed**（校验器自身出错按拒绝处理）：

| 层 | 规则 |
| --- | --- |
| ① 本机判定 | Host 必须是回环（`localhost` / `*.localhost` / `::1` / `127.0.0.0/8` **逐段**校验）。**写请求强制**；读请求在宿主栅栏可用时交给它判 |
| ② 跨站判定 | `Sec-Fetch-Site: cross-site`、或 `Origin` 与 `Host` 不同源 → 一律拒（防"任意网页 fetch localhost"） |
| ③ 委托宿主 | `connection.requestRejection(req)` —— 它知道 DSH 自己的 `--trusted-host`；它抛异常按拒绝处理 |

> `127.0.0.0/8` 用的是**逐段校验**而不是 `startsWith('127.')` ——
> 后者会放过 `127.0.0.1.evil.com` 这类相似域名（有测试钉住这条）。

部署在反代后面又确实需要远端使用时，显式声明：

```bash
NOVEL2CARD_TRUSTED_HOSTS=card.example.com,192.168.1.9:19387
```

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
| POST | `/novel2card/reveal` | 在系统文件管理器里打开产物目录（目录只能来自任务记录） |
| POST | `/novel2card/cancel` | 协作式取消 |
| POST | `/novel2card/remove` | 删除任务记录与产物 |

SSE 之所以可行：`dsh-host-webserver` 的 gzip 过滤器**显式豁免 `text/event-stream`**，
且 handler 直接拥有 `res`（`route.handler(req, res)`）。

---

## 数据放在哪（不用再翻文件夹）

```
$DSH_HOME/novel2card/
└── output/
    └── task_<时间戳>/          ← 与本地 Web 版同样的产物结构
        ├── character_card.json   ← 角色卡本体，导入 SillyTavern 用这个
        ├── worldbook.json / preset_fragment.json
        ├── characters.json / vision.json
        ├── summary.json / SUMMARY.md
        ├── meta.json / README.md
        └── ...
```

本机 `$DSH_HOME` 是 `C:\Users\<你>\.dsh`，所以完整路径形如：

```
C:\Users\六六六\.dsh\novel2card\output\task_1792745208244\character_card.json
```

**面板里不用翻**：跑完之后「产物」区会显示：

- 每个产物的文件大小，`character_card.json` 带**「下载」**按钮
- **产物目录的绝对路径**（可选中复制）
- **「📂 打开目录」** 按钮 —— 直接在系统文件管理器里打开这个任务目录
- **「复制路径」** 按钮

> 为什么加这个：每层目录都带时间戳，手动找确实麻烦。用户反馈过
> 「我翻文件找有点麻烦」，所以给了这两条捷径。

`/novel2card/reveal` 这条路由的安全要点：**不接受任意路径** ——
目录只能来自服务端自己的任务记录，且必须落在插件数据根之下，
否则就成了「让宿主打开任意目录」的洞。这条有测试钉住（越界目录返回 403）。

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
node tests/dsh-plugin.mjs        # 82 项：解析器 / 清单 / 宿主导出 / 客户端 bundle / 核心目录解析
node tests/dsh-plugin-e2e.mjs    # 58 项：HTTP 端到端 + 信任栅栏
```

**`dsh-plugin.mjs` 里最有价值的一条**：把 `client.js` 放进 `vm` + 假 React 里**实际执行一遍**。
客户端 bundle 要是有语法错或引用了未定义的东西，在浏览器里会直接让整个 slot 崩掉
（控制台：`slot entry crashed in '<slot>'`），而 Node 里完全看不出来 —— 所以必须真跑。

它还在三种安装形态下实测了核心目录解析：在仓库里（link 软链）、
被复制到别处（应**明确失败**而不是碰巧成功）、环境变量兜底，
外加**中文路径**（`D:\角色卡生成器` 就是中文目录）。
后面这条抓到过一个真 bug：`import(new URL('file://' + path))` 这种手工拼法
在中文路径下直接抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，改用 `pathToFileURL` 才对。

**`dsh-plugin-e2e.mjs`** 把插件的路由真挂到一个 HTTP 服务器上，再用一个**假的 OpenAI 兼容端点**
当 LLM，跑完整的「小说 → 角色卡」：

```
POST /novel2card/generate (multipart)
  → SSE: start → 20+ 条 progress → files → done
  → 产物含 character_card.json（结构校验通过）
  → 下载 / 目录穿越被拒 / 取消 / 删除
```

这一层也抓到过两个真 bug：

1. **对已完成的任务订阅 SSE** 时，原来先 `res.end()` 再继续回放历史事件，抛出
   `ERR_STREAM_WRITE_AFTER_END`（未捕获会打挂宿主进程）—— 用户表现是"打开一个历史任务就崩"。
   现在结束信号只由缓冲里的 `__end` 驱动，且幂等。
2. **安全测试第一版是假绿的**：用 `fetch` 伪造 `Host` 头来测栅栏，
   而 `fetch`（undici）会**忽略调用方设置的 `Host`**（forbidden header，运行时自己重写）——
   所有用例都返回 200/404，看起来像"栅栏没生效"，实际是压根没测到。
   改用 `http.request` 才真正验证了栅栏。

栅栏的测试覆盖：本机放行 / `localhost` 放行 / `127.0.0.53` 放行（整段 127/8）/
跨站拒绝 / 跨源拒绝 / `127.0.0.1.evil.com` 拒绝 / `128.0.0.1` 拒绝 /
非本机读写都拒绝 / **全部 8 条路由逐条验证受保护**。

---

## 没验证的部分（诚实说明）

| 项 | 状态 |
| --- | --- |
| 装进真实 DSH profile | ✅ **已装上并验证**：`node_modules/dsh-plugin-novel2card` 是 Junction → `D:\角色卡生成器\dsh`；`GET /novel2card/meta` 返回 200，`core.ok: true` |
| 生成流程（小说 → 卡） | ✅ HTTP 层端到端跑通（真服务器 + 假 LLM），产出的 `character_card.json` 结构校验通过 |
| 信任栅栏 | ✅ 8 条路由逐条验证；**但宿主重启前的实测仍是 200**，需重启后才真正生效（Node 模块缓存） |
| 浏览器里的实际渲染 | ❌ 没看过。侧栏入口与右侧栏面板在真实 DSH 里的样子、`sidebar.panellist` 的 props、`layout.openRightbar` 的可用性都**未经实证** |
| `ctx.webServer` 之外的服务名 | ⚠️ 只注入 `webServer`；`connection` 与 `layout` 都是运行时 `ctx.get()` 取的，拿不到时会回落（栅栏回落自带校验、布局回落为不打开面板 + console.warn） |
| 图片任务 | ⚠️ 路由与逻辑都写了，但端到端只测了小说路径 |
| 宿主进程里的 express/multer | ✅ 没用到 —— multipart 自己解析（`lib/multipart.js`），不新增依赖 |

**如果侧栏入口没出现或点不开**，最先看浏览器控制台有没有
`slot entry crashed` 或 `layout.openRightbar 不可用` —— 前者说明 slot 名或组件有问题，
后者说明 `layout` 服务名不对。这两处是本插件最可能需要按版本微调的地方。
再看 `GET /novel2card/meta` 的 `core.ok` 是否为 true（核心目录有没有找到）。
