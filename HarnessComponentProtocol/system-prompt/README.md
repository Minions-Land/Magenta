# System Prompt Module

The `system-prompt` Module exposes two deliberately separate products through the
same real `system-prompt/HcpServer.ts`:

- the selected `pi` Source produces one live `capability:system-prompt` binding;
- the repository-declared `descriptor` Source converts host- or Package-supplied
  prompt descriptors into inert, file-backed Resources.

A Capability is executable composition behavior. A Resource is selected prompt
content. Neither product is converted into the other, and every Magnet returns
exactly one product.

## Selected Capability

- **Source**: `pi`
- **Implementation**: `system-prompt/pi/system-prompt.ts`
- **Binding**: `SystemPromptProvider` in `system-prompt/pi/provider.ts`
- **Slot**: `system-prompt`

`SystemPromptProvider` provides:

- `buildSystemPrompt(options)` for deterministic base composition;
- `formatSkillsForSystemPrompt(skills, options)` for Agent Skills XML; and
- `loadDescriptor(path)` for validated descriptor loading.

The composition function is deterministic when `currentDate` is supplied. It
preserves caller order for tools, guidelines, appended prompt content, context
files, and skills. Its section order is:

1. selected default or custom base;
2. host-selected appended prompt content;
3. conditional bundled operational fragment;
4. project context files;
5. model-visible skills when `read` is active; and
6. date and working directory.

A custom base replaces the default Magenta identity, tool list, guidelines,
collaboration principles, and documentation section. It does **not** suppress a
host-enabled operational fragment for an active background tool.

## Background Work Fragment

The provider emits background-work instructions only when both conditions hold:

1. the host supplies `bundledPromptFeatures.backgroundWork = true`; and
2. `bg_shell` and/or `sub_agent` is present in `selectedTools`.

The fragment mentions only active tools. `bg_shell` guidance tells the agent to
start long work, continue independent work immediately, and wait only at an
explicit dependency barrier. `sub_agent` guidance is absent unless that tool is
active. With neither tool, no background section is emitted.

## Host Boundary

The provider composes resolved inputs; it does not discover or select them.
`pi/coding-agent` remains responsible for:

- filesystem, CLI, Package, and extension discovery;
- precedence between custom, discovered, and Package prompt Resources;
- active-tool selection and tool prompt metadata;
- project context and skill loading;
- installed Magenta documentation paths; and
- whether bundled prompt features are enabled.

`AgentSession` resolves `capability:system-prompt` from its one session
`HcpClient`. A loader that exposes no HCP may use the thin legacy facade in
`pi/coding-agent/src/core/system-prompt.ts`. If an HCP exists but the required
slot is missing, that is an assembly error and must not silently fall back to a
statically selected Source.

Host discovery, precedence, and extensions therefore remain outside the
Capability, while deterministic composition remains inside the selected Source.
No TOML or generated assembly table participates in prompt-section assembly.

## Skills Output

`formatSkillsForSystemPrompt()` filters skills with
`disableModelInvocation: true`, preserves input order, and XML-escapes names,
descriptions, and locations:

```xml
<available_skills>
  <skill>
    <name>coding-methodology</name>
    <description>Systematic approach to coding tasks</description>
    <location>/path/to/SKILL.md</location>
  </skill>
</available_skills>
```

Relative paths referenced by a skill are resolved by the agent against the skill
directory; the formatter does not read the skill body.

## Descriptor Resources

Package prompt content is declared as a Resource descriptor:

```toml
kind = "system-prompt" # or append-system-prompt
name = "domain-system-prompt"
content_path = "SYSTEM.md"
```

`system-prompt` Resources replace according to host precedence.
`append-system-prompt` Resources append and use distinct names. Descriptor paths
must remain local to the descriptor directory. Package content never becomes a
second live system-prompt Capability.

## Repository Declaration

```toml
kind = "system-prompt"
product = "capability"
slot = "system-prompt"
autoload = true
name = "system-prompt"
source = "pi"
```

The existing declaration and generated assembly remain the only repository
selection path; adding composition behavior does not add a registry, Source
switch, or second Client.
