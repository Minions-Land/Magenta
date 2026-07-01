# Prompt Templates Module

The **prompt-templates** module loads and manages reusable prompt templates from Markdown files.

## Implementation

- **Source**: pi (TypeScript)
- **Location**: `prompt-templates/pi/prompt-templates.ts`

## Key Exports

- `loadPromptTemplates()` — Load templates from directories or files
- `loadSourcedPromptTemplates()` — Load templates with source tags
- `PromptTemplate` — Template metadata and content
- `PromptTemplateDiagnostic` — Loading warnings

## Template Structure

Prompt templates are Markdown files (`.md`) with optional YAML frontmatter:

```markdown
---
description: Brief description of when to use this template
argument-hint: Optional hint for arguments this template accepts
---

# Template Content

Your prompt template goes here.

Use {{variable}} for parameter substitution.
```

## Usage

```typescript
import { loadPromptTemplates } from "@magenta/harness";

// Load from directories or files
const { promptTemplates, diagnostics } = await loadPromptTemplates(env, [
  "/path/to/templates/dir",    // Loads direct .md children (non-recursive)
  "/path/to/specific.md"       // Loads specific file
]);

// Access loaded templates
for (const template of promptTemplates) {
  console.log(template.name);         // Derived from filename
  console.log(template.description);  // From frontmatter
  console.log(template.content);      // Template body
  console.log(template.filePath);     // Absolute path
}
```

## Template Discovery

Templates are discovered by:
1. **From directories**: Loads direct `.md` children (non-recursive)
2. **From files**: Loads explicit `.md` files
3. Missing paths are silently skipped
4. Non-markdown files are ignored
5. Read/parse failures are returned as diagnostics (warnings, not errors)

## Frontmatter Fields

- `description` (optional) — Human-readable description
- `argument-hint` (optional) — Hint for expected arguments/parameters

Other fields are preserved but not used by the loader.

## Source Tagging

`loadSourcedPromptTemplates()` tags templates by origin:

```typescript
const { promptTemplates } = await loadSourcedPromptTemplates(env, [
  { path: "/builtin/templates", source: "builtin" },
  { path: "/user/templates", source: "user" }
]);

for (const { promptTemplate, source } of promptTemplates) {
  console.log(promptTemplate.name, source);  // "example" "builtin"
}
```

This enables filtering templates by provenance.

## Diagnostics

The loader emits warnings (not errors) for:
- `file_info_failed` — Could not stat a file
- `list_failed` — Could not list directory
- `read_failed` — Could not read file
- `parse_failed` — YAML frontmatter parse error

Invalid templates are skipped with diagnostics. Loading continues for remaining templates.

## Template Naming

Template names are derived from filenames:
- `example-template.md` → name: `"example-template"`
- `my_prompt.md` → name: `"my_prompt"`

## Registration

```toml
[[components]]
kind = "prompt-template"
name = "prompt-templates"
path = "prompt-templates/prompt-templates.toml"
```

## Dependencies

- `yaml` — YAML frontmatter parsing
- Types module (ExecutionEnv, PromptTemplate)

## Use Cases

1. **Reusable prompts**: Standard prompts for common tasks
2. **Parameter substitution**: Templates with `{{variable}}` placeholders
3. **Multi-source**: Combine built-in and user-defined templates
4. **Dynamic loading**: Discover templates at runtime

## Architecture Notes

Prompt templates are **data files** loaded at startup, not code. This enables:
- Users to add custom templates without code changes
- Hot-reloading templates in development
- Versioning templates separately from code
- Sharing templates across projects
