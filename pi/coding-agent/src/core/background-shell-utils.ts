export const RESULT_LIMIT_BYTES = 50 * 1024;
export const TAIL_LIMIT_BYTES = 64 * 1024;

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appendTail(current: string, data: Buffer, limitBytes = TAIL_LIMIT_BYTES): string {
	let next = current + data.toString("utf8");
	const bytes = Buffer.byteLength(next, "utf8");
	if (bytes <= limitBytes) return next;

	let cut = bytes - limitBytes;
	let index = 0;
	while (index < next.length && cut > 0) {
		cut -= Buffer.byteLength(next[index], "utf8");
		index++;
	}
	next = next.slice(index);
	return next;
}

export function truncateTail(text: string, maxBytes = RESULT_LIMIT_BYTES): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

	let bytes = 0;
	let index = text.length;
	while (index > 0 && bytes < maxBytes) {
		index--;
		bytes += Buffer.byteLength(text[index], "utf8");
	}
	return { text: text.slice(index), truncated: true };
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}

export function timestampForFile(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, "-");
}

/** How a progress reading was derived, from most to least authoritative. */
export type ProgressSource = "marker" | "output" | "time";

/** Priority for progress sources: a higher number wins over a lower one. */
export const PROGRESS_SOURCE_PRIORITY: Record<ProgressSource, number> = {
	marker: 3,
	output: 2,
	time: 1,
};

/** A parsed progress reading with the value and how it was obtained. */
export type ShellProgress = {
	/** Fraction complete in [0, 1]. */
	value: number;
	/** How the value was derived. */
	source: ProgressSource;
};

/**
 * Hint word shown after the bar. Only time-based readings are flagged (as an
 * estimate), since they have no real progress signal and will keep climbing
 * even if the process stalls. Readings backed by real output need no hint.
 */
export const PROGRESS_SOURCE_HINT: Record<ProgressSource, string> = {
	marker: "",
	output: "",
	time: "estimated",
};

// Explicit marker form: `@@progress 0.42` or `@@progress 42%` (optional trailing note).
const MARKER_RE = /@@progress\s+(\d{1,3}(?:\.\d+)?)(%?)/i;
// Percent form: a number 0-100 immediately followed by `%` (e.g. `42%`, ` 7.5%`).
const PERCENT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/g;
// Counter form: `[n/total]` or `n/total` where total > 0 (e.g. `[123/456]`, `3/10`).
const COUNTER_RE = /\[?\b(\d+)\s*\/\s*(\d+)\b\]?/g;

/**
 * Detect an explicit `@@progress <value>` marker in a chunk. The value may be a
 * fraction (`0.42`) or a percent (`42%`). Returns the LAST marker in the chunk,
 * or `undefined` when none is present.
 */
export function detectProgressMarker(text: string): number | undefined {
	let found: number | undefined;
	for (const line of text.split(/\r?\n/)) {
		const match = MARKER_RE.exec(line);
		if (!match) continue;
		const raw = Number.parseFloat(match[1]);
		if (!Number.isFinite(raw)) continue;
		// A trailing `%` (or a value > 1) means it is expressed on a 0-100 scale.
		const value = match[2] === "%" || raw > 1 ? raw / 100 : raw;
		found = clampFraction(value);
	}
	return found;
}

/**
 * Remove `@@progress ...` marker lines from a chunk so they never pollute the
 * visible output tail. Non-marker content is preserved verbatim.
 */
export function stripProgressMarkers(text: string): string {
	if (!text.includes("@@progress")) return text;
	// Remove each marker line together with its own trailing newline (if any), so
	// no blank gap is left behind in the visible output.
	return text.replace(/@@progress\s+\d{1,3}(?:\.\d+)?%?[^\n]*(?:\r?\n|$)/gi, "");
}

/**
 * Detect a progress fraction from a chunk of process output using zero-config
 * heuristics. Scans for the LAST percent token (`NN%`) or counter token
 * (`[n/total]`) in the chunk, since progress lines typically overwrite and the
 * most recent value is the freshest. Returns `undefined` when nothing matches,
 * so callers keep the previous reading rather than resetting it.
 */
export function detectProgressFromChunk(text: string): number | undefined {
	let percent: number | undefined;
	for (const match of text.matchAll(PERCENT_RE)) {
		const n = Number.parseFloat(match[1]);
		if (Number.isFinite(n) && n >= 0 && n <= 100) percent = n / 100;
	}
	if (percent !== undefined) return clampFraction(percent);

	let counter: number | undefined;
	for (const match of text.matchAll(COUNTER_RE)) {
		const done = Number.parseInt(match[1], 10);
		const total = Number.parseInt(match[2], 10);
		if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done <= total) counter = done / total;
	}
	if (counter !== undefined) return clampFraction(counter);

	return undefined;
}

/**
 * Merge a newly detected reading into the current progress, honoring source
 * priority: an equal-or-higher-priority source updates the value; a
 * lower-priority source never overwrites a better one.
 */
export function mergeProgress(current: ShellProgress | undefined, next: ShellProgress): ShellProgress {
	if (!current) return next;
	return PROGRESS_SOURCE_PRIORITY[next.source] >= PROGRESS_SOURCE_PRIORITY[current.source] ? next : current;
}

/** Compute a time-based progress fraction, capped just below full while running. */
export function timeProgressFraction(elapsedMs: number, expectedSeconds: number): number | undefined {
	if (!(expectedSeconds > 0)) return undefined;
	return clampFraction(Math.min(elapsedMs / (expectedSeconds * 1000), 0.99));
}

function clampFraction(value: number): number {
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

/**
 * Render a compact unicode progress bar plus percentage, e.g. `▓▓▓▓░░░░ 42%`.
 * Time-based readings additionally get an ` estimated` hint. Accepts either a
 * bare fraction or a {@link ShellProgress} (whose source drives the hint).
 * `width` is the number of bar cells.
 */
export function renderProgressBar(progress: number | ShellProgress, width = 10): string {
	const value = typeof progress === "number" ? progress : progress.value;
	const source = typeof progress === "number" ? undefined : progress.source;
	const fraction = clampFraction(value);
	const filled = Math.round(fraction * width);
	const bar = "▓".repeat(filled) + "░".repeat(Math.max(0, width - filled));
	const pct = Math.round(fraction * 100);
	const hintWord = source ? PROGRESS_SOURCE_HINT[source] : "";
	const hint = hintWord ? ` ${hintWord}` : "";
	return `${bar} ${pct}%${hint}`;
}
