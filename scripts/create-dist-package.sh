#!/usr/bin/env bash
set -e

# 为用户创建分发包
# 用法: ./scripts/create-dist-package.sh [version]

VERSION="${1:-$(date +%Y%m%d)}"
DIST_NAME="magenta-dist-${VERSION}"
DIST_DIR="dist-packages/${DIST_NAME}"

echo "📦 创建 Magenta 分发包..."
echo "版本标识: ${VERSION}"
echo ""

# 1. 检查二进制是否存在
BINARY_PATH="pi/coding-agent/dist/magenta"
if [ ! -f "$BINARY_PATH" ]; then
  echo "⚠️  二进制文件不存在，开始构建..."
  npm run build:binary
fi

# 2. 创建分发目录
echo "📁 创建分发目录..."
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 3. 复制文件
echo "📄 复制文件..."
cp "$BINARY_PATH" "$DIST_DIR/magenta"
cp scripts/user-install.sh "$DIST_DIR/install.sh"
cp scripts/INSTALL_README.md "$DIST_DIR/README.md"
chmod +x "$DIST_DIR/magenta"
chmod +x "$DIST_DIR/install.sh"

# 4. 创建压缩包
echo "🗜️  压缩..."
cd dist-packages
tar czf "${DIST_NAME}.tar.gz" "$DIST_NAME"
cd ..

# 5. 计算校验和
CHECKSUM=$(shasum -a 256 "dist-packages/${DIST_NAME}.tar.gz" | awk '{print $1}')

echo ""
echo "✅ 分发包创建完成！"
echo ""
echo "📦 文件位置:"
echo "   dist-packages/${DIST_NAME}.tar.gz"
echo ""
echo "🔐 SHA256 校验和:"
echo "   $CHECKSUM"
echo ""
echo "📤 分发方式:"
echo "   1. 直接发送压缩包给用户"
echo "   2. 上传到内部文件服务器"
echo "   3. 通过企业即时通讯工具发送"
echo ""
echo "👥 用户使用方式:"
echo "   tar xzf ${DIST_NAME}.tar.gz"
echo "   cd $DIST_NAME"
echo "   ./install.sh"
