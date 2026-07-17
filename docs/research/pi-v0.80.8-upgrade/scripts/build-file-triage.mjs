import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../../..");
const upstreamGit = process.env.PI_UPSTREAM_REPO ?? "/tmp/magenta-pi-upstream-v0.80.8-20260717";
const magentaGit = process.env.MAGENTA_REPO ?? repoRoot;
const refs = {
  base: process.env.PI_U2_SHA ?? "0201806adfa825ab3d7957a4267d46e5030fd357",
  imported: process.env.MAGENTA_IMPORT_SHA ?? "f1da4c98bd3b8df522a0e80e2f6e6bfcdb064328",
  current: process.env.MAGENTA_CURRENT_SHA ?? "e7a6e770385e2c6ca16888f7ed5a97bd38bdb39e",
  target: process.env.PI_U8_SHA ?? "fae7176cb9f7c4725a40d9d481d8d70b80f18086",
};
const workspaces = new Set(["ai", "agent", "coding-agent", "tui", "orchestrator"]);

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const revParse = (repo, ref) => execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
assert(revParse(upstreamGit, "v0.80.2") === refs.base, "v0.80.2 does not match fixed U2 SHA");
assert(revParse(upstreamGit, "v0.80.8") === refs.target, "v0.80.8 does not match fixed U8 SHA");
assert(revParse(magentaGit, refs.imported) === refs.imported, "fixed import SHA is unavailable");
assert(revParse(magentaGit, refs.current) === refs.current, "fixed current SHA is unavailable");

function readBlob(repo, ref, path) {
  try {
    return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
function hashBlob(blob) {
  return blob === null ? null : createHash("sha256").update(blob).digest("hex");
}
function relation(hashValue, baseHash, targetHash) {
  if (hashValue === null) {
    if (targetHash === null) return "absent_as_target";
    return baseHash === null ? "missing_target_addition" : "deleted_or_absent";
  }
  if (hashValue === targetHash) return "exact_target";
  if (hashValue === baseHash) return "exact_base";
  return "diverged";
}
function resolveLogicalPath(repo, ref, targetPath, sourcePath) {
  if (readBlob(repo, ref, targetPath) !== null) return targetPath;
  if (sourcePath !== targetPath && readBlob(repo, ref, sourcePath) !== null) return sourcePath;
  return targetPath;
}

const diff = execFileSync(
  "git",
  ["-C", upstreamGit, "diff", "--name-status", "--find-renames", `${refs.base}..${refs.target}`, "--", ...[...workspaces].map((workspace) => `packages/${workspace}`)],
  { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
);
const records = [];
for (const line of diff.trim().split("\n")) {
  if (!line) continue;
  const fields = line.split("\t");
  const change = fields[0];
  const sourcePath = fields[1];
  const targetPath = change.startsWith("R") || change.startsWith("C") ? fields[2] : fields[1];
  const parts = targetPath.split("/");
  if (parts[0] !== "packages" || !workspaces.has(parts[1])) continue;
  const workspace = parts[1];
  const rel = parts.slice(2).join("/");
  const sourceRel = sourcePath.split("/").slice(2).join("/");
  const importTargetPath = `pi/${workspace}/${rel}`;
  const importSourcePath = `pi/${workspace}/${sourceRel}`;
  const importResolvedPath = resolveLogicalPath(magentaGit, refs.imported, importTargetPath, importSourcePath);
  const currentResolvedPath = resolveLogicalPath(magentaGit, refs.current, importTargetPath, importSourcePath);
  const blobs = {
    base: readBlob(upstreamGit, refs.base, sourcePath),
    target: readBlob(upstreamGit, refs.target, targetPath),
    imported: readBlob(magentaGit, refs.imported, importResolvedPath),
    current: readBlob(magentaGit, refs.current, currentResolvedPath),
  };
  const hashes = Object.fromEntries(Object.entries(blobs).map(([key, blob]) => [key, hashBlob(blob)]));
  records.push({
    workspace,
    path: rel,
    upstreamChange: change,
    upstreamSourcePath: sourcePath,
    upstreamTargetPath: targetPath,
    importResolvedPath,
    currentResolvedPath,
    importRelation: relation(hashes.imported, hashes.base, hashes.target),
    currentRelation: relation(hashes.current, hashes.base, hashes.target),
    changedSinceImport: hashes.imported !== hashes.current,
    baseExists: hashes.base !== null,
    targetExists: hashes.target !== null,
    importExists: hashes.imported !== null,
    currentExists: hashes.current !== null,
    baseSha256: hashes.base ?? "",
    targetSha256: hashes.target ?? "",
    importSha256: hashes.imported ?? "",
    currentSha256: hashes.current ?? "",
  });
}

const columns = Object.keys(records[0]);
const csvCell = (value) => {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
mkdirSync(reportRoot, { recursive: true });
writeFileSync(join(reportRoot, "file-triage.csv"), [columns.join(","), ...records.map((record) => columns.map((column) => csvCell(record[column])).join(","))].join("\n") + "\n");
const counts = {};
for (const record of records) {
  const key = `${record.workspace}\t${record.currentRelation}`;
  counts[key] = (counts[key] ?? 0) + 1;
}
const summary = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => `${key}\t${count}`).join("\n");
writeFileSync(join(reportRoot, "file-triage-summary.tsv"), `${summary}\n`);
console.log(JSON.stringify({ refs, records: records.length, csv: join(reportRoot, "file-triage.csv") }, null, 2));
console.log(summary);
