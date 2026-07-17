import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
  fields.push(field);
  return fields;
};
const lines = readFileSync(`${dir}/semantic-index.csv`, "utf8").trimEnd().split("\n");
const header = parseCsvLine(lines.shift());
const semantics = lines.map((line) => {
  const fields = parseCsvLine(line);
  return Object.fromEntries(header.map((name, index) => [name, fields[index]]));
});
const waveIds = {
  W0: ["HC-009"],
  W1: ["AG-007", "AG-008", "AG-009", "AG-010", "AI-002", "AI-006", "AI-008", "AI-014", "AI-015", "AI-017", "AI-018", "AI-019", "AI-025", "CC-002", "CC-003", "CC-005", "CC-013", "CC-024"],
  W2: ["AG-011", "AG-014", "AI-003", "AI-007", "AI-021", "AI-022", "AI-023", "AI-024", "CC-036", "CC-037", "CU-013"],
  W3: ["AI-004", "AI-009", "AI-011", "AI-012", "AI-030", "AI-032", "AI-033", "AI-034", "AI-035", "AI-039", "CC-020", "CC-042"],
  W4: ["CC-001", "CC-008", "CC-009", "CC-010", "CC-011", "CC-016", "CC-021", "CC-025", "CC-026", "CC-030", "CC-032", "CC-033", "CC-035", "CC-038", "CC-040", "CC-044", "CC-046", "CU-001", "CU-002", "CU-003", "CU-004", "CU-005", "CU-006", "CU-007", "CU-008", "CU-009", "CU-010", "CU-014", "CU-016", "CU-019", "CU-020", "CU-026", "HC-007", "MX-001", "MX-002", "MX-003", "MX-004", "TR-001", "TR-002", "TR-003", "TR-004"],
  W5: ["AI-027", "AI-029", "AI-038", "AI-040", "AI-043", "HC-001"],
  W6: ["CC-015", "CC-018", "CC-019", "CC-027", "CC-028", "CC-029", "CC-047", "CC-048", "CC-049", "CC-050", "CC-051", "CC-052", "CC-053", "CC-054", "CC-055", "CC-058", "CC-059", "HC-002"],
  W7: ["AG-001", "AG-003", "AG-004", "AG-005", "AG-006", "CC-004", "CC-007", "CC-017", "CC-023", "CC-031", "CC-034", "CC-039", "CC-043", "HC-004", "HC-005"],
  W8: ["AG-012", "AI-028", "CC-012", "CC-041", "HC-003"],
  W9: ["AI-020", "AI-026", "AI-031", "AI-036", "AI-041", "AI-042", "AI-044", "AI-046", "CC-006", "CC-045", "CC-057", "HC-008", "TR-012", "TR-013", "TR-015", "TR-017", "TR-018"],
  CROSSWALK: ["AG-013", "AG-015", "CC-014", "CC-056", "CU-011", "CU-012", "CU-015", "CU-017", "CU-018", "CU-021", "CU-022", "CU-023", "CU-024", "CU-025"],
  EXCLUDED: ["HC-006", "TR-006"],
};
const assignment = new Map();
for (const [wave, ids] of Object.entries(waveIds)) {
  for (const id of ids) {
    if (assignment.has(id)) throw new Error(`${id} assigned to both ${assignment.get(id)} and ${wave}`);
    assignment.set(id, wave);
  }
}
for (const semantic of semantics) {
  if (assignment.has(semantic.id)) continue;
  if (semantic.status === "N/A") assignment.set(semantic.id, "EXCLUDED");
  else if (semantic.status === "PRESENT" || semantic.status === "SUPERSEDED") assignment.set(semantic.id, "VERIFY");
  else throw new Error(`Actionable semantic ID lacks wave: ${semantic.id} (${semantic.status})`);
}
for (const id of assignment.keys()) {
  if (!semantics.some((semantic) => semantic.id === id)) throw new Error(`Unknown wave-map ID: ${id}`);
}
const waveMetadata = {
  W0: { owner: "upgrade branch + HCP governance", gate: "G0", rollback: "discard isolated upgrade worktree", dependsOn: "none" },
  W1: { owner: "pi/ai + pi/agent + HCP tool/session safety boundaries", gate: "G1", rollback: "owner-scoped W1 commit set", dependsOn: "W0" },
  W2: { owner: "pi/ai contracts + pi/agent/coding consumers", gate: "G2", rollback: "usage/pricing/thinking commit set", dependsOn: "W1" },
  W3: { owner: "pi/ai provider transports + coding model compatibility", gate: "G3", rollback: "provider-scoped transport commits", dependsOn: "W1,W2" },
  W4: { owner: "pi/tui + coding TUI/RPC/settings/extensions; HCP edit adapter", gate: "G4", rollback: "feature-scoped UI/RPC commits", dependsOn: "W1" },
  W5: { owner: "pi/ai Models/auth + Magenta composite credential resolver", gate: "G5", rollback: "pi-ai Models/auth commit set", dependsOn: "W1,W2,W3" },
  W6: { owner: "coding-agent ModelRuntime/extensions/SDK/auth UI", gate: "G6", rollback: "coding ModelRuntime integration commit set", dependsOn: "W4,W5" },
  W7: { owner: "HCP session/compaction + pi/agent API + coding policy", gate: "G7", rollback: "session then compaction owner-scoped commits", dependsOn: "W5,W6" },
  W8: { owner: "pi/ai + pi/agent + coding dynamic tools; existing HCP tool pool", gate: "G8", rollback: "dynamic-tool protocol commit set", dependsOn: "W4,W5,W6,W7" },
  W9: { owner: "catalog/OAuth/build/release owners", gate: "G9", rollback: "pre-release abort; post-release forward recovery", dependsOn: "W4,W5,W6,W7,W8" },
  CROSSWALK: { owner: "crosswalk only; canonical IDs own code", gate: "canonical target gates", rollback: "no independent code; follows canonical targets", dependsOn: "canonical targets" },
  VERIFY: { owner: "current implementation owner", gate: "G0 regression", rollback: "none; retain current behavior", dependsOn: "W0" },
  EXCLUDED: { owner: "none", gate: "scope audit", rollback: "no code may be imported", dependsOn: "none" },
};
const ownerOverrides = {
  "AG-009": "HarnessComponentProtocol/_magenta/env/pi/nodejs.ts + HarnessComponentProtocol/tools/bash + coding adapter",
  "CC-014": "HarnessComponentProtocol/tools/bash + coding adapter",
  "CU-017": "HarnessComponentProtocol/tools/bash + coding adapter",
  "CC-021": "HarnessComponentProtocol/tools/edit + coding renderer",
  "CU-018": "HarnessComponentProtocol/tools/edit + coding renderer",
  "CU-026": "HarnessComponentProtocol/tools/edit/bash + coding renderers",
  "HC-004": "HarnessComponentProtocol/_magenta/session",
  "HC-005": "HarnessComponentProtocol/compaction/pi + coding policy",
  "CC-017": "HarnessComponentProtocol/compaction/pi",
  "CC-034": "HarnessComponentProtocol/compaction/pi",
  "CC-039": "HarnessComponentProtocol/compaction/pi + agent boundary",
  "CC-043": "coding AgentSession + HCP compaction dependency injection",
  "HC-009": "HCP assembly governance",
};
const crosswalkTargets = {
  "AG-013": ["AI-003"],
  "AG-015": ["AI-038", "CC-048"],
  "CC-014": ["AG-009"],
  "CC-056": ["AI-041"],
  "CU-011": ["CC-048", "CC-049", "CC-050", "CC-051"],
  "CU-012": ["CC-052", "CC-054", "CC-055", "CC-058"],
  "CU-015": ["CC-028", "CC-047", "CC-049"],
  "CU-017": ["AG-009"],
  "CU-018": ["CC-021"],
  "CU-021": ["AG-007", "AG-008", "AG-010", "CC-004", "CC-005", "CC-031"],
  "CU-022": ["AI-028", "CC-012", "CC-041"],
  "CU-023": ["CC-010", "CC-015", "CC-026", "CC-027"],
  "CU-024": ["CC-006", "CC-019", "CC-029"],
  "CU-025": ["CC-003"],
};
const governanceIds = new Set(["HC-001", "HC-002", "HC-003", "HC-004", "HC-005", "HC-007", "HC-008", "HC-009", "CU-026"]);
const noteOverrides = {
  "CC-010": "Current internal session_info_changed exists; extension-facing event type/dispatch/export is missing.",
  "CC-043": "Implement only after W5/W6 provide Models-backed ambient auth.",
  "CC-047": "Implement against W5/W6 provider-owned auth; do not patch the legacy registry.",
  "HC-009": "Global invariant checked after every wave despite one primary governance row.",
  "TR-015": "Conditional on D5 remote-catalog publication decision.",
  "TR-017": "Mechanical upstream bump is excluded; W9 marks Pi private 0.80.8-magenta.0, HCP private 0.0.2, and forbids npm fork publication.",
};
const rows = semantics.map((semantic) => {
  const primaryWave = assignment.get(semantic.id);
  const metadata = waveMetadata[primaryWave];
  const targets = crosswalkTargets[semantic.id] ?? [semantic.id];
  const implementationRole = primaryWave === "CROSSWALK"
    ? "CROSSWALK"
    : primaryWave === "VERIFY"
      ? "VERIFY"
      : primaryWave === "EXCLUDED"
        ? "EXCLUDED"
        : governanceIds.has(semantic.id)
          ? "GOVERNANCE"
          : "CANONICAL";
  const targetWaves = primaryWave === "CROSSWALK"
    ? [...new Set(targets.map((id) => assignment.get(id)))].sort().join(",")
    : metadata.dependsOn;
  return {
    id: semantic.id,
    domain: semantic.domain,
    status: semantic.status,
    primaryWave,
    implementationRole,
    canonicalImplementationIds: targets.join(";"),
    implementationOwner: implementationRole === "CROSSWALK" ? `crosswalk only; see ${targets.join(",")}` : (ownerOverrides[semantic.id] ?? metadata.owner),
    dependsOn: targetWaves,
    testGate: metadata.gate,
    rollbackUnit: metadata.rollback,
    title: semantic.title,
    notes: noteOverrides[semantic.id] ?? "",
  };
}).sort((a, b) => a.id.localeCompare(b.id));
const columns = Object.keys(rows[0]);
const quote = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
writeFileSync(`${dir}/wave-map.csv`, [columns.join(","), ...rows.map((row) => columns.map((column) => quote(row[column])).join(","))].join("\n") + "\n");
const summary = {};
for (const row of rows) summary[row.primaryWave] = (summary[row.primaryWave] ?? 0) + 1;
console.log(JSON.stringify({ rows: rows.length, summary }, null, 2));
for (const wave of ["W0", "W1", "W2", "W3", "W4", "W5", "W6", "W7", "W8", "W9", "CROSSWALK", "VERIFY", "EXCLUDED"]) {
  console.log(`${wave}: ${rows.filter((row) => row.primaryWave === wave).map((row) => row.id).join(", ")}`);
}
