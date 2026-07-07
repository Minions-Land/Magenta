# Reference — Hugging Face Fetch (models & datasets)

How to download a Hugging Face model or dataset when the canonical host (`huggingface.co`) is slow, blocked, or TCP-reset — the common case behind a restrictive network.

> Magenta's `WebFetch`/network layer auto-probes local proxies and VPN ports, so a running proxy is used automatically. But the `huggingface-cli`, `git-lfs`, `requests`, and `httpx` paths do **not** always inherit that — they frequently need an explicit **mirror endpoint** and LFS handling. This doc is that recipe.

## The mirror-first strategy

The most reliable path on a restrictive network is a **mirror endpoint** plus `curl`/`git`. The canonical mirror is `hf-mirror.com`; set it via `HF_ENDPOINT` so the official tools route through it.

```bash
export HF_ENDPOINT=https://hf-mirror.com
```

If your environment has a different working mirror, substitute it. If direct `huggingface.co` works (proxy/VPN up), you can skip the mirror — probe first.

### 0. Probe what works

```bash
# Does the canonical host respond? (proxy/VPN may make it work directly)
curl -sS --max-time 10 -o /dev/null -w "hf.co: %{http_code} %{time_total}s\n" https://huggingface.co/ || true
# Does the mirror respond?
curl -sS --max-time 10 -o /dev/null -w "mirror: %{http_code} %{time_total}s\n" https://hf-mirror.com/ || true
```

Use whichever returns quickly. The rest of this doc assumes the mirror; drop `hf-mirror.com` → `huggingface.co` if the canonical host works.

### 1. Resolve canonical slug & metadata

```bash
# Bare slug may 307-redirect to canonical <owner>/<repo>:
curl -sS --max-time 10 -I "https://hf-mirror.com/api/datasets/<slug>" | grep -i location

# Metadata:
curl -sS --max-time 15 "https://hf-mirror.com/api/datasets/<owner>/<repo>" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ['id','sha','lastModified','license','downloads']})"
```

A bare slug on the API can return 401 — that's the redirect behavior, not an auth failure. Resolve to canonical `<owner>/<repo>` first.

### 2. Single file

```bash
curl -sSL --max-time 60 -o <local-name> \
  "https://hf-mirror.com/datasets/<owner>/<repo>/resolve/main/<path>"
```

- Drop `/datasets` for **models**: `https://hf-mirror.com/<owner>/<repo>/resolve/main/<path>`
- Use `/raw/main/` instead of `/resolve/main/` for raw text without LFS resolution.

### 3. List then bulk-fetch

```bash
curl -sSL --max-time 30 \
  "https://hf-mirror.com/api/datasets/<owner>/<repo>/tree/main?recursive=true" \
  | python3 -c "import json,sys;[print(f\"{f['type']}\t{f['path']}\t{f.get('size','')}\") for f in json.load(sys.stdin)]"
```

Generate a `fetch.sh` from the listing and loop one `curl` per blob. Don't pack multiple curls into a single inline shell `for` — prone to mangling.

### 4. Official CLI through the mirror

```bash
export HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download <owner>/<repo> --local-dir ./weights/
# dataset:
huggingface-cli download <owner>/<repo> --repo-type dataset --local-dir ./data/
```

With `HF_ENDPOINT` set, the CLI routes through the mirror. If the CLI still fails the TLS handshake on a restrictive host, fall back to the `curl`/`git` paths above/below.

### 5. Whole repo via git + LFS

```bash
export GIT_LFS_SKIP_SMUDGE=1        # skip LFS on initial clone
git clone --depth=1 https://hf-mirror.com/datasets/<owner>/<repo> ./<local-dir>
cd <local-dir>
# Rewrite LFS endpoint to the mirror, then pull only what you need:
git config -f .lfsconfig lfs.url "https://hf-mirror.com/datasets/<owner>/<repo>.git/info/lfs"
git lfs fetch --include "<narrow-glob>"   # e.g. "*.safetensors"
git lfs checkout
```

Some datasets are Xet-only and the LFS bridge DNS may not resolve. In that case use the auto-generated parquet snapshot:

```
https://hf-mirror.com/datasets/<owner>/<repo>/resolve/refs%2Fconvert%2Fparquet/...
```

### 6. Gated / token-required (ImageNet, Llama, GAIA, etc.)

```bash
export HF_TOKEN="hf_..."     # prefix with a space to keep it out of shell history
curl -sSL --max-time 60 -H "Authorization: Bearer $HF_TOKEN" \
  -o <local-name> \
  "https://hf-mirror.com/datasets/<owner>/<repo>/resolve/main/<path>"
```

Terms must already be accepted on the user's Hugging Face account. A mirror proxies the auth header but cannot accept terms on the user's behalf.

## Pitfalls

- Don't assume `huggingface-cli` works out of the box on a restrictive host — set `HF_ENDPOINT` to a mirror or fall back to `curl`.
- Always resolve to canonical `<owner>/<repo>` before hitting the API; a bare slug can 401.
- Always set `GIT_LFS_SKIP_SMUDGE=1` for the initial clone, then narrow the LFS include glob — don't pull multi-GB blobs blindly.
- A single dataset can be 100+ GB. Read the file listing and sizes first; fetch only what the task needs.
- Keep tokens out of logs and shell history; never echo `HF_TOKEN`.

## Self-update

Network conditions and working mirrors drift. If a step here stops working, diagnose (probe both hosts, check proxy), find the next working endpoint, and patch this doc with the new command and a date stamp so the next run lands on it directly.
