#!/usr/bin/env bash
set -e

# 一键安装 Magenta - 从 GitHub Release 自动下载并安装
# 用法: curl -fsSL https://your-server.com/install.sh | bash
#   或: bash <(curl -fsSL https://your-server.com/install.sh)

GITHUB_REPO="${MAGENTA_GITHUB_REPO:-your-org/magenta3}"
GITHUB_TOKEN="${MAGENTA_GITHUB_TOKEN:-ghp_xxxxxxxxxxxx}"  # 这里填你的 token
INSTALL_DIR="${HOME}/.local/bin"

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
  "https://api.github.com/repos/$GITHUB_REPO/releases/latest")

VERSION=$(echo "$RELEASE_INFO" | grep '"tag_name":' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')
DOWNLOAD_URL=$(echo "$RELEASE_INFO" | grep "browser_download_url.*$BINARY_NAME" | sed -E 's/.*"browser_download_url": *"([^"]+)".*/\1/')

if [ -z "$VERSION" ] || [ -z "$DOWNLOAD_URL" ]; then
  echo "❌ 无法获取最新版本信息"
  echo "请检查 GitHub token 或网络连接"
  exit 1
fi

echo "📦 最新版本: $VERSION"
echo "⬇️  下载中..."
echo ""

# 创建临时目录
TMP_DIR=$(mktemp -d)
TMP_FILE="$TMP_DIR/magenta"

# 下载二进制
curl -fsSL \
  -H "Accept: application/octet-stream" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -o "$TMP_FILE" \
  "$DOWNLOAD_URL"

if [ ! -f "$TMP_FILE" ]; then
  echo "❌ 下载失败"
  exit 1
fi

# 验证下载
if [ ! -s "$TMP_FILE" ]; then
  echo "❌ 下载的文件为空"
  exit 1
fi

echo "✅ 下载完成"
echo ""

# 安装
echo "📂 安装到: $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
mv "$TMP_FILE" "$INSTALL_DIR/magenta"
chmod +x "$INSTALL_DIR/magenta"

# 清理临时文件
rm -rf "$TMP_DIR"

echo "✅ 安装成功！"
echo ""

# 检查 PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  需要将 $INSTALL_DIR 添加到 PATH"
  echo ""
  
  # 检测 shell
  if [ -n "$ZSH_VERSION" ]; then
    SHELL_CONFIG="~/.zshrc"
  elif [ -n "$BASH_VERSION" ]; then
    SHELL_CONFIG="~/.bashrc"
  else
    SHELL_CONFIG="~/.profile"
  fi
  
  echo "请运行以下命令："
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_CONFIG"
  echo "  source $SHELL_CONFIG"
  echo ""
fi

# 验证安装
if command -v magenta &> /dev/null; then
  INSTALLED_VERSION=$(magenta --version 2>/dev/null || echo "unknown")
  echo "🎉 Magenta $INSTALLED_VERSION 已就绪！"
  echo ""
  echo "运行 'magenta' 开始使用"
  echo "运行 'magenta --help' 查看帮助"
  echo "运行 'magenta --update' 检查更新"
else
  echo "⚠️  安装完成，需要重新加载 shell 后才能使用"
  echo ""
  echo "快速测试: $INSTALL_DIR/magenta --version"
fi
