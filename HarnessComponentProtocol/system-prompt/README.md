# System Prompt Module

The **system-prompt** module formats agent skills for inclusion in the system prompt.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `system-prompt/pi/system-prompt.ts`

## Key Export

- `formatSkillsForSystemPrompt()` — Format available skills into XML block for system prompt

## Usage

```typescript
import { formatSkillsForSystemPrompt } from "@magenta/harness";

const skills = [
  {
    name: "coding-methodology",
    description: "Systematic approach to coding tasks",
    filePath: "/path/to/SKILL.md",
    content: "...",
    disableModelInvocation: false
  },
  // ... more skills
];

const systemPromptBlock = formatSkillsForSystemPrompt(skills);
// Append to system prompt
```

## Output Format

Generates XML-formatted skills block:

```xml
The following skills provide specialized instructions for specific tasks.
Read the full skill file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>coding-methodology</name>
    <description>Systematic approach to coding tasks</description>
    <location>/path/to/SKILL.md</location>
  </skill>
  <skill>
    <name>evidence-driven-proposal</name>
    <description>Make recommendations with evidence</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

## Features

- **XML escaping**: Properly escapes `<`, `>`, `&`, `"`, `'` in values
- **Filtering**: Excludes skills with `disableModelInvocation: true`
- **Empty handling**: Returns empty string if no visible skills
- **Path resolution hint**: Includes instruction for relative path handling

## Skill Visibility

Only skills with `disableModelInvocation: false` (or undefined) are included in the system prompt. This allows:
- Hidden skills (internal/utility skills not meant for model invocation)
- User-only skills (invocable via `/skill` command but not listed for model)

## TOML Declaration

```toml
[[components]]
kind = "system-prompt"
name = "system-prompt"
path = "system-prompt/system-prompt.toml"
```

```toml
kind = "system-prompt"
product = "capability"
slot = "system-prompt"
autoload = true
name = "system-prompt"
source = "pi"
```

## Dependencies

- Structural Skill type

## Architecture Notes

This module is **pure formatting** — it doesn't load skills or construct the full system prompt. It only formats the skills block for inclusion.

The full system prompt is assembled by the agent loop, which combines:
1. Base instructions
2. Skills block (from this module)
3. Tool definitions
4. Context-specific instructions
5. Memory/session context

## Design Rationale

Skills are presented in a structured XML format so the model can:
- Easily identify available skills
- Understand when to invoke each skill
- Reference skills by name in tool calls
- Parse skill metadata reliably

The XML format follows the agentskills.io specification for skill presentation.
