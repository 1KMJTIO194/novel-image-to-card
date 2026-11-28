# 文档索引

项目 [README](../README.md) 只保留快速开始与入口说明；详细内容在这里。

## 使用文档

| 文档 | 内容 |
| --- | --- |
| [一键启动器](LAUNCHER.md) | 三平台启动脚本的分工、端口占用处理、打包方式 |
| [文本编码](ENCODING.md) | GBK/Big5/UTF-16 自动检测、上传文件名乱码 |
| [界面结构与前端约定](WEB_UI.md) | 8 个页面、变更总结、进度跨页保持、表单可访问性、模型选择器、Base URL 校验 |
| [命令系统](COMMANDS.md) | 全部终端命令与参数 |
| [生成预设](PRESETS.md) | 自定义 prompt 的结构、按 Step 覆盖、append/replace |
| [两个任务模式](USAGE.md) | 从零生成与完善已有卡、章节选择、完善指令 |
| [图片生成角色卡](IMAGE_CARD.md) | 图片 → 设定的总结流程、档位、精修、分批、切片 |
| [产物说明与导入](OUTPUT_AND_IMPORT.md) | 一次导入 / 分开导入、世界书与预设片段、组装函数 |
| [开发、测试与项目结构](DEVELOPMENT.md) | 目录结构、测试套件、克隆与推送、健壮性约定 |
| [DSH 插件](../dsh/README.md) | 插件面板、Agent 工具、路由表、数据目录、安全栅栏 |

## 技术笔记（实现向）

这些是开发过程中按主题记录的细节 / 踩坑与设计取舍，适合想改代码或排查异常时查阅。

| 笔记 | 内容 |
| --- | --- |
| [分批评析](batching.md) | 为什么分批、批次切分、摘要链与上下文链 |
| [合并调用](merged-calls.md) | 同一段正文只喂一次：逐章 / 世界观 / 人物 / 事件+简介的合并口径 |
| [人物分层](character-tiers.md) | 主角 / 主要NPC / 次要 / 路人的判定与档位详细度 |
| [时间线构成](timeline-from-events.md) | 事件 → 时间线的求解方式（含第二轮真实小说修复） |
| [状态栏生成器](step75-statusbar.md) | Step 7.5 设计：状态栏、正则体系、主题与校验 |
| [状态栏美化背景](statusbar-sanitization.md) | 状态栏 / 正文美化的背景为什么是透明的（酒馆 DOM 约束） |
| [时间与触发词](dates-and-triggers.md) | 年份推断、相对时间、事件触发词设计 |
| [图片 → 卡](image-to-card.md) | 图片路径的早期设计与演进 |
| [图片分批上限](image-card-batch-limits.md) | 上限 8 → 60 张与分批处理 |
| [常驻开销与剧情](variable-overhead-and-story.md) | 世界书预算、常驻条目与剧情组织 |
| [真实小说跑测发现](real-novel-findings.md) | 三本真实小说跑出来的 bug 记录 |
| [世界观归并修复](worldview-merge-fixes.md) | P0：世界观归并的两个结构修复 |
| [完善卡静默 bug](augment-fixes-and-summary.md) | 完善角色卡：三个静默 bug + 变更总结 |
| [完善卡并入](augment-merge-into-existing.md) | 新内容为什么没并进已有条目 |
| [章节标记格式](chapter-marker-formats.md) | 第二本真实小说跑出来的章节标记 bug |

## 工具

| 工具 | 用途 |
| --- | --- |
| [`scripts/token-audit.mjs`](../scripts/token-audit.mjs) | Token 消耗审计：真实任务统计 / 各配置档位模拟（不花钱） |
| [`scripts/launcher.mjs`](../scripts/launcher.mjs) | 一键启动器（自检 + 端口检测 + 启动） |
| [`scripts/image-card-from-dir.mjs`](../scripts/image-card-from-dir.mjs) | 从本机图片目录直接生成图片卡 |
