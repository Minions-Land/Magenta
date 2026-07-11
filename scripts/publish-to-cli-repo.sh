#!/usr/bin/env bash
set -euo pipefail

# 将 Magenta 所有平台的二进制发布到公开的 Magenta-CLI 仓库。
#
# 用法：
#   ./scripts/publish-to-cli-repo.sh <version> "<release notes>"
#   例：./scripts/publish-to-cli-repo.sh 0.0.4 "修复若干问题"
#
# 前提：
#   - 已运行 cd pi/coding-agent && npm run build:release-all（产出 dist/release/ 下所有平台二进制）
#   - 已安装并登录 gh CLI（gh auth status）

VERSION="${1:-}"
NOTES="${2:-Release v${VERSION}}"
DIST_REPO="Minions-Land/Magenta-CLI"
SRC_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CODING_AGENT="${SRC_ROOT}/pi/coding-agent"
RELEASE_DIR="${CODING_AGENT}/dist/release"

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

# 2. 确认 release 目录存在且有二进制
if [ ! -d "$RELEASE_DIR" ] || [ -z "$(ls "$RELEASE_DIR"/magenta-* 2>/dev/null)" ]; then
  echo "❌ release 目录不存在或没有二进制文件。"
  echo "   请先运行: cd pi/coding-agent && npm run build:release-all"
  exit 1
fi

echo "📦 找到以下平台二进制："
ls -lh "$RELEASE_DIR"/magenta-*
echo ""

# 3. 安全检查：确认所有二进制都不含泄露 token
echo "🔒 检查二进制是否含泄露 token..."
for binary in "$RELEASE_DIR"/magenta-*; do
  if strings "$binary" 2>/dev/null | grep -qE 'ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'; then
    echo "❌ $binary 里检测到疑似 GitHub token！中止发布。"
    exit 1
  fi
done
echo "✅ 所有二进制均无内嵌 token"

# 4. 验证至少一个二进制能运行（当前平台）
CURRENT_PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
CURRENT_ARCH=$(uname -m)
case "$CURRENT_PLATFORM" in
  darwin)
    if [ "$CURRENT_ARCH" = "arm64" ]; then
      TEST_BINARY="$RELEASE_DIR/magenta-macos-arm64"
    else
      TEST_BINARY="$RELEASE_DIR/magenta-macos-x64"
    fi
    ;;
  linux)
    TEST_BINARY="$RELEASE_DIR/magenta-linux-x64"
    ;;
  *)
    echo "⚠️  当前平台 $CURRENT_PLATFORM 无法验证二进制，跳过测试"
    TEST_BINARY=""
    ;;
esac

if [ -n "$TEST_BINARY" ] && [ -f "$TEST_BINARY" ]; then
  ACTUAL_VERSION=$("$TEST_BINARY" --version 2>/dev/null || echo "")
  if [ "$ACTUAL_VERSION" != "$VERSION" ]; then
    echo "❌ 二进制版本 ($ACTUAL_VERSION) 与预期 ($VERSION) 不符。"
    exit 1
  fi
  echo "✅ 二进制版本验证通过: $ACTUAL_VERSION"
fi

# 5. 发布到公开仓库（release 存在则追加 assets）
echo "🚀 发布到 ${DIST_REPO} (v${VERSION})..."
if gh release view "v${VERSION}" --repo "$DIST_REPO" >/dev/null 2>&1; then
  # Release 已存在，上传所有 assets（覆盖同名）
  gh release upload "v${VERSION}" "$RELEASE_DIR"/magenta-* --repo "$DIST_REPO" --clobber
else
  # 创建新 release 并上传所有 assets
  gh release create "v${VERSION}" "$RELEASE_DIR"/magenta-* \
    --repo "$DIST_REPO" \
    --title "Magenta v${VERSION}" \
    --notes "$NOTES"
fi

echo ""
echo "✅ 发布完成！"
echo "   查看: https://github.com/${DIST_REPO}/releases/tag/v${VERSION}"
echo ""
echo "用户安装命令："
echo "  macOS (Apple Silicon): curl -fsSL https://github.com/${DIST_REPO}/releases/latest/download/magenta-macos-arm64 -o magenta && chmod +x magenta"
echo "  macOS (Intel):         curl -fsSL https://github.com/${DIST_REPO}/releases/latest/download/magenta-macos-x64 -o magenta && chmod +x magenta"
echo "  Linux:                 curl -fsSL https://github.com/${DIST_REPO}/releases/latest/download/magenta-linux-x64 -o magenta && chmod +x magenta"
echo "  Windows:               curl -fsSL https://github.com/${DIST_REPO}/releases/latest/download/magenta-windows-x64.exe -o magenta.exe"
