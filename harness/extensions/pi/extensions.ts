import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

/** Return the Harness-owned bundled pi extensions directory for source and built packages. */
export function getBundledExtensionsDir(): string {
	if (isBunBinary) {
		return join(dirname(process.execPath), "extensions", "bundled");
	}
	return join(__dirname, "bundled");
}
