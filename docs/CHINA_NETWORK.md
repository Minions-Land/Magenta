# China Network Guide

Direct access to `github.com`, `api.github.com`, and `raw.githubusercontent.com`
is slow or unreliable from many networks in mainland China. Magenta downloads
release binaries, runtime resources, harness packages, and helper tools from
GitHub, so those operations can stall without a mirror.

This guide covers one optional accelerator: **payload mirror routing** for large
release assets. The maintained installers use bounded `curl` downloads and do
not depend on an extra downloader. Integrity-bearing release metadata stays on
the direct `api.github.com` TLS connection so a payload mirror cannot replace
both an artifact and the checksum used to verify it.

## Quick Diagnosis

If `magenta --update` fails with "Could not fetch latest release", first check whether the GitHub API is reachable:

```bash
curl -I https://api.github.com/repos/Minions-Land/Magenta-CLI/releases/latest
```

Interpret the result:

- **Connection timeout or refused**: release metadata is unreachable. A payload mirror does not proxy this integrity-bearing API request; configure a network path or HTTPS proxy that can reach `api.github.com`.
- **HTTP 403** with `x-ratelimit-remaining: 0`: The unauthenticated API rate limit (60/hour) is exhausted. Wait for the reset time in the error, or set `MAGENTA_GITHUB_TOKEN`.
- **HTTP 200**: The API is reachable, so the failure is elsewhere. If the running binary predates the split-asset release format (binary + resources archive + checksums), it cannot auto-update and must be reinstalled with the installation script from [User Install](./USER_INSTALL.md).

## 1. Mirror Routing

Set the `MAGENTA_GITHUB_MIRROR` environment variable to a GitHub payload
proxy prefix. Eligible release asset URLs are rewritten through it:

```
MAGENTA_GITHUB_MIRROR=https://ghfast.top
  https://github.com/owner/repo/releases/download/v1/asset
    -> https://ghfast.top/https://github.com/owner/repo/releases/download/v1/asset
```

Release metadata remains direct: `api.github.com` supplies trusted asset digests
and must be reachable before a mirrored payload can be accepted.

Add it to your shell profile so it applies to every session:

```bash
# ~/.bashrc or ~/.zshrc
export MAGENTA_GITHUB_MIRROR=https://ghfast.top
```

For standalone installation and `magenta --update`, the mirror accelerates the
large executable and resources archive after the direct release metadata check.
Other package and helper-tool acquisition paths also honor the setting where
supported, but may have their own metadata requirements.

### Choosing a mirror

Public GitHub proxies come and go, and their throughput varies a lot by time of
day. If one is slow or returns errors, switch to another. Known options at the
time of writing:

| Mirror | Prefix |
| --- | --- |
| ghfast.top | `https://ghfast.top` |
| gh-proxy.com | `https://gh-proxy.com` |
| ghproxy.net | `https://ghproxy.net` |
| gh.llkk.cc | `https://gh.llkk.cc` |

These are third-party services. Standalone release payloads are authenticated
with direct GitHub API digests and/or an official checksum manifest kept outside
the payload mirror. A checksum manifest may travel through a mirror only when
its own API digest authenticates it; otherwise it is fetched directly from
GitHub.

## Manual Download

For a manual download, choose one exact release tag from the Releases page. Do
not substitute an unversioned redirect: the tag is part of the integrity
contract. A mirror may serve the two large payloads, while the manifest remains
direct:

```bash
tag="<exact-release-tag>"
mirror=https://ghfast.top
release="https://github.com/Minions-Land/Magenta-CLI/releases/download/$tag"
base="$mirror/$release"

curl -fL --retry 3 "$base/magenta-linux-x64" -o magenta-linux-x64
curl -fL --retry 3 "$base/magenta-resources-universal.tar.gz" -o magenta-resources-universal.tar.gz
# The manifest is the trust root, so fetch it directly from the exact tag.
curl -fL --retry 3 "$release/SHA256SUMS" -o SHA256SUMS

# SHA256SUMS covers every release payload. Select only the two files downloaded
# above, then require both entries to be present and correct.
awk '$2 == "magenta-linux-x64" || $2 == "magenta-resources-universal.tar.gz"' SHA256SUMS > SHA256SUMS.selected
test "$(wc -l < SHA256SUMS.selected | tr -d " ")" = 2
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS.selected
else
  shasum -a 256 -c SHA256SUMS.selected
fi
```

## Verifying Integrity

Whichever mirror you use, always confirm the payloads against a trust root
obtained outside that mirror. The public bootstrap resolves one exact tag and
verifies the installer against its GitHub API digest. The full installer then
fetches `SHA256SUMS` directly from that tag and verifies the executable and
resources against the selected manifest entries; the built-in updater also
checks GitHub asset digests. For manual downloads, fetch the manifest directly
as shown above and verify a tag-specific subset:

```bash
sha256sum magenta-linux-x64 magenta-resources-universal.tar.gz
# compare against the matching lines in SHA256SUMS
```

A mismatch means the download is corrupt or tampered. Delete it and retry,
switching mirrors if the failure repeats.

## Troubleshooting

- **A mirror stalls or returns 404/5xx**: switch `MAGENTA_GITHUB_MIRROR` to
  another prefix from the table above.
- **The exact tag cannot be resolved**: restore direct access to
  `api.github.com`; a payload mirror cannot replace the metadata trust root.
- **`magenta --update` still slow**: confirm the variable is exported in the
  current shell with `echo $MAGENTA_GITHUB_MIRROR`. It must be set in the same
  environment that launches `magenta`.
- **Corporate proxy only**: point `MAGENTA_GITHUB_MIRROR` at your internal GitHub
  mirror, or host the release assets on internal object storage and set the
  prefix to that base URL.
