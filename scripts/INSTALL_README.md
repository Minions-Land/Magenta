# Magenta 分发包

这是 Magenta 的可执行文件。按照以下步骤安装：

## 快速安装

```bash
# 1. 解压（如果是压缩包）
tar xzf magenta-dist.tar.gz
cd magenta-dist

# 2. 运行安装脚本
./install.sh
```

## 手动安装

```bash
# 复制到本地 bin 目录
mkdir -p ~/.local/bin
cp magenta ~/.local/bin/
chmod +x ~/.local/bin/magenta

# 添加到 PATH（如果还没有）
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## 验证安装

```bash
magenta --version
```

## 使用说明

```bash
# 启动 Magenta
magenta

# 查看帮助
magenta --help

# 检查更新
magenta --update
```

## 更新

Magenta 内置了自动更新功能：
- 每次启动会自动检查新版本（24小时一次）
- 看到更新提示后，运行 `magenta --update` 即可升级

## 支持

如有问题，请联系管理员。
