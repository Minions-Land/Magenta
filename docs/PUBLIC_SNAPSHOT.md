# Reviewed Public Snapshot

Do not make either private repository public in place and do not rewrite its
existing history as a publication mechanism. Historical objects can remain
reachable from tags, release metadata, pull-request refs, caches, artifacts, or
copies even after a force push. Credential revocation is a separate mandatory
owner action.

`npm run public:snapshot` exports only an allowlisted current root snapshot into
a new local repository. It does not clone the source repository, call GitHub,
create a remote, push, copy tags, import Releases, import pull-request refs, or
copy Actions artifacts. The default is a temporary dry-run audit.

## Required Owner Decisions

The checked-in [`public-snapshot-policy.example.json`](../scripts/public-snapshot-policy.example.json)
is intentionally unapproved and cannot pass. Repository owners must provide a
separate reviewed policy with all of these decisions:

- the exact clean source commit reviewed for publication;
- the allowlisted target repository owner and root-commit author;
- approved root `LICENSE` and `NOTICE` contents, each pinned by SHA-256;
- source include/exclude roots and every approved package root;
- every allowed binary asset, pinned by path, digest, and justification;
- every interoperability-name occurrence, pinned by file, line, line digest,
  term, and justification.

Keep the completed policy outside the private source worktree. This avoids
changing the reviewed commit merely by filling in its approval record.

## Audit

Run the non-mutating audit first:

```bash
npm run public:snapshot -- --policy /secure/reviewed-public-policy.json
```

The audit requires `gitleaks` and runs it in directory mode against a temporary
materialized snapshot, never against source history. A built-in redacted scan
also rejects credential patterns, private-key material, credential/backup paths,
unapproved packages, oversized files, and unapproved binary data.

Restricted product/package names are rejected by default. Provider names that
are genuine interoperability contracts are not globally replaced; each
occurrence needs an exact line-level approval whose digest becomes stale when
the line changes. This preserves real compatibility while preventing a broad
word exception from hiding unrelated content.

Any dirty source state, missing scanner, malformed policy, stale approval,
missing legal file, digest mismatch, scan finding, symlink, submodule, or source
race fails the audit. No partial output is retained.

## Create A Local Repository

After reviewing the dry-run report, create a new local repository at a path
outside the private checkout:

```bash
npm run public:snapshot -- \
  --policy /secure/reviewed-public-policy.json \
  --write \
  --output ../Magenta-public-reviewed
```

The output path must not exist. The exporter never overwrites or backs up a
destination. It writes `PUBLIC_SNAPSHOT_MANIFEST.json` and
`SHA256SUMS.public`, initializes a new `main` repository, and creates exactly
one parentless commit using the allowlisted author. It then verifies that the
repository has no remote, tag, extra branch, or copied ref.

The tool deliberately stops there. Creating a GitHub repository, selecting its
visibility, and pushing the reviewed root commit remain explicit owner actions
after credential revocation, licensing, package review, and manifest review are
complete.
