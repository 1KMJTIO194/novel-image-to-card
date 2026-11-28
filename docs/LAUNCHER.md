> 本文是项目 [README](../README.md) 的展开说明；文档索引见 [docs/README.md](README.md)。

# 一键启动器实现说明

三平台脚本都做了同一套检查，但**分工不同**：

```
Windows：启动.cmd（纯 ASCII）──┐
                               ├─→ scripts/launcher.mjs（真正的逻辑 + 中文提示）
macOS  ：启动.command（bash）──┘   （Unix 脚本自带等价实现，不依赖 launcher）
Linux  ：启动.sh（bash）
```

**为什么 Windows 脚本是纯 ASCII、中文提示放在 Node 里？**
`cmd.exe` 按**控制台代码页**解析批处理文件。带中文的 UTF-8 批处理在部分系统上会被吃掉字节，
表现为莫名其妙的 `'xxx' is not recognized as an internal or external command`；
而 `chcp 65001` 在旧版 conhost 里中文又会变乱码。
所以 `启动.cmd` 只保留 ASCII 的引导逻辑（找 node、转交），所有中文提示由 `launcher.mjs` 输出 ——
Node 处理 UTF-8 是稳的，而且过了 Node 检测就一定能跑。
这一点有测试强制：`启动.cmd` 里出现任何非 ASCII 字符都会让 `test:launcher` 失败。

**npm 调用方式**：不用 `shell: true`（会把参数拼成字符串，Node 会抛 DEP0190），
也不用 `npm.cmd`（`shell: false` 执行不了），而是用**当前 Node 直接执行 npm 自带的 `npm-cli.js`**，
完全绕开 shell 与 PATH 差异。

**依赖判定**：`node_modules` + 关键包（express / multer）+ `.deps-ok` 标记文件三者齐全才算就绪。
标记文件让「首次运行」与「后续运行」能给出不同提示；安装成功后自动写入，之后启动就是秒开。

**端口占用**：启动前主动探测，比等服务报错更早给出可读提示。三件事：

1. **认自己**：先请求 `/api/system` 看 `cwd` 是不是本项目 —— 是的话说明"你双击了两次"，
   直接打开已在运行的那个界面，不再起第二个实例。
2. **报占用者**：Windows 用 `netstat` + `tasklist`，Linux 用 `lsof`/`ss`；
   识别不到时（端口转发 / 容器 / 别的用户）会明说识别不到，不假装知道。
3. **自动换端口**：从 `端口+1` 往后扫 10 个（`PORT_SCAN_RANGE`），用第一个空闲的；
   全都占了才让用户 `set PORT=`。换之前会问一句，并打印换成了哪个，不会悄悄换。

## 打包

```bash
npm run build:portable
```

产出 `dist/novel2card-便携版.zip`（含三平台脚本与 `使用说明.txt`）。
打包时会把 `启动.command` / `启动.sh` 的 zip 权限位显式写成 755 ——
Windows 上没有可执行位，若用 `archive.directory()` 从 stat 读取，解压到 macOS/Linux 后会丢失执行权限。
