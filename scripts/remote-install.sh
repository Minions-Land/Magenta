#!/usr/bin/env bash
set -e

# 一键安装 Magenta - 从 GitHub Release 自动下载并安装
# 用法: 
#   export MAGENTA_GITHUB_TOKEN="your_token"
#   curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta/main/scripts/remote-install.sh | bash

GITHUB_REPO="${MAGENTA_GITHUB_REPO:-Minions-Land/Magenta}"
GITHUB_TOKEN="${MAGENTA_GITHUB_TOKEN}"
INSTALL_DIR="${HOME}/.local/bin"

if [ -z "$GITHUB_TOKEN" ]; then
  echo "❌ 需要设置 GitHub Token"
  echo ""
  echo "请运行:"
  echo "  export MAGENTA_GITHUB_TOKEN='your_token_here'"
  echo "  curl -fsSL https://raw.githubusercontent.com/Minions-Land/Magenta/main/scripts/remote-install.sh | bash"
  exit 1
fi

echo "📦 安装 Magenta..."
echo ""

# 检测平台
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$PLATFORM" in
  darwin)
    BINARY_NAME="magenta-macos"
    ;;
  linux)
    BINARY_NAME="magenta-linux"
    ;;
  *)
    echo "❌ 不支持的平台: $PLATFORM"
    exit 1
    ;;
esac

echo "🔍 检测平台: $PLATFORM ($ARCH)"
echo "📥 从 GitHub 获取最新版本..."
echo ""

# 获取最新 release 信息
RELEASE_INFO=$(curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$GITHUB_REPO/releases/latest")

VERSION=$(echo "$RELEASE_INFO" | grep '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')

# 获取 asset ID（用于私有仓库下载）
ASSET_ID=$(echo "$RELEASE_INFO" | grep -A3 "\"name\": \"$BINARY_NAME\"" | grep '"id":' | head -1 | sed -E 's/.*"id": *([0-9]+).*/\1/')

if [ -z "$VERSION" ] || [ -z "$ASSET_ID" ]; then
  echo "❌ 无法获取最新版本信息"
  echo "请检查:"
  echo "  - GitHub token 是否有效"
  echo "  - 是否有仓库访问权限"
  echo "  - Release 中是否存在 $BINARY_NAME 文件"
  exit 1
fi

echo "📦 最新版本: $VERSION"
echo "⬇️  下载中 (大约 73MB)..."
echo ""

# 创建临时目录
TMP_DIR=$(mktemp -d)
TMP_FILE="$TMP_DIR/magenta"

# 下载二进制（使用 API endpoint 支持私有仓库）
curl -fsSL \
  -H "Accept: application/octet-stream" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -o "$TMP_FILE" \
  "https://api.github.com/repos/$GITHUB_REPO/releases/assets/$ASSET_ID"

if [ ! -f "$TMP_FILE" ]; then
  echo "❌ 下载失败"
  rm -rf "$TMP_DIR"
  exit 1
fi

# 验证下载
FILE_SIZE=$(stat -f%z "$TMP_FILE" 2>/dev/null || stat -c%s "$TMP_FILE" 2>/dev/null)
if [ "$FILE_SIZE" -lt 1000000 ]; then
  echo "❌ 下载的文件太小 ($FILE_SIZE bytes)，可能下载失败"
  rm -rf "$TMP_DIR"
  exit 1
fi

echo "✅ 下载完成 ($(echo "scale=1; $FILE_SIZE/1024/1024" | bc) MB)"
echo ""

# 安装
echo "📂 安装到: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# 备份旧版本
if [ -f "$INSTALL_DIR/magenta" ]; then
  OLD_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
  echo "📦 备份旧版本: $OLD_VERSION"
  mv "$INSTALL_DIR/magenta" "$INSTALL_DIR/magenta.backup"
fi

mv "$TMP_FILE" "$INSTALL_DIR/magenta"
chmod +x "$INSTALL_DIR/magenta"

# 清理临时文件
rm -rf "$TMP_DIR"

echo "✅ 安装成功！"
echo ""

# 验证安装
INSTALLED_VERSION=$("$INSTALL_DIR/magenta" --version 2>/dev/null || echo "unknown")
echo "🎉 Magenta $INSTALLED_VERSION 已就绪！"
echo ""

# 检查 PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  $INSTALL_DIR 不在 PATH 中"
  echo ""
  
  # 检测 shell
  if [ -n "$ZSH_VERSION" ]; then
    SHELL_CONFIG="~/.zshrc"
  elif [ -n "$BASH_VERSION" ]; then
    SHELL_CONFIG="~/.bashrc"
  else
    SHELL_CONFIG="~/.profile"
  fi
  
  echo "添加到 PATH:"
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_CONFIG"
  echo "  source $SHELL_CONFIG"
  echo ""
  echo "或者直接运行: $INSTALL_DIR/magenta"
else
  echo "快速开始:"
  echo "  magenta --help       # 查看帮助"
  echo "  magenta --update     # 检查更新"
  echo "  magenta              # 启动对话"
fi
