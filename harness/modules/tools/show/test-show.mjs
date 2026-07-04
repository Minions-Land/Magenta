#!/usr/bin/env node
import { readFileSync, existsSync, writeFileSync } from "node:fs";

// 创建一个简单的 SVG
const svg = `<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="100" fill="#4A90E2"/>
  <text x="100" y="50" font-size="20" fill="white" text-anchor="middle" dominant-baseline="middle">
    Hello from show!
  </text>
</svg>`;

const imagePath = "/tmp/test-show.svg";
writeFileSync(imagePath, svg);

console.log("═══════════════════════════════════════════════════════════════");
console.log("🎨 show 工具演示");
console.log("═══════════════════════════════════════════════════════════════\n");

console.log("📁 测试图片路径:");
console.log("   " + imagePath + "\n");

console.log("🔧 模拟 AI 调用 show 工具:");
console.log("   show({");
console.log("     path: \"" + imagePath + "\",");
console.log("     title: \"测试图片\",");
console.log("     type: \"image\"");
console.log("   })\n");

console.log("📦 show 工具返回:");
const result = {
  success: true,
  message: "Rich content reference created: 测试图片",
  reference: {
    type: "image",
    path: imagePath,
    mimeType: "image/svg+xml",
    metadata: {
      title: "测试图片",
      size: svg.length,
    }
  }
};

console.log(JSON.stringify(result, null, 2));
console.log();

console.log("═══════════════════════════════════════════════════════════════");
console.log("👀 用户在 TUI 中看到:");
console.log("═══════════════════════════════════════════════════════════════\n");

console.log("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓");
console.log("┃ Magenta TUI - 对话界面                                     ┃");
console.log("┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫");
console.log("┃                                                            ┃");
console.log("┃ You: 给我展示一张图片                                      ┃");
console.log("┃                                                            ┃");
console.log("┃ ────────────────────────────────────────────────────────   ┃");
console.log("┃                                                            ┃");
console.log("┃ Assistant: 好的！这是图片：                                ┃");
console.log("┃                                                            ┃");
console.log("┃ 📎 测试图片 [Ctrl+O 展开 | Enter 浮窗查看]                 ┃");
console.log("┃    ↑                                                       ┃");
console.log("┃    └─ 可交互的链接                                         ┃");
console.log("┃                                                            ┃");
console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n");

console.log("⌨️  用户按下 Ctrl+O (内联展开)...\n");

console.log("┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓");
console.log("┃ 📎 测试图片 [Ctrl+O 收起]                                  ┃");
console.log("┃ ┌────────────────────────────────────────────────────────┐ ┃");
console.log("┃ │                                                        │ ┃");
console.log("┃ │        ╔═══════════════════════════════╗              │ ┃");
console.log("┃ │        ║                               ║              │ ┃");
console.log("┃ │        ║     Hello from show!          ║              │ ┃");
console.log("┃ │        ║                               ║              │ ┃");
console.log("┃ │        ╚═══════════════════════════════╝              │ ┃");
console.log("┃ │                                                        │ ┃");
console.log("┃ │  (在支持图形协议的终端中显示真实图片)                  │ ┃");
console.log("┃ └────────────────────────────────────────────────────────┘ ┃");
console.log("┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛\n");

console.log("🖱️  或者按下 Enter (浮动窗口)...\n");

console.log("         ┌────────────────────────────────┐");
console.log("         │  测试图片                      │");
console.log("         ├────────────────────────────────┤");
console.log("         │                                │");
console.log("         │  ╔═══════════════════════╗     │");
console.log("         │  ║                       ║     │");
console.log("         │  ║  Hello from show!     ║     │");
console.log("         │  ║                       ║     │");
console.log("         │  ╚═══════════════════════╝     │");
console.log("         │                                │");
console.log("         │  Zoom: 100%                    │");
console.log("         ├────────────────────────────────┤");
console.log("         │ +/- zoom · ↑↓ · Esc close     │");
console.log("         └────────────────────────────────┘\n");

console.log("═══════════════════════════════════════════════════════════════");
console.log("✨ 这就是 show 工具！");
console.log("═══════════════════════════════════════════════════════════════\n");

console.log("🎯 关键特性:\n");
console.log("  ✅ AI 调用 show(path) 展示任何内容");
console.log("  ✅ 用户看到可交互的链接");
console.log("  ✅ Ctrl+O 内联展开");
console.log("  ✅ Enter 浮动窗口");
console.log("  ✅ 支持真实图片（Kitty/iTerm2）");
console.log("  ✅ 不破坏对话流\n");

console.log("📁 SVG 已保存: " + imagePath);
console.log("   你可以用浏览器打开查看\n");

