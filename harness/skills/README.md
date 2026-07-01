# Skills Module

The **skills** module loads and manages agent skills from `SKILL.md` files.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `skills/pi/skills.ts`

## Key Exports

- `loadSkills()` — Load skills from directories (single or multiple)
- `loadSkillsTagged()` — Load skills with source tags
- `formatSkillInvocation()` — Format skill content for agent prompt
- `formatSkillsForSystemPrompt()` — Format available skills list for system prompt
- `Skill` — Skill metadata and content
- `SkillDiagnostic` — Loading warnings

## Skill Structure

Skills are Markdown files (`SKILL.md` or `*.md` at directory root) with YAML frontmatter:

```markdown
---
name: example-skill
description: What this skill does
disable-model-invocation: false
---

# Skill Instructions

When to use this skill...

## Usage

...
```

## Usage

```typescript
import { loadSkills, formatSkillInvocation } from "@magenta/harness";

// Load from one or more directories
const { skills, diagnostics } = await loadSkills(env, [
  "/path/to/skills",
  "/path/to/more/skills"
]);

// Format for invocation
const prompt = formatSkillInvocation(skills[0], "Additional instructions...");

// Format for system prompt
const systemPromptBlock = formatSkillsForSystemPrompt(skills);
```

## Skill Discovery

Skills are discovered by:
1. Recursively traversing directories
2. Finding `SKILL.md` files in subdirectories
3. Finding `*.md` files at directory root level
4. Parsing YAML frontmatter for metadata
5. Extracting content after frontmatter
6. Honoring `.gitignore` / `.ignore` / `.fdignore` files

## Frontmatter Fields

- `name` (required) — Stable skill identifier (max 64 chars)
- `description` (required) — Short description (max 1024 chars)
- `disable-model-invocation` (optional) — If true, agent can't invoke this skill via model call

## Diagnostics

The loader emits warnings (not errors) for:
- `file_info_failed` — Could not stat a file
- `list_failed` — Could not list directory
- `read_failed` — Could not read file
- `parse_failed` — YAML frontmatter parse error
- `invalid_metadata` — Missing or invalid name/description

Missing directories are silently skipped. Invalid skills are skipped with diagnostics.

## Source Tagging

`loadSkillsTagged()` accepts an array of `{ dir, source }` and tags each loaded skill with its source:

```typescript
const { skills } = await loadSkillsTagged(env, [
  { dir: "/builtin/skills", source: "builtin" },
  { dir: "/user/skills", source: "user" }
]);

console.log(skills[0].source); // "builtin" | "user"
```

This enables filtering skills by origin.

## Invocation Format

Skills are wrapped in XML-style tags for the agent:

```xml
<skill name="example-skill" location="/path/to/SKILL.md">
References are relative to /path/to.

[skill content]
</skill>

[optional additional instructions]
```

## Registration

```toml
[[components]]
kind = "skill"
name = "skills"
path = "skills/skills.toml"
```

## Dependencies

- `yaml` — YAML frontmatter parsing
- `ignore` — `.gitignore` pattern matching
- Types module (ExecutionEnv, Skill)

## Architecture Notes

Skills are **user-invocable capabilities** loaded from the filesystem. The agent can reference them via `/skill` command or when the model sees them in the system prompt.
