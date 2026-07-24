import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCleanCompiledDist } from "./verify-clean-dist.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");

export const PROVIDER_TEST_CREDENTIAL_ENV_KEYS = Object.freeze([
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANT_LING_API_KEY",
	"AWS_ACCESS_KEY_ID",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_PROFILE",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GCLOUD_PROJECT",
	"GEMINI_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MOONSHOT_API_KEY",
	"NVIDIA_API_KEY",
	"OPENAI_API_KEY",
	"OPENAI_CODEX_OAUTH_TOKEN",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
]);

export function createDefaultTestEnvironment(source = process.env) {
	const environment = { ...source, PI_NO_LOCAL_LLM: "1" };
	for (const key of PROVIDER_TEST_CREDENTIAL_ENV_KEYS) delete environment[key];
	return environment;
}

export function getTestCommands({ e2e = false } = {}) {
	if (e2e) return [["run", "test", "--workspace", "@earendil-works/pi-ai"]];
	return [
		["run", "test:scripts"],
		["run", "test", "--workspaces", "--if-present"],
	];
}

export function assertTestWorkspaceReady(root = REPOSITORY_ROOT) {
	return assertCleanCompiledDist(root);
}

export function runTests({ e2e = false, environment = process.env } = {}) {
	assertTestWorkspaceReady();
	const childEnvironment = e2e ? { ...environment } : createDefaultTestEnvironment(environment);
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";

	for (const args of getTestCommands({ e2e })) {
		const result = spawnSync(npm, args, {
			cwd: REPOSITORY_ROOT,
			env: childEnvironment,
			stdio: "inherit",
		});
		if (result.error) throw result.error;
		if (result.status !== 0) return result.status ?? 1;
	}

	return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--e2e");
	if (unknownArguments.length > 0) {
		console.error(`Unknown test runner argument: ${unknownArguments[0]}`);
		process.exitCode = 2;
	} else {
		process.exitCode = runTests({ e2e: process.argv.includes("--e2e") });
	}
}
