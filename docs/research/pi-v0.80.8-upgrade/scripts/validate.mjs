import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const repoRoot = resolve(scriptDir, "../../../..");
const upstream = process.env.PI_UPSTREAM_REPO ?? "/tmp/magenta-pi-upstream-v0.80.8-20260717";
const magenta = process.env.MAGENTA_REPO ?? repoRoot;
const refs = {
  base: process.env.PI_U2_SHA ?? "0201806adfa825ab3d7957a4267d46e5030fd357",
  imported: process.env.MAGENTA_IMPORT_SHA ?? "f1da4c98bd3b8df522a0e80e2f6e6bfcdb064328",
  current: process.env.MAGENTA_CURRENT_SHA ?? "e7a6e770385e2c6ca16888f7ed5a97bd38bdb39e",
  target: process.env.PI_U8_SHA ?? "fae7176cb9f7c4725a40d9d481d8d70b80f18086",
};
const packageWorkspaces = new Set(["ai", "agent", "coding-agent", "tui", "orchestrator"]);

const parseCsvLine = (line) => {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") { fields.push(field); field = ""; }
    else field += char;
  }
  if (quoted) throw new Error(`Unterminated CSV quote: ${line.slice(0, 80)}`);
  fields.push(field);
  return fields;
};
const readCsv = (path) => {
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  const header = parseCsvLine(lines.shift());
  return lines.map((line, rowIndex) => {
    const fields = parseCsvLine(line);
    if (fields.length !== header.length) throw new Error(`${path}:${rowIndex + 2}: expected ${header.length} fields, got ${fields.length}`);
    return Object.fromEntries(header.map((name, index) => [name, fields[index]]));
  });
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const counts = (values) => Object.fromEntries([...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map())].sort());
const split = (value) => value ? value.split(";") : [];
const revParse = (repo, ref) => execFileSync("git", ["-C", repo, "rev-parse", ref], { encoding: "utf8" }).trim();
assert(revParse(upstream, "v0.80.2") === refs.base, "v0.80.2 does not match fixed U2 SHA");
assert(revParse(upstream, "v0.80.8") === refs.target, "v0.80.8 does not match fixed U8 SHA");
assert(revParse(magenta, refs.imported) === refs.imported, "fixed import SHA is unavailable");
assert(revParse(magenta, refs.current) === refs.current, "fixed current SHA is unavailable");
const readBlob = (repo, ref, path) => {
  try { return execFileSync("git", ["-C", repo, "show", `${ref}:${path}`], { maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return null; }
};
const hashBlob = (blob) => blob === null ? "" : createHash("sha256").update(blob).digest("hex");
const resolveLogicalPath = (repo, ref, targetPath, sourcePath) => readBlob(repo, ref, targetPath) !== null
  ? targetPath
  : sourcePath !== targetPath && readBlob(repo, ref, sourcePath) !== null
    ? sourcePath
    : targetPath;
const relation = (value, base, target) => {
  if (!value) return !target ? "absent_as_target" : !base ? "missing_target_addition" : "deleted_or_absent";
  if (value === target) return "exact_target";
  if (value === base) return "exact_base";
  return "diverged";
};
const workspaceFor = (path) => path.match(/^packages\/([^/]+)\//)?.[1] ?? (path.startsWith(".github/") ? ".github" : path.split("/")[0] || "root");

const semantics = readCsv(`${reportRoot}/semantic-index.csv`);
const semanticById = new Map(semantics.map((row) => [row.id, row]));
assert(semantics.length === 178, `semantic count ${semantics.length}`);
assert(semanticById.size === 178, "duplicate semantic ID");
const allowedStatuses = new Set(["PRESENT", "PARTIAL", "SUPERSEDED", "MISSING", "CONFLICT", "N/A", "CONDITIONAL"]);
assert(semantics.every((row) => allowedStatuses.has(row.status)), "non-normalized semantic status");
const semanticStatusCounts = counts(semantics.map((row) => row.status));
assert(JSON.stringify(semanticStatusCounts) === JSON.stringify({ CONDITIONAL: 1, CONFLICT: 60, MISSING: 71, "N/A": 12, PARTIAL: 21, PRESENT: 8, SUPERSEDED: 5 }), `status counts ${JSON.stringify(semanticStatusCounts)}`);

const releaseBySha = new Map();
for (const version of [3, 4, 5, 6, 7, 8]) {
  const shas = execFileSync("git", ["-C", upstream, "rev-list", "--reverse", `v0.80.${version - 1}..v0.80.${version}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const sha of shas) releaseBySha.set(sha, `v0.80.${version}`);
}
const rawLog = execFileSync("git", ["-C", upstream, "log", "--reverse", "--date=iso-strict", "--format=@@COMMIT%x09%H%x09%ad%x09%s", "--name-status", "v0.80.2..v0.80.8"], { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 });
const expectedCommits = [];
let currentCommit;
for (const line of rawLog.split("\n")) {
  if (line.startsWith("@@COMMIT\t")) {
    const [, sha, date, subject] = line.split("\t");
    currentCommit = { sha, version: releaseBySha.get(sha), date, subject, changes: [] };
    expectedCommits.push(currentCommit);
  } else if (currentCommit && line.trim()) {
    const fields = line.split("\t");
    const status = fields[0];
    const paths = status.startsWith("R") || status.startsWith("C") ? fields.slice(1, 3) : fields.slice(1, 2);
    currentCommit.changes.push({ status, paths });
  }
}
const commits = readCsv(`${reportRoot}/commit-ledger.csv`);
assert(commits.length === 243 && expectedCommits.length === 243, `commit counts ledger=${commits.length} git=${expectedCommits.length}`);
assert(new Set(commits.map((row) => row.sha)).size === 243, "duplicate commit SHA");
let allChangeRecords = 0;
let packageChangeRecords = 0;
let pathEndpoints = 0;
const directlyReferenced = new Set();
for (let index = 0; index < commits.length; index++) {
  const row = commits[index];
  const expected = expectedCommits[index];
  assert(row.sha === expected.sha && row.version === expected.version && row.date === expected.date && row.subject === expected.subject, `commit metadata/order mismatch at ${row.sha.slice(0, 8)}`);
  const expectedPaths = expected.changes.flatMap((change) => change.paths);
  const expectedChanges = expected.changes.map((change) => `${change.status}:${change.paths.join("=>")}`);
  const expectedPackageCount = expected.changes.filter((change) => change.paths.at(-1)?.startsWith("packages/")).length;
  const expectedWorkspaces = [...new Set(expectedPaths.map(workspaceFor))].sort();
  assert(Number(row.changeCount) === expected.changes.length, `${row.sha.slice(0, 8)} changeCount`);
  assert(Number(row.packageChangeCount) === expectedPackageCount, `${row.sha.slice(0, 8)} packageChangeCount`);
  assert(Number(row.pathEndpointCount) === expectedPaths.length, `${row.sha.slice(0, 8)} endpointCount`);
  assert(JSON.stringify(split(row.paths)) === JSON.stringify(expectedPaths), `${row.sha.slice(0, 8)} paths payload`);
  assert(JSON.stringify(split(row.changes)) === JSON.stringify(expectedChanges), `${row.sha.slice(0, 8)} changes payload`);
  assert(JSON.stringify(split(row.workspaces)) === JSON.stringify(expectedWorkspaces), `${row.sha.slice(0, 8)} workspaces`);
  const ids = split(row.semanticIds);
  const direct = split(row.directSemanticIds);
  const dependencies = split(row.dependencySemanticIds);
  assert(JSON.stringify([...new Set([...direct, ...dependencies])].sort()) === JSON.stringify([...ids].sort()), `${row.sha.slice(0, 8)} semantic direct/dependency union`);
  for (const id of ids) assert(semanticById.has(id), `${row.sha.slice(0, 8)} unknown semantic ${id}`);
  for (const id of direct) directlyReferenced.add(id);
  assert(row.coverage === "EVIDENCE_LINKED" || row.coverage === "MECHANICAL_OR_NA", `${row.sha.slice(0, 8)} coverage ${row.coverage}`);
  allChangeRecords += expected.changes.length;
  packageChangeRecords += expectedPackageCount;
  pathEndpoints += expectedPaths.length;
}
assert(allChangeRecords === 1257, `all change records ${allChangeRecords}`);
assert(packageChangeRecords === 1194, `package change records ${packageChangeRecords}`);
assert(pathEndpoints === 1265, `path endpoints ${pathEndpoints}`);
assert(JSON.stringify(counts(commits.map((row) => row.version))) === JSON.stringify({ "v0.80.3": 93, "v0.80.4": 82, "v0.80.5": 3, "v0.80.6": 14, "v0.80.7": 31, "v0.80.8": 20 }), "version counts changed");
const commitCoverage = counts(commits.map((row) => row.coverage));
assert(JSON.stringify(commitCoverage) === JSON.stringify({ EVIDENCE_LINKED: 237, MECHANICAL_OR_NA: 6 }), `coverage counts ${JSON.stringify(commitCoverage)}`);
const orphanDirectIds = [...semanticById.keys()].filter((id) => !directlyReferenced.has(id));
assert(orphanDirectIds.length === 0, `semantic IDs without a direct commit edge: ${orphanDirectIds.join(",")}`);

const rawDiff = execFileSync("git", ["-C", upstream, "diff", "--name-status", "--find-renames", `${refs.base}..${refs.target}`, "--", ...[...packageWorkspaces].map((workspace) => `packages/${workspace}`)], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const expectedFileChanges = new Map();
for (const line of rawDiff.trim().split("\n")) {
  const fields = line.split("\t");
  const status = fields[0];
  const sourcePath = fields[1];
  const targetPath = status.startsWith("R") || status.startsWith("C") ? fields[2] : fields[1];
  expectedFileChanges.set(targetPath, { status, sourcePath, targetPath });
}
const files = readCsv(`${reportRoot}/file-triage.csv`);
assert(files.length === 393 && expectedFileChanges.size === 393, `file counts csv=${files.length} git=${expectedFileChanges.size}`);
assert(new Set(files.map((row) => `${row.workspace}/${row.path}`)).size === 393, "duplicate target package path");
const expectedRenameTargets = [
  "packages/ai/src/auth/oauth/anthropic.ts",
  "packages/ai/src/auth/oauth/device-code.ts",
  "packages/ai/src/auth/oauth/github-copilot.ts",
  "packages/ai/src/auth/oauth/oauth-page.ts",
  "packages/ai/src/auth/oauth/openai-codex.ts",
  "packages/ai/src/auth/oauth/pkce.ts",
];
const actualRenameTargets = [...expectedFileChanges.values()].filter((change) => change.status.startsWith("R")).map((change) => change.targetPath).sort();
assert(JSON.stringify(actualRenameTargets) === JSON.stringify(expectedRenameTargets), `unexpected rename coordinates ${actualRenameTargets.join(",")}`);
for (const row of files) {
  const targetPath = `packages/${row.workspace}/${row.path}`;
  const expected = expectedFileChanges.get(targetPath);
  assert(expected, `triage path absent from tag diff: ${targetPath}`);
  assert(row.upstreamChange === expected.status && row.upstreamSourcePath === expected.sourcePath && row.upstreamTargetPath === expected.targetPath, `triage change coordinates ${targetPath}`);
  const importTargetPath = expected.targetPath.replace(/^packages\//, "pi/");
  const importSourcePath = expected.sourcePath.replace(/^packages\//, "pi/");
  const importResolvedPath = resolveLogicalPath(magenta, refs.imported, importTargetPath, importSourcePath);
  const currentResolvedPath = resolveLogicalPath(magenta, refs.current, importTargetPath, importSourcePath);
  assert(row.importResolvedPath === importResolvedPath, `import resolved path ${targetPath}`);
  assert(row.currentResolvedPath === currentResolvedPath, `current resolved path ${targetPath}`);
  const hashes = {
    base: hashBlob(readBlob(upstream, refs.base, expected.sourcePath)),
    target: hashBlob(readBlob(upstream, refs.target, expected.targetPath)),
    imported: hashBlob(readBlob(magenta, refs.imported, importResolvedPath)),
    current: hashBlob(readBlob(magenta, refs.current, currentResolvedPath)),
  };
  assert(row.baseSha256 === hashes.base && row.targetSha256 === hashes.target && row.importSha256 === hashes.imported && row.currentSha256 === hashes.current, `hash mismatch ${targetPath}`);
  assert(row.baseExists === String(Boolean(hashes.base)) && row.targetExists === String(Boolean(hashes.target)) && row.importExists === String(Boolean(hashes.imported)) && row.currentExists === String(Boolean(hashes.current)), `exists flags ${targetPath}`);
  assert(row.importRelation === relation(hashes.imported, hashes.base, hashes.target), `import relation ${targetPath}`);
  assert(row.currentRelation === relation(hashes.current, hashes.base, hashes.target), `current relation ${targetPath}`);
  assert(row.changedSinceImport === String(hashes.imported !== hashes.current), `changedSinceImport ${targetPath}`);
}
const fileRelationCounts = counts(files.map((row) => row.currentRelation));
assert(JSON.stringify(fileRelationCounts) === JSON.stringify({ deleted_or_absent: 10, diverged: 166, exact_base: 122, exact_target: 12, missing_target_addition: 83 }), `triage counts ${JSON.stringify(fileRelationCounts)}`);

const waves = readCsv(`${reportRoot}/wave-map.csv`);
assert(waves.length === 178 && new Set(waves.map((row) => row.id)).size === 178, "wave-map row/id count");
assert(waves.every((row) => semanticById.has(row.id) && semanticById.get(row.id).status === row.status), "wave-map status/ID foreign key");
const allowedDispositions = new Set(["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "CROSSWALK", "VERIFY", "EXCLUDED"]);
const allowedRoles = new Set(["CANONICAL", "CROSSWALK", "GOVERNANCE", "VERIFY", "EXCLUDED"]);
const waveById = new Map(waves.map((row) => [row.id, row]));
assert(waves.every((row) => allowedDispositions.has(row.primaryWave) && allowedRoles.has(row.implementationRole)), "unknown wave disposition/role");
for (const row of waves) {
  const targets = split(row.canonicalImplementationIds);
  assert(targets.length > 0 && targets.every((id) => waveById.has(id)), `invalid canonical targets for ${row.id}`);
  if (["CANONICAL", "GOVERNANCE", "VERIFY", "EXCLUDED"].includes(row.implementationRole)) assert(targets.length === 1 && targets[0] === row.id, `${row.id} must own only itself`);
  if (row.implementationRole === "CROSSWALK") {
    assert(row.primaryWave === "CROSSWALK" && row.implementationOwner.startsWith("crosswalk only"), `${row.id} crosswalk ownership`);
    for (const target of targets) assert(["CANONICAL", "GOVERNANCE"].includes(waveById.get(target).implementationRole), `${row.id} targets non-canonical ${target}`);
  }
  if (["MISSING", "PARTIAL", "CONFLICT", "CONDITIONAL"].includes(row.status)) assert(/^W\d$/.test(row.primaryWave) || row.primaryWave === "CROSSWALK", `actionable ${row.id} assigned ${row.primaryWave}`);
  if (/^W\d$/.test(row.primaryWave)) {
    const waveNumber = Number(row.primaryWave.slice(1));
    for (const dependency of split(row.dependsOn.replaceAll(",", ";")).filter((value) => /^W\d$/.test(value))) {
      assert(Number(dependency.slice(1)) < waveNumber, `${row.id} dependency ${dependency} is not before ${row.primaryWave}`);
    }
  }
  assert(row.implementationOwner && row.testGate && row.rollbackUnit, `incomplete wave ownership ${row.id}`);
}
const roleCounts = counts(waves.map((row) => row.implementationRole));
assert(JSON.stringify(roleCounts) === JSON.stringify({ CANONICAL: 135, CROSSWALK: 14, EXCLUDED: 13, GOVERNANCE: 9, VERIFY: 7 }), `implementation role counts ${JSON.stringify(roleCounts)}`);
const waveCounts = counts(waves.map((row) => row.primaryWave));
assert(JSON.stringify(waveCounts) === JSON.stringify({ CROSSWALK: 14, EXCLUDED: 13, VERIFY: 7, W0: 1, W1: 18, W2: 11, W3: 12, W4: 41, W5: 6, W6: 18, W7: 15, W8: 5, W9: 17 }), `wave counts ${JSON.stringify(waveCounts)}`);

const readme = readFileSync(`${reportRoot}/README.md`, "utf8");
const semanticIdPattern = /(?:AI|AG|CC|CU|TR|HC|MX)-\d{3}/g;
for (const wave of ["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9"]) {
  const section = new RegExp(`### ${wave}\\.[\\s\\S]*?(?=\\n### |\\n## )`).exec(readme)?.[0];
  assert(section, `README missing ${wave} section`);
  const listed = [...(section.match(/Primary IDs?: ([^\n]+)/)?.[1]?.matchAll(semanticIdPattern) ?? [])].map((match) => match[0]).sort();
  const mapped = waves.filter((row) => row.primaryWave === wave).map((row) => row.id).sort();
  assert(JSON.stringify(listed) === JSON.stringify(mapped), `README ${wave} primary IDs differ from wave-map`);
}
for (const disposition of ["CROSSWALK", "VERIFY", "EXCLUDED"]) {
  const prefix = `- \`${disposition}\`: `;
  const line = readme.split("\n").find((candidate) => candidate.startsWith(prefix))?.slice(prefix.length);
  assert(line, `README missing ${disposition} list`);
  const listed = [...line.matchAll(semanticIdPattern)].map((match) => match[0]).sort();
  const mapped = waves.filter((row) => row.primaryWave === disposition).map((row) => row.id).sort();
  assert(JSON.stringify(listed) === JSON.stringify(mapped), `README ${disposition} IDs differ from wave-map`);
}
for (const match of readme.matchAll(/\]\((\.\.?\/[^)#]+)(?:#[^)]+)?\)/g)) {
  const target = resolve(reportRoot, match[1]);
  assert(existsSync(target), `broken README link ${match[1]}`);
}
for (const expectedText of ["237 linked to evidence IDs", "`exact_target` | 12", "`MISSING` | 71", "W0 -> W1 -> W2 -> W3 -> W4 -> W5 -> W6 -> W7 -> W8 -> W9"]) assert(readme.includes(expectedText), `README claim missing: ${expectedText}`);

const result = {
  fixedSnapshots: refs,
  commits: commits.length,
  commitCoverage,
  versionCounts: counts(commits.map((row) => row.version)),
  allCommitFileChangeRecords: allChangeRecords,
  packageCommitFileChangeRecords: packageChangeRecords,
  pathEndpoints,
  semanticItems: semantics.length,
  semanticStatusCounts,
  semanticIdsWithDirectCommitEdge: directlyReferenced.size,
  files: files.length,
  fileRelationCounts,
  waveAssignments: waveCounts,
  implementationRoles: roleCounts,
  verifiedRenameCoordinates: expectedRenameTargets,
  brokenReadmeLinks: 0,
};
if (process.argv.includes("--write-result")) writeFileSync(`${reportRoot}/validation.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
