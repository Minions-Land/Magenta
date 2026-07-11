# System Prompt Module

The `system-prompt` Module has two deliberately separate products:

- the selected `pi` Source produces a live Capability for formatting skills and
  loading system-prompt descriptors;
- the repository-declared `descriptor` Source converts host- or Package-supplied
  descriptors into file-backed Resources.

This keeps executable behavior and inert prompt content distinct while routing
both through the same real `system-prompt/HcpServer.ts`.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `system-prompt/pi/system-prompt.ts`

## Capability Surface

- `SystemPromptProvider` loads and validates descriptors.
- `formatSkillsForSystemPrompt()` formats available skills as model context.
- `loadSystemPromptDescriptor()` is the Source-independent descriptor loader.

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

Package prompt content is declared separately as a Resource descriptor:

```toml
kind = "system-prompt" # or append-system-prompt
name = "domain-system-prompt"
content_path = "SYSTEM.md"
```

`system-prompt` Resources replace by default; `append-system-prompt` Resources
append and must use distinct names. Package content never becomes another live
system-prompt Capability.

## Dependencies

- Structural Skill type

## Architecture Notes

The Module provides formatting and descriptor behavior; it does not own the
application's final prompt composition. The agent loop combines:
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
