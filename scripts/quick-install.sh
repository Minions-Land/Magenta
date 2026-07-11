#!/usr/bin/env bash
# Magenta 极简安装脚本 - 从公开仓库匿名下载，无需 GitHub Token
# 用法：curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/quick-install.sh | bash

set -e

DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"

echo "📦 Magenta 快速安装..."

# 检测平台
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$OS" in
  darwin)
    case "$ARCH" in
      arm64|aarch64) BINARY="magenta-macos-arm64" ;;
      x86_64|amd64)  BINARY="magenta-macos-x64" ;;
      *) echo "❌ 不支持的 macOS 架构: $ARCH"; exit 1 ;;
    esac
    ;;
  linux)
    case "$ARCH" in
      x86_64|amd64) BINARY="magenta-linux-x64" ;;
      *) echo "❌ 不支持的 Linux 架构: $ARCH"; exit 1 ;;
    esac
    ;;
  *) echo "❌ 不支持的系统: $OS (Windows 请用 PowerShell 下载 magenta-windows-x64.exe)"; exit 1 ;;
esac

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "📥 下载中 (~73MB)..."
curl -fsSL \
  -o "$INSTALL_DIR/magenta" \
  "https://github.com/${DIST_REPO}/releases/latest/download/${BINARY}"

chmod +x "$INSTALL_DIR/magenta"

echo "📥 下载运行时资源 (~7MB)..."
# 优先下载平台特定资源包（含预编译二进制）
RESPLATFORM=""
case "$OS" in
  darwin)
    case "$ARCH" in
      arm64|aarch64) RESPLATFORM="macos-arm64" ;;
      x86_64|amd64)  RESPLATFORM="macos-x64" ;;
    esac
    ;;
  linux)
    case "$ARCH" in
      x86_64|amd64) RESPLATFORM="linux-x64" ;;
    esac
    ;;
esac

RES_URL="https://github.com/${DIST_REPO}/releases/latest/download/magenta-resources-${RESPLATFORM}.tar.gz"
curl -fsSL "$RES_URL" 2>/dev/null | tar -xz -C "$INSTALL_DIR/" || {
  echo "⚠️  平台特定资源包不存在，尝试通用包（部分工具可能需要手动编译 Rust 组件）..."
  curl -fsSL "https://github.com/${DIST_REPO}/releases/latest/download/magenta-resources.tar.gz" | tar -xz -C "$INSTALL_DIR/"
}

echo "✅ 安装完成！"
echo ""

# 检查 PATH
if [[ ":$PATH:" == *":$INSTALL_DIR:"* ]]; then
  VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "?")
  echo "🎉 Magenta $VERSION 已就绪！"
  echo ""
  echo "运行: magenta --help"
else
  echo "⚠️  请将 $INSTALL_DIR 添加到 PATH:"
  echo ""
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
  echo "  source ~/.zshrc"
  echo ""
  echo "或直接运行: $INSTALL_DIR/magenta"
fi
