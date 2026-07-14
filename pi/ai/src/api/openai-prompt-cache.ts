export const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

const HASH_HEX_LENGTH = 32;
const HASH_SEPARATOR = "-";

// Browser-safe 128-bit string digest. Prompt cache keys are affinity hints, not
// authentication material; the digest prevents long IDs with a shared prefix
// from collapsing to the same provider key without pulling Node crypto into
// browser bundles.
function digest128(value: string): string {
	let h1 = 1_779_033_703;
	let h2 = 3_144_134_277;
	let h3 = 1_013_904_242;
	let h4 = 2_773_480_762;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		h1 = h2 ^ Math.imul(h1 ^ code, 597_399_067);
		h2 = h3 ^ Math.imul(h2 ^ code, 2_869_860_233);
		h3 = h4 ^ Math.imul(h3 ^ code, 951_274_213);
		h4 = h1 ^ Math.imul(h4 ^ code, 2_716_044_179);
	}
	h1 = Math.imul(h3 ^ (h1 >>> 18), 597_399_067);
	h2 = Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233);
	h3 = Math.imul(h1 ^ (h3 >>> 17), 951_274_213);
	h4 = Math.imul(h2 ^ (h4 >>> 19), 2_716_044_179);
	h1 ^= h2 ^ h3 ^ h4;
	h2 ^= h1;
	h3 ^= h1;
	h4 ^= h1;
	return [h1, h2, h3, h4].map((part) => (part >>> 0).toString(16).padStart(8, "0")).join("");
}

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
	if (key === undefined) return undefined;
	const chars = Array.from(key);
	if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
	const prefixLength = OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH - HASH_SEPARATOR.length - HASH_HEX_LENGTH;
	return `${chars.slice(0, prefixLength).join("")}${HASH_SEPARATOR}${digest128(key)}`;
}
