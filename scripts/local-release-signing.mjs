/**
 * Bun appends its compiled payload after the Mach-O linker signature, so a
 * local macOS build must be re-signed after the executable is complete. This
 * is intentionally ad-hoc signing for local diagnostics, never a substitute
 * for the Developer ID and notarization gate used by public releases.
 */
export function signLocalMacBinary({ binaryPath, platform, runCommand }) {
	if (!platform.startsWith("darwin-")) return false;
	if (typeof runCommand !== "function") throw new Error("Local macOS signing requires a command runner.");

	runCommand("codesign", ["--force", "--sign", "-", "--timestamp=none", binaryPath]);
	runCommand("codesign", ["--verify", "--strict", "--verbose=2", binaryPath]);
	return true;
}
