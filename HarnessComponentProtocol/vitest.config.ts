import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve sibling workspace packages to their TypeScript sources so tests run
// against current source (not stale dist). Mirrors pi/coding-agent's alias setup.
const aiSrcIndex = fileURLToPath(new URL("../pi/ai/src/index.ts", import.meta.url));
const aiSrcCompat = fileURLToPath(new URL("../pi/ai/src/compat.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../pi/agent/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/**/*.test.ts"],
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: aiSrcCompat },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
		],
	},
});
