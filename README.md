# 小说 / 图片一键生成角色卡工具

把**小说文本**或**图片**自动转换成 **SillyTavern 角色卡**：一批世界书条目（A 包）+ 一套酒馆助手预设片段（B 包），
包含时间线、事件压力、剧情阶段、人设增量与 MVU 变量树。

全程在本机运行：除了调用你自己配置的 LLM API，没有任何外部请求。

| | |
| --- | --- |
| 三条入口 | 小说生成完整卡 / 小说完善已有卡 / 图片生成角色卡 |
| 界面 | 本地 Web 工作台（8 个页面）+ 内置命令行 |
| 测试 | 46 个套件、3542 项断言，全部可离线跑（`npm test`） |
| 依赖 | Node.js ≥ 18，6 个运行时依赖 |

> 本文档只保留快速开始与入口说明；细节都拆到了 [docs/](docs/README.md)，点链接看对应章节。

---

## 快速开始

### 方式一：一键启动器（推荐给非开发者）

| 平台 | 脚本 | 启动方式 |
| --- | --- | --- |
| Windows | `启动.cmd` | 双击 |
| macOS | `启动.command` | 右键 → 打开（首次，绕过安全提示），之后双击 |
| Linux | `启动.sh` | `chmod +x 启动.sh` 后 `./启动.sh` |

脚本自动：检测 Node.js（≥18）→ 检查依赖（缺则 `npm install`，失败换国内镜像）→ 处理端口占用 → 启动服务 → 打开浏览器。

> 端口被占用时：认得出是「本项目自己」就直接打开；是别的程序就自动往后扫 3001–3009；整段都被占才报错并给手动办法。
> 细节见 [一键启动器实现说明](docs/LAUNCHER.md)。

仓库内也可以直接用：

```bash
npm run launch                       # 等同双击启动脚本
npm run launch -- --port 3001        # 指定端口
node scripts/launcher.mjs --check    # 只自检（Node/依赖/端口）
```

### 方式二：手动启动（开发者）

```bash
npm install
npm start
```

浏览器打开 <http://localhost:3000>。

### 然后：先选输出内容

「生成流程」页顶部三个按钮决定产出：

| 按钮 | 产出 | 适用 |
| --- | --- | --- |
| **完整 JSON 角色卡**（默认、推荐） | `character_card.json` | SillyTavern 导入一次即可 |
| **A 包 + B 包** | `worldbook.json` + `preset_fragment.json` | 想手动控制导入流程 |
| **两者都要** | 两套产物 | 不确定 / 想都留着 |

### 然后

1. **设置** → 填 Base URL / API Key / 模型 → 点「测试连接」
   - DeepSeek：`https://api.deepseek.com/v1` + `deepseek-chat`
   - 本地 Ollama：`http://localhost:11434/v1`，Key 可留空
2. **生成流程** → 选小说（.txt / .md）→ 设 user 模式 → 开始生成
3. **任务与产物** → 打包下载，或逐个下载
4. **角色卡内容 / 预设规则** → 核对世界书条目、变量树、阶段增量
5. 按产物里的 `README.md` 导入 SillyTavern

底栏可直接输入 `gen` 启动生成；`help` 查看全部命令。

---

## 四种使用入口

| 入口 | 说明 | 文档 |
| --- | --- | --- |
| **Web 工作台** | 8 个页面：生成 / 图片 / 任务与产物 / 角色卡内容 / 预设规则 / 命令参考 / 设置 | [界面结构与前端约定](docs/WEB_UI.md) |
| **命令行** | 内置 `gen` / `help` 等命令；另有启动器与目录生成脚本 | [命令系统](docs/COMMANDS.md) |
| **DSH 插件** | 在 DeepSeek Harness 界面里用面板，或直接在聊天里说「把 D:\书.txt 做成角色卡」 | [dsh/README.md](dsh/README.md) |
| **Agent 工具** | `novel2card_generate` / `_augment` / `_image_card` / `_list_results` / `_read_result`（插件注册） | [dsh/README.md](dsh/README.md) |

---

## 命令速查

```bash
npm start                      # 启动 Web 工作台（默认 3000 端口）
npm run launch                 # 一键启动器（自动检测 / 换端口）
npm test                       # 全量测试（45 套件）
npm run build:portable         # 便携打包（含启动脚本与 zip）

node scripts/image-card-from-dir.mjs --dir <图片目录> [--title 名称]   # 从本机目录生成图片卡
node scripts/token-audit.mjs   # Token 消耗审计（真实任务）
node scripts/token-audit.mjs --simulate   # 估算各配置档位成本（不花钱）
```

全部命令与参数见 [命令系统](docs/COMMANDS.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [文档索引](docs/README.md) | 全部文档一览 |
| [命令系统](docs/COMMANDS.md) | CLI 命令、启动器参数、脚本用法 |
| [两个任务模式](docs/USAGE.md) | 从零生成 / 完善已有卡、章节选择、完善指令 |
| [生成预设](docs/PRESETS.md) | 自定义 prompt 的结构、按 Step 覆盖 |
| [产物说明与导入](docs/OUTPUT_AND_IMPORT.md) | 生成哪些文件、一次导入 / 分开导入、组装函数 |
| [图片生成角色卡](docs/IMAGE_CARD.md) | 图片 → 设定的总结流程、档位、外观精修、分批与切片 |
| [界面结构与前端约定](docs/WEB_UI.md) | 页面结构、变更总结、进度跨页、表单与校验 |
| [文本编码](docs/ENCODING.md) | GBK / Big5 / UTF-16 自动检测、文件名乱码 |
| [一键启动器](docs/LAUNCHER.md) | 三平台脚本分工、端口占用处理、打包 |
| [开发、测试与项目结构](docs/DEVELOPMENT.md) | 目录结构、测试套件、克隆与推送、健壮性约定 |
| [DSH 插件](dsh/README.md) | 插件面板、Agent 工具、路由表、数据目录、安全栅栏 |

---

## 说明

- 服务只监听 `127.0.0.1`，API Key 仅经本地服务转发给 LLM，不写盘、不上传第三方。
- 小说文本、产物都留在本机 `output/`，可随时删除；上传原件在 `uploads/`，两者都已被 `.gitignore` 排除。
- 生成档位、角色卡版本（普通版 / 成人版）、格式（普通卡 / 完整卡）等行为细节见文档索引对应章节。

---

## 许可

**GNU Affero General Public License v3.0（AGPL-3.0）** —— 全文见 [LICENSE](LICENSE)。

Copyright (C) 2026 米德格拉伊（[@1KMJTIO194](https://github.com/1KMJTIO194)）

| 你可以 | 你必须 |
| --- | --- |
| 免费使用、修改、私有部署（**自己用不受任何限制**） | 分发修改版时**同样以 AGPL-3.0 开源**并提供完整源码 |
| 拿去研究、二次开发 | 保留版权声明与许可声明 |
| — | **把它改成网络服务给别人用**时，也要向那些用户提供源码（AGPL 第 13 条） |

> 一句话：**自己用随便用；对外分发（包括做成在线服务）必须开源**。
> 历史说明：本仓库早期提交（`2b47d1b` 及之前）曾以 MIT 发布，那些已发出的副本仍按 MIT 有效；从之后的提交起改为 AGPL-3.0。

本工具只做「文本/图片 → 角色卡文件」的转换，**在本机运行**，
除了调用你自己配置的 LLM API 之外没有任何外部请求，也不收集任何数据。
