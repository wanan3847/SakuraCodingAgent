#!/bin/sh
# Sakura Coding Agent 安装脚本
#
#   curl -fsSL https://github.com/wanan3847/SakuraCodingAgent/releases/latest/download/install.sh | sh
#
# 它做的事：校验 Node/npm 版本 → 下载发布 tarball → 用 SHA256SUMS 校验 → npm 全局安装 → 自检。
# 校验不通过就直接失败退出，不会安装未校验的内容。
#
# 选项：
#   --version V        安装指定版本（默认最新发布）
#   --base-url URL     覆盖下载地址（默认 GitHub Release；也支持 file:// 本地目录）
#   --prefix DIR       npm 全局安装目录（默认沿用当前 npm 全局前缀）
#   --tarball FILE     直接使用本地 tarball（跳过下载；同目录有 SHA256SUMS 时仍然校验）
#   --dry-run          只打印将要执行的操作
#   -h | --help        显示帮助
#
# 环境变量：SAKURA_VERSION、SAKURA_BASE_URL、SAKURA_PREFIX、SAKURA_TARBALL
set -eu

REPO="${SAKURA_REPO:-wanan3847/SakuraCodingAgent}"
ASSET_TARBALL="sakura.tgz"
ASSET_SUMS="SHA256SUMS"
VERSION="${SAKURA_VERSION:-latest}"
BASE_URL="${SAKURA_BASE_URL:-}"
PREFIX="${SAKURA_PREFIX:-}"
LOCAL_TARBALL="${SAKURA_TARBALL:-}"
DRY_RUN=0
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

say()  { printf '%s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die()  { printf '错误：%s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,25p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || say "见脚本头部注释"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version 需要一个版本号"; VERSION="$2"; shift 2 ;;
    --base-url) [ $# -ge 2 ] || die "--base-url 需要一个地址"; BASE_URL="$2"; shift 2 ;;
    --prefix)  [ $# -ge 2 ] || die "--prefix 需要一个目录"; PREFIX="$2"; shift 2 ;;
    --tarball) [ $# -ge 2 ] || die "--tarball 需要一个文件"; LOCAL_TARBALL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# ---------- 运行环境检查 ----------

command -v node >/dev/null 2>&1 || die "需要 Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}：https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "需要 npm（随 Node.js 一起安装）"

node_version="$(node -v 2>/dev/null | sed 's/^v//')"
node_major="$(printf '%s' "$node_version" | cut -d. -f1)"
node_minor="$(printf '%s' "$node_version" | cut -d. -f2)"
case "$node_major" in ''|*[!0-9]*) die "无法解析 node -v 的输出：$node_version" ;; esac
if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] || { [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; }; then
  die "Node.js ${node_version} 太旧，需要 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}（nvm install ${MIN_NODE_MAJOR} 可升级）"
fi

fetch() { # fetch <url> <dest>
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 15 -O "$2" "$1"
  else
    die "需要 curl 或 wget 来下载发布文件"
  fi
}

sha256_of() { # sha256_of <file> -> hex
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= *//'
  else die "找不到 sha256sum / shasum / openssl，无法校验下载内容"
  fi
}

# ---------- 解析下载地址 ----------

if [ -n "$LOCAL_TARBALL" ]; then
  [ -f "$LOCAL_TARBALL" ] || die "--tarball 指向的文件不存在：$LOCAL_TARBALL"
  TARBALL="$(cd "$(dirname "$LOCAL_TARBALL")" && pwd)/$(basename "$LOCAL_TARBALL")"
  SUMS="$(dirname "$TARBALL")/$ASSET_SUMS"
  [ -f "$SUMS" ] || SUMS=""
  say "使用本地 tarball：$TARBALL"
else
  if [ -z "$BASE_URL" ]; then
    if [ "$VERSION" = "latest" ]; then
      BASE_URL="https://github.com/${REPO}/releases/latest/download"
    else
      case "$VERSION" in v*) tag="$VERSION" ;; *) tag="v$VERSION" ;; esac
      BASE_URL="https://github.com/${REPO}/releases/download/${tag}"
    fi
  fi
  BASE_URL="${BASE_URL%/}"
  TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sakura-install.XXXXXX")"
  trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
  TARBALL="$TMP_DIR/$ASSET_TARBALL"
  SUMS="$TMP_DIR/$ASSET_SUMS"
  say "下载源：$BASE_URL"
  say "下载 $ASSET_TARBALL …"
  fetch "$BASE_URL/$ASSET_TARBALL" "$TARBALL" || die "下载失败：$BASE_URL/${ASSET_TARBALL}（检查版本号或网络）"
  say "下载 $ASSET_SUMS …"
  fetch "$BASE_URL/$ASSET_SUMS" "$SUMS" || die "下载校验清单失败：$BASE_URL/${ASSET_SUMS}（没有校验清单就不会安装）"
fi

# ---------- 校验 ----------

if [ -n "$SUMS" ]; then
  expected="$(awk -v name="$(basename "$TARBALL")" '$2 == name || $2 == "*" name { print $1; exit }' "$SUMS")"
  if [ -z "$expected" ]; then
    expected="$(awk 'NF >= 2 { print $1; exit }' "$SUMS")"
    [ -n "$expected" ] || die "校验清单为空：$SUMS"
    warn "清单里没有 $(basename "$TARBALL") 的条目，改用清单第一行做校验"
  fi
  actual="$(sha256_of "$TARBALL")"
  [ "$expected" = "$actual" ] || die "SHA-256 校验失败：期望 ${expected}，实际 ${actual}（已中止，未安装）"
  say "SHA-256 校验通过：$actual"
else
  warn "没有 ${ASSET_SUMS}，跳过校验（仅在你完全信任这个 tarball 时继续）"
fi

# ---------- 安装 ----------

if [ -n "$PREFIX" ]; then
  set -- install --global --ignore-scripts --no-audit --no-fund --prefix "$PREFIX" "$TARBALL"
  TARGET_BIN="$PREFIX/bin"
else
  set -- install --global --ignore-scripts --no-audit --no-fund "$TARBALL"
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  TARGET_BIN="${npm_prefix:+$npm_prefix/bin}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  say "（--dry-run）将要执行：npm $*"
  [ -n "${TARGET_BIN:-}" ] && say "（--dry-run）预期命令位置：$TARGET_BIN/sakura"
  exit 0
fi

say "安装中：npm install --global --ignore-scripts …"
npm "$@" || die "npm 全局安装失败。若提示权限问题，用 --prefix 指向可写目录，例如：
    sh -s -- --prefix \"\$HOME/.local\"
或先配置：npm config set prefix \"\$HOME/.local\""

# ---------- 自检 ----------

SAKURA_BIN=""
if [ -n "${TARGET_BIN:-}" ] && [ -x "$TARGET_BIN/sakura" ]; then
  SAKURA_BIN="$TARGET_BIN/sakura"
elif command -v sakura >/dev/null 2>&1; then
  SAKURA_BIN="$(command -v sakura)"
fi

ON_PATH="$(command -v sakura 2>/dev/null || true)"
NAME="sakura"
CONFLICT=""

if [ -n "$SAKURA_BIN" ]; then
  if installed_version="$("$SAKURA_BIN" --version 2>/dev/null)"; then
    say "已安装：${SAKURA_BIN}（版本 ${installed_version:-未报告}）"
  else
    say "已安装：${SAKURA_BIN}"
  fi
  AGENT_BIN="$(dirname "$SAKURA_BIN")/sakura-agent"
  if [ -n "$ON_PATH" ] && [ "$ON_PATH" != "$SAKURA_BIN" ]; then
    CONFLICT="$ON_PATH"
    if [ -x "$AGENT_BIN" ]; then NAME="sakura-agent"; fi
    warn "PATH 里的 sakura 指向别的东西：${CONFLICT}"
    warn "它不是本次安装的命令。请改用 ${NAME}，或把 $(dirname "$SAKURA_BIN") 放到 PATH 更前面。"
  elif [ -z "$ON_PATH" ]; then
    warn "$(dirname "$SAKURA_BIN") 不在 PATH 里，请把它加入 PATH（例如加到 ~/.zshrc 或 ~/.bashrc）"
  fi
  if [ -x "$AGENT_BIN" ] && [ "$NAME" = "sakura" ]; then
    say "无冲突的名字（推荐）：${AGENT_BIN}"
  fi
else
  warn "没有找到 sakura 命令，请检查 npm 全局目录是否在 PATH 中（npm prefix -g）"
fi

say ""
say "下一步："
say "  ${NAME} init          # 选择本机 Ollama 模型并写入独立配置"
say "  ${NAME}               # 启动终端工作台"
say "  ${NAME} doctor        # 检查独立配置、资源与 MCP"
say ""
say "卸载：npm rm -g sakura-coding-agent，并按需删除 ~/.sakura"
