/** Largest delay Node accepts without coercing the timer to roughly 1 ms. */
export const NODE_MAX_TIMEOUT_MS = 2_147_483_647;
export const NODE_MAX_TIMEOUT_SECONDS = NODE_MAX_TIMEOUT_MS / 1000;

function invalidTimeout(name: string, requirement: string): RangeError {
	return new RangeError(`Invalid ${name}: ${requirement}`);
}

/** Validate an optional Node timer delay. `undefined` deliberately means no timer. */
export function validateNodeTimeoutMs(value: unknown, name = "timeout"): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw invalidTimeout(name, "must be a finite number greater than 0 milliseconds");
	}
	if (value > NODE_MAX_TIMEOUT_MS) {
		throw invalidTimeout(name, `maximum is ${NODE_MAX_TIMEOUT_MS} milliseconds`);
	}
	return value;
}

/** Validate seconds against Node's timer domain. `undefined` deliberately means no timer. */
export function validateNodeTimeoutSeconds(value: unknown, name = "timeout"): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw invalidTimeout(name, "must be a finite number of seconds");
	}
	if (value > NODE_MAX_TIMEOUT_SECONDS) {
		throw invalidTimeout(name, `maximum is ${NODE_MAX_TIMEOUT_SECONDS} seconds`);
	}
	return value;
}

/** Convert validated seconds to a delay suitable for `setTimeout`. */
export function nodeTimeoutSecondsToMs(value: unknown, name = "timeout"): number | undefined {
	const seconds = validateNodeTimeoutSeconds(value, name);
	return seconds === undefined ? undefined : seconds * 1000;
}
