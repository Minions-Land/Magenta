#!/usr/bin/env bash
set -e

echo "📦 打包 Magenta 用于分发..."

# 构建项目
npm run build

# 创建分发目录
DIST_DIR="magenta-dist"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# 复制必要文件
cp -r pi/coding-agent/dist "$DIST_DIR/"
cp bin/magenta "$DIST_DIR/"
cp -r node_modules "$DIST_DIR/"  # 或使用 npm pack
cp package.json "$DIST_DIR/"

# 创建安装脚本
cat > "$DIST_DIR/install.sh" << 'EOF'
#!/usr/bin/env bash
set -e

INSTALL_DIR="${HOME}/.magenta"
BIN_DIR="${HOME}/.local/bin"

echo "📦 安装 Magenta..."

# 复制文件
mkdir -p "$INSTALL_DIR"
cp -r dist node_modules package.json "$INSTALL_DIR/"
cp magenta "$INSTALL_DIR/"

# 创建全局命令
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/magenta" "$BIN_DIR/magenta"
chmod +x "$BIN_DIR/magenta"

# 检查 PATH
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "⚠️  请将以下内容添加到你的 shell 配置文件："
  echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

echo "✅ Magenta 已安装！"
echo "   运行: magenta"
EOF

chmod +x "$DIST_DIR/install.sh"

# 打包
tar czf magenta-latest.tar.gz "$DIST_DIR"

echo "✅ 分发包已创建: magenta-latest.tar.gz"
echo ""
echo "分发给用户后，他们只需执行："
echo "  tar xzf magenta-latest.tar.gz"
echo "  cd magenta-dist && ./install.sh"
