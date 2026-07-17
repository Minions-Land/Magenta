// Shared normalization for provider HTTP error objects.
//
// Provider SDKs expose status and response-body details under different fields.
// This helper surfaces those details while bounding their size and redacting
// credentials that a proxy, gateway, or serialized SDK error may echo.

export const MAX_PROVIDER_ERROR_BODY_CHARS = 4000;
const REDACTED = "[REDACTED]";
const SENSITIVE_FIELD_PATTERN = /^(?:authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|secret)$/i;

export interface NormalizedProviderError {
	/** HTTP status code, when one could be extracted from the SDK error object. */
	status?: number;
	/** Raw HTTP body reason, already redacted, trimmed, and truncated to the cap. */
	body?: string;
	/** Redacted `error.message`, or a safe serialization for a non-`Error` throw. */
	message: string;
	/** True when `message` already contains the body (no separate body to add). */
	messageCarriesBody: boolean;
}

type SdkErrorShape = Error & {
	statusCode?: unknown;
	status?: unknown;
	body?: unknown;
	error?: unknown;
	$metadata?: { httpStatusCode?: unknown };
	$response?: { statusCode?: unknown; body?: unknown };
};

export function normalizeProviderError(error: unknown): NormalizedProviderError {
	if (!(error instanceof Error)) {
		return { message: safeJsonStringify(error), messageCarriesBody: false };
	}

	const sdkError = error as SdkErrorShape;
	const status = extractStatus(sdkError);
	const body = extractBody(sdkError);
	const message = sanitizeProviderErrorText(error.message);
	const messageCarriesBody = body === undefined || message.includes(body);

	return {
		status,
		body,
		message,
		messageCarriesBody,
	} satisfies NormalizedProviderError;
}

function extractStatus(error: SdkErrorShape): number | undefined {
	if (typeof error.statusCode === "number") return error.statusCode;
	if (typeof error.status === "number") return error.status;
	if (typeof error.$metadata?.httpStatusCode === "number") return error.$metadata.httpStatusCode;
	if (typeof error.$response?.statusCode === "number") return error.$response.statusCode;
	return undefined;
}

function extractBody(error: SdkErrorShape): string | undefined {
	const bodyText = pickBodyText(error);
	if (bodyText === undefined) return undefined;
	const trimmed = sanitizeProviderErrorText(bodyText).trim();
	if (trimmed.length === 0) return undefined;
	return truncateErrorText(trimmed, MAX_PROVIDER_ERROR_BODY_CHARS);
}

function pickBodyText(error: SdkErrorShape): string | undefined {
	if (typeof error.body === "string") return error.body;
	if (isNonEmptyObject(error.error)) return safeJsonStringify(error.error);
	const responseBody = error.$response?.body;
	if (typeof responseBody === "string") return responseBody;
	if (isNonEmptyObject(responseBody)) return safeJsonStringify(responseBody);
	return undefined;
}

function isNonEmptyObject(value: unknown): boolean {
	return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

/** Compose a provider display string without exposing credential material. */
export function formatProviderError(norm: NormalizedProviderError, prefix?: string): string {
	let formatted: string;
	if (norm.messageCarriesBody || norm.status === undefined || norm.body === undefined) {
		formatted =
			prefix !== undefined && norm.status !== undefined
				? `${prefix} (${norm.status}): ${norm.message}`
				: norm.message;
	} else {
		formatted = prefix !== undefined ? `${prefix} (${norm.status}): ${norm.body}` : `${norm.status}: ${norm.body}`;
	}
	return sanitizeProviderErrorText(formatted);
}

export function truncateErrorText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

/**
 * Redact common credential forms from free-form error text. Structured JSON is
 * sanitized by key first; regex fallbacks cover header dumps and query strings.
 */
export function sanitizeProviderErrorText(text: string): string {
	let sanitized = text;
	const trimmed = text.trim();
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		try {
			sanitized = stringifyRedacted(JSON.parse(trimmed));
		} catch {
			// Fall through to free-form redaction.
		}
	}

	return sanitized
		.replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, `$1 ${REDACTED}`)
		.replace(/\b(sk-(?:ant-)?[A-Za-z0-9_-]{8,})\b/g, REDACTED)
		.replace(/\b(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, REDACTED)
		.replace(
			/(\b(?:authorization|proxy-authorization|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|secret)\b\s*[=:]\s*)(["']?)[^\s,"';&}\]]+\2/gi,
			`$1${REDACTED}`,
		);
}

function stringifyRedacted(value: unknown): string {
	try {
		const seen = new WeakSet<object>();
		const serialized = JSON.stringify(value, (key, entry: unknown) => {
			if (SENSITIVE_FIELD_PATTERN.test(key)) return REDACTED;
			if (entry && typeof entry === "object") {
				if (seen.has(entry)) return "[Circular]";
				seen.add(entry);
			}
			return entry;
		});
		return serialized === undefined ? String(value) : serialized;
	} catch {
		return String(value);
	}
}

export function safeJsonStringify(value: unknown): string {
	return sanitizeProviderErrorText(stringifyRedacted(value));
}
