#!/usr/bin/env bash
# 定影 Onceglance · 一条命令安装/更新 CLI 与 Agent Skill（PRD SKL-4）
#
# 用法（Git Bash / WSL / macOS）：
#   curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 \
#     https://github.com/wample/OnceGlance/releases/latest/download/install.sh | bash
#
# 行为：
#   1. 下载发行版 once CLI（按平台/架构选择）+ SHA-256 校验
#   2. 安装到 ~/.onceglance/bin 并提示加入 PATH
#   3. 安装 onceglance-tutorial Skill 到通用 Agent Skills 目录（~/.agents/skills），
#      若检测到 Codex CLI 则同时写入 ~/.codex/skills
#   4. 运行 once status --json 验证安装
set -euo pipefail

REPO="wample/OnceGlance"
VERSION="${ONCEGLANCE_VERSION:-latest}"
INSTALL_DIR="$HOME/.onceglance/bin"
SKILLS_DIR="$HOME/.agents/skills"

log() { printf '\033[1;32m[onceglance]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[onceglance]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- 平台判断 ----
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT) os="windows" ;;
  Darwin) os="macos" ;;
  Linux) os="linux" ;;
  *) fail "不支持的平台：$OS" ;;
esac
case "$ARCH" in
  x86_64|amd64) arch="x86_64" ;;
  arm64|aarch64) arch="aarch64" ;;
  *) fail "不支持的架构：$ARCH" ;;
esac

BASE="https://github.com/${REPO}/releases"
if [ "$VERSION" = "latest" ]; then
  DL="$BASE/latest/download"
else
  DL="$BASE/download/${VERSION}"
fi

# ---- 1) 下载 CLI ----
mkdir -p "$INSTALL_DIR"
ASSET="once-${os}-${arch}.zip"
log "下载 $DL/$ASSET"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 -o "$TMP/once.zip" "$DL/$ASSET" \
  || fail "下载失败。请检查网络或到 $BASE 手动下载。"

# SHA-256 校验（发行版随附 checksums.txt；缺失时警告继续）
if curl -fsSL -o "$TMP/checksums.txt" "$DL/checksums.txt" 2>/dev/null; then
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$TMP" && grep "$ASSET" checksums.txt | sha256sum -c - >/dev/null 2>&1) \
      && log "SHA-256 校验通过" || fail "SHA-256 校验失败，文件可能被篡改，已中止。"
  elif command -v shasum >/dev/null 2>&1; then
    (cd "$TMP" && grep "$ASSET" checksums.txt | shasum -a 256 -c - >/dev/null 2>&1) \
      && log "SHA-256 校验通过" || fail "SHA-256 校验失败，已中止。"
  fi
else
  log "警告：未找到 checksums.txt，跳过校验（建议从 Release 页面手动核对）。"
fi

unzip -oq "$TMP/once.zip" -d "$TMP/unzipped"
EXE_NAME="once"
[ "$os" = "windows" ] && EXE_NAME="once.exe"
found="$(find "$TMP/unzipped" -name "$EXE_NAME" -type f | head -1)"
[ -n "$found" ] || fail "压缩包中未找到 $EXE_NAME"
mv "$found" "$INSTALL_DIR/$EXE_NAME"
chmod +x "$INSTALL_DIR/$EXE_NAME" 2>/dev/null || true
log "CLI 已安装：$INSTALL_DIR/$EXE_NAME"

# ---- 2) PATH 提示 ----
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *)
    log "将以下行加入你的 shell 配置以启用 PATH："
    printf '      export PATH="%s:$PATH"\n' "$INSTALL_DIR"
    ;;
esac

# ---- 3) 安装 Agent Skill ----
install_skill() {
  local dest="$1"
  mkdir -p "$dest/onceglance-tutorial"
  curl -fsSL --retry 3 -o "$dest/onceglance-tutorial/SKILL.md" \
    "$DL/onceglance-tutorial-SKILL.md" \
    && log "Skill 已安装：$dest/onceglance-tutorial" \
    || log "警告：Skill 下载失败，可稍后手动安装。"
}
install_skill "$SKILLS_DIR"
# Codex CLI 目录适配
[ -d "$HOME/.codex" ] && install_skill "$HOME/.codex/skills"

# ---- 4) 验证 ----
log "验证安装："
"$INSTALL_DIR/$EXE_NAME" status --json || log "once status 运行异常，请重启终端后再试。"
log "完成。接下来：重启你的 Agent，然后让它读 onceglance-tutorial Skill 开始写教程。"
