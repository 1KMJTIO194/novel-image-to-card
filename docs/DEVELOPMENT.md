> 本文是项目 [README](../README.md) 的展开说明；文档索引见 [docs/README.md](README.md)。

# 开发、测试与项目结构

## 目录结构

```
server.js              Express 服务：SSE 生成、任务 API、预设校验/预览、静态资源
src/
  pipeline.js          生成主流程（Step 0.5 → Step 8）
  llm.js               OpenAI 兼容客户端 + 按 Step 应用预设 + 连通性测试 + 模型列表
  encoding.js          文本编码检测与转码（BOM / UTF-8 校验 / jschardet + iconv-lite）
  image_card.js        图片 → 角色卡：视觉抽取、分批并发、跨批去重、同图合并、切片接线
  image_summary.js     把图片里的信息总结成角色/世界设定（不写画面描述、不抽剧情）
  detail_level.js      生成档位（基础版 / 完整版）与反剧透约束
  content_mode.js      角色卡版本（普通版 / 成人版）
  card_format.js       角色卡格式（普通卡 / 完整卡：美化与变量）
  event_segments.js    事件按剧情段落分组（事件条目按段撰写的依据）
  char_excerpt.js      主要角色的定向节选（按出场章节取样）
  image_detail.js      主要角色外貌/服装精修（分层后单独再看一次图）
  image_slice.js       超长截图竖直切片（解决长图里的文字读不到）—— sharp 是可选依赖
  preset.js            转发 public/js/core/preset-schema.js（保持服务端引入路径稳定）
  steps.js             各步骤的提示词
  templates.js         B3/B4/B5 模板与 B4 渲染
  utils.js             JSON 解析、并发映射、章节切分、token 估算
public/
  index.html           外壳（侧边栏 + 顶栏 + 内容区 + 命令栏）
  css/base.css         设计令牌与通用组件
  css/panels.css       业务面板样式
  js/app.js            应用装配、路由注册、任务轮询、全局进度指示器
  js/core/active-run.js     活动生成任务状态中心（流、事件日志、轮询、派生渲染状态）
  js/core/model-picker.js   模型选择器（下拉面板、过滤、键盘操作、四种加载状态）
  js/core/preset-schema.js  预设纯逻辑：校验 / 合并 / describe / preview（前后端共用）
  js/core/             api / store / router / commands / terminal / dom / preset-manager
  js/pages/            七个页面模块
dsh/                   DeepSeek Harness 插件（复用 src/ 的核心，产物与本地版一致）
  index.js             宿主侧：ctx.webServer.register 挂 /novel2card/* 路由
  client.js            浏览器侧：__ModuleLoader__ bundle，UI 挂到 sidebar.panellist
  lib/tasks.js         任务注册表（内存 + SSE 缓冲 + 取消）
  lib/multipart.js     自带的 multipart 解析器（宿主里没有 express/multer）
  cordis.patch.yml     bundle 挂载声明
scripts/
  image-card-from-dir.mjs  从本机目录直接生成角色卡（CLI；与网页版共用同一套扫描/流水线）
tests/
  character-card.mjs   完整角色卡结构（chara_card_v3、initvar、EJS、正则）
  output-mode.mjs      输出模式（card / ab / both 的真实产物集合）
  api-config.mjs       API 配置（Base URL / 鉴权 / 请求体 / 错误映射 / 转发）
  encoding.mjs         编码检测与转码（GBK/Big5/UTF-16/BOM/乱码二进制/真值）
  encoding-e2e.mjs     真实 GBK 小说跑完整流水线（需 uploads/ 里的真值文件）
  filename-encoding.mjs 上传文件名乱码修正
  preset.mjs           预设单元测试（合并顺序、replace、校验、step 传参）
  progress-persist.mjs 进度跨页面保持（切页、切回、刷新、转入后台）
  launcher.mjs         一键启动器（静态检查 + 纯函数单测 + zip 校验）
  e2e.mjs              后端端到端（内置假 LLM，含预设生效性断言）
  frontend-smoke.mjs   前端模块冒烟（最小 DOM 桩，零依赖）
  jsdom-smoke.mjs      真实 DOM 冒烟（jsdom，可选）
  preset-ui.mjs        预设 UI 测试（导入/编辑/确认/预览/提交）
  form-audit.mjs       表单规范审计 + 模型选择器 + 浏览器模块图完整性
scripts/               一键启动器（打包时复制到 zip 根目录）
  启动.cmd             Windows：纯 ASCII 引导脚本
  启动.command         macOS：bash，原生 UTF-8
  启动.sh              Linux：bash，原生 UTF-8
  launcher.mjs         Windows 脚本调用的 Node 启动器（三平台逻辑参考实现）
  使用说明.txt          随 zip 分发的三平台说明与常见问题
dist/                  便携版打包产物（npm run build:portable）
output/<taskId>/       每次生成的产物
uploads/               临时上传（生成后自动清理）
```

## 测试

```bash
npm test               # 十三套全跑
npm run test:card      # 完整角色卡结构（chara_card_v3）
npm run test:mode      # 输出模式（三种模式的真实产物集合）
npm run test:api       # API 配置（Base URL / 鉴权 / 请求体 / 错误映射 / 转发）
npm run test:encoding  # 编码检测与转码（GBK/Big5/UTF-16/BOM/乱码二进制）
npm run test:filename  # 上传文件名乱码修正
npm run test:preset    # 预设单元测试（纯逻辑，零依赖）
npm run test:progress  # 进度跨页面保持（jsdom）
npm run test:launcher  # 一键启动器（静态检查 + 逻辑单测 + zip 校验）
npm run test:e2e       # 后端端到端（需先 npm start）
npm run test:ui        # 前端模块冒烟（自制 DOM 桩）
npm run test:dom       # 真实 DOM（jsdom）
npm run test:preset-ui # 预设 UI（jsdom）
npm run test:form      # 表单规范审计 + 模型选择器 + 模块图完整性
```

| 套件 | 断言数 | 覆盖内容 |
| --- | --- | --- |
| `tests/character-card.mjs` | 196 | chara_card_v3 结构、initvar 必须关闭、**initvar 根节点无 stat_data 包裹层**、EJS 未转义、**EJS 用真实引擎实际渲染**、**更新规则路径能在 initvar 里逐条取到**、**变量名含点号/空白时的路径安全**、**initvar YAML 抗特殊字符**、正则/tavern_helper、**世界书容器字段**、**insertion_order 全局唯一且内置 1–9**、**creator_notes 三件事清单**、变量规则按实际变量树展开、三种 userMode、空上下文兜底、同名去重、顶层与 data.* 一致性 |
| `tests/data-layer.mjs` | 128 | **数据层真实故障的回归**：人物 keys 不能是 prompt 字段名、**人物名单必须吃下 LLM 的 11 种返回形态**（防"人物条目全丢"）、**主名查不到时用别名保底**、描述性称呼/机构名/幻觉名剔除、名字收敛成原文形式、历史背景与故事线分离、**时间线按叙事顺序**、**采样必须覆盖首/中/尾**、世界观占位符拦截与实质兜底、**phase 与角色阶段表对齐**、事件时间回填 |
| `tests/chapter-range.mjs` | 65 | `parseRange` 的 `all`/`1-5`/`1,3,5-8`/越界/写反/去重/空值，`chunkText` 的范围过滤与**选中为空时明确报错**，无章节标记时的退化，`listChapters` 的 1-based 序号，两模式口径一致 |
| `tests/augment.mjs` | 148 | 卡片校验与结构提取、initvar 解析（含坏 YAML）、**实体对齐**（别名命中/新增/冲突/失败降级）、**matched 落空退化为新增**、append/merge/overwrite 三策略、变量树合并、**角色阶段表文本层面合并且不跨 EJS 标签**、原卡扩展原样保留、版本递增、id 唯一连续。**含「不用标准前缀的卡」的回归**：那种卡的类型全为空，对齐器必须仍能看到全部条目并按名字合并（否则新内容会全部变成新条目） |
| `tests/dates.mjs` | 143 | 日期解析与规范化（显式年月日优先于推断）、中文数字、相对时间、**块标题带句读时的章节匹配**、时间提及与事件的对齐、跨年推断边界 |
| `tests/statusbar.mjs` | 267 | 状态栏 HTML 生成与校验：所有 class 必须带 `custom-` 前缀、CSS 变量不得落在 `body`/`:root`、字段路径与变量树一致、**非 ST 宏的 `{{ }}` 必须为 0**、正则隐藏规则、预览页可独立打开 |
| `tests/batcher.mjs` | 78 | 分批切分（章数/字数先到者为准）、批次边界与断点续跑、批次状态落盘与读回、并集覆盖全部章节 |
| `tests/merge_batches.mjs` | 68 | 分批结果归并：同分类同名去重、跨分类同名合并、**超出分类配额时合并进已有条目而不是丢弃**、报告字段 |
| `tests/character-tiers.mjs` | 67 | 人物分层（主角/主要NPC/次要NPC/路人NPC）：按剧情占比与出章数判定、注释前缀、按层筛选与关闭 |
| `tests/pipeline-merge.mjs` | 16 | 合并调用的开关：同一段正文只喂一次时各 Step 的传参不重不漏 |
| `tests/robustness.mjs` | 68 | **抽取事故回归**：`asArray` 吃下 LLM 的 7 种容器形态（**单条目对象不被误当容器**）、事件/世界观字段名与中文分类值归一化、变量树兜底（占位事件 + 主线 + **恰好一个 ongoing**）、时间线不再输出无信息量占位、世界观兜底必须含 `map_world` |
| `tests/density.mjs` | 39 | **内容密度契约**：四类 Prompt 必须含全部模板字段与防编造约束、`content_yaml`/`content`/中文键名兼容、逐字段「未提及」放行但整条空话拦截、**空壳条目（只有 name/title/type）算占位符**、事件完整正文优先且缺失时回退简洁格式 |
| `tests/output-mode.mjs` | 90 | card / ab / both 三种模式**真实生成**后的产物集合、files 事件清单、README 随模式变化、meta/project 记录模式、默认与非法值回退 |
| `tests/api-config.mjs` | 51 | Base URL 拼接（结尾斜杠/多级路径/漏写 `/v1`）、Authorization 头、请求体字段、模型列表两种结构、401/404/429/500/HTML/超时的可读错误、生成接口确实使用页面配置 |
| `tests/encoding.mjs` | 84 | GBK/GB2312/Big5/Shift_JIS/Latin-1、UTF-8·UTF-16 的 BOM、低置信度警告、乱码二进制优雅回退、真值文件还原 |
| `tests/filename-encoding.mjs` | 13 | multipart 文件名 latin1 乱码检出与修正、ASCII/已正确解码时不误伤 |
| `tests/preset.mjs` | 73 | 合并顺序、append/replace 语义、JSON 兜底、校验告警、各 Step 传参无遗漏 |
| `tests/progress-persist.mjs` | 73 | 切页时流不断、切回后进度完整重建、只增不减、刷新自动接上、转入后台不误判完成 |
| `tests/launcher.mjs` | 176 | 三平台脚本齐全 / Windows 脚本纯 ASCII / Unix 分支与结构配对 / 依赖判定 / 端口探测 / zip 权限位 / `--check` 无副作用 / 交互读取不挂死 / **向后找空闲端口**（扫描边界、全占返回 null）/ **识别端口上是不是本项目自己**（`/api/system` 的 `cwd`） |
| `tests/e2e.mjs` | 188 | 界面模块全部可达、生成、**character_card.json 存在于产物且 >10KB**、产物结构、任务 API、打包、命令降级、预设真的作用到 prompt |
| `tests/frontend-smoke.mjs` | 77 | 外壳装配、命令、补全、持久化、各页渲染、桩 SSE 生成、降级提示 |
| `tests/jsdom-smoke.mjs` | 50 | 真实 DOM：表单值语义、querySelector、页面切换、命令面板、终端、CSS 覆盖率、**下拉按 name 定位（不按下标）** |
| `tests/preset-ui.mjs` | 48 | 预设卡片：导入/编辑/实时校验/replace 确认/预览弹层/生成时提交 |
| `tests/form-audit.mjs` | 85 | 模块图可解析性（防白屏）、逐页 ID/name/label、按钮 type、模型选择器状态与交互 |
| `tests/image-card.mjs` | 119 | 图片 → 卡：视觉可用性判据（含真实模型的拒答原文回归）、短地名、**长漫画分批**（上限 60、批次切分、`imageOffset` 全局图号、跨批去重、空批次告警） |
| `tests/image-slice.mjs` | 70 | **超长截图切片**：切法几何（该切才切、无缝隙、无漏切、重叠防切断文字行）、切片→原图下标映射（含与 `imageOffset` 不叠加）、真实切图验证、sharp 缺失时优雅回落 |
| `tests/image-card-fields.mjs` | 60 | **同图重复合并**（6 段合成 1 条、不同名不合并、跨图不合并）与**截图文字被用起来**（转录进世界书并去重、description 写出身份/关系、scenario 用文字而非画面、prompt 指令齐全） |
| `tests/image-summary.mjs` | 97 | **信息→设定**：指涉图片的措辞被清洗、prompt 明令禁止"画面描述"与"剧情事件"、归一化容错、设定 YAML 不写「图片未提供」占位、装配后**没有剧情事件条目**、卡字段全部不含指涉图片的措辞、两个入口接线、**年龄/身高/体重/三围必定出现**（有值照写、缺值写「未提供（可自行设定）」、纯视觉路人不加占位） |
| `tests/image-card-dir.mjs` | 25 | **从本机目录生成**：只收图片扩展名、自然序（1,2,10 不乱序）、数量上限、空目录/坏路径可读报错；服务端**只接受回环请求**且把图复制进任务目录；前端输入框与 CLI 共用同一扫描函数 |
| `tests/image-detail.mjs` | 72 | **主要角色外貌精修**：只精修主角/主要NPC、按视觉档案找图、名字对不上时按页采样兜底、只在更详细时覆盖、`found:false` 不清空、失败不中断；prompt 覆盖发型/五官/肤色/上下装/鞋袜/配饰；Web 版 + DSH 插件 + CLI 三处接线 |
| `tests/detail-level.mjs` | 79 | **生成档位**：基础版不加量、完整版才追加更细要求；反剧透「禁止推测未揭示的真相」两档都有且只这一条；分层字数随档位、路人两档一致；图片总结与精修人数随档位；六个入口都接线；**真跑一遍 runPipeline 两档**（抓过 TDZ 崩溃） |
| `tests/content-mode.mjs` | 72 | **角色卡版本**：默认普通版（不传/传错都回落）、普通版由**代码**删成人字段（不只靠 prompt）、成人版保留并写具体、两档都有「出场角色须成年」；图片路径总结清空/保留成人字段；世界书装配关口；六个入口接线；真跑两档 pipeline |
| `tests/card-format.mjs` | 77 | **角色卡格式**：默认完整卡、普通卡=完整卡严格子集（只少美化与变量，设定一个不少）、无 `regex_scripts`/`tavern_helper`、跳过状态栏调用、不产出变量/状态栏/正则文件；两档都真跑 pipeline；六个入口接线 |
| `tests/event-segments.mjs` | 38 | **剧情条目按段落生成**：事件章节标记（含中文数字/无章节兜底）、分组只带本段原文、**最后一段原文确实被喂到**（旧实现永远看不到）、简介独立调用且不塞原文、基础版保持旧行为、`eventEntriesPerBatch` 可强制开关、prompt 接线 |
| `tests/major-profiles.mjs` | 27 | **主要角色定向档案**：章节检索（名字/别名、单字忽略、首尾+均匀取样）、节选只含出场章节且不超上限、完整版默认开/基础版默认关、定向调用带「按出场章节取样」且**包含后期章节**（旧的全书随机抽样做不到）、次要角色仍批量、`charMajorTargeted`/`majorTargetedLimit` 可开关 |
| `tests/summary.mjs` | 66 | 变更总结：完善的前后差异、从零生成的产出清单、零变化时给原因、真实报告字段对齐、分类计数不可用时**不显示误导的 0** |
| `tests/card-doctor.mjs` | 51 | 成卡体检与无损优化：空壳/同名/key 冲突/常驻预算；**只删无 keys 的空壳**，有 keys 的只报告；合并保留两边正文 |
| `tests/augment-instruction.mjs` | 43 | **完善指令 + 已有卡世界观上下文**：摘要要读得懂（取正文值而不是复述条目名、YAML 键名不外泄、超限截断并说明）、指令段措辞（高优先级、不得违反事实）、以及 `runAugment` 四个步骤确实注入了上下文 |
| `tests/augment-integrate.mjs` | 20 | **完善卡的人设整合**：默认开启时条目被整合（不再出现「【新增内容】」、含新信息、保留旧信息）、关闭时保持追加合并、整合失败不中断且记进 `integrateSkipped`、append 策略不整合、报告 `how=integrated`、prompt 要求冲突以新剧情为准 |
| `tests/budget-whole.mjs` | 16 | **整套常驻预算**：卡内置的固定常驻模板（变量更新规则 / 导演指令 / 角色阶段…）从不参与预算计算，于是"导入完整卡时超标"是静默的；这里按用户实际导入的东西复算并告警 |
| `tests/usage-merge.mjs` | 18 | **图片路径 token 记账**：`mergeUsage` 合并 calls/inputChars/outputChars/byStep、同 step 累加、null/坏值安全；Web 版合并三份（视觉+总结+精修）、插件合并两份；合并后 byStep 同时含 `image-vision` 与 `image-summary` |
| `tests/token-audit.mjs` | 36 | **Token 审计工具**：字符→Token 换算、按步骤汇总、真实任务审计（成功/失败/浪费/倍数）、报告渲染；确定性模拟钉住配置成本关系（完整版 > 基础版、关 P0/P1 各自能省、逐个档案比批量贵）；prompt 分类与 CLI 参数 |
| `tests/dsh-plugin.mjs` | 137 | DSH 插件：multipart 解析（二进制逐字节）、清单/补丁/图标/语言包约定、宿主导出形态、**客户端 bundle 在 vm + 假 React 里实际执行**、**main.key 必须等于 sidebar.panellist.id**、核心目录在四种安装形态下解析（含中文路径）、**查看角色卡文件位置**、**Agent 工具**（5 个工具的定义/注册/配置读写/路径白名单） |
| `tests/dsh-plugin-e2e.mjs` | 115 | DSH 插件 HTTP 端到端：路由挂真服务器 + 假 LLM，跑完整「小说 → 角色卡」与「完善（带指令）」；含 SSE、产物下载、目录穿越拦截、取消；**信任栅栏**（跨站/跨源/非本机一律拒，路由逐条验证）；**打开产物目录 / 定位角色卡文件**；**Agent 工具端到端**（保存接口配置 → generate/augment 工具真实产出卡片 → list/read 找回结果） |
| `tests/docs-links.mjs` | 13 | **文档链接与精简度**：根 README 保持 ≤300 行（拆分前 1500+ 行）、长章节已移出、`docs/` 10 篇文档齐全且都有回链、README / docs / dsh README 的相对链接无断链、docs 索引列全使用文档与技术笔记 |

合计 **3542 项断言 / 46 个套件**。EJS 渲染那组断言需要 `ejs`（已列为 devDependency）；
找不到引擎时会打印跳过提示而不失败，可用 `EJS_PATH` 环境变量指向任意 ejs 副本。

> `tests/output-mode.mjs`、`api-config.mjs`、`filename-encoding.mjs`、`e2e.mjs` 里有几条断言
> 会请求 `127.0.0.1:3000` 上的本地服务 —— **没有服务在跑时它们会失败**（`ECONNREFUSED`），
> 这不是代码回归。先 `npm start` 再跑全量即可。

另外三份**针对性核验脚本**（不进 `npm test`，前两份需要服务器在 3000 端口运行）——
它们不看测试绿不绿，而是把真实生成的 `character_card.json` 拆开逐字段核验：

| 脚本 | 断言数 | 它回答什么问题 |
| --- | --- | --- |
| `tests/_verify-card.mjs` | 102 | 模拟 LLM 生成，逐项核验 JSON 是否完整：规范字段、`data.*` 一致性、正则真的能隐藏 `<update>`、EJS 配对未转义、条目字段齐全、跨产物一致 |
| `tests/_verify-real.mjs` | 69 | 拿**真实 GBK 长篇小说**（220 KB 字节流）跑完整流水线，核验转码无乱码、initvar 与取值路径对齐、更新规则路径可达、条目顺序唯一、体积与内容饱满度 |
| `tests/_verify-ejs.mjs` | 57 | 用真实 EJS 引擎把每条 EJS 条目在 6 种情形下**实际渲染**，并核对渲染内容的正确性（偏离度分支、阶段命中、极端阶段名） |

```bash
node tests/_verify-ejs.mjs     # 不需要服务器
node tests/_verify-card.mjs    # 需要服务器在跑
node tests/_verify-real.mjs    # 需要服务器在跑 + uploads/ 里有真实 GBK 文件
```

另外 `tests/encoding-e2e.mjs` 是针对性回归：拿**真实的 GBK 小说**跑完整条流水线，
断言日志里的编码说明、`meta.json` 的 `sourceEncoding`、以及**送进 LLM 的 prompt 是正确中文**。
它需要 `uploads/` 里那份真实 GBK 残留（`npm run test:encoding` 不含它）：

```bash
node tests/encoding-e2e.mjs
```

**关于启动器的测试边界**：本开发沙箱禁止 `spawn` 子进程，因此 `tests/launcher.mjs` 不去
"运行启动器"，而是把 `launcher.mjs` 的纯函数直接 import 进来单测（依赖判定、端口探测、参数解析、
版本校验），外加静态检查三平台脚本。真正的端到端启动（双击 → 装依赖 → 开浏览器）在
`npm run launch` 与手工双击中覆盖，实现已在 Windows 上实测通过。

`tests/e2e.mjs` 会自建一个假的 OpenAI 兼容服务并按提示词特征返回结构化数据，
因此可以在**不消耗任何 API 额度**的情况下跑完整条流水线；它还会记录每次收到的
system/user 消息，用来断言预设的后缀确实被追加到了正确的 Step、且没污染别的 Step。
`jsdom` 只用于测试，未安装时 `test:dom` / `test:preset-ui` / `test:form` 会自动跳过。

## 克隆与推送

代码已按 **AGPL-3.0** 协议开源（自己用不受限制；对外分发修改版或做成在线服务需同样开源）。`.gitignore` 会排除**全部用户数据**：

| 被排除 | 内容 |
| --- | --- |
| `output/` | 用你的小说生成的角色卡、世界书、变量树、总结 |
| `uploads/` | 你上传的小说 / 角色卡 / 图片原件 |
| `_tmp-*`、`.tmp-*` | 临时脚本（其中一批曾硬编码真实书名与本机路径） |
| `acl-recovery/`、`_acl-recovery/` | 本机环境产物（含机器 SID 与路径） |
| `.env`、`node_modules/`、`dist/` | 常规 |

推送到新仓库：

```bash
git init
git add -A
git commit -m "feat: 小说/图片一键生成 SillyTavern 角色卡"

# 中文文件名在 git status 里会显示成 \xxx 八进制转义，看着像乱码 —— 关掉它：
git config core.quotePath false

git branch -M main
git remote add origin https://github.com/1KMJTIO194/novel-image-to-card.git
git push -u origin main
```

推送前自查（确认没有私人内容混进去）：

```bash
git status --porcelain          # 看有没有 output/ uploads/ _tmp-* 之类的意外项
git ls-files | Select-String "output|uploads|_tmp-"   # 应为空
```

> **历史小提示**：`feat(dsh): 增加 DeepSeek Harness 插件` 这一步是通过
> GitHub Git Data API 推的（当时 `github.com:443` 不可达而 `api.github.com` 通），
> 所以它的 commit SHA（`64d7fb9`）与本地 `git commit` 得到的不同。
> **内容完全相同** —— 两侧 tree SHA 都是 `4ddb3d2d…`。
> 下次网络正常时 `git push` 把本地那条推上去，历史自然对齐。

## 说明

- 服务只监听 `127.0.0.1`，API Key 仅经本地服务转发给 LLM，不写盘、不上传第三方。
- 小说文本、产物都留在本机 `output/`，可随时删除。
- 便携打包（含启动脚本与 zip）：`npm run build:portable`。

### 健壮性约定

- **界面资源不被缓存**：`.js / .css / .html` 一律 `Cache-Control: no-store`。
  本地单机应用缓存省不下什么，但过期缓存会让你在改完代码后仍执行旧模块，
  表现为「明明修好了还是白屏」。
- **模块图完整性有测试兜底**：`tests/form-audit.mjs` 静态遍历 `public/` 下所有 `import`
  并检查目标文件存在、不越出 `public/`；`tests/e2e.mjs` 进一步逐个 URL 请求实际运行的服务，
  确认 54 个模块全部返回 200。任何模块路径写错都会在测试里直接暴露，而不是等到白屏。
- **外部命令失败不影响服务**：`exec` 在权限受限环境（沙箱、精简系统）下会**同步抛出** `EPERM`，
  未接住会直接终结进程。所有外部命令统一走 `spawnDetached()`，同时兜住同步抛出与异步回调报错；
  「打开目录」失败时返回 `{ok:false, hint}` 降级提示，前端与 `reveal` 命令都会改用文字路径 + 打包下载。
- **进程级兜底**：另有 `uncaughtException` / `unhandledRejection` 记录日志后继续运行，
  避免任何漏网异常让本地服务悄悄退出。
- **协作式取消**：生成过程在每个阶段边界检查 `AbortSignal`，取消后不会写坏产物。
- **进度状态与页面解耦**：生成状态由 `active-run.js` 持有，「切页 / 刷新 / 转入后台」都不会丢进度；
  页面卸载通过 `dsh:route-leave` 清理定时器，避免定时器随导航泄漏。详见 [界面结构 → 生成进度跨页面保持](WEB_UI.md)。

