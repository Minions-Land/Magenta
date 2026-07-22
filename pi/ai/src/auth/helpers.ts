import type { ApiKeyAuth, ApiKeyCredential, AuthContext, OAuthAuth } from "./types.ts";

export type EnvApiKeyAuthOptions = {
	/** Optional provider base-URL variables, in precedence order. */
	baseUrlEnvVars?: readonly string[];
	/** Variables whose values authenticate with an Authorization Bearer header. */
	bearerTokenEnvVars?: readonly string[];
};

async function firstConfiguredValue(
	names: readonly string[],
	credential: ApiKeyCredential | undefined,
	ctx: AuthContext,
): Promise<string | undefined> {
	for (const name of names) {
		const value = credential?.env?.[name] ?? (await ctx.env(name));
		if (value) return value;
	}
	return undefined;
}

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(
	name: string,
	envVars: readonly string[],
	options: EnvApiKeyAuthOptions = {},
): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential }) => {
			let value = credential?.key;
			let source = value ? "stored credential" : undefined;
			let bearerToken = false;
			if (value) {
				bearerToken = (options.bearerTokenEnvVars ?? []).some((name) => credential?.env?.[name] === value);
			} else {
				for (const envVar of envVars) {
					const configured = await ctx.env(envVar);
					if (!configured) continue;
					value = configured;
					source = envVar;
					bearerToken = options.bearerTokenEnvVars?.includes(envVar) ?? false;
					break;
				}
			}
			if (!value || !source) return undefined;
			const baseUrl = await firstConfiguredValue(options.baseUrlEnvVars ?? [], credential, ctx);
			return {
				auth: {
					...(bearerToken ? { headers: { authorization: `Bearer ${value}` } } : { apiKey: value }),
					...(baseUrl ? { baseUrl } : {}),
				},
				source,
			};
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 */
export function lazyOAuth(input: { name: string; load: () => Promise<OAuthAuth> }): OAuthAuth {
	let promise: Promise<OAuthAuth> | undefined;
	const loaded = () => {
		promise ??= input.load();
		return promise;
	};
	return {
		name: input.name,
		login: async (interaction) => (await loaded()).login(interaction),
		refresh: async (credential) => (await loaded()).refresh(credential),
		toAuth: async (credential) => (await loaded()).toAuth(credential),
	};
}
