import type { OAuthCredentials } from "../auth/types.ts";
import type { Api, Model } from "../types.ts";

/** Legacy extension OAuth prompt. */
export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

/** Legacy extension OAuth authorization link. */
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

/** Legacy extension OAuth device-code notification. */
export interface OAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthSelectOption {
	id: string;
	label: string;
}

export interface OAuthSelectPrompt {
	message: string;
	options: OAuthSelectOption[];
}

/** Callback surface retained only for coding-agent extension compatibility. */
export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void;
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	signal?: AbortSignal;
}

export type { OAuthCredentials };

/** @deprecated Alias for provider id string. */
export type OAuthProviderId = string;
export type OAuthProvider = OAuthProviderId;

/** @deprecated Legacy provider info. */
export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}

/**
 * @deprecated Legacy provider interface for extension compatibility.
 * Built-in providers delegate to canonical `OAuthAuth` in auth/oauth/*.
 */
export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;
	usesCallbackServer?: boolean;
	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
	getApiKey(credentials: OAuthCredentials): string;
	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}
