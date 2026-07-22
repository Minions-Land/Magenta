export function runReleaseGate({
	expectedVersion,
	nodeExecutable = process.execPath,
	prepareArtifacts = () => {},
	resourceMarker,
	runCommand,
	skipCheck = false,
	skipTest = false,
}) {
	if (typeof runCommand !== "function") throw new Error("runReleaseGate requires a command runner.");

	runCommand("npm", ["run", "clean"]);
	runCommand("npm", ["run", "build:offline"]);
	prepareArtifacts();

	const verifyArgs = ["scripts/verify-brand-version.mjs"];
	if (expectedVersion !== undefined) verifyArgs.push("--expected", expectedVersion);
	verifyArgs.push("--require-dist");
	if (resourceMarker !== undefined) verifyArgs.push("--resource-marker", resourceMarker);
	runCommand(nodeExecutable, verifyArgs);

	if (!skipCheck) runCommand("npm", ["run", "check:release"]);
	if (!skipTest) runCommand("npm", ["test"]);
}
