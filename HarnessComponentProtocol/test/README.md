# Harness Tests

Harness tests are currently flat for compatibility with the existing Vitest
configuration. Treat them as four ownership groups when adding coverage:

- `assembly`: registry, catalog, HCP, Magnet, package tool assembly.
- `runtime`: process runtime, script runtime, sandbox, policy, hooks.
- `capabilities`: tools, skills, prompt templates, system prompt, context,
  memory, compaction.
- `session-loop`: session storage, `AgentHarness`, stream behavior, repo
  utilities.

New tests should name the owning boundary clearly. If this directory is later
split into subdirectories, keep those four groups as the migration map.
