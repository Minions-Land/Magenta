import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repo = process.env.PI_UPSTREAM_REPO ?? "/tmp/magenta-pi-upstream-v0.80.8-20260717";
const reportFiles = [
  ["ai", join(reportRoot, "ai.md")],
  ["agent", join(reportRoot, "agent.md")],
  ["coding-core", join(reportRoot, "coding-core.md")],
  ["coding-ui", join(reportRoot, "coding-ui.md")],
  ["tui-repo", join(reportRoot, "tui-repo.md")],
  ["hcp", join(reportRoot, "hcp-conflicts.md")],
];
const versions = [3, 4, 5, 6, 7, 8];
const releaseBySha = new Map();
for (const version of versions) {
  const shas = execFileSync("git", ["-C", repo, "rev-list", "--reverse", `v0.80.${version - 1}..v0.80.${version}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const sha of shas) releaseBySha.set(sha, `v0.80.${version}`);
}
const fullShas = [...releaseBySha.keys()];
const resolveSha = (short) => {
  const matches = fullShas.filter((sha) => sha.startsWith(short));
  return matches.length === 1 ? matches[0] : undefined;
};
const semanticBySha = new Map();
const directSemanticBySha = new Map();
const dependencySemanticBySha = new Map();
const evidenceBySha = new Map();
const labelsBySha = new Map();
const add = (map, sha, value) => {
  if (!map.has(sha)) map.set(sha, new Set());
  map.get(sha).add(value);
};
for (const [domain, path] of reportFiles) {
  let currentId;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trimStart();
    if (/^##\s+(?!#)/.test(trimmed)) currentId = undefined;
    const sectionMatch = /^(?:###\s+|\*\*)?((?:AI|AG|CC|CU|TR|HC)-\d{3})\b/.exec(trimmed);
    if (sectionMatch) currentId = sectionMatch[1];
    const shortShas = [...new Set([...line.matchAll(/\b([0-9a-f]{8,40})\b/g)].map((match) => match[1]))];
    if (shortShas.length === 0) continue;
    const ids = [...new Set([
      ...line.matchAll(/\b(?:AI|AG|CC|CU|TR|HC)-\d{3}\b/g),
    ].map((match) => match[0]))];
    if (currentId) ids.push(currentId);
    const uniqueIds = [...new Set(ids)];
    const labels = [];
    for (const token of ["N/A", "NO-OP", "mechanical", "release", "test-only", "docs", "merge", "revert", "SUPERSEDED", "PRESENT", "PARTIAL", "MISSING", "CONFLICT", "PORT", "ADOPTED", "ALREADY", "CONDITIONAL"]) {
      if (line.toLowerCase().includes(token.toLowerCase())) labels.push(token);
    }
    for (const short of shortShas) {
      const sha = resolveSha(short);
      if (!sha) continue;
      add(evidenceBySha, sha, domain);
      for (const id of uniqueIds) {
        add(semanticBySha, sha, id);
        if (!currentId || id === currentId) add(directSemanticBySha, sha, id);
        else add(dependencySemanticBySha, sha, id);
      }
      for (const label of labels) add(labelsBySha, sha, label);
    }
  }
}

const manualSemantic = {
  "ec857fece5de": "MX-001",
  "4a9c962b5940": "MX-002",
  "86afffe01f6f": "MX-003",
  "12545274ea1c": "MX-004",
  "c6d8371521fc": "MX-004",
  "3e551faf7913": "CU-020",
};
for (const [short, id] of Object.entries(manualSemantic)) {
  const sha = resolveSha(short);
  if (!sha) throw new Error(`Manual SHA not resolved: ${short}`);
  add(semanticBySha, sha, id);
  add(directSemanticBySha, sha, id);
  add(evidenceBySha, sha, "parent-review");
}
for (const [id, shorts] of Object.entries({
  "CU-026": ["cbcf4e04", "85b7c247", "a1b336d7"],
  "HC-009": ["9993c969", "3d8f7435", "dd1c690f", "87ad8243", "fae7176c"],
})) {
  for (const short of shorts) {
    const sha = resolveSha(short);
    if (!sha) throw new Error(`Manual SHA not resolved: ${short}`);
    add(semanticBySha, sha, id);
    add(directSemanticBySha, sha, id);
    add(evidenceBySha, sha, "parent-review");
  }
}
for (const short of ["927e98068cda"]) {
  const sha = resolveSha(short);
  if (!sha) throw new Error(`Manual SHA not resolved: ${short}`);
  add(labelsBySha, sha, "test-only");
  add(evidenceBySha, sha, "parent-review");
}

const raw = execFileSync("git", ["-C", repo, "log", "--reverse", "--date=iso-strict", "--format=@@COMMIT%x09%H%x09%ad%x09%s", "--name-status", "v0.80.2..v0.80.8"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
const commits = [];
let current;
for (const line of raw.split("\n")) {
  if (line.startsWith("@@COMMIT\t")) {
    const [, sha, date, subject] = line.split("\t");
    current = { sha, version: releaseBySha.get(sha) ?? "UNMAPPED_VERSION", date, subject, changes: [] };
    commits.push(current);
  } else if (current && line.trim()) {
    const fields = line.split("\t");
    const status = fields[0];
    const paths = (status.startsWith("R") || status.startsWith("C")) ? fields.slice(1, 3) : fields.slice(1, 2);
    current.changes.push({ status, paths });
  }
}
const workspaceFor = (path) => path.match(/^packages\/([^/]+)\//)?.[1] ?? (path.startsWith(".github/") ? ".github" : path.split("/")[0] || "root");
const rows = commits.map((commit) => {
  const semanticIds = [...(semanticBySha.get(commit.sha) ?? [])].sort();
  const directSemanticIds = [...(directSemanticBySha.get(commit.sha) ?? [])].sort();
  const dependencySemanticIds = [...(dependencySemanticBySha.get(commit.sha) ?? [])]
    .filter((id) => !directSemanticIds.includes(id))
    .sort();
  const evidence = [...(evidenceBySha.get(commit.sha) ?? [])].sort();
  const labels = [...(labelsBySha.get(commit.sha) ?? [])].sort();
  const mechanical = /^(Release v|Add \[Unreleased\]|chore: approve contributor|docs: audit unreleased changelog)/i.test(commit.subject);
  const pathEndpoints = commit.changes.flatMap((change) => change.paths);
  const packageChangeCount = commit.changes.filter((change) => change.paths.at(-1)?.startsWith("packages/")).length;
  return {
    sha: commit.sha,
    version: commit.version,
    date: commit.date,
    subject: commit.subject,
    changeCount: commit.changes.length,
    packageChangeCount,
    pathEndpointCount: pathEndpoints.length,
    workspaces: [...new Set(pathEndpoints.map(workspaceFor))].sort().join(";"),
    semanticIds: semanticIds.join(";"),
    directSemanticIds: directSemanticIds.join(";"),
    dependencySemanticIds: dependencySemanticIds.join(";"),
    evidenceReports: evidence.join(";"),
    evidenceLabels: labels.join(";"),
    coverage: semanticIds.length > 0 ? "EVIDENCE_LINKED" : mechanical || labels.some((v) => ["N/A", "NO-OP", "mechanical", "release", "test-only", "docs", "merge", "revert"].includes(v)) ? "MECHANICAL_OR_NA" : "REVIEW_REQUIRED",
    paths: pathEndpoints.join(";"),
    changes: commit.changes.map((change) => `${change.status}:${change.paths.join("=>")}`).join(";"),
  };
});
const columns = Object.keys(rows[0]);
const quote = (value) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
writeFileSync(join(reportRoot, "commit-ledger.csv"), [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n");
const coverage = {};
for (const row of rows) coverage[row.coverage] = (coverage[row.coverage] ?? 0) + 1;
console.log(JSON.stringify({ total: rows.length, coverage, reviewRequired: rows.filter((row) => row.coverage === "REVIEW_REQUIRED").map((row) => ({ sha: row.sha.slice(0, 12), version: row.version, subject: row.subject, workspaces: row.workspaces })) }, null, 2));
