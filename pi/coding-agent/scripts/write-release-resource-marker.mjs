import { readFile, writeFile } from "node:fs/promises";

const sourcePath = new URL("../src/brand-version.generated.ts", import.meta.url);
const source = await readFile(sourcePath, "utf8");
const match = source.match(/BRAND_VERSION\s*=\s*["']([^"']+)["']/);
if (!match?.[1]) throw new Error("Unable to read Magenta brand version");

await writeFile(new URL("../dist/magenta-release.json", import.meta.url), `${JSON.stringify({ version: match[1] })}\n`);
