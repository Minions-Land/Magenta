#!/usr/bin/env bash
set -e

# 用户安装脚本 - 将 Magenta 安装到本地
# 用法: ./install.sh

INSTALL_DIR="${HOME}/.local/bin"
BINARY_NAME="magenta"

echo "📦 安装 Magenta..."
echo ""

# 检查二进制文件是否存在
if [ ! -f "$BINARY_NAME" ]; then
  echo "❌ 错误：未找到 magenta 二进制文件"
  echo "请确保在包含 magenta 文件的目录中运行此脚本"
  exit 1
fi

# 创建安装目录
mkdir -p "$INSTALL_DIR"

# 复制并设置权限
cp "$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

echo "✅ Magenta 已安装到: $INSTALL_DIR/$BINARY_NAME"
echo ""

# 检查 PATH
if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
  echo "⚠️  $INSTALL_DIR 不在你的 PATH 中"
  echo ""
  echo "请将以下内容添加到你的 shell 配置文件："
  echo ""
  
  # 检测 shell 类型
  if [ -n "$ZSH_VERSION" ]; then
    SHELL_CONFIG="~/.zshrc"
  elif [ -n "$BASH_VERSION" ]; then
    SHELL_CONFIG="~/.bashrc"
  else
    SHELL_CONFIG="~/.profile"
  fi
  
  echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> $SHELL_CONFIG"
  echo "  source $SHELL_CONFIG"
  echo ""
else
  echo "✅ PATH 配置正确"
  echo ""
fi

# 测试安装
if command -v magenta &> /dev/null; then
  VERSION=$(magenta --version 2>/dev/null || echo "unknown")
  echo "🎉 安装成功！"
  echo "   版本: $VERSION"
  echo ""
  echo "运行 'magenta' 开始使用"
  echo "运行 'magenta --help' 查看帮助"
  echo "运行 'magenta --update' 检查更新"
else
  echo "⚠️  安装完成，但需要重新加载 shell 或手动添加到 PATH"
  echo ""
  echo "快速测试: $INSTALL_DIR/magenta --version"
fi
