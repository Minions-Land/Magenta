/** Environment variables explicitly allowed for OAuth-backed tests. */
const OAUTH_TOKEN_ENV_BY_PROVIDER = {
	anthropic: "ANTHROPIC_OAUTH_TOKEN",
	"github-copilot": "COPILOT_GITHUB_TOKEN",
	"openai-codex": "OPENAI_CODEX_OAUTH_TOKEN",
} as const;

/** Resolve a test OAuth token without reading or modifying persistent credentials. */
export async function resolveApiKey(provider: string): Promise<string | undefined> {
	const envName = OAUTH_TOKEN_ENV_BY_PROVIDER[provider as keyof typeof OAUTH_TOKEN_ENV_BY_PROVIDER];
	return envName === undefined ? undefined : process.env[envName];
}
