#!/usr/bin/env bash
# Magenta 极简安装脚本 - 真正的一键安装
# 用法：curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta/main/scripts/quick-install.sh | MAGENTA_GITHUB_TOKEN=your_token bash

set -e

TOKEN="${MAGENTA_GITHUB_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "❌ 需要 GitHub Token"
  echo ""
  echo "用法："
  echo "  curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta/main/scripts/quick-install.sh | MAGENTA_GITHUB_TOKEN=your_token bash"
  exit 1
fi

echo "📦 Magenta 快速安装..."

# 检测平台
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$OS" in
  darwin) BINARY="magenta-macos" ;;
  linux) BINARY="magenta-linux" ;;
  *) echo "❌ 不支持的系统: $OS"; exit 1 ;;
esac

# 获取最新版本的 asset ID
echo "🔍 获取最新版本..."
ASSET_ID=$(curl -fsSL \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/Minions-Land/Magenta/releases/latest" \
  | grep -A3 "\"name\": \"$BINARY\"" \
  | grep '"id":' \
  | head -1 \
  | sed -E 's/.*"id": *([0-9]+).*/\1/')

if [ -z "$ASSET_ID" ]; then
  echo "❌ 获取失败，请检查 token 或网络"
  exit 1
fi

# 下载到 ~/.local/bin
INSTALL_DIR="$HOME/.local/bin"
mkdir -p "$INSTALL_DIR"

echo "📥 下载中 (~73MB)..."
curl -fsSL \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/octet-stream" \
  -o "$INSTALL_DIR/magenta" \
  "https://api.github.com/repos/Minions-Land/Magenta/releases/assets/$ASSET_ID"

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
