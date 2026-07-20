import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type ClipboardModule = {
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

type ClipboardRequire = (id: string) => unknown;

const CLIPBOARD_PACKAGE = "@mariozechner/clipboard";
const moduleRequire = createRequire(import.meta.url);
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export function getPackagedClipboardNativeRequest(
	runtimePlatform: NodeJS.Platform = process.platform,
	runtimeArch: string = process.arch,
): string | undefined {
	if (runtimePlatform === "darwin" && (runtimeArch === "arm64" || runtimeArch === "x64")) {
		return "@mariozechner/clipboard-darwin-universal/clipboard.darwin-universal.node";
	}
	if (runtimePlatform === "linux" && runtimeArch === "x64") {
		return "@mariozechner/clipboard-linux-x64-gnu/clipboard.linux-x64-gnu.node";
	}
	if (runtimePlatform === "win32" && runtimeArch === "x64") {
		return "@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node";
	}
	return undefined;
}

function createPackagedClipboardRequire(
	packageRoot: string,
	runtimePlatform: NodeJS.Platform,
	runtimeArch: string,
): ClipboardRequire {
	const requireFromRoot = createRequire(pathToFileURL(packageRoot).href);
	return (id) => {
		if (id !== CLIPBOARD_PACKAGE) return requireFromRoot(id);
		const nativeRequest = getPackagedClipboardNativeRequest(runtimePlatform, runtimeArch);
		return requireFromRoot(nativeRequest ?? id);
	};
}

/** Resolve native clipboard packages from the verified runtime archive, then the legacy executable root. */
export function createExecutableClipboardRequires(
	executablePath = process.execPath,
	runtimePlatform: NodeJS.Platform = process.platform,
	runtimeArch: string = process.arch,
): ClipboardRequire[] {
	const executableDirectory = dirname(executablePath);
	return [
		createPackagedClipboardRequire(
			join(executableDirectory, "runtime", "package.json"),
			runtimePlatform,
			runtimeArch,
		),
		createPackagedClipboardRequire(join(executableDirectory, "package.json"), runtimePlatform, runtimeArch),
	];
}

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, ...createExecutableClipboardRequires()],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		try {
			return requireClipboard(CLIPBOARD_PACKAGE) as ClipboardModule;
		} catch {
			// Try the next resolution root.
		}
	}
	return null;
}

const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };
