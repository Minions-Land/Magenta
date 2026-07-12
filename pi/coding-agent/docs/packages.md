> Magenta can help bundle extensions, skills, prompt templates, and themes into an extension package.

# Extension Packages

Extension packages bundle extensions, skills, prompt templates, and themes for npm, git, HTTPS, SSH, or local-path distribution. The `pi` manifest key and `pi-package` keyword remain compatibility APIs.

These are not Harness domain packages. Harness packages are selected with
`--harness-package` or `/harness package`, then loaded from a local Package root
or a verified GitHub Release cached under `~/.magenta/harness-packages`; they do
not use the extension-package manager described here.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating an Extension Package](#creating-an-extension-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Extension packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform actions including running executables. Review source code before installing third-party packages.

```bash
magenta install npm:@foo/bar@1.0.0
magenta install git:github.com/user/repo@v1
magenta install https://github.com/user/repo  # raw URLs work too
magenta install /absolute/path/to/package
magenta install ./relative/path/to/package

magenta remove npm:@foo/bar
magenta list                     # show installed extension packages
magenta update                   # update Magenta only
magenta update --all             # update Magenta and extension packages
magenta update --extensions      # update extension packages only
magenta update --self            # update Magenta only
magenta update --self --force    # reinstall Magenta even if current
magenta update npm:@foo/bar      # update one extension package
magenta update --extension npm:@foo/bar
```

These commands manage extension packages, and `magenta update` can update the Magenta CLI installation. To uninstall Magenta itself, see [Quickstart](quickstart.md#install).

By default, `install` and `remove` write to user settings (`~/.magenta/agent/settings.json`). Use `-l` to write to project settings (`.magenta/settings.json`) instead. Project settings can be shared with your team, and Magenta installs missing extension packages on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
magenta -e npm:@foo/bar
magenta -e git:github.com/user/repo
```

## Package Sources

Magenta accepts three extension-package source types in settings and `magenta install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`magenta update --extensions`, `magenta update --all`).
- User installs go under `~/.magenta/agent/npm/`.
- Project installs go under `.magenta/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `magenta update --extensions` and `magenta update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `magenta install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.magenta/agent/git/<host>/<path>` (global) or `.magenta/git/<host>/<path>` (project).
- When reconciliation changes the checkout, Magenta resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
magenta install git:git@github.com:user/repo

# ssh:// protocol format
magenta install ssh://git@github.com/user/repo

# With version ref
magenta install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Magenta loads resources using extension-package rules.

## Creating an Extension Package

Add a `pi` manifest to `package.json` or use conventional directories. Include the `pi-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Gallery Metadata

The upstream [extension-package gallery](https://pi.dev/packages) displays packages tagged with `pi-package`. Add `video` or `image` fields to show a preview:

```json
{
  "name": "my-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 only. On desktop, autoplays on hover. Clicking opens a fullscreen player.
- **image**: PNG, JPEG, GIF, or WebP. Displayed as a static preview.

If both are set, video takes precedence.

## Package Structure

### Convention Directories

If no `pi` manifest is present, Magenta auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When Magenta installs an extension package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Magenta provides core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`.

Other extension packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Magenta loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shared-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shared-extensions"],
  "pi": {
    "extensions": ["extensions", "node_modules/shared-extensions/extensions"],
    "skills": ["skills", "node_modules/shared-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `magenta config` to enable or disable extensions, skills, prompt templates, and themes from installed extension packages and local directories. It works for both global (`~/.magenta/agent`) and project (`.magenta/`) scopes.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins. Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
