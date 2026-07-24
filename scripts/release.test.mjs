import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	MACOS_EMBEDDED_PAYLOADS,
	MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30,
} from "./macos-release-bundle-contract.mjs";
import {
	addUnreleasedSection,
	assertExpectedChangedPaths,
	assertLatestPublishedVersion,
	compareVersions,
	createReleaseGitPlan,
	extractReleaseNotes,
	finalizeChangelog,
	isOfficialSourceRemote,
	parseChangedPaths,
	parseReleaseArguments,
	parseRemoteAnnotatedTagCommit,
	RELEASE_MAIN_FETCH_ARGS,
	readActiveBrand,
	resolveReleaseVersion,
	rollbackReleasePreparation,
	updateBrandVersionSource,
	verifyAbandonedVersionIsUnpublished,
	verifyLatestPublishedVersion,
} from "./release.mjs";
import { runReleaseGate } from "./release-gate.mjs";

function assertSourceOrder(source, needles, label) {
	let cursor = -1;
	for (const needle of needles) {
		const index = source.indexOf(needle, cursor + 1);
		assert.ok(index > cursor, `${label} must contain ${JSON.stringify(needle)} in release order`);
		cursor = index;
	}
}

function assertCheckoutCredentialsAreNotPersisted(workflow, label) {
	const checkoutPattern = /^\s*- (?:name:[^\n]+\n\s+)?uses: actions\/checkout@[0-9a-f]{40}[^\n]*\n(?<body>(?:\s{8,}[^\n]*\n)*)/gmu;
	const matches = [...workflow.matchAll(checkoutPattern)];
	assert.ok(matches.length > 0, `${label} must contain at least one checkout step`);
	for (const match of matches) {
		assert.match(match.groups?.body ?? "", /^\s+persist-credentials: false\s*$/mu, `${label} checkout`);
	}
}

test("resolves product version bumps independently of workspace versions", () => {
	assert.equal(resolveReleaseVersion("0.0.23", "patch"), "0.0.24");
	assert.equal(resolveReleaseVersion("0.9.8", "minor"), "0.10.0");
	assert.equal(resolveReleaseVersion("9.8.7", "major"), "10.0.0");
	assert.equal(resolveReleaseVersion("0.80.2", "0.81.0"), "0.81.0");
	assert.equal(compareVersions("0.0.24", "0.0.23"), 1);
});

test("release builds are pinned, offline, and receipt-bound", () => {
	const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	const codingPackage = JSON.parse(
		readFileSync(new URL("../pi/coding-agent/package.json", import.meta.url), "utf8"),
	);
	const localRelease = readFileSync(new URL("./local-release.mjs", import.meta.url), "utf8");
	const releaseGate = readFileSync(new URL("./release-gate.mjs", import.meta.url), "utf8");
	const binaryBuild = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
	const clipboardStage = readFileSync(new URL("./stage-release-clipboard.mjs", import.meta.url), "utf8");
	const macosSigning = readFileSync(new URL("./macos-release-signing.mjs", import.meta.url), "utf8");
	const macosTrustGenerator = readFileSync(new URL("./generate-macos-release-trust.mjs", import.meta.url), "utf8");
	const macosWorkflow = readFileSync(new URL("./macos-release-workflow.mjs", import.meta.url), "utf8");
	const releasePublisher = readFileSync(new URL("./github-release-publish.mjs", import.meta.url), "utf8");
	const unixInstaller = readFileSync(new URL("./install.sh", import.meta.url), "utf8");
	const unixSmoke = readFileSync(new URL("./smoke-unix-release.sh", import.meta.url), "utf8");
	const windowsInstaller = readFileSync(new URL("./install.ps1", import.meta.url), "utf8");
	const ciWorkflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
	const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
	const processToolsWorkflow = readFileSync(
		new URL("../.github/workflows/build-process-tools.yml", import.meta.url),
		"utf8",
	);
	const packagePromotionWorkflow = readFileSync(
		new URL("../.github/workflows/promote-package-release.yml", import.meta.url),
		"utf8",
	);
	const macosSigningJobStart = workflow.indexOf("\n  macos-signing:");
	const smokeLinuxJobStart = workflow.indexOf("\n  smoke-linux:");
	const smokeMacosJobStart = workflow.indexOf("\n  smoke-macos:");
	const smokeWindowsJobStart = workflow.indexOf("\n  smoke-windows:");
	assert.ok(macosSigningJobStart >= 0 && smokeLinuxJobStart > macosSigningJobStart);
	assert.ok(smokeMacosJobStart > smokeLinuxJobStart && smokeWindowsJobStart > smokeMacosJobStart);
	const macosSigningJob = workflow.slice(macosSigningJobStart, smokeLinuxJobStart);
	const smokeMacosJob = workflow.slice(smokeMacosJobStart, smokeWindowsJobStart);

	assert.match(rootPackage.scripts["build:offline"], /npm run build:offline -w @earendil-works\/pi-ai/u);
	assert.doesNotMatch(rootPackage.scripts["build:offline"], /npm run build -w @earendil-works\/pi-ai/u);
	assert.match(rootPackage.scripts["check:release"], /npm run check:assumptions/u);
	assert.match(rootPackage.scripts["check:release"], /generate-macos-release-trust\.mjs --check/u);
	assert.match(codingPackage.scripts["build:release-all"], /\.\.\/ai run build:offline/u);
	assert.doesNotMatch(codingPackage.scripts["build:release-all"], /\.\.\/ai run build &&/u);
	const requiredReleaseCopy = codingPackage.scripts["build:release-all"].slice(
		codingPackage.scripts["build:release-all"].lastIndexOf("&& shx cp -r "),
	);
	assert.match(
		requiredReleaseCopy,
		/shx cp -r .*dist\/photon_rs_bg\.wasm dist\/release\//u,
	);
	assert.doesNotMatch(requiredReleaseCopy, /(?:2>\/dev\/null|\|\|\s*true)/u);
	assert.match(codingPackage.scripts.clean, /clean-coding-agent-build\.mjs/u);
	assert.match(codingPackage.scripts["build:binary"], /run-bun-compile\.mjs build --compile/u);
	assert.equal(codingPackage.scripts["build:release-all"].match(/run-bun-compile\.mjs build --compile/gu)?.length, 4);
	assert.doesNotMatch(codingPackage.scripts["build:binary"], /(?:^|&&\s+)bun build --compile/u);
	assert.doesNotMatch(codingPackage.scripts["build:release-all"], /(?:^|&&\s+)bun build --compile/u);
	assert.match(codingPackage.scripts.prebuild, /generate-macos-release-trust\.mjs/u);
	assert.match(macosTrustGenerator, /installerTrustPattern/u);
	assert.match(macosTrustGenerator, /standalone Unix installer trust/u);
	assert.equal(MACOS_EMBEDDED_PAYLOADS.length, 6);
	assert.equal(MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30.length, 10);
	assert.equal(new Set(MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30).size, 10);
	assert.deepEqual(
		[...MACOS_PUBLISHED_RELEASE_ASSET_NAMES_V0_0_30].sort(),
		[
			"SHA256SUMS",
			"SOURCE_COMMIT",
			"install.ps1",
			"install.sh",
			"macos-signing-receipt.json",
			"magenta-linux-x64",
			"magenta-macos-arm64",
			"magenta-macos-x64",
			"magenta-resources-universal.tar.gz",
			"magenta-windows-x64.exe",
		].sort(),
	);
	assert.match(localRelease, /runReleaseGate\(\{/u);
	assert.doesNotMatch(localRelease, /run\("npm", \["run", "check"\]/u);
	assert.match(localRelease, /pi\/coding-agent\/dist\/magenta-release\.json/u);
	assert.match(releaseGate, /verify-brand-version\.mjs/u);
	assert.match(localRelease, /createAndVerifyLocalBinaryArchive\(/u);
	assert.match(localRelease, /handleLocalReleaseOutputFailure\(/u);
	assert.match(localRelease, /explicitOut: options\.outDir !== undefined/u);
	assertSourceOrder(localRelease, ["signLocalMacBinary({", "createAndVerifyLocalBinaryArchive({"], "local signing");
	assert.match(localRelease, /rmSync\(binaryBuildDirectory/u);
	assert.doesNotMatch(localRelease, /cpSync\(join\(binaryBuildDirectory, archiveName\)/u);
	assert.match(binaryBuild, /\.magenta-binary-output/u);
	assert.match(binaryBuild, /run-bun-compile\.mjs build --compile/u);
	assert.doesNotMatch(binaryBuild, /\bbun build --compile/u);
	assert.match(binaryBuild, /Refusing to replace a directory not owned by this script/u);
	assert.doesNotMatch(binaryBuild, /build-binaries\.yml/u);
	assert.match(binaryBuild, /npm run clean\s+npm run build:offline/u);
	assert.doesNotMatch(binaryBuild, /npm run build(?:\s|$)/u);
	assert.match(ciWorkflow, /npm run clean\s+npm run build:offline/u);
	assert.doesNotMatch(ciWorkflow, /npm run build(?:\s|$)/u);
	for (const [label, source] of [
		["CI workflow", ciWorkflow],
		["release workflow", workflow],
		["process-tools workflow", processToolsWorkflow],
		["package promotion workflow", packagePromotionWorkflow],
	]) {
		assertCheckoutCredentialsAreNotPersisted(source, label);
	}
	assert.match(processToolsWorkflow, /^permissions:\s*\n  contents: read\s*$/mu);
	assert.ok(
		ciWorkflow.indexOf("npm run build:offline") < ciWorkflow.indexOf("npm test"),
		"CI must build ignored workspace dist before cross-workspace tests import it",
	);
	assert.match(workflow, /npm ci --ignore-scripts/u);
	assert.match(workflow, /npm run clean\s+npm run build:offline/u);
	assert.match(workflow, /npm run check:release\s+npm test/u);
	assert.ok(
		workflow.indexOf("npm run build:offline") < workflow.indexOf("npm test"),
		"release CI must build ignored workspace dist before cross-workspace tests import it",
	);
	assert.match(workflow, /stage-release-clipboard\.mjs/u);
	assert.match(workflow, /run-bun-compile\.mjs build --compile \.\.\/\.\.\/scripts\/clipboard-runtime-probe\.ts/u);
	assert.doesNotMatch(workflow, /\bbun build --compile/u);
	assert.match(workflow, /verify-brand-version\.mjs/u);
	assert.match(workflow, /apple_team_id=\$\(node scripts\/macos-release-trust\.mjs\)/u);
	assert.match(workflow, /test "\$\(node scripts\/macos-release-trust\.mjs\)" = "\$EXPECTED_APPLE_TEAM_ID"/u);
	assert.match(workflow, /smoke-linux:\s+[\s\S]*runs-on: ubuntu-24\.04/u);
	assert.match(workflow, /file release\/magenta-linux-x64[^\n]+ELF 64-bit\.\*x86-64/u);
	assert.match(workflow, /release\/magenta-linux-x64 --version/u);
	assert.match(workflow, /release\/magenta-linux-x64 --help/u);
	assert.match(workflow, /bash scripts\/smoke-unix-release\.sh release/u);
	assert.match(workflow, /smoke-macos:\s+[\s\S]*runner: macos-15\s+[\s\S]*runner: macos-15-intel/u);
	assert.match(workflow, /codesign --verify --strict --check-notarization/u);
	assert.match(workflow, /certificate leaf\[field\.1\.2\.840\.113635\.100\.6\.1\.13\] exists/u);
	assert.match(workflow, /spctl --assess --type execute/u);
	assert.match(workflow, /if grep -q '\^Signature=adhoc\$'/u);
	assert.match(workflow, /find "\$install_dir" -type f -print0/u);
	assert.match(workflow, /test "\$verified_macho" -ge 3/u);
	assert.match(macosSigningJob, /environment:\s+[\s\S]*name: macos-release/u);
	assert.match(macosSigningJob, /timeout-minutes: 300/u);
	assert.equal(workflow.match(/retention-days: 7/gu)?.length, 2);
	assert.doesNotMatch(workflow, /retention-days: 1(?:\s|$)/u);
	assert.match(workflow, /MAGENTA_MACOS_CERTIFICATE_P12_BASE64: \$\{\{ secrets\./u);
	assert.match(workflow, /MAGENTA_APPLE_NOTARY_KEY_P8_BASE64: \$\{\{ secrets\./u);
	assert.match(workflow, /macos-release-workflow\.mjs/u);
	assert.match(workflow, /MAGENTA_MACOS_TEAM_ID: \$\{\{ secrets\.MAGENTA_MACOS_TEAM_ID \}\}/u);
	assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}[\s\S]*magenta-unsigned/u);
	assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}[\s\S]*unsigned_artifact_name/u);
	assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}[\s\S]*magenta-signing-output/u);
	assert.doesNotMatch(workflow, /macos-signing-gate:|unix-installer-gate:/u);
	assert.doesNotMatch(workflow, /Require organization signing integration|exit 1\s*\n\s*unix-installer/u);
	assert.match(
		workflow,
		/needs: \[macos-signing, smoke-linux, smoke-macos, smoke-windows\]/u,
	);
	assert.match(workflow, /needs\.macos-signing\.outputs\.checksum_manifest_sha256/u);
	assert.doesNotMatch(workflow, /name: Publish verified release/u);
	assert.match(macosWorkflow, /\["run", "build:release-all"\]/u);
	assert.match(macosWorkflow, /DEFAULT_COMMAND_TIMEOUT_MS = 60 \* 60 \* 1000/u);
	assert.match(macosWorkflow, /OUTER_REBUILD_TIMEOUT_MS = 90 \* 60 \* 1000/u);
	assert.match(macosWorkflow, /Outer rebuild changed signed embedded payload/u);
	assert.match(macosWorkflow, /does not contain signed embedded payload bytes/u);
	assert.match(macosWorkflow, /does not contain the signed clipboard bytes/u);
	assert.match(macosWorkflow, /Final signed helper Identifier mismatch/u);
	assert.match(macosWorkflow, /verifyInitialReleaseBundle\(\{[\s\S]*receipt\.finalManifestSha256/u);
	assert.match(macosSigning, /rebuildOuterBinaries callback is required/u);
	assert.match(clipboardStage, /assertTarballIntegrity\(tarball, pkg\.integrity/u);
	assert.match(workflow, /checksum_manifest_sha256/u);
	assert.match(workflow, /sha256sum -c SHA256SUMS/u);
	assert.match(workflow, /install\.sh install\.ps1 SOURCE_COMMIT > SHA256SUMS/u);
	assert.match(workflow, /EXPECTED_ASSETS=.*install\.sh/u);
	assert.match(workflow, /EXPECTED_ASSETS=.*macos-signing-receipt\.json/u);
	assert.match(workflow, /cmp release\/macos-signing-receipt\.json attestations\/macos-signing-receipt\.json/u);
	assert.match(workflow, /_release-helper-proof > "\$proof"/u);
	assert.match(workflow, /verify-macos-runtime-helper-proof\.mjs/u);
	assertSourceOrder(
		smokeMacosJob,
		['file "release/${{ matrix.binary }}"', 'chmod 0755 "release/${{ matrix.binary }}"', '"$binary" _release-helper-proof'],
		"downloaded macOS artifact permission restoration",
	);
	assert.match(workflow, /"install\.sh",\s+"install\.ps1"/u);
	assert.match(unixInstaller, /"\$BIN_FILE" _install-unix/u);
	assert.match(unixSmoke, /resource-install:README\.md/u);
	assert.match(unixSmoke, /binary-install:complete/u);
	assert.match(unixSmoke, /\.local\/lib\/magenta/u);
	assert.match(unixSmoke, /\.local\/bin/u);
	assert.match(unixSmoke, /test -L "\$entrypoint"/u);
	assert.match(unixSmoke, /bash "\$release_dir\/install\.sh" --uninstall/u);
	assert.match(unixSmoke, /test ! -e "\$entrypoint"/u);
	assert.match(unixSmoke, /Leave one verified installation/u);
	assert.match(unixSmoke, /\.magenta-install-update\.json/u);
	assert.match(unixSmoke, /RUNNER_TEMP is required/u);
	assert.match(unixSmoke, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
	assert.doesNotMatch(unixSmoke, /v\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*/u);
	assert.match(windowsInstaller, /Invoke-MagentaCapture \$binaryPath "--help --offline smoke"/u);
	assert.doesNotMatch(windowsInstaller, /Invoke-MagentaCapture \$binaryPath "--help"(?:\r?\n|\s)/u);
	assert.match(workflow, /group: release-\$\{\{ inputs\.release_tag \|\| github\.ref_name \}\}/u);
	assert.match(workflow, /\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/u);
	assert.doesNotMatch(workflow, /gh release delete|--cleanup-tag/u);
	assert.doesNotMatch(workflow, /softprops\/action-gh-release/u);
	assert.doesNotMatch(workflow, /gh release create|gh release upload/u);
	assert.match(workflow, /publish:\s+[\s\S]*environment:\s+[\s\S]*name: cli-release/u);
	assert.match(releasePublisher, /Existing non-empty draft is not bound to SOURCE_COMMIT/u);
	assert.match(releasePublisher, /Pre-existing empty draft is not bound to SOURCE_COMMIT/u);
	assert.match(releasePublisher, /GitHub draft asset does not match the verified bundle/u);
	assert.match(releasePublisher, /"--paginate", "--slurp"/u);
	assert.match(releasePublisher, /Release \$\{tag\} is already published; refusing to modify it/u);
	assertSourceOrder(
		releasePublisher,
		['const uploadOrder = ["SOURCE_COMMIT"', "uploadAsset", "publishDraft"],
		"draft publication",
	);
	assert.match(workflow, /extractReleaseNotes\(changelog, version\)/u);
	assert.doesNotMatch(workflow, /Fallback if no notes found|echo "Release \$VERSION"/u);
	assertSourceOrder(
		workflow,
		[
			"Run release checks and tests",
			"Upload source-bound unsigned candidates",
			"Sign inside-out",
			"Upload the sealed signed release artifact",
			"Idempotently stage and publish",
		],
		"release artifact flow",
	);
	assert.doesNotMatch(workflow, /gh release download \$\{\{ inputs\.release_tag/u);
	const releaseScript = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");
	assert.match(releaseScript, /runReleaseGate\(\{ expectedVersion: version, runCommand: run \}\)/u);
	assert.match(releaseScript, /const releaseTrust = readMacosReleaseTrust\(\)/u);
	assert.doesNotMatch(releaseScript, /run\("npm", \["run", "build"\]\)/u);
	assert.match(releaseScript, /verify-brand-version\.mjs/u);
	assert.match(releaseScript, /buildArtifactsTouched = true;\s+runReleaseGate/u);
	assert.match(releaseScript, /rollbackReleasePreparation\(\{ buildArtifactsTouched, snapshots \}\)/u);
	assert.match(releaseScript, /publication is not complete until the Release workflow starts and passes/u);
	assert.doesNotMatch(releaseScript, /Published source tag/u);
	assertSourceOrder(
		releaseScript,
		[
			"const preconditions = ensureReleasePreconditions();",
			"const releaseTrust = readMacosReleaseTrust();",
			"writeFileSync(brand.configPath, nextBrandSource);",
			"runReleaseGate({ expectedVersion: version, runCommand: run });",
			"run(\"git\", [...plan.releaseCommitArgs",
		],
		"configured macOS trust before release mutation and history",
	);
	assertSourceOrder(
		releaseGate,
		[
			'runCommand("npm", ["run", "clean"]);',
			'runCommand("npm", ["run", "build:offline"]);',
			"prepareArtifacts();",
			"runCommand(nodeExecutable, verifyArgs);",
			'runCommand("npm", ["run", "check:release"]);',
			'runCommand("npm", ["test"]);',
		],
		"shared release gate",
	);
	assertSourceOrder(
		releaseScript,
		[
			'run(process.execPath, ["scripts/verify-brand-version.mjs", "--expected", version]);',
			"buildArtifactsTouched = true;",
			"runReleaseGate({ expectedVersion: version, runCommand: run });",
			"assertChangedPaths(releasePaths);",
		],
		"remote release",
	);
	assertSourceOrder(localRelease, ["runReleaseGate({", "const tarballs = new Map();"], "local release");

	const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
	for (const file of readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/u.test(name))) {
		const contents = readFileSync(new URL(file, workflowDirectory), "utf8");
		const actions = [...contents.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
		for (const action of actions) {
			assert.match(action, /@[0-9a-f]{40}$/u, `${file} must pin ${action} to a commit`);
		}
	}
});

test("Unix release smoke rejects missing runner state and malformed release tags before mutation", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-unix-smoke-contract-"));
	const releaseDirectory = join(root, "release");
	const installDirectory = join(root, "install");
	mkdirSync(releaseDirectory);
	const smokePath = new URL("./smoke-unix-release.sh", import.meta.url).pathname;
	const argsFor = (tag) => [smokePath, releaseDirectory, installDirectory, tag];
	try {
		const { RUNNER_TEMP: _runnerTemp, ...environmentWithoutRunnerTemp } = process.env;
		const missingRunnerTemp = spawnSync("bash", argsFor("v1.2.3"), {
			encoding: "utf8",
			env: environmentWithoutRunnerTemp,
		});
		assert.equal(missingRunnerTemp.status, 2);
		assert.match(missingRunnerTemp.stderr, /RUNNER_TEMP is required/u);

		for (const tag of ["1.2.3", "v1.2", "v1x2x3", "v1.2.3suffix", "v1.2.3.4"]) {
			const malformed = spawnSync("bash", argsFor(tag), {
				encoding: "utf8",
				env: { ...process.env, RUNNER_TEMP: root },
			});
			assert.equal(malformed.status, 2, `${tag}: ${malformed.stderr}`);
			assert.match(malformed.stderr, /Invalid release tag/u);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release gate validates a clean offline build before checks and tests", () => {
	const calls = [];
	runReleaseGate({
		expectedVersion: "0.0.30",
		nodeExecutable: "node-under-test",
		prepareArtifacts: () => calls.push(["prepare-artifacts"]),
		resourceMarker: "pi/coding-agent/dist/magenta-release.json",
		runCommand: (command, args) => calls.push([command, ...args]),
	});

	assert.deepEqual(calls, [
		["npm", "run", "clean"],
		["npm", "run", "build:offline"],
		["prepare-artifacts"],
		[
			"node-under-test",
			"scripts/verify-brand-version.mjs",
			"--expected",
			"0.0.30",
			"--require-dist",
			"--resource-marker",
			"pi/coding-agent/dist/magenta-release.json",
		],
		["npm", "run", "check:release"],
		["npm", "test"],
	]);
});

test("local release skips only optional gates, not clean build validation", () => {
	const calls = [];
	runReleaseGate({
		nodeExecutable: "node-under-test",
		runCommand: (command, args) => calls.push([command, ...args]),
		skipCheck: true,
		skipTest: true,
	});

	assert.deepEqual(calls, [
		["npm", "run", "clean"],
		["npm", "run", "build:offline"],
		["node-under-test", "scripts/verify-brand-version.mjs", "--require-dist"],
	]);
});

test("pre-commit rollback preserves existing output before build and removes output after build starts", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-rollback-"));
	const sourcePath = join(root, "version.txt");
	const distPath = join(root, "dist");
	const snapshots = new Map([["version.txt", "old version\n"]]);
	try {
		writeFileSync(sourcePath, "candidate version\n");
		mkdirSync(distPath);
		writeFileSync(join(distPath, "cli.js"), "existing output\n");
		let cleanCalls = 0;
		const cleanBuildArtifacts = () => {
			cleanCalls += 1;
			rmSync(distPath, { force: true, recursive: true });
		};

		rollbackReleasePreparation({
			buildArtifactsTouched: false,
			cleanBuildArtifacts,
			root,
			snapshots,
		});
		assert.equal(readFileSync(sourcePath, "utf8"), "old version\n");
		assert.equal(readFileSync(join(distPath, "cli.js"), "utf8"), "existing output\n");
		assert.equal(cleanCalls, 0);

		writeFileSync(sourcePath, "candidate version\n");
		rollbackReleasePreparation({
			buildArtifactsTouched: true,
			cleanBuildArtifacts,
			root,
			snapshots,
		});
		assert.equal(readFileSync(sourcePath, "utf8"), "old version\n");
		assert.equal(cleanCalls, 1);
		assert.equal(existsSync(distPath), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects invalid, non-increasing, or unsafe release targets", () => {
	assert.throws(() => resolveReleaseVersion("0.0.23", "v0.0.24"), /Invalid release target/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "0.0.23"), /must be greater/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "0.0.22"), /must be greater/u);
	assert.throws(() => resolveReleaseVersion("0.0.23", "01.0.0"), /Invalid release target/u);
	assert.throws(() => resolveReleaseVersion("9007199254740991.0.0", "major"), /safe integers/u);
});

test("parses an explicit exact-version unpublished recovery without weakening normal release syntax", () => {
	assert.deepEqual(parseReleaseArguments(["patch"]), { abandonedVersion: undefined, target: "patch" });
	assert.deepEqual(parseReleaseArguments(["--abandon-unpublished=0.0.30", "0.0.31"]), {
		abandonedVersion: "0.0.30",
		target: "0.0.31",
	});
	assert.throws(() => parseReleaseArguments(["--abandon-unpublished=0.0.30"]), /Usage/u);
	assert.throws(() => parseReleaseArguments(["--abandon-unpublished=v0.0.30", "patch"]), /Invalid/u);
	assert.throws(
		() => parseReleaseArguments(["--abandon-unpublished=0.0.30", "--abandon-unpublished=0.0.30", "patch"]),
		/Usage/u,
	);
});

test("requires the active product version to match the latest published CLI release", () => {
	assert.equal(
		assertLatestPublishedVersion("0.0.29", {
			draft: false,
			prerelease: false,
			tag_name: "v0.0.29",
		}),
		"0.0.29",
	);
	assert.throws(
		() =>
			assertLatestPublishedVersion("0.0.28", {
				draft: false,
				prerelease: false,
				tag_name: "v0.0.27",
			}),
		/Repair or rerun the existing version/u,
	);
	assert.equal(
		assertLatestPublishedVersion(
			"0.0.30",
			{ draft: false, prerelease: false, tag_name: "v0.0.29" },
			{ abandonedVersion: "0.0.30" },
		),
		"0.0.29",
	);
	assert.throws(
		() =>
			assertLatestPublishedVersion(
				"0.0.30",
				{ draft: false, prerelease: false, tag_name: "v0.0.29" },
				{ abandonedVersion: "0.0.31" },
			),
		/must exactly match/u,
	);
	assert.throws(
		() =>
			assertLatestPublishedVersion(
				"0.0.30",
				{ draft: false, prerelease: false, tag_name: "v0.0.30" },
				{ abandonedVersion: "0.0.30" },
			),
		/must be newer/u,
	);
	assert.throws(
		() => assertLatestPublishedVersion("0.0.29", { draft: false, prerelease: false, tag_name: "v01.0.0" }),
		/Invalid latest public CLI release version/u,
	);
});

test("requires one exact remote annotated tag for abandoned-version recovery", () => {
	const tagObject = "1".repeat(40);
	const taggedCommit = "2".repeat(40);
	assert.equal(
		parseRemoteAnnotatedTagCommit(
			`${tagObject}\trefs/tags/v0.0.30\n${taggedCommit}\trefs/tags/v0.0.30^{}\n`,
			"0.0.30",
		),
		taggedCommit,
	);
	assert.throws(
		() => parseRemoteAnnotatedTagCommit(`${taggedCommit}\trefs/tags/v0.0.30\n`, "0.0.30"),
		/annotated source tag/u,
	);
	assert.throws(
		() =>
			parseRemoteAnnotatedTagCommit(
				`${tagObject}\trefs/tags/v0.0.30\nnot-a-sha\trefs/tags/v0.0.30^{}\n`,
				"0.0.30",
			),
		/invalid object id/u,
	);
});

test("fails closed when the public release lookup fails", async () => {
	await assert.rejects(
		() =>
			verifyLatestPublishedVersion("0.0.29", async () => ({
				ok: false,
				status: 403,
			})),
		/GitHub API returned 403/u,
	);
	await assert.rejects(
		() => verifyLatestPublishedVersion("0.0.29", async () => Promise.reject(new Error("offline"))),
		/Could not query.*offline/u,
	);
});

test("abandoned-version recovery rejects any already-published exact release", async () => {
	assert.equal(
		await verifyAbandonedVersionIsUnpublished("0.0.30", async () => ({ ok: false, status: 404 })),
		"absent",
	);
	assert.equal(
		await verifyAbandonedVersionIsUnpublished("0.0.30", async () => ({
			ok: true,
			status: 200,
			json: async () => ({ draft: true, prerelease: false, tag_name: "v0.0.30" }),
		})),
		"draft",
	);
	await assert.rejects(
		() =>
			verifyAbandonedVersionIsUnpublished("0.0.30", async () => ({
				ok: true,
				status: 200,
				json: async () => ({ draft: false, prerelease: true, tag_name: "v0.0.30" }),
			})),
		/already published as a prerelease/u,
	);
	await assert.rejects(
		() =>
			verifyAbandonedVersionIsUnpublished("0.0.30", async () => ({
				ok: true,
				status: 200,
				json: async () => ({ draft: false, prerelease: false, tag_name: "v0.0.30" }),
			})),
		/already published/u,
	);
});

test("updates only the active brand product version field", () => {
	const source = [
		"export const BRAND_CONFIG = {",
		'\tname: "Magenta",',
		'\tversion: "0.0.23",',
		"\tinfra: {",
		'\t\tpiVersion: "0.80.2",',
		'\t\tharnessVersion: "0.1.0",',
		"\t},",
		"};",
		"",
	].join("\n");
	const updated = updateBrandVersionSource(source, "0.0.23", "0.0.24");
	assert.match(updated, /version: "0\.0\.24"/u);
	assert.match(updated, /piVersion: "0\.80\.2"/u);
	assert.match(updated, /harnessVersion: "0\.1\.0"/u);
});

test("reads the active brand from valid TOML variants instead of a Pi package", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-brand-"));
	try {
		mkdirSync(join(root, "brands/magenta"), { recursive: true });
		writeFileSync(
			join(root, "brands/registry.toml"),
			["active='magenta'", "", "[[brands]]", "name='magenta'", "path='magenta/magenta.brand.ts'"].join(
				"\n",
			),
		);
		writeFileSync(
			join(root, "brands/magenta/magenta.brand.ts"),
			[
				"export const BRAND_CONFIG = {",
				'\tname: "Magenta",',
				'\tversion: "0.0.23",',
				'\tinfra: { piVersion: "0.80.2" },',
				"};",
			].join("\n"),
		);
		const brand = readActiveBrand(root);
		assert.equal(brand.displayName, "Magenta");
		assert.equal(brand.version, "0.0.23");
		assert.equal(brand.configRelativePath, "brands/magenta/magenta.brand.ts");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects an active brand path outside the brands directory", () => {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-brand-"));
	try {
		mkdirSync(join(root, "brands"), { recursive: true });
		writeFileSync(
			join(root, "brands/registry.toml"),
			["active = 'magenta'", "", "[[brands]]", "name = 'magenta'", "path = '../outside.ts'"].join("\n"),
		);
		assert.throws(() => readActiveBrand(root), /escapes the brands directory/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("finalizes a non-empty Unreleased section and restores the next-cycle heading", () => {
	const source = [
		"# Changelog",
		"",
		"Intro.",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Release commands use the product version.",
		"",
		"## [0.0.23] - 2026-07-16",
		"- Previous release.",
		"",
	].join("\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	assert.match(released, /## \[0\.0\.24\] - 2026-07-17/u);
	assert.doesNotMatch(released, /^## \[Unreleased\]$/mu);
	const nextCycle = addUnreleasedSection(released);
	assert.match(nextCycle, /Intro\.\n\n## \[Unreleased\]\n\n## \[0\.0\.24\]/u);
});

test("extracts only complete dated release notes outside Markdown fences", () => {
	const source = [
		"# Changelog",
		"",
		"```md",
		"## [0.0.24] - 1999-01-01",
		"### Fake",
		"- Fake entry.",
		"```",
		"",
		"## [0.0.24] - 2026-07-17",
		"",
		"### Fixed",
		"- Crash-safe updates.",
		"",
		"## [0.0.23] - 2026-07-16",
		"### Fixed",
		"- Previous release.",
		"",
	].join("\n");
	assert.equal(extractReleaseNotes(source, "0.0.24"), "### Fixed\n- Crash-safe updates.\n");

	assert.throws(
		() => extractReleaseNotes(source.replace("## [0.0.24] - 2026-07-17", "## [0.0.24]"), "0.0.24"),
		/must include an ISO release date/u,
	);
	assert.throws(
		() =>
			extractReleaseNotes(
				source.replace("### Fixed\n- Crash-safe updates.", "```md\n### Fake\n- Fake entry.\n```"),
				"0.0.24",
			),
		/no subsection outside a code fence/u,
	);
});

test("ignores changelog marker text inside prose and fenced examples", () => {
	const source = [
		"# Changelog",
		"",
		"The text `## [Unreleased]` names the required heading.",
		"",
		"```md",
		"## [Unreleased]",
		"```",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Safe release parsing.",
		"",
		"## [0.0.23] - 2026-07-16",
		"",
	].join("\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	assert.match(released, /```md\n## \[Unreleased\]\n```/u);
	assert.match(released, /## \[0\.0\.24\] - 2026-07-17/u);
});

test("preserves CRLF when adding the next Unreleased heading", () => {
	const source = [
		"# Changelog",
		"",
		"## [Unreleased]",
		"",
		"### Fixed",
		"- Safe release parsing.",
		"",
		"## [0.0.23] - 2026-07-16",
		"",
	].join("\r\n");
	const released = finalizeChangelog(source, "0.0.24", "2026-07-17");
	const nextCycle = addUnreleasedSection(released);
	assert.match(nextCycle, /## \[Unreleased\]\r\n\r\n## \[0\.0\.24\]/u);
});

test("rejects empty, duplicate, or already-finalized changelog state", () => {
	const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.0.23] - 2026-07-16\n";
	assert.throws(() => finalizeChangelog(empty, "0.0.24", "2026-07-17"), /must contain/u);
	const duplicate = `${empty}\n## [Unreleased]\n`;
	assert.throws(() => finalizeChangelog(duplicate, "0.0.24", "2026-07-17"), /exactly one/u);
	assert.throws(() => addUnreleasedSection(empty), /already contains/u);
});

test("accepts only the exact release file set", () => {
	const expected = [
		"brands/magenta/magenta.brand.ts",
		"pi/coding-agent/CHANGELOG.md",
		"pi/coding-agent/src/brand-version.generated.ts",
	];
	assert.doesNotThrow(() => assertExpectedChangedPaths([...expected].reverse(), expected));
	assert.throws(
		() => assertExpectedChangedPaths([...expected, "pi/ai/src/providers/openrouter.models.ts"], expected),
		/unexpected paths/u,
	);
});

test("uses the official source remote and lease-protected fully qualified pushes", () => {
	assert.equal(isOfficialSourceRemote("git@github.com:Minions-Land/Magenta.git"), true);
	assert.equal(isOfficialSourceRemote("https://github.com/Minions-Land/Magenta"), true);
	assert.equal(isOfficialSourceRemote("git@github.com:someone/Magenta.git"), false);
	assert.deepEqual(RELEASE_MAIN_FETCH_ARGS, [
		"fetch",
		"origin",
		"+refs/heads/main:refs/remotes/origin/main",
	]);

	const remoteMainSha = "a".repeat(40);
	const plan = createReleaseGitPlan({ displayName: "Magenta", remoteMainSha, version: "0.0.24" });
	assert.deepEqual(plan.tagCreateArgs, ["tag", "-a", "v0.0.24", "-m", "Magenta CLI v0.0.24"]);
	assert.deepEqual(plan.mainPushArgs, [
		"push",
		`--force-with-lease=refs/heads/main:${remoteMainSha}`,
		"origin",
		"HEAD:refs/heads/main",
	]);
	assert.deepEqual(plan.tagPushArgs, ["push", "origin", "refs/tags/v0.0.24:refs/tags/v0.0.24"]);
	assert.equal(plan.releaseCommitArgs.includes("--only"), true);
	assert.equal(plan.nextCycleCommitArgs.includes("--only"), true);
});

test("parses porcelain paths and rejects rename or copy records", () => {
	assert.deepEqual(parseChangedPaths(" M file with spaces.md\0?? scripts/new-file.mjs\0"), [
		"file with spaces.md",
		"scripts/new-file.mjs",
	]);
	assert.throws(() => parseChangedPaths("R  renamed.md\0original.md\0"), /renamed or copied/u);
	assert.throws(() => parseChangedPaths("C  copied.md\0original.md\0"), /renamed or copied/u);
});

function git(cwd, args, { allowFailure = false } = {}) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
	return result;
}

function gitWithIdentity(cwd, args, options) {
	return git(cwd, ["-c", "user.name=Release Test", "-c", "user.email=release@example.com", ...args], options);
}

function createGitFixture() {
	const root = mkdtempSync(join(tmpdir(), "magenta-release-git-"));
	const remote = join(root, "remote.git");
	const repo = join(root, "repo");
	mkdirSync(repo);
	git(root, ["init", "--bare", remote]);
	git(repo, ["init", "-b", "main"]);
	writeFileSync(join(repo, "version.txt"), "0.0.23\n");
	writeFileSync(join(repo, "CHANGELOG.md"), "## [Unreleased]\n");
	git(repo, ["add", "--", "version.txt", "CHANGELOG.md"]);
	gitWithIdentity(repo, ["commit", "-m", "initial"]);
	git(repo, ["remote", "add", "origin", remote]);
	git(repo, ["push", "-u", "origin", "main"]);
	git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
	return {
		initialHead: git(repo, ["rev-parse", "HEAD"]).stdout.trim(),
		remote,
		repo,
		root,
	};
}

test("Git plan creates an annotated release tag before the next-cycle commit", () => {
	const fixture = createGitFixture();
	try {
		const plan = createReleaseGitPlan({
			displayName: "Magenta",
			remoteMainSha: fixture.initialHead,
			version: "0.0.24",
		});
		writeFileSync(join(fixture.repo, "version.txt"), "0.0.24\n");
		gitWithIdentity(fixture.repo, [...plan.releaseCommitArgs, "version.txt"]);
		const releaseCommit = git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim();
		gitWithIdentity(fixture.repo, plan.tagCreateArgs);
		writeFileSync(join(fixture.repo, "CHANGELOG.md"), "## [Unreleased]\n\n## [0.0.24]\n");
		gitWithIdentity(fixture.repo, [...plan.nextCycleCommitArgs, "CHANGELOG.md"]);
		const nextCycleCommit = git(fixture.repo, ["rev-parse", "HEAD"]).stdout.trim();
		git(fixture.repo, plan.mainPushArgs);
		git(fixture.repo, plan.tagPushArgs);

		assert.notEqual(nextCycleCommit, releaseCommit);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim(),
			nextCycleCommit,
		);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "cat-file", "-t", "v0.0.24"]).stdout.trim(),
			"tag",
		);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "v0.0.24^{}"]).stdout.trim(),
			releaseCommit,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("lease-protected main push rejects a concurrent remote advance", () => {
	const fixture = createGitFixture();
	try {
		writeFileSync(join(fixture.repo, "version.txt"), "local release\n");
		gitWithIdentity(fixture.repo, ["commit", "--only", "-m", "local", "--", "version.txt"]);
		const plan = createReleaseGitPlan({
			displayName: "Magenta",
			remoteMainSha: fixture.initialHead,
			version: "0.0.24",
		});

		const other = join(fixture.root, "other");
		git(fixture.root, ["clone", fixture.remote, other]);
		writeFileSync(join(other, "version.txt"), "remote advance\n");
		gitWithIdentity(other, ["commit", "--only", "-m", "remote", "--", "version.txt"]);
		git(other, ["push", "origin", "main"]);
		const remoteAdvance = git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim();

		const rejected = git(fixture.repo, plan.mainPushArgs, { allowFailure: true });
		assert.notEqual(rejected.status, 0);
		assert.equal(
			git(fixture.root, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]).stdout.trim(),
			remoteAdvance,
		);
	} finally {
		rmSync(fixture.root, { recursive: true, force: true });
	}
});
