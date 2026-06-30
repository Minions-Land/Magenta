import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

export function getCodingAgentRoot(): string {
  const override = process.env.MAGENTA_CODING_AGENT_ROOT || process.env.PI_CODING_AGENT_ROOT || process.env.PI_PACKAGE_DIR;
  if (override && existsSync(override)) return override;

  try {
    const cli = process.argv[1] ? realpathSync(process.argv[1]) : undefined;
    const fromCli = cli ? findCodingAgentRoot(cli) : undefined;
    if (fromCli) return fromCli;
  } catch {
    // Ignore and fall back to cwd/ancestor discovery below.
  }

  const fromCwd = findCodingAgentRoot(join(process.cwd(), "x"));
  if (fromCwd) return fromCwd;

  return "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent";
}

function findCodingAgentRoot(startPath: string): string | undefined {
  let dir = dirname(startPath);
  while (true) {
    const candidates = [
      join(dir, "pi/packages/coding-agent"),
      join(dir, "packages/coding-agent"),
      join(dir, "node_modules/@earendil-works/pi-coding-agent"),
    ];

    for (const candidate of candidates) {
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }

    const marker = "/@earendil-works/pi-coding-agent/dist/";
    const markerIndex = startPath.indexOf(marker);
    if (markerIndex >= 0) return startPath.slice(0, markerIndex + "/@earendil-works/pi-coding-agent".length);

    const workspaceMarker = "/packages/coding-agent/";
    const workspaceIndex = startPath.indexOf(workspaceMarker);
    if (workspaceIndex >= 0) return startPath.slice(0, workspaceIndex + "/packages/coding-agent".length);

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
