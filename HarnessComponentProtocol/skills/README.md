# Skills Module

The `skills` module owns file-backed instructions exposed to the agent as
`skill:<name>` Resources.

## Entity Tree

Harness-native skills use the same explicit root, slot, and source layout as
tools:

```text
skills/
  HcpServer.ts
  <skill>/
    <skill>.toml
    HcpServer.ts
    <source>/
      HcpMagnet.ts
      SKILL.md
```

The routing chain is:

```text
HcpClient -> skills/<skill>/HcpServer -> <source>/HcpMagnet -> SKILL.md
```

`HcpMagnet.toResource()` returns a file-backed `skill` Resource. Skills do not
enter capability builder resolution and do not produce agent tools.

The registered trunk slots are:

- `paper-analysis` from `pi`
- `pptx` from `pi`
- `research-orchestration` from `pi`
- `self-evo` from `magenta`

The directories below `self-evo/magenta/` are chapters referenced by the parent
skill. They are intentionally not registered as independent slots.

## Shared Loading

Shared parsing and discovery behavior lives in `skills/HcpServer.ts`, alongside
the `skills` grouping Server. Its public functions are:

- `loadSkills()` - load skills from one or more directories
- `loadSourcedSkills()` - load directories while preserving caller-provided provenance
- `loadSkillFile()` - load one Markdown file
- `formatSkillInvocation()` - format an invoked skill for model context
- `getHarnessSkillsDir()` - return the installed harness skills root

Discovery recursively finds `SKILL.md`, accepts direct root `*.md` files, and
honors `.gitignore`, `.ignore`, and `.fdignore`. If a directory contains its own
`SKILL.md`, that file defines the skill and nested directories are treated as its
assets rather than additional skills.

## Skill File

```markdown
---
name: example-skill
description: What this skill does
disable-model-invocation: false
---

# Skill Instructions

Follow these instructions.
```

Names are limited to lowercase letters, digits, and hyphens. Descriptions are
required. `disable-model-invocation: true` keeps a skill out of model-visible
discovery while still allowing a parent workflow to read it as an asset.

## Registration

Each real slot has its own `harness.toml` row and descriptor:

```toml
[[components]]
kind = "skill"
name = "example-skill"
path = "skills/example-skill/example-skill.toml"
```

```toml
kind = "skill"
name = "example-skill"
source = "pi"
description = "What this skill does."
```

The generated assembly has one `HCP_MAGNETS` inventory; session assembly filters
its skill entries, registers the root first, and then registers each leaf Server.
Therefore `resolve("skill:example-skill")` returns the real
`skills/example-skill/HcpServer` instance.

## Dependencies

- `yaml` for frontmatter parsing
- `ignore` for ignore-file matching
- `ExecutionEnv` for filesystem access
