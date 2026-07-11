#!/usr/bin/env bash
# Magenta 极简安装脚本 - 从公开仓库匿名下载，无需 GitHub Token
# 用法：curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta-CLI/main/quick-install.sh | bash

set -e

DIST_REPO="${MAGENTA_DIST_REPO:-Minions-Land/Magenta-CLI}"

echo "📦 Magenta 快速安装..."

# 检测平台
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  darwin) BINARY="magenta-macos" ;;
  linux)  BINARY="magenta-linux" ;;
  *) echo "❌ 不支持的系统: $OS"; exit 1 ;;
esac

INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "📥 下载中 (~73MB)..."
curl -fsSL \
  -o "$INSTALL_DIR/magenta" \
  "https://github.com/${DIST_REPO}/releases/latest/download/${BINARY}"

chmod +x "$INSTALL_DIR/magenta"

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
