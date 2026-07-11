#!/usr/bin/env bash
set -euo pipefail

# 将 Magenta 二进制发布到公开的 Magenta-CLI 仓库。
#
# 架构：
#   Minions-Land/Magenta      (私有) - 源码，在此仓库构建
#   Minions-Land/Magenta-CLI  (公开) - 只存放编译后的二进制，用户匿名下载
#
# 用法：
#   ./scripts/publish-to-cli-repo.sh <version> "<release notes>"
#   例：./scripts/publish-to-cli-repo.sh 0.0.4 "修复若干问题"
#
# 前提：
#   - 已安装并登录 gh CLI（gh auth status）
#   - 已安装 bun（用于编译单文件二进制）

VERSION="${1:-}"
NOTES="${2:-Release v${VERSION}}"
DIST_REPO="Minions-Land/Magenta-CLI"
SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODING_AGENT="${SRC_ROOT}/pi/coding-agent"

if [ -z "$VERSION" ]; then
  echo "❌ 用法: $0 <version> [release-notes]"
  echo "   例: $0 0.0.4 \"修复若干问题\""
  exit 1
fi

# 1. 确认 brand 版本与发布版本一致
BRAND_VERSION=$(grep -oE 'version: "[0-9]+\.[0-9]+\.[0-9]+"' "${SRC_ROOT}/brands/magenta/magenta.brand.ts" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
if [ "$BRAND_VERSION" != "$VERSION" ]; then
  echo "⚠️  brand 版本 ($BRAND_VERSION) 与发布版本 ($VERSION) 不一致。"
  echo "   请先更新 brands/magenta/magenta.brand.ts 里的 version 字段为 $VERSION，再运行本脚本。"
  exit 1
fi

# 2. 编译单文件二进制
echo "🔨 构建二进制 v${VERSION}..."
cd "$CODING_AGENT"
npm run build:binary >/dev/null 2>&1 || npm run build:binary
BINARY="${CODING_AGENT}/dist/magenta"
if [ ! -f "$BINARY" ]; then
  echo "❌ 二进制未生成: $BINARY"
  exit 1
fi

# 3. 安全检查：确认二进制里没有内嵌任何 token
echo "🔒 检查二进制是否含泄露 token..."
if strings "$BINARY" | grep -qE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'; then
  echo "❌ 二进制里检测到疑似 GitHub token！中止发布。"
  exit 1
fi
echo "✅ 无内嵌 token"

# 4. 验证二进制能运行
ACTUAL_VERSION=$("$BINARY" --version 2>/dev/null || echo "")
if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
  echo "❌ 二进制版本 ($ACTUAL_VERSION) 与预期 ($VERSION) 不符。"
  exit 1
fi
echo "✅ 二进制版本验证通过: $ACTUAL_VERSION"

# 5. 准备平台命名的二进制
PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$PLATFORM" in
  darwin) ASSET_NAME="magenta-macos" ;;
  linux)  ASSET_NAME="magenta-linux" ;;
  *) echo "❌ 不支持的平台: $PLATFORM"; exit 1 ;;
esac
STAGE="$(mktemp -d)"
cp "$BINARY" "${STAGE}/${ASSET_NAME}"

# 6. 发布到公开仓库（release 存在则追加 asset）
echo "🚀 发布到 ${DIST_REPO} (v${VERSION}, asset: ${ASSET_NAME})..."
if gh release view "v${VERSION}" --repo "$DIST_REPO" >/dev/null 2>&1; then
  gh release upload "v${VERSION}" "${STAGE}/${ASSET_NAME}" --repo "$DIST_REPO" --clobber
else
  gh release create "v${VERSION}" "${STAGE}/${ASSET_NAME}" \
    --repo "$DIST_REPO" \
    --title "Magenta v${VERSION}" \
    --notes "$NOTES"
fi

rm -rf "$STAGE"

echo ""
echo "✅ 发布完成！"
echo "   用户安装命令："
echo "   curl -fsSL https://github.com/${DIST_REPO}/releases/latest/download/${ASSET_NAME} -o magenta && chmod +x magenta"
