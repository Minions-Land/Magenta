import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const reportRoot = resolve(scriptDir, "..");
const inputs = [
  { domain: "ai", path: join(reportRoot, "ai.md"), source: "ai.md", heading: /^(AI-\d{3}) \|/ },
  { domain: "agent", path: join(reportRoot, "agent.md"), source: "agent.md", heading: /^### (AG-\d{3}) - (.+)$/ },
  { domain: "coding-core", path: join(reportRoot, "coding-core.md"), source: "coding-core.md", heading: /^\*\*(CC-\d{3}) - (.+)\*\*\s*$/ },
  { domain: "coding-ui", path: join(reportRoot, "coding-ui.md"), source: "coding-ui.md", heading: /^### (CU-\d{3})\s+(.+)$/ },
  { domain: "tui-repo", path: join(reportRoot, "tui-repo.md"), source: "tui-repo.md", heading: /^### (TR-\d{3}) - (.+)$/ },
];
const sourceTokens = ["PRESENT", "PARTIAL", "SUPERSEDED", "MISSING", "CONFLICT", "N/A", "PORT", "ADAPT", "ALREADY", "ADOPTED", "DEPENDENCY", "NO-OP", "CONDITIONAL"];
const records = [];
const extractTokens = (line) => {
  const upper = line.toUpperCase();
  return [...new Set(sourceTokens.filter((token) => new RegExp(`(^|[^A-Z])${token.replace("/", "\\/")}([^A-Z]|$)`).test(upper)))];
};
const normalize = (record) => {
  const raw = record.sourceStatus.toUpperCase();
  if (record.domain === "hcp") return record.id === "HC-006" ? "SUPERSEDED" : "CONFLICT";
  if (record.id === "TR-009") return "N/A";
  if (raw.includes("CONFLICT") || raw.includes("ADAPT")) return "CONFLICT";
  if (raw.includes("PARTIAL")) return "PARTIAL";
  if (raw.includes("MISSING") || raw.includes("PORT")) return "MISSING";
  if (raw.includes("SUPERSEDED")) return "SUPERSEDED";
  if (raw.includes("PRESENT") || raw.includes("ALREADY") || raw.includes("ADOPTED")) return "PRESENT";
  if (raw.includes("CONDITIONAL")) return "CONDITIONAL";
  if (raw.includes("DEPENDENCY")) return "MISSING";
  if (raw.includes("N/A") || raw.includes("NO-OP")) return "N/A";
  return "UNCLASSIFIED";
};
for (const input of inputs) {
  const lines = readFileSync(input.path, "utf8").split("\n");
  let current;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const match = input.heading.exec(line);
    if (match) {
      let title = match[2]?.trim();
      if (input.domain === "ai") {
        const official = line.match(/official:\s*(.*?)(?:\s*\|\s*commits?\s|\s*\|\s*upstream\s)/);
        title = official?.[1]?.replaceAll("`", "") ?? line.split("|")[2]?.trim() ?? match[1];
      }
      current = { id: match[1], domain: input.domain, title, status: "UNCLASSIFIED", sourceStatus: "", source: input.source, line: index + 1 };
      records.push(current);
      if (input.domain === "ai") {
        const statusToken = "PRESENT|PARTIAL|SUPERSEDED|MISSING|CONFLICT|N\\/A";
        const emphasized = [...line.matchAll(new RegExp(`\\*\\*((?:${statusToken})(?:\\/(?:${statusToken}))*)\\*\\*`, "g"))]
          .flatMap((statusMatch) => extractTokens(statusMatch[1]));
        current.sourceStatus = [...new Set(emphasized)].join("/");
        current = undefined;
      }
      continue;
    }
    if (!current) continue;
    const plainStatusLine = line.replaceAll("**", "");
    const statusMatch = /(?:Status|Class|Classification|状态):\s*(.*)/.exec(plainStatusLine);
    if (statusMatch) {
      const firstSentence = statusMatch[1].split(/(?:\.\s|。)/)[0];
      current.sourceStatus = extractTokens(firstSentence).join("/");
    }
  }
}
const orchestrator = records.find((record) => record.id === "TR-006");
if (orchestrator) orchestrator.sourceStatus = "SUPERSEDED/N/A";
const hcpLines = readFileSync(join(reportRoot, "hcp-conflicts.md"), "utf8").split("\n");
for (let index = 0; index < hcpLines.length; index++) {
  const match = /^\| (HC-\d{3}) \| (.*?) \|.*?\|.*?\| (.*?) \|$/.exec(hcpLines[index]);
  if (!match) continue;
  records.push({ id: match[1], domain: "hcp", title: match[2].replaceAll("`", ""), status: "UNCLASSIFIED", sourceStatus: match[3].replace(/\*\*/g, "").trim(), source: "hcp-conflicts.md", line: index + 1 });
}
records.push(
  { id: "MX-001", domain: "misc", title: "Question extension executes multiple questions sequentially", status: "UNCLASSIFIED", sourceStatus: "MISSING", source: "parent-review", line: "" },
  { id: "MX-002", domain: "misc", title: "pnpm self-update cache prune hint", status: "UNCLASSIFIED", sourceStatus: "MISSING", source: "parent-review", line: "" },
  { id: "MX-003", domain: "misc", title: "Fork selector rejects duplicate selection", status: "UNCLASSIFIED", sourceStatus: "MISSING", source: "parent-review", line: "" },
  { id: "MX-004", domain: "misc", title: "Restore Windows terminal title after package update check", status: "UNCLASSIFIED", sourceStatus: "MISSING", source: "parent-review", line: "" },
);
for (const record of records) record.status = normalize(record);
records.sort((a, b) => a.id.localeCompare(b.id));
const duplicateIds = records.map((record) => record.id).filter((id, index, all) => all.indexOf(id) !== index);
const unclassified = records.filter((record) => record.status === "UNCLASSIFIED");
const columns = ["id", "domain", "title", "status", "sourceStatus", "source", "line"];
const quote = (value) => {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
writeFileSync(join(reportRoot, "semantic-index.csv"), [columns.join(","), ...records.map((record) => columns.map((column) => quote(record[column])).join(","))].join("\n") + "\n");
const domains = {};
const statuses = {};
for (const record of records) {
  domains[record.domain] = (domains[record.domain] ?? 0) + 1;
  statuses[record.status] = (statuses[record.status] ?? 0) + 1;
}
console.log(JSON.stringify({ records: records.length, domains, statuses, duplicateIds, unclassified }, null, 2));
