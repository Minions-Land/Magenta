#!/usr/bin/env bash
set -e

# Magenta GitHub Release 发布脚本
# 用法: ./scripts/release-to-github.sh <version> [release-notes]

VERSION="$1"
NOTES="${2:-更新版本 $VERSION}"

if [ -z "$VERSION" ]; then
  echo "❌ 错误：请指定版本号"
  echo "用法: $0 <version> [release-notes]"
  echo "示例: $0 0.80.3 '修复 bug'"
  exit 1
fi

# 检查必需的环境变量
if [ -z "$MAGENTA_GITHUB_REPO" ]; then
  echo "❌ 错误：未设置 MAGENTA_GITHUB_REPO"
  echo "请设置: export MAGENTA_GITHUB_REPO='your-org/magenta3'"
  exit 1
fi

if [ -z "$MAGENTA_GITHUB_TOKEN" ]; then
  echo "❌ 错误：未设置 MAGENTA_GITHUB_TOKEN"
  echo "请设置: export MAGENTA_GITHUB_TOKEN='ghp_xxxxx'"
  exit 1
fi

# 检查 gh CLI 是否安装
if ! command -v gh &> /dev/null; then
  echo "❌ 错误：未安装 GitHub CLI (gh)"
  echo "安装: brew install gh"
  exit 1
fi

echo "🔨 开始构建 Magenta v${VERSION}..."
echo ""

# 1. 构建二进制
echo "📦 构建二进制文件..."
npm run build:binary

BINARY_PATH="pi/coding-agent/dist/magenta"

if [ ! -f "$BINARY_PATH" ]; then
  echo "❌ 错误：二进制文件不存在: $BINARY_PATH"
  exit 1
fi

echo "✅ 二进制构建完成"
echo ""

# 2. 检查版本标签是否已存在
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
  echo "⚠️  警告：标签 v${VERSION} 已存在"
  read -p "是否删除现有标签并重新创建？(y/N) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    git tag -d "v${VERSION}"
    git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
  else
    echo "❌ 取消发布"
    exit 1
  fi
fi

# 3. 创建 Git 标签（可选）
echo "📌 创建 Git 标签 v${VERSION}..."
git tag -a "v${VERSION}" -m "Release v${VERSION}"
git push origin "v${VERSION}"
echo ""

# 4. 发布到 GitHub Releases
echo "🚀 发布到 GitHub Releases..."
echo "仓库: $MAGENTA_GITHUB_REPO"
echo "版本: v${VERSION}"
echo "说明: $NOTES"
echo ""

# 根据平台选择二进制名称
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$PLATFORM" in
  darwin)
    ASSET_NAME="magenta-macos"
    ;;
  linux)
    ASSET_NAME="magenta-linux"
    ;;
  *)
    ASSET_NAME="magenta"
    ;;
esac

# 创建 release
gh release create "v${VERSION}" \
  "$BINARY_PATH#${ASSET_NAME}" \
  --repo "$MAGENTA_GITHUB_REPO" \
  --title "Magenta v${VERSION}" \
  --notes "$NOTES"

echo ""
echo "✅ 发布完成！"
echo ""
echo "📋 下一步："
echo "1. 通知用户运行 'magenta --update' 更新"
echo "2. 或者将二进制文件发送给新用户"
echo ""
echo "🔗 查看 Release:"
echo "   https://github.com/${MAGENTA_GITHUB_REPO}/releases/tag/v${VERSION}"
