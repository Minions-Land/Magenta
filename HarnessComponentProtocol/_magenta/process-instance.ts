import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ProcessInstanceStatus = "alive" | "dead" | "unknown";

let localProcessStartIdentityInitialized = false;
let localProcessStartIdentity: string | null = null;

type ProcessExistence = "exists" | "dead" | "unknown";

function processExistence(pid: number): ProcessExistence {
	if (!Number.isInteger(pid) || pid <= 0) return "dead";
	try {
		process.kill(pid, 0);
		return "exists";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return "dead";
		if (code === "EPERM") return "exists";
		return "unknown";
	}
}

function readProcessStartIdentity(pid: number): string | null {
	try {
		if (process.platform === "linux") {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const closeParen = stat.lastIndexOf(")");
			if (closeParen < 0) return null;
			// After the executable name, field 3 is at index 0. Field 22
			// (`starttime`) is therefore index 19 in this suffix.
			const fields = stat
				.slice(closeParen + 2)
				.trim()
				.split(/\s+/);
			const startTicks = fields[19];
			const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
			return startTicks && bootId ? `linux:${bootId}:${startTicks}` : null;
		}
		if (process.platform === "darwin" || process.platform === "freebsd") {
			const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 2_000,
			})
				.trim()
				.split(/\r?\n/)[0]
				.trim();
			return started ? `bsd:${started}` : null;
		}
		if (process.platform === "win32") {
			const command = `$p=Get-Process -Id ${pid} -ErrorAction Stop; $p.StartTime.ToUniversalTime().Ticks`;
			for (const executable of ["powershell.exe", "pwsh.exe"]) {
				try {
					const started = execFileSync(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
						timeout: 2_000,
					}).trim();
					if (started) return `windows:${started}`;
				} catch {
					// Try the other PowerShell name before failing closed.
				}
			}
			return null;
		}
		// Conservative fallback for another Unix-like host. `ps` output is an
		// absolute start timestamp, not a volatile elapsed-time display.
		const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 2_000,
		})
			.trim()
			.split(/\r?\n/)[0]
			.trim();
		return started ? `ps:${started}` : null;
	} catch {
		return null;
	}
}

/** Return an OS-backed identity for one concrete PID lifetime. */
export function getProcessStartIdentity(pid: number): string | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (pid === process.pid && localProcessStartIdentityInitialized) return localProcessStartIdentity;
	const identity = readProcessStartIdentity(pid);
	if (pid === process.pid) {
		localProcessStartIdentityInitialized = true;
		localProcessStartIdentity = identity;
	}
	return identity;
}

/** Compatibility boolean for callers that only need a signal-0 existence probe. */
export function isProcessAlive(pid: number): boolean {
	return processExistence(pid) === "exists";
}

/**
 * Compare a PID and recorded start identity without treating probe failures as
 * proof of death. A missing identity is unknown and therefore not GC evidence.
 */
export function getProcessInstanceStatus(pid: number, expectedStartId: string | null): ProcessInstanceStatus {
	const existence = processExistence(pid);
	if (existence === "dead") return "dead";
	if (existence === "unknown" || !expectedStartId) return "unknown";
	const currentStartId = getProcessStartIdentity(pid);
	if (!currentStartId) return "unknown";
	return currentStartId === expectedStartId ? "alive" : "dead";
}

export function isProcessInstanceAlive(pid: number, expectedStartId: string | null): boolean {
	return getProcessInstanceStatus(pid, expectedStartId) === "alive";
}
