# Security

Magenta is a local coding agent. It runs with the permissions of the user account that starts it, and it treats files writable by that user as inside the same local trust boundary.

## Project Trust

Project trust controls whether Magenta loads project-local settings, resources, extension packages, and extensions. It is not a sandbox and it does not restrict what the model can ask tools to do after you start working in a directory.

Magenta considers a project to have resources that require trust when it finds any of these from the current working directory:

- `.magenta/settings.json`
- `.magenta/extensions`, `.magenta/skills`, `.magenta/prompts`, or `.magenta/themes`
- `.magenta/SYSTEM.md` or `.magenta/APPEND_SYSTEM.md`
- project `.agents/skills` in the current directory or an ancestor directory

A bare `.magenta` directory does not count as a project resource that requires trust.

When an interactive session starts in a project with resources that require trust and no saved decision for the current directory or a parent directory, Magenta follows `defaultProjectTrust` from global settings. The default value is `"ask"`, which asks whether to trust the project when UI is available. Saved decisions are stored by canonical directory in `~/.magenta/agent/trust.json`, and the closest saved decision on the current or parent path applies before the global default.

Trusting a project allows Magenta to load project resources that require trust, including:

- `.magenta/settings.json`
- `.magenta` resources such as extensions, skills, prompt templates, themes, and system prompt files
- missing project packages configured through project settings
- project-local extensions and project package-managed extensions

Declining trust skips protected resources. `AGENTS.md` and `CLAUDE.md` context files are loaded regardless of project trust unless context loading is disabled. Before trust is resolved, Magenta only loads context files, user/global extensions, and CLI `-e` extensions. User/global and CLI extensions can handle the `project_trust` event; the first extension that returns a yes/no decision owns the decision.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such resources, while `"always"` trusts them. Use `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## No Built-in Sandbox

Magenta does not include a built-in sandbox. Built-in tools can read files, write files, edit files, and run shell commands with the permissions of the Magenta process. Extensions are TypeScript modules that run with the same permissions. Package installs, shell commands, language servers, test commands, and other developer tools behave as ordinary local processes.

This is intentional. Magenta is designed to operate on local source trees, invoke project toolchains, and integrate with the user's existing development environment. A partial in-process sandbox would be easy to misunderstand as a security boundary while still depending on the host shell, filesystem, package managers, credentials, and extension code. Real isolation needs to come from the operating system or a virtualization/container boundary.

Project trust is only an input-loading guard. It prevents a repository from silently changing Magenta's settings or extensions before you approve it. It does not make untrusted code, untrusted prompts, or untrusted model output safe. Prompt injection from repository files, comments, documentation, context files, or build output is expected local-agent risk and cannot be reliably prevented by Magenta.

## Running Untrusted or Unmonitored Work

For untrusted repositories, generated code you do not intend to monitor closely, or unattended automation, run Magenta in a contained environment. Use a container, VM, micro-VM, remote sandbox, or policy-controlled sandbox with only the files and credentials required for the task.

Common patterns are documented in [Containerization](containerization.md):

- run the whole `magenta` process inside a container/sandbox
- run host Magenta while routing built-in tool execution into a Gondolin micro-VM
- mount only the workspace paths the agent should access
- avoid mounting host `~/.magenta/agent` unless the container should access host sessions, settings, and credentials
- pass the minimum required API keys or use short-lived credentials
- restrict network access when the task does not need it
- review diffs and outputs before copying results back to trusted systems

If you bind-mount a host workspace read/write, writes from inside the container or VM can still modify host files. Use read-only mounts or copy files into and out of the sandbox when you need stronger protection from unintended writes.

## Delegated Work Boundaries

`sub_agent` runs sessionless, one-shot workers for bounded delegation. A workflow
orchestrates the same kind of worker through named presets with fixed
runtime-owned control flow. The public tool neither exposes nor accepts
model-authored inline JavaScript; trusted programmatic script modules remain an
internal Harness capability. Workflow workers are denied `sub_agent`, `bg_shell`,
`multiagent`, and `send_message`, preventing nested delegation and out-of-band
peer coordination.

`multiagent` is the durable lifecycle control plane for persistent teammate
Sessions. Its public target identity is only `sessionId`; ordinary communication
uses `send_message`, and there is no Assignment or blocking wait API. With
`workspace="worktree"`, Magenta requires a clean Git Main checkout, creates a
versioned linked checkout under `.magenta/tmp/collaboration/<main-session>/`,
captures tracked and untracked non-ignored changes (including mode, symlink, and
binary data) through a separate Git index, and applies them only through explicit
`integrate`. Integration verifies
the receipt hash and requires a clean parent; it never stashes, resets, cleans, or
silently resolves conflicts. `discard` requires confirmation, and shutdown retains
unintegrated worktree generations and receipts. Reopening the exact same Main
Session validates the child Session identity and manifest before automatically
resuming desired-running teammates.

A worktree is conflict isolation, not a security sandbox. A granted `bash` or file
tool can still use absolute paths outside it, and repository Git filters/hooks may
execute under the existing project-trust policy. Patch receipts can contain
sensitive source data; they are mode `0600` and are never inlined into model
context. `send_message` remains the urgent, durable-acceptance mailbox data plane
and does not create a teammate, prove delivery, or carry Assignment status.

Side/BTW history is stored as versioned custom session entries that are excluded
from the main model context. Its **Enqueue as teammate** action exists only in the
human TUI, requires confirmation, and is not exposed in the teammate tool schema
or main system prompt. The bounded transcript is written only to the child's
hidden context; parent status/tool details retain metadata but never the
transcript. The bootstrap asks the teammate to send Main its understanding and
questions before broad action, so it creates neither an Assignment nor an ownership lease.

Ultra enables workflow and managed-teammate capabilities by default and maps to
the selected model's highest native reasoning level. It does not dispatch work,
start workers, or create teammates automatically.

## Reporting Security Issues

Report security-sensitive issues privately through [GitHub Security Advisories](https://github.com/Minions-Land/Magenta/security/advisories/new). Do not open a public issue for a confidential vulnerability.

Expected local-agent behavior, lack of a built-in sandbox, prompt injection from untrusted content, and behavior of user-installed extensions or skills are generally outside the security boundary unless the report demonstrates a real privilege-boundary bypass or shows how Magenta grants access that the local user did not already have.
