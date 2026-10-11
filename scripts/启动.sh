#!/usr/bin/env bash
# 小说 → 角色卡生成器 · 一键启动（Linux）
# 首次使用需要加执行权限：chmod +x 启动.sh

cd "$(dirname "$0")" || exit 1

PORT="${PORT:-3000}"
NODE_MIN=18
DEPS_MARKER=".deps-ok"

# ============================================================
# 输出工具
# ============================================================
say()  { printf '%s\n' "$*"; }
line() { printf '%s\n' "------------------------------------------------------------"; }

say ""
say "============================================================"
say "   小说 → 角色卡生成器"
say "============================================================"
say ""

# Linux 桌面环境下的"打开浏览器"
open_url() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  elif command -v sensible-browser >/dev/null 2>&1; then
    sensible-browser "$1" >/dev/null 2>&1 &
  else
    say "  （未能自动打开浏览器，请手动访问 $1）"
  fi
}

pause_exit() {
  say ""
  # 非交互（例如通过管道调用）时不要卡住
  if [ -t 0 ]; then
    printf '按回车键退出...'
    read -r _ || true
  fi
  exit "$1"
}

# ============================================================
# 1. 检测 Node.js
# ============================================================
if ! command -v node >/dev/null 2>&1; then
  say "  [错误] 未检测到 Node.js"
  say ""
  say "  本工具需要 Node.js 18 或更高版本才能运行。"
  say ""
  say "  安装方式（任选其一）："
  say "    Ubuntu/Debian：  sudo apt install nodejs npm"
  say "    Fedora：         sudo dnf install nodejs npm"
  say "    Arch：           sudo pacman -S nodejs npm"
  say "    或用 nvm：       https://github.com/nvm-sh/nvm"
  say ""
  say "  官网下载：https://nodejs.org/"
  say ""
  open_url "https://nodejs.org/"
  pause_exit 1
fi

NODE_VERSION="$(node -v 2>/dev/null)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"

if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt "$NODE_MIN" ] 2>/dev/null; then
  say "  [错误] Node.js 版本过低：$NODE_VERSION"
  say ""
  say "  本工具需要 18 或更高版本（推荐最新的 LTS）。"
  say "  建议用 nvm 安装新版：https://github.com/nvm-sh/nvm"
  say ""
  open_url "https://nodejs.org/"
  pause_exit 1
fi

say "  [OK] Node.js $NODE_VERSION"

if ! command -v npm >/dev/null 2>&1; then
  say ""
  say "  [错误] 找到了 Node.js，但没有找到 npm。"
  say "         请安装 npm（通常随 Node.js 一起提供）：sudo apt install npm"
  pause_exit 1
fi

# ============================================================
# 2. 检查依赖（首次运行 / 后续运行 区分提示）
# ============================================================
NEED_INSTALL=0
if [ ! -d node_modules ]; then
  NEED_INSTALL=1
elif [ ! -f "$DEPS_MARKER" ]; then
  NEED_INSTALL=1
elif [ ! -d node_modules/express ]; then
  NEED_INSTALL=1
fi

if [ "$NEED_INSTALL" -eq 0 ]; then
  say "  [OK] 依赖已就绪"
else
  say ""
  line
  if [ -d node_modules ]; then
    say "  依赖似乎不完整，正在重新安装..."
  else
    say "  首次运行：正在安装依赖"
  fi
  say ""
  say "  * 需要联网，通常 30 秒到 2 分钟"
  say "  * 装完会自动打开浏览器，请不要关闭这个窗口"
  line
  say ""

  INSTALL_OK=0
  if npm install --no-audit --no-fund; then
    INSTALL_OK=1
    echo ok > "$DEPS_MARKER"
    say ""
    say "  [OK] 依赖安装完成"
  else
    say ""
    line
    say "  [错误] 依赖安装失败"
    line
    say ""
    say "  常见原因：网络问题 / npm 源访问慢，或没有写权限。"
    say ""
    say "  正在自动改用国内镜像重试一次..."
    say ""
    if npm install --no-audit --no-fund --registry=https://registry.npmmirror.com; then
      INSTALL_OK=1
      echo ok > "$DEPS_MARKER"
      say ""
      say "  [OK] 使用国内镜像安装成功"
    fi
  fi

  if [ "$INSTALL_OK" -eq 0 ]; then
    say ""
    say "  [错误] 国内镜像也失败了。请手动执行："
    say ""
    say "    npm config set registry https://registry.npmmirror.com"
    say "    npm install"
    say ""
    say "  若提示 EACCES 权限错误，请改用："
    say "    npm config set prefix ~/.npm-global"
    say "  或用 sudo 运行本脚本。"
    pause_exit 1
  fi
fi

# ============================================================
# 3. 启动服务
# ============================================================
say ""
say "============================================================"
say "  正在启动服务..."
say "  浏览器会自动打开 http://localhost:$PORT"
say "  用完请回到本窗口按 Ctrl+C 停止"
say "============================================================"
say ""

# 由本脚本负责开浏览器，避免服务端重复打开
export NO_OPEN=1

# 后台等服务起来再开浏览器；最多等 20 秒
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/system" 2>/dev/null; then
      open_url "http://localhost:$PORT"
      exit 0
    fi
    sleep 0.5
  done
) &

node server.js --port "$PORT"
CODE=$?

if [ "$CODE" -eq 0 ]; then
  say ""
  say "  服务已停止。随时可以再次运行本脚本启动。"
  pause_exit 0
fi

if [ "$CODE" -eq 1 ]; then
  say ""
  line
  say "  端口 $PORT 被占用，服务没能启动"
  line
  say ""
  # 试着给出占用者信息（需要 lsof/ss 之一）
  if command -v lsof >/dev/null 2>&1; then
    say "  占用该端口的进程："
    lsof -i ":$PORT" 2>/dev/null | sed 's/^/    /'
    say ""
  elif command -v ss >/dev/null 2>&1; then
    say "  占用该端口的进程："
    ss -lptn "sport = :$PORT" 2>/dev/null | sed 's/^/    /'
    say ""
  fi
  printf '  是否改用端口 3001 重试？(y/N) '
  read -r ANSWER || true
  case "$ANSWER" in
    [Yy]*)
      say ""
      say "  改用端口 3001 启动..."
      say ""
      node server.js --port 3001
      ;;
    *)
      say ""
      say "  手动换端口：PORT=3005 ./启动.sh"
      ;;
  esac
  pause_exit 1
fi

say ""
say "  [错误] 服务异常退出（退出码 $CODE）。请把上面的报错信息发给开发者。"
pause_exit "$CODE"
