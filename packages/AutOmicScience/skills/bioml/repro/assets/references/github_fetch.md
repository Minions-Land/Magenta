# Reference — GitHub Fetch (read-only)

How to read, summarize, port, or copy material from a GitHub repo — a single file, a sub-tree, a whole repo — from an environment where direct `github.com` HTTPS may be throttled.

> Magenta's `WebFetch` tool already auto-probes local proxies/VPN, so for reading a page it usually "just works". This doc is for the `bash`+`gh`/`git`/`curl` path you need when pulling code and weights for reproduction.

## Decision: pick scope

| Scope | Command family |
|-------|----------------|
| Single file | `gh api` + `base64 -d`, or `raw.githubusercontent.com` |
| Sub-tree / folder | recursive tree call → bulk fetch loop |
| Whole repo (need grep/build/run) | `gh repo clone --depth=1` |
| Metadata only | one `gh api repos/<o>/<r>` call |

## Procedure

### 1. Confirm reachability

```bash
gh auth status 2>&1 | head -5          # is gh installed + authenticated?
gh api repos/<owner>/<repo> --jq '{name, default_branch, license: .license.spdx_id}'
```

`api.github.com` is typically reachable even when `github.com` HTTPS is throttled. `gh api` is the fast path.

### 2. Single file

```bash
gh api "repos/<owner>/<repo>/contents/<path>" --jq '.content' | base64 -d > <local-name>
```

The `.content` field is **always base64** — don't forget `base64 -d`.

### 3. Sub-tree listing → bulk fetch

```bash
gh api "repos/<owner>/<repo>/git/trees/<branch>?recursive=1" \
  --jq '.tree[] | select(.path | startswith("<subdir>")) | "\(.type)\t\(.path)"'
```

Build a `fetch.sh` with an array of paths and loop one fetch per file. **Do not** inline a long multi-line `gh api ... | base64 -d` `for` chain directly — some shells mangle it. Write the script to a file and run it.

### 4. Whole repo (only when you need to grep/build/run)

```bash
# Preferred (gh handles auth, rewrites to SSH if configured):
gh repo clone <owner>/<repo> ./<repo-slug> -- --depth=1

# Plain git fallback:
git clone --depth=1 https://github.com/<owner>/<repo>.git ./<repo-slug>
```

Always `--depth=1` unless you specifically need history. SSH (`git@github.com`) is often more reliable than HTTPS when HTTPS is throttled.

### 5. No-`gh` fallback

```bash
curl -sSL --max-time 30 \
  "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<path>" \
  -o <local-name>
```

### 6. Watch the rate limit

```bash
gh api rate_limit --jq '.resources.core'
```

Authenticated budget is 5000/h. For 100+ files, prefer `gh repo clone` over per-file `gh api`.

## Fallback ladder (when a step fails)

1. **Diagnose first**: `gh auth status`, `gh api rate_limit`, `curl -v --max-time 10 https://api.github.com/zen`, `curl -v --max-time 10 https://github.com/`. Identify what broke — auth, throttle, scope, or DNS.
2. **Walk the ladder**: `gh api` → `gh repo clone` (SSH) → `raw.githubusercontent.com` → `git clone` over HTTPS. Magenta's proxy auto-probe helps `curl`/`WebFetch`; if a proxy/VPN is running locally it is picked up automatically.
3. **Capture what worked**: note the exact command that returned bytes so the next run lands on it directly.

## Output — always report

- Repo + branch + short commit SHA
- Where the bytes landed (local path)
- The **license** (SPDX id) — flag explicitly if the next step is to copy/reuse the code. CC BY-NC, GPL, and missing LICENSE all change what you can do downstream.

## Pitfalls

- `WebFetch` on `github.com` can be throttled — for bulk code prefer `gh api` / `raw.githubusercontent.com`.
- Don't paste long multi-line `gh api | base64 -d` loops directly into the shell — write `fetch.sh`.
- Don't forget `base64 -d` on the `.content` field.
- Don't full-clone large repos without `--depth=1`.
- Don't skip the license check when content goes into a shared/published artifact.
