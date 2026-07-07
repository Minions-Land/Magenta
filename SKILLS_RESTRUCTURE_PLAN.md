# Magenta Skills 结构审计与重组计划

## 当前状态审计

### Harness Skills (modules/skills/)

#### ✅ 已有良好结构的：
- **self-evo/magenta/** - 已重构完成
  - SKILL.md ✓
  - 子技能结构清晰 ✓

#### ⚠️ 需要重组的：

**1. paper-analysis/pi/**
```
当前:
paper-analysis/
└── pi/
    └── SKILL.md

需要:
paper-analysis/
├── pi/
│   └── SKILL.md
└── assets/ (可选，如需要)
    ├── scripts/
    ├── references/
    └── templates/
```

**2. pptx/pi/**
```
当前:
pptx/
└── pi/
    └── SKILL.md

需要:
pptx/
├── pi/
│   └── SKILL.md
└── assets/
    ├── scripts/       (PPT 模板生成脚本)
    ├── references/    (PPT 设计最佳实践)
    └── templates/     (PPT 模板文件)
```

**3. research-orchestration/pi/**
```
当前:
research-orchestration/
└── pi/
    └── SKILL.md

需要:
research-orchestration/
├── pi/
│   └── SKILL.md
└── assets/
    ├── scripts/       (工作流编排脚本)
    └── references/    (编排模式文档)
```

### Package Skills (packages/AutOmicScience/skills/)

#### ⚠️ 全部需要重组：

**当前结构（所有 5 个 skills）：**
```
<skill-name>/
├── SKILL.md
└── method/          ← 这个命名不标准
    ├── *.md         ← 方法文档
    └── ...
```

**需要改为：**
```
<skill-name>/
├── SKILL.md
└── assets/          ← 标准命名
    ├── references/  ← method/ 内容移到这里
    │   ├── *.md
    │   └── ...
    ├── scripts/     ← 如有分析脚本
    └── templates/   ← 如有输出模板
```

**受影响的 skills：**
1. multi-omics
2. omics-shared
3. rna
4. scatac-seq
5. spatial

---

## 标准结构定义

### 完整的 Skill 结构

```
skill-name/
├── <source>/               (pi/, magenta/, codex/, etc.)
│   └── SKILL.md            ← 必需
│       ├── YAML frontmatter (name, description 必需)
│       └── Markdown 指令
└── assets/                 ← 可选，但如果有则必须遵循子结构
    ├── scripts/            ← 可执行代码（确定性/重复性任务）
    │   ├── *.py
    │   ├── *.sh
    │   └── *.js
    ├── references/         ← 按需加载到上下文的文档
    │   ├── *.md
    │   ├── *.txt
    │   └── *.pdf
    └── templates/          ← 输出中使用的文件
        ├── *.docx
        ├── *.pptx
        ├── *.json
        └── ...
```

### Package Skills 的简化结构

```
packages/<Name>/skills/<skill-name>/
├── SKILL.md                ← 必需（扁平，无 <source> 子目录）
└── assets/                 ← 可选
    ├── scripts/
    ├── references/
    └── templates/
```

**关键区别：**
- Harness skills 有 `<source>/` 子目录（pi/, magenta/）
- Package skills 扁平结构（SKILL.md 直接在 skill-name/ 下）
- 两者都使用 `assets/` 统一命名

---

## 重组执行计划

### Phase 1: Harness Skills (低风险)

#### 1.1 paper-analysis
- ✅ SKILL.md 已存在
- 🔧 检查是否需要 assets/
  - 如需要 PDF 处理脚本 → scripts/
  - 如需要引用格式文档 → references/

#### 1.2 pptx
- ✅ SKILL.md 已存在
- ➕ 创建 assets/
  - templates/ - 添加标准 PPT 模板
  - references/ - PPT 设计最佳实践文档
  - scripts/ - 模板生成辅助脚本

#### 1.3 research-orchestration
- ✅ SKILL.md 已存在
- 🔧 检查是否需要 assets/
  - scripts/ - 工作流编排辅助
  - references/ - 编排模式文档

### Phase 2: Package Skills (需要重命名)

**对于所有 5 个 AutOmicScience skills：**

```bash
# 对每个 skill 执行：
cd packages/AutOmicScience/skills/<skill-name>/
mv method assets
cd assets
mkdir -p scripts references templates
mv *.md references/  # 将所有方法文档移到 references/
```

**具体操作：**

1. **multi-omics/method/** → **multi-omics/assets/references/**
2. **omics-shared/method/** → **omics-shared/assets/references/**
3. **rna/method/** → **rna/assets/references/**
4. **scatac-seq/method/** → **scatac-seq/assets/references/**
5. **spatial/method/** → **spatial/assets/references/**

### Phase 3: 更新所有 SKILL.md

确保每个 SKILL.md 中：
1. YAML frontmatter 正确（name, description）
2. 如果引用了 assets，使用正确路径：
   ```markdown
   # 引用示例
   See `assets/references/method-name.md` for details.
   Run `assets/scripts/analysis.py` to process data.
   Use `assets/templates/report.docx` as output template.
   ```

---

## 验证清单

重组完成后，每个 skill 应该满足：

- [ ] SKILL.md 在正确位置
  - Harness: `<skill-name>/<source>/SKILL.md`
  - Package: `<skill-name>/SKILL.md`
- [ ] YAML frontmatter 完整（name, description）
- [ ] 如有 bundled resources：
  - [ ] 使用 `assets/` 目录
  - [ ] 子目录正确：scripts/, references/, templates/
  - [ ] SKILL.md 中正确引用路径
- [ ] 没有遗留的非标准目录（如 `method/`）

---

## 收益

1. **一致性**：所有 skills 遵循相同结构
2. **可预测性**：用户/开发者知道在哪里找东西
3. **可扩展性**：新 skills 有清晰的模板可遵循
4. **工具支持**：未来的 skill-creator 可以自动生成正确结构
5. **文档清晰**：assets/ 的三分类明确了用途

---

## 下一步

1. 审查现有 skills 的 SKILL.md 内容
2. 识别哪些需要 assets/
3. 执行重组（先 harness，后 packages）
4. 更新所有 SKILL.md 中的路径引用
5. 验证 npm run build/check:structure
6. 提交到 git
