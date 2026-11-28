> 本文是项目 [README](../README.md) 的展开说明；文档索引见 [docs/README.md](README.md)。

# 命令系统

三处入口共用同一套命令：**底部命令栏**、**Ctrl+K 命令面板**、**命令参考页**。

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl + K` | 打开命令面板（模糊搜索 + Tab 补全） |
| `Ctrl + \`` | 展开 / 收起底部终端 |
| `↑` / `↓` | 调取命令历史 |
| `Tab` | 补全命令与参数 |
| `Esc` | 关闭面板 / 清空输入 |

## 命令一览

**配置**
```
base <URL>                  设置 Base URL
key <KEY>                   设置 API Key（仅存本机浏览器）
model [名称]                查看/设置模型；--list 拉取模型列表
mode <auto|protagonist|participant|observer>
config [键] [值]            查看/修改任意配置项
limit <a|b> <token数>       设置 A/B 包常驻 token 上限
save [名称] / load          导出 / 导入配置 JSON
```

**任务**
```
tasks [--limit n]           列出历史任务
open <序号|任务ID>          打开任务（可直接跟 --tab log）
log [序号|任务ID]           回放执行日志
files [序号|任务ID]         列出产物
cat <文件名> [--task ID]    查看产物内容
copy <文件名>               复制产物内容到剪贴板
export [序号|任务ID]        打包 zip 下载
reveal [序号|任务ID]        在文件管理器中打开产物目录
rm <序号|任务ID>            删除任务
cancel [任务ID]             取消运行中的任务
gen [--title 标题]          用当前表单参数开始生成
rerun                       复用上次参数重新生成
```

**系统与界面**
```
status / doctor             状态 / 自检（服务、配置、连通性）
ping                        测试 LLM 连通性
go <页面>                   切换页面
theme [dark|light]          切换主题
term [on|off]               展开 / 收起终端
help [命令]                 命令帮助
clear                       清空终端
```

语法：`命令名 位置参数 --选项 值`，选项也支持 `key=value`，含空格的值用引号包裹。
