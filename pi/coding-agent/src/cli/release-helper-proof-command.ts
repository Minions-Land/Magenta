import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	getEmbeddedToolPath,
	getProcessToolsBinaryPath,
	HcpClientisbunbinaryurl,
	prepareEmbeddedHelperCacheRoot,
} from "@magenta/harness";

const PROOF_SCHEMA = "magenta.release-embedded-helper-proof.v1";
const ALLOWED_ARCHITECTURES = new Set(["arm64", "x64"]);

type ReleaseHelperKind = "fd" | "process-tools" | "rg";

export interface ReleaseEmbeddedHelperProof {
	schema: typeof PROOF_SCHEMA;
	platform: "darwin";
	architecture: "arm64" | "x64";
	helpers: Array<{
		kind: ReleaseHelperKind;
		path: string;
		sha256: string;
		size: number;
	}>;
}

interface ReleaseHelperProofDependencies {
	architecture?: string;
	cacheRoot?: string;
	getFdPath?(): string | null;
	getProcessToolsPath?(): string;
	getRgPath?(): string | null;
	platform?: string;
	trustedRoot?: string;
}

function pathIsWithin(parent: string, candidate: string): boolean {
	const pathFromParent = relative(parent, candidate);
	return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function inspectMaterializedHelper(kind: ReleaseHelperKind, inputPath: string | null, cacheRoot: string) {
	if (!inputPath) throw new Error(`Release helper did not materialize: ${kind}`);
	const inputStats = lstatSync(inputPath);
	if (!inputStats.isFile() || inputStats.isSymbolicLink()) {
		throw new Error(`Materialized release helper is not a regular file: ${kind}`);
	}
	const path = realpathSync(inputPath);
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error(`Materialized release helper is not a regular file: ${kind}`);
	}
	if (!pathIsWithin(cacheRoot, path)) {
		throw new Error(`Release helper did not come from the isolated embedded cache: ${kind}`);
	}
	const content = readFileSync(path);
	if (content.length === 0) throw new Error(`Materialized release helper is empty: ${kind}`);
	return {
		kind,
		path,
		sha256: createHash("sha256").update(content).digest("hex"),
		size: content.length,
	};
}

export function createReleaseEmbeddedHelperProof(
	dependencies: ReleaseHelperProofDependencies = {},
): ReleaseEmbeddedHelperProof {
	const platform = dependencies.platform ?? process.platform;
	const architecture = dependencies.architecture ?? process.arch;
	if (platform !== "darwin" || !ALLOWED_ARCHITECTURES.has(architecture)) {
		throw new Error(`Release helper proof requires native macOS arm64 or x64, got ${platform} ${architecture}`);
	}
	const requestedCacheRoot = resolve(dependencies.cacheRoot ?? join(homedir(), ".magenta", "cache"));
	const requestedTrustedRoot = resolve(
		dependencies.trustedRoot ?? (dependencies.cacheRoot === undefined ? homedir() : dirname(requestedCacheRoot)),
	);
	prepareEmbeddedHelperCacheRoot(requestedCacheRoot, requestedTrustedRoot);
	const processToolsPath = (dependencies.getProcessToolsPath ?? getProcessToolsBinaryPath)();
	const fdPath = (dependencies.getFdPath ?? (() => getEmbeddedToolPath("fd")))();
	const rgPath = (dependencies.getRgPath ?? (() => getEmbeddedToolPath("rg")))();
	const cacheRoot = realpathSync(requestedCacheRoot);
	const helpers = [
		inspectMaterializedHelper("process-tools", processToolsPath, cacheRoot),
		inspectMaterializedHelper("fd", fdPath, cacheRoot),
		inspectMaterializedHelper("rg", rgPath, cacheRoot),
	].sort((left, right) => left.kind.localeCompare(right.kind));
	return {
		schema: PROOF_SCHEMA,
		platform,
		architecture: architecture as "arm64" | "x64",
		helpers,
	};
}

export function handleReleaseHelperProofCommand(args: readonly string[]): void {
	if (args.length !== 0) throw new Error("_release-helper-proof does not accept arguments");
	if (process.env.MAGENTA_RELEASE_HELPER_PROOF !== "1") {
		throw new Error("_release-helper-proof requires MAGENTA_RELEASE_HELPER_PROOF=1");
	}
	const isCompiledBun =
		typeof (globalThis as { Bun?: unknown }).Bun !== "undefined" && HcpClientisbunbinaryurl(import.meta.url);
	if (!isCompiledBun) throw new Error("_release-helper-proof is available only in a compiled Bun executable");
	process.stdout.write(`${JSON.stringify(createReleaseEmbeddedHelperProof())}\n`);
}
