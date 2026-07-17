# Pi v0.80.2 -> v0.80.8: TUI / Orchestrator / Root-CI-Build-Release Analysis

## Scope and evidence baseline

- Upstream range: `/tmp/magenta-pi-upstream-v0.80.8-20260717`, `v0.80.2..v0.80.8`.
- Fixed trees: `U2=/tmp/magenta-pi-v0802`, `U8=/tmp/magenta-pi-v0808`.
- Import snapshot: `/tmp/magenta-import-f1da4c` (plain tree, not a Git repository).
- Magenta mapping target: `/Users/mjm/Magenta3` at `4a08f6305ed3fa88067d7dbd9a19ced606dcef0f`.
- Path-relevant upstream log: 99 commits when selecting `packages/tui`, `packages/orchestrator`, `.github`, `scripts`, `.pi`, and top-level build/dependency/release files. This deliberately includes merge commits, contributor metadata, release bumps, changelog cycle commits, and lock drift.
- Final scoped tree delta: 42 files, 3,838 insertions, 174 deletions. `packages/tui` has 9 final changed files; `packages/orchestrator` is a new 18-file package; the rest is root/CI/build/release/dependency surface.

Classification used below:

- `PORT`: behavior is missing and should be translated into Magenta.
- `ADAPT`: behavior is useful, but direct cherry-pick is unsafe because Magenta has diverged.
- `ALREADY`: current Magenta independently contains the effective change.
- `SUPERSEDED`: current HCP/Magenta architecture provides the capability through a stronger or different owner.
- `N/A`: upstream product/repository policy does not apply to Magenta.
- `CONDITIONAL`: only useful if another upgrade decision enables its prerequisite.

## Recommended migration order

1. `TR-004`, `TR-003`, `TR-001`: isolated TUI output/input correctness.
2. `TR-002`: adapt paste-marker cleanup to Magenta's richer registry and undo model.
3. `TR-012`: repair native clipboard packaging for compiled Bun releases.
4. `TR-013` and `TR-018`: make release/test execution deterministic before broad upgrade work.
5. Do not import `packages/orchestrator`; retain HCP and managed-teammate ownership.
6. Revisit `TR-015` only if the model-runtime/model-catalog upgrade is selected elsewhere.

---

## TUI changes

### TR-001 - Preserve source backslash escapes in rendered user messages

- **Upstream evidence:** commit [`f2e9d753`](https://github.com/earendil-works/pi/commit/f2e9d75388fe17325ebe31372e5287b4acdb67a3), `fix(coding-agent): preserve backslash escapes in user messages`, closes upstream issue `#6105`. Official TUI changelog: `packages/tui/CHANGELOG.md` under `0.80.3`, "opt-in Markdown renderer option to preserve source backslash escapes".
- **Files/symbols:** `packages/tui/src/components/markdown.ts:MarkdownOptions.preserveBackslashEscapes`, inline token switch `case "escape"`; `packages/tui/test/markdown.test.ts`; coding-agent `UserMessageComponent` opts in.
- **Behavior:** default Markdown rendering still normalizes escaped punctuation; opt-in rendering uses `token.raw`, so a source backslash before a quote remains visually identical to the submitted source.
- **Magenta current mapping:** `pi/tui/src/components/markdown.ts:MarkdownOptions` only has `preserveOrderedListMarkers`; `pi/coding-agent/src/modes/interactive/components/user-message.ts:26` only enables that option. Missing.
- **Classification:** `PORT` (medium priority, low conflict).
- **Migration action:** port the TUI option and `escape` token branch, then enable it only in `UserMessageComponent`. Do not globally change assistant/summary rendering.
- **Dependencies:** `marked` escape token behavior already exists in current TUI; no package change.
- **Tests:** port both default-normalization and opt-in-preservation assertions; add a coding-agent component assertion proving user messages opt in while assistant Markdown does not.

### TR-002 - Clean paste-marker state on deletion and editor reset

- **Upstream evidence:** commit [`8a2ce5a5`](https://github.com/earendil-works/pi/commit/8a2ce5a54024be2eb2b879288212141741afa65e), `fix(tui): decrement paste counter on paste marker delete and terminal clear (#6397)`. Official TUI changelog under `0.80.4` says stale paste state is prevented after marker removal.
- **Files/symbols:** upstream `packages/tui/src/components/editor.ts:setText`, `handleBackspace`, `PASTE_MARKER_SINGLE` capture groups, `pastes`, `pasteCounter`. Upstream clears all paste state in `setText`; deleting an atomic marker deletes its map entry, decrements the counter, renumbers later visible markers and map keys.
- **Magenta current mapping:** `pi/tui/src/components/editor.ts` has diverged substantially. It stores `PasteEntry { id, marker, expandedText }`, exposes `createPasteMarker`, `getPasteMarkerSnapshot`, `restorePasteMarkerSnapshot`, and `clearPasteMarkers`, and snapshots paste state for editor replacement. However, `setText` at line 1013 and `handleBackspace` at line 1323 do not remove/reset registrations. The upstream patch cannot be cherry-picked safely.
- **Classification:** `ADAPT` (high priority because stale expanded payload can survive visible marker deletion/reset).
- **Migration action:**
  - On `setText`, clear registrations/counter at the draft boundary without accidentally erasing the undo snapshot that should restore the previous draft.
  - On atomic marker deletion, locate the matching `PasteEntry` and remove it.
  - Prefer keeping `pasteCounter` monotonic within a draft or recomputing it from remaining ids. Do **not** blindly apply upstream's decrement-and-renumber algorithm: Magenta snapshots ids and expanded payloads, and holes are safer than id reuse/collision.
  - Preserve `clearPasteMarkers()` as the single reset primitive, but split "clear registry" from "clear undo stack" if `setText` needs an undoable reset.
- **Dependencies:** Magenta paste snapshots, custom editor replacement, clipboard image marker flows, undo stack.
- **Tests:** delete one of several markers and verify only its expanded payload is removed; insert a new marker after deletion and verify no id collision; `setText`/Ctrl-C/submit reset registrations; undo restores text and the matching marker registry; snapshot/restore remains valid with deleted-id holes.

### TR-003 - Parse legacy Alt-prefixed printable symbols

- **Upstream evidence:** commit [`8479bd84`](https://github.com/earendil-works/pi/commit/8479bd84743e8889f728acb21a62794102db0529), `fix(tui): parse legacy alt-prefixed symbols (#6523)`. Official TUI changelog under `0.80.7` names `Alt+,` and `Alt+.`.
- **Files/symbols:** `packages/tui/src/keys.ts:matchesKey`, `parseKey`, `SYMBOL_KEYS`; `packages/tui/test/keys.test.ts`.
- **Behavior:** with Kitty keyboard protocol inactive, `ESC + printable symbol` is decoded like the already-supported legacy `ESC + letter/digit`; Kitty-active mode continues rejecting the ambiguous legacy form.
- **Magenta current mapping:** `pi/tui/src/keys.ts:1162` and `:1299` still restrict legacy Alt parsing to letters/digits even though `SYMBOL_KEYS` already exists. Missing.
- **Classification:** `PORT` (high priority, trivial conflict).
- **Migration action:** add `SYMBOL_KEYS.has(key)` to both match and parse branches; keep the `_kittyProtocolActive` guard.
- **Dependencies:** none.
- **Tests:** port `Alt+,`/`Alt+.` positive cases with Kitty off and negative cases with Kitty on; retain existing Ctrl+Alt symbol coverage. Upstream isolated `keys.test.ts` passed 59/59 in this analysis environment.

### TR-004 - Normalize visible tabs before terminal differential output

- **Upstream evidence:** commit [`1c799cec`](https://github.com/earendil-works/pi/commit/1c799cecd02c6d8245afa39b1684f07d3b96bd3e), `fix(tui): normalize tabs for terminal output (#6697)`. Official TUI changelog under `0.80.8` says terminal output now normalizes tabs consistently.
- **Files/symbols:** `packages/tui/src/utils.ts:normalizeTerminalOutput`, `extractAnsiCode`; `packages/tui/test/tab-width.test.ts`; call site remains `TUI` differential output normalization.
- **Behavior:** visible `\t` becomes the layout's fixed three spaces so a terminal's physical tab stops cannot wrap an otherwise single logical row. Tabs inside CSI/OSC/APC terminal control strings remain byte-identical.
- **Magenta current mapping:** `pi/tui/src/utils.ts:282` only performs Thai/Lao AM normalization; `pi/tui/src/tui.ts:1449` already routes output through this function. Missing and directly compatible with the optimized renderer.
- **Classification:** `PORT` (highest TUI priority; prevents viewport corruption/overlay row drift).
- **Migration action:** port the ANSI-aware loop exactly around Magenta's existing `extractAnsiCode`; retain Thai/Lao normalization first and the fast return when no tab exists.
- **Dependencies:** none.
- **Tests:** port control-sequence byte-preservation and tab-containing overlay viewport assertions; add a regression against Magenta's optimized history renderer to ensure no raw tab reaches `Terminal.write` and no false full redraw occurs.

### TR-005 - Quiet dot reporters for package tests

- **Upstream evidence:** commit [`47830134`](https://github.com/earendil-works/pi/commit/478301342b4c5fd4e2993d0c9b985cd60fb370ae), `test: use quiet dot reporters and show output only for failing tests`; TUI `package.json` changes `node --test` to dot reporter flags.
- **Files/symbols:** `packages/tui/package.json:scripts.test` (and other package manifests outside this report's package scope).
- **Magenta current mapping:** `pi/tui/package.json:10` still uses the standard reporter. This is output policy, not behavior.
- **Classification:** `N/A` for selective TUI migration. Apply only repo-wide if Magenta wants the same CI log policy.
- **Migration action:** no isolated TUI change; a repo-wide change must preserve useful failure diagnostics and Node-version compatibility.
- **Dependencies/tests:** no product test. Verify the selected Node 22 runner supports both reporter flags and that failures still print stack traces.

---

## Orchestrator package

### TR-006 - Experimental `@earendil-works/pi-orchestrator`

- **Upstream evidence:** merge commit [`87ad8243`](https://github.com/earendil-works/pi/commit/87ad8243cb92eda6af97eca68224893fdb092521), `feat(experimental): pi orchestrator`, plus the full historical chain in the coverage appendix. `packages/orchestrator/README.md` and package metadata explicitly say "Experimental", "may change or be removed", and "CLI, APIs, and behavior are not yet stable". Its changelog has only empty version headings. There are **no package tests**.
- **Final upstream files/symbols:**
  - CLI/daemon: `src/cli.ts`, `serve`, `list`, `spawn`, `status`, `stop`, `rpc`, `rpc-stream`.
  - Local IPC: `src/ipc/{client,protocol,server}.ts`, newline-delimited JSON over a Unix socket, stale-socket detection.
  - Child agent bridge: `RpcProcessInstance`, `OrchestratorSupervisor`, serialized request ids, event/UI forwarding, session metadata refresh.
  - Persistence/lifecycle: `machine.json`, `instances.json`, restart recovery marks prior online instances stopped.
  - Radius presence: machine/Pi registration, credential lookup, heartbeat/backoff, three-404 re-registration, disconnect.
- **Magenta current mapping:**
  - `HarnessComponentProtocol/multiagent/HcpServer.ts` owns sessionless workflow orchestration with fixed and scripted patterns, guards, cancellation and state persistence.
  - `pi/coding-agent/src/core/tools/sub-agent.ts` owns one-shot workers and workflow facade.
  - `pi/coding-agent/src/core/tools/teammate-agent.ts` owns long-lived child process lifecycle (`start/status/send/interrupt/stop/resume/integrate/discard`), RPC correlation, worktree isolation, assignment receipts and shutdown.
  - `pi/coding-agent/src/modes/rpc/rpc-client.ts:RpcClient` already provides typed JSONL child RPC and event/UI response handling.
  - `HarnessComponentProtocol/multiagent/message/message-store.ts` provides persistent SQLite presence, heartbeats, inbox/outbox, peer routes, retry claims and SSH-federated peer transport.
  - HCP governance intentionally keeps the management envelope in-process rather than introducing another daemon protocol boundary.
- **Classification by capability:**
  - Spawn/list/status/stop and child lifecycle: `SUPERSEDED` by managed teammates/background events.
  - RPC request/event/UI stream: `SUPERSEDED` by current `RpcClient` and teammate RPC plumbing.
  - Local instance/session persistence and presence: `SUPERSEDED` by session files, background events, assignment state and SQLite mailbox presence.
  - Workflow orchestration: `SUPERSEDED` by HCP multiagent workflows, which are materially more capable and tested.
  - Standalone machine-wide Unix-socket `orchestrator` service: `N/A`; Magenta deliberately has no separate daemon owner.
  - Radius cloud registration/heartbeat: `N/A`; Magenta does not use Radius. SSH mailbox federation covers Magenta's remote peer requirement without Radius credentials.
- **Migration action:** do not add `packages/orchestrator`, root workspace aliases, build step, dependency, lock entries, CLI, socket, or Radius code. If a future product requirement calls for third-party programs to control a machine-wide pool through one stable local socket, specify that as a new HCP transport requirement and reuse current lifecycle/message owners; do not import this untested experimental package.
- **Residual capability check:** no upstream orchestrator capability is required for the present Magenta design. The only non-equivalent surface is the standalone daemon/Radius service, and it is a product choice rather than an upgrade gap.
- **Tests if revisited:** upstream supplies none. Any future HCP transport must test stale sockets, malformed/multiple JSONL frames, concurrent request serialization, child startup/exit races, timeout/kill escalation, restart recovery, heartbeat backoff/re-registration, credential isolation, and Windows behavior (upstream's Unix socket path is itself a portability concern).

---

## Root / CI / build / dependencies / release

### TR-007 - Visible release asset directory and relaxed generated-diff assertion

- **Upstream evidence:** [`954ec998`](https://github.com/earendil-works/pi/commit/954ec998140aa2aa66bb861ad1ffa09c47b3ad15) moves `.release-assets` to `release-assets` because artifact upload ignored the hidden directory; [`ec6311be`](https://github.com/earendil-works/pi/commit/ec6311beb5b24fc918e5031173608447582d7262) removes `git diff --exit-code` before npm publish because generated release artifacts are allowed.
- **Files/symbols:** `.github/workflows/build-binaries.yml` artifact preparation/upload and npm publish job.
- **Magenta current mapping:** `.github/workflows/release.yml` already uploads visible `pi/coding-agent/dist/release` artifacts and has no generated-diff assertion. `scripts/release.mjs` explicitly validates its expected changed paths before commits.
- **Classification:** `ALREADY` / architecture-specific.
- **Migration action:** none. Preserve Magenta's stricter source-release changed-path checks.
- **Tests:** existing release workflow must continue to fail on missing assets (`if-no-files-found: error`).

### TR-008 - Remove OpenClaw gate

- **Upstream evidence:** [`97820276`](https://github.com/earendil-works/pi/commit/978202765f1037a33fed61a74645ba0afb05b8b4) deletes `.github/workflows/openclaw-gate.yml`.
- **Magenta current mapping:** no OpenClaw workflow or gate exists.
- **Classification:** `N/A`.
- **Migration action/tests:** none.

### TR-009 - Generated installer lock release artifacts

- **Upstream evidence:** [`622eca76`](https://github.com/earendil-works/pi/commit/622eca76089f9c3b1af358f8c7cfa7937fbe5b0a), `feat(coding-agent): add installer lock generation`. Adds `scripts/generate-coding-agent-install-lock.mjs`, root check/generate scripts, release regeneration, and checksummed installer package/lock assets. The generator converts workspace links to registry tarballs, closes the runtime dependency graph, and validates lifecycle-script allowlists/platform packages.
- **Magenta current mapping:** Magenta publishes `pi/coding-agent/npm-shrinkwrap.json`; `scripts/generate-coding-agent-shrinkwrap.mjs` already closes internal HCP/Pi dependencies, validates exact resolution, rejects local links/dev metadata, and enforces install-script allowlists. `scripts/publish.mjs` uses npm provenance and `--ignore-scripts`. The main Magenta installer downloads signed/checksummed standalone binary/resource assets rather than performing the upstream lock-driven npm install.
- **Classification:** `N/A` for the current binary installer; effective npm-package hardening is `ALREADY` via shrinkwrap.
- **Migration action:** do not create a second dependency lock artifact unless Magenta introduces an npm-based end-user installer/updater that cannot consume the packaged shrinkwrap.
- **Dependencies/tests:** `npm run check:shrinkwrap` passed on current `4a08f63`. Continue isolated npm install/package smoke tests for the existing shrinkwrap.

### TR-010 - Restrict CI bot gate bypasses

- **Upstream evidence:** [`8f64353e`](https://github.com/earendil-works/pi/commit/8f64353e654c4b9a7afa800757086816cd5f1eb4) changes issue/PR gates from bypassing every `[bot]` author to a fixed trusted set and forbids untrusted bots from using collaborator/approved-user bypasses.
- **Files:** `.github/workflows/{issue-gate,pr-gate}.yml`.
- **Magenta current mapping:** those governance gates and `.github/APPROVED_CONTRIBUTORS` do not exist.
- **Classification:** `N/A`.
- **Migration action:** if Magenta later creates equivalent public contribution gates, adopt the allowlist principle rather than these Earendil-specific identities.
- **Tests:** fixture-test trusted bot, untrusted bot, collaborator, and approved human branches before deployment.

### TR-011 - Automated issue-analysis workflow and session import repro

- **Upstream evidence:** [`abe9c9d9`](https://github.com/earendil-works/pi/commit/abe9c9d9f15e843e56848849fc96d0a5486b47aa) through [`4087346d`](https://github.com/earendil-works/pi/commit/4087346dfde47da8378d6773ef5b99aca4610823), plus [`49956a7c`](https://github.com/earendil-works/pi/commit/49956a7c). Adds a 634-line workflow, `/ir` extension, CI-aware `/is` behavior, issue close prompt instructions, PAT/gist/auth refresh handling, staff authorization, comment trigger, result summary and runner tags.
- **Files/symbols:** `.github/workflows/issue-analysis.yml`, `.pi/extensions/import-repro.ts`, `.pi/prompts/{is,wr}.md`.
- **Magenta current mapping:** Magenta has native session import/share commands and explicit research orchestration, but no Earendil issue-label/comment workflow, organization secrets, `@issuron` bot, or `.pi` extension ownership. Current extension retirement/HCP ownership also makes direct `.pi/extensions` import architecturally wrong.
- **Classification:** `N/A` as an upstream repository operation, not a runtime upgrade.
- **Migration action:** do not port. A Magenta issue-analysis automation would need a separate threat model and HCP-native session resource/import path, Minions-Land authorization, supported model selection, secret rotation, fork-safe triggers and artifact retention policy.
- **Tests:** workflow authorization tests are mandatory if separately designed; specifically reject fork/untrusted actor secret access and malformed imported session paths.

### TR-012 - Include native clipboard binary at the path expected by Bun release

- **Upstream evidence:** [`62f45bad`](https://github.com/earendil-works/pi/commit/62f45badae4a9e7a2ec7caac34cecae2abd684e1), `Fix native clipboard in bun release (#6418)`.
- **Files/symbols:** `scripts/build-binaries.sh`; platform mapping now records both package and concrete file (`clipboard.darwin-arm64.node`, `clipboard.linux-x64-gnu.node`, etc.) and copies the native file into `node_modules/@mariozechner/clipboard/` next to the wrapper.
- **Magenta current mapping:** `scripts/build-binaries.sh:163-183` copies the wrapper and platform package but not the concrete native file into the wrapper directory. Missing, same layout and likely same compiled-Bun resolution failure.
- **Classification:** `PORT` (high priority release correctness).
- **Migration action:** port the six `clipboard_native_file` mappings and final copy, retaining Magenta's current output paths.
- **Dependencies:** all six `@mariozechner/clipboard-*` optional packages must be installed for cross-platform packaging.
- **Tests:** for every built target assert the wrapper directory contains the expected `.node`; run an actual copy/paste smoke on the host-native binary; at minimum load the clipboard module from the unpacked archive. Upstream supplied no automated regression test, so packaging verification must be added locally.

### TR-013 - Gate local/source release on full tests

- **Upstream evidence:** [`53213442`](https://github.com/earendil-works/pi/commit/532134428af1d59b8d33260c0093946fc7066753), `fix: gate releases on full tests`. `scripts/release.mjs` runs `./test.sh` after checks; `scripts/local-release.mjs` does so by default and adds explicit `--skip-test`.
- **Magenta current mapping:** `scripts/release.mjs:346` runs only `npm run check:release`; `scripts/local-release.mjs` runs only `npm run check` before packaging and has no `--skip-test`; `.github/workflows/release.yml` builds and smoke-tests binaries but does not run the unit suite.
- **Classification:** `PORT` (highest root/release priority).
- **Migration action:** add `./test.sh` before release commit/tag creation and before local packaging, with an explicit local `--skip-test` escape hatch. Consider a separate CI test job required by the release build so manually dispatched existing tags are also gated; a tag workflow cannot retroactively prevent a bad source tag, but it can prevent publication.
- **Dependencies:** tests must be deterministic and credential-isolated (`TR-018`) before becoming a release gate.
- **Tests:** unit-test argument parsing and command order with injected/spied process execution; verify a failing test prevents commits/tags/artifact publication; verify `--skip-test` only affects local release and is visible in help/output.

### TR-014 - Bun 1.3.14 for release binaries

- **Upstream evidence:** [`91585d9a`](https://github.com/earendil-works/pi/commit/91585d9a3829831b07560901c4b3e9bbe3b4e35a), `bump bun to 1.3.14 (#6503)`.
- **Magenta current mapping:** `.github/workflows/release.yml:38` already pins `1.3.14`.
- **Classification:** `ALREADY`.
- **Migration action/tests:** none beyond existing release smoke.

### TR-015 - Publish generated model catalogs to R2

- **Upstream evidence:** [`2be9efa1`](https://github.com/earendil-works/pi/commit/2be9efa19cd64aed40ca63f92c0c0f9a6bac7c9d), `feat(ai): publish generated model catalogs to R2 (#6720)`. Adds root generate/check scripts, `.artifacts/` ignore, a validator/publisher script, and scheduled/CI/workflow-dispatch R2 publication with pinned Actions and environment secrets.
- **Magenta current mapping:** current `model-registry.ts` refreshes local/provider data but has no selected remote R2 catalog artifact/publisher workflow. Model-runtime/catalog implementation is owned by the AI/coding-agent upgrade decision, outside this report's code ownership.
- **Classification:** `CONDITIONAL`.
- **Migration action:** only port/adapt after the model-runtime consumer format and trust/update policy are selected. Use Magenta-owned bucket/environment names, immutable source-commit metadata, schema validation, signed/authenticated transport expectations, and pinned Actions appropriate to the current repo. Do not copy Earendil R2 account ids/secrets.
- **Dependencies:** generated catalog schema and runtime refresh consumer from upstream AI/model-runtime changes.
- **Tests:** dry-run validation of every catalog, duplicate/collision/path traversal rejection, source-commit manifest check, publish idempotence, artifact download integrity, and runtime fallback when remote refresh fails.

### TR-016 - `undici` vulnerability refresh in Gondolin example dependency

- **Upstream evidence:** [`1d486163`](https://github.com/earendil-works/pi/commit/1d48616328f27ff37badc40c6a6b2acf48bfd686), `Fix examples, update to latest undici for vuln fix`; root lock changes nested Gondolin `undici 6.26.0 -> 6.27.0`.
- **Magenta current mapping:** `package-lock.json` already resolves `node_modules/@earendil-works/gondolin/node_modules/undici` to `6.27.0` (and root `undici` to `8.5.0`).
- **Classification:** `ALREADY`.
- **Migration action/tests:** none; retain lockfile audit.

### TR-017 - Mechanical versions, lock drift, changelog cycle and release metadata

- **Upstream evidence:** release commits `a23abe4a`, `912d0953`, `cc62baa4`, `2b3fda99`, `818d6745`, `fae7176c`; corresponding `[Unreleased]` cycle commits and changelog audits; orchestrator stale version/lock drift fixes `7e6e59b6`, `988990f1`, `0760bbae`.
- **Files:** package versions/dependency ranges, `package-lock.json`, package changelogs, generated release metadata.
- **Magenta current mapping:** `scripts/release.mjs` separates Magenta product versions from Pi workspace infrastructure versions. Current fork packages remain `0.80.2`; a raw upstream release commit would still misrepresent provenance.
- **Classification:** `N/A` mechanically; changelog descriptions are evidence for functional TRs above.
- **Migration action:** do not cherry-pick upstream bump/empty headings/lock drift. Upstream already occupies the same `@earendil-works/*@0.80.8` namespace. Per master D8, after all semantic gates, mark the four vendored/private Pi packages `0.80.8-magenta.0`, exact-pin internal deps, bump private HCP to `0.0.2`, and record the upstream tag/full SHA; do not npm-publish these fork tarballs. Magenta product version remains independent.
- **Tests:** run Magenta version/release script tests, five-package local exact dependency closure, publish-script fail-closed test and shrinkwrap check after functional ports.

### TR-018 - Isolate Radius/gateway/experimental environment during tests

- **Upstream evidence:** [`961fa6c1`](https://github.com/earendil-works/pi/commit/961fa6c14228d3c652869256fa2349d1f08e6306), `feat(ai): add Radius gateway support`, updates `test.sh` to unset `RADIUS_API_KEY`, `PI_GATEWAY`, and `PI_EXPERIMENTAL`. Later model-runtime merge commits preserve the root change.
- **Magenta current mapping:** Magenta has no Radius or `PI_GATEWAY`, but it **does** implement `PI_EXPERIMENTAL` and has environment-sensitive setup/experimental tests. Current `test.sh` does not unset it.
- **Classification:** partial `PORT` for `PI_EXPERIMENTAL`; `N/A` for Radius/gateway variables unless corresponding provider work is selected.
- **Migration action:** add `unset PI_EXPERIMENTAL` to Magenta's isolated test harness. If AI provider changes add gateway/Radius variables, extend the central env-key inventory and test isolation at the same time.
- **Dependencies/tests:** run `PI_EXPERIMENTAL=1 ./test.sh` and prove baseline test behavior remains identical to an unset shell; preserve focused tests that explicitly set/restore the variable internally.

### TR-019 - Contributor approval metadata

- **Upstream evidence:** 16 `chore: approve contributor ...` commits update `.github/APPROVED_CONTRIBUTORS` only (listed in appendix).
- **Magenta current mapping:** no equivalent file/gate; identities are Earendil repository policy.
- **Classification:** `N/A`.
- **Migration action/tests:** none.

---

## Verification performed

- `git diff`, path-filtered `git log`, per-commit `git show`, final-tree source reads, and current-tree symbol searches were used for every classification.
- Current Magenta `npm run check:shrinkwrap`: **passed** (`npm-shrinkwrap.json is up to date`).
- Upstream isolated `packages/tui/test/keys.test.ts`: **59/59 passed**, including new legacy Alt-symbol cases.
- Full U8 TUI test command could not be validated from the fixed snapshot because that snapshot has no installed dependencies; failures were `ERR_MODULE_NOT_FOUND` for packages such as `get-east-asian-width` and `chalk`, not assertion failures. This is an environment limitation, not evidence that the upstream tests regress.
- Current Magenta targeted TUI baseline (`editor`, `keys`, `markdown`, `tab-width`): **316/316 passed**.
- No repository files were modified by this analysis.

---

## Commit coverage appendix

Every path-relevant commit from the 99-commit scoped log is mapped below. Merge commits are retained even where their first-parent path diff is empty; mechanical/meta commits are not omitted.

| # | Commit | Subject | Mapped item |
|---:|---|---|---|
| 1 | `7ece19b0` | chore: package structure | TR-006 |
| 2 | `d799c722` | feat: ipc socket | TR-006 |
| 3 | `60fb6dc6` | chore: add auth path getter too | TR-006 |
| 4 | `92e28e9c` | feat: ipc server | TR-006 |
| 5 | `5f60fc01` | feat: machine and instance storage | TR-006 |
| 6 | `83e8c3d3` | feat: handler | TR-006 |
| 7 | `946b9c7d` | feat: serve and command | TR-006 |
| 8 | `2a2dc0e9` | feat: commands | TR-006 |
| 9 | `0cbdc283` | fix: lifecycle | TR-006 |
| 10 | `0d02df76` | feat: supervisor | TR-006 |
| 11 | `8bc92fc9` | feat: rpc bridge | TR-006 |
| 12 | `52b7f774` | feat: support rpc commands | TR-006 |
| 13 | `9bfafc8c` | feat: radius connection | TR-006 |
| 14 | `a6d88ddc` | fix: use Radius Pi id for persistence | TR-006 |
| 15 | `f1d9f762` | fix: heartbeat 3 404s re-register | TR-006 |
| 16 | `5cb52842` | fix: bridge missing rpc commands | TR-006 |
| 17 | `4806b8f9` | fix: use radius creds instead of api key | TR-006 |
| 18 | `c4e89b03` | feat: ui attach rpc support | TR-006 |
| 19 | `337de9b0` | fix: RPC parity, UX polish, logging | TR-006 |
| 20 | `1d5fd235` | fix: theme in ui attach | TR-006 |
| 21 | `ac92f92b` | fix: not found errors | TR-006 |
| 22 | `a7b0138e` | fix: raw rpc | TR-006 |
| 23 | `d79e3061` | cleanup: one shot vs stream | TR-006 |
| 24 | `555ab2e5` | cleanup: small optimizations | TR-006 |
| 25 | `13a18600` | fix: rpc stream | TR-006 |
| 26 | `d9910555` | fix: no dynamic imports | TR-006 |
| 27 | `cc12750e` | fix: serialize rpc requests, no eager rewrites | TR-006 |
| 28 | `8277bd68` | Add [Unreleased] section for next cycle | TR-017 |
| 29 | `954ec998` | fix: upload release assets from visible directory | TR-007 |
| 30 | `97820276` | fix: remove OpenClaw gate | TR-008 |
| 31 | `ec6311be` | fix: skip dirty check before npm publish | TR-007 |
| 32 | `77f1fa62` | docs: experimental | TR-006 |
| 33 | `0563baa5` | feat: add experimental orchestrator package metadata | TR-006 |
| 34 | `be64062f` | Merge branch main into feat/pi-orchestrator | TR-006 |
| 35 | `7e6e59b6` | fix: stale version | TR-006, TR-017 |
| 36 | `6ca7ba7c` | chore: approve contributor geraschenko | TR-019 |
| 37 | `49956a7c` | docs(agent): close completed issues in wrap prompt | TR-011 |
| 38 | `1d486163` | Fix examples, update to latest undici for vuln fix | TR-016 |
| 39 | `122527b2` | fix: rpc-entry and bun support | TR-006 |
| 40 | `7f930076` | fix: orch (dynamic) version | TR-006 |
| 41 | `9505389b` | fix: git url | TR-006 |
| 42 | `2f853bbc` | fix: class RpcProcessInstance as state machine | TR-006 |
| 43 | `988990f1` | fix: lockfile drift | TR-006, TR-017 |
| 44 | `0760bbae` | fix: lockfile drift | TR-006, TR-017 |
| 45 | `87ad8243` | feat(experimental): pi orchestrator | TR-006 |
| 46 | `622eca76` | feat(coding-agent): add installer lock generation | TR-009 |
| 47 | `f2e9d753` | fix(coding-agent): preserve backslash escapes | TR-001 |
| 48 | `8f64353e` | fix: restrict bot gate bypasses | TR-010 |
| 49 | `541d11f7` | chore: approve contributor skhoroshavin | TR-019 |
| 50 | `a23abe4a` | Release v0.80.3 | TR-017 |
| 51 | `dd87c02c` | Add [Unreleased] section for next cycle | TR-017 |
| 52 | `45c0fe78` | chore: approve contributor cyzlmh | TR-019 |
| 53 | `9f91da21` | chore: approve contributor xz-dev | TR-019 |
| 54 | `c9715af3` | chore: approve contributor rajp152k | TR-019 |
| 55 | `47830134` | test: use quiet dot reporters | TR-005 |
| 56 | `abe9c9d9` | feat(coding-agent): add CI issue analysis import flow | TR-011 |
| 57 | `d1e72d05` | fix(coding-agent): use PAT directly for issue analysis auth | TR-011 |
| 58 | `3df11fd8` | fix(coding-agent): share issue analysis sessions as gists | TR-011 |
| 59 | `010e519c` | fix(coding-agent): use gist token for issue analysis share | TR-011 |
| 60 | `4728706e` | feat(coding-agent): trigger issue analysis from comments | TR-011 |
| 61 | `190b6459` | fix(coding-agent): use issuron issue analysis trigger | TR-011 |
| 62 | `7a92545b` | feat(coding-agent): include analysis summary in issue comment | TR-011 |
| 63 | `fda6451a` | fix(coding-agent): use high reasoning for issue analysis | TR-011 |
| 64 | `647c5554` | feat(coding-agent): add runner tags for issue analysis | TR-011 |
| 65 | `4087346d` | fix(coding-agent): persist issue analysis auth refresh | TR-011 |
| 66 | `cfaa52e1` | chore: approve contributor affanali2k3 | TR-019 |
| 67 | `8a2ce5a5` | fix(tui): decrement paste counter on marker delete/clear | TR-002 |
| 68 | `d1da5836` | chore: approve contributor ArcadiaLin | TR-019 |
| 69 | `4ea062f9` | chore: approve contributor anilgulecha | TR-019 |
| 70 | `62f45bad` | Fix native clipboard in bun release | TR-012 |
| 71 | `5cb50679` | chore: approve contributor DeviosLang | TR-019 |
| 72 | `050b8176` | chore: approve contributor HarrodRen | TR-019 |
| 73 | `bf75b8aa` | docs: audit unreleased changelogs | TR-017 |
| 74 | `912d0953` | Release v0.80.4 | TR-017 |
| 75 | `ef793a98` | Add [Unreleased] section for next cycle | TR-017 |
| 76 | `cc62baa4` | Release v0.80.5 | TR-017 |
| 77 | `e3513193` | Add [Unreleased] section for next cycle | TR-017 |
| 78 | `8432c6f2` | chore: approve contributor aaronkyriesenbach | TR-019 |
| 79 | `53213442` | fix: gate releases on full tests | TR-013 |
| 80 | `2b3fda99` | Release v0.80.6 | TR-017 |
| 81 | `34582ef3` | Add [Unreleased] section for next cycle | TR-017 |
| 82 | `81de5702` | chore: approve contributor farid-fari | TR-019 |
| 83 | `91585d9a` | bump bun to 1.3.14 | TR-014 |
| 84 | `5416b183` | chore: approve contributor petrroll | TR-019 |
| 85 | `8479bd84` | fix(tui): parse legacy alt-prefixed symbols | TR-003 |
| 86 | `16a3d420` | chore: approve contributor vibeinging | TR-019 |
| 87 | `961fa6c1` | feat(ai): add Radius gateway support | TR-018 |
| 88 | `9993c969` | feat(coding-agent): replace model registry with model runtime | TR-006 (Radius import compatibility), TR-015 prerequisite |
| 89 | `53a087fe` | docs: audit unreleased changelogs | TR-017 |
| 90 | `818d6745` | Release v0.80.7 | TR-017 |
| 91 | `9d09075c` | Add [Unreleased] section for next cycle | TR-017 |
| 92 | `cd7cad4e` | feat(coding-agent): merge origin/main into model runtime facade | TR-015 prerequisite, TR-018 |
| 93 | `5e336cfa` | Merge origin/main into model runtime changes | TR-015 prerequisite, TR-018 |
| 94 | `1c799cec` | fix(tui): normalize tabs for terminal output | TR-004 |
| 95 | `5d9fedf7` | chore: approve contributor DivineDominion | TR-019 |
| 96 | `36db3fa3` | chore: approve contributor ananthakumaran | TR-019 |
| 97 | `2be9efa1` | feat(ai): publish generated model catalogs to R2 | TR-015 |
| 98 | `eb793510` | docs: audit unreleased changelogs | TR-017 |
| 99 | `fae7176c` | Release v0.80.8 | TR-017 |

## Final decision summary

- `PORT`: TR-001, TR-003, TR-004, TR-012, TR-013, and the `PI_EXPERIMENTAL` portion of TR-018.
- `ADAPT`: TR-002.
- `ALREADY`: TR-007, TR-014, TR-016, and the effective npm hardening portion of TR-009.
- `SUPERSEDED`: all applicable local lifecycle/RPC/presence/workflow portions of TR-006.
- `CONDITIONAL`: TR-015.
- `N/A`: TR-005, TR-008, upstream installer-lock distribution in TR-009, TR-010, TR-011, standalone daemon/Radius portions of TR-006, mechanical TR-017, and TR-019.

No capability from upstream `packages/orchestrator` remains necessary to absorb into current Magenta. The actionable set is seven migration units: five direct ports, one partial env-isolation port, and one paste-registry adaptation; model catalog publication is a separate conditional decision.
