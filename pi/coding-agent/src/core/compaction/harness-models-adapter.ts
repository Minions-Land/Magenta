/**
 * Adapter that bridges pi's free-function completion transport to the harness
 * `Models` provider abstraction used by harness compaction / branch-summarization.
 *
 * Architecture (mirrors harness-skills-adapter.ts and the HCP/HcpMagnet split): the
 * harness concrete impl calls only `models.completeSimple(model, context, options)`.
 * pi historically completes via the free `completeSimple` from
 * "@earendil-works/pi-ai/compat" (plus an optional `streamFn` transport), and injects
 * request auth (apiKey / headers / env) into the options object. This adapter wraps
 * that pi-owned transport + auth into a `Models`-shaped object so the harness compaction
 * functions can be reused unchanged.
 *
 * Only `completeSimple` is exercised by harness compaction, so the other `Models`
 * members are intentionally left unimplemented (the object is cast through `unknown`).
 * The streaming seam lives here rather than in harness: when `streamFn` is supplied the
 * request is routed through it (final message awaited via `stream.result()`), otherwise
 * the non-streaming compat `completeSimple` is used. This keeps harness provider-agnostic.
 *
 * IMPORTANT: `completeSimple` is imported from "@earendil-works/pi-ai/compat" so that the
 * reasoning test's `vi.mock("@earendil-works/pi-ai/compat")` intercepts it, and the auth
 * fields are merged INTO the options object the harness passes (the test asserts
 * `call[2]` carries both `reasoning` and `apiKey`).
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Context, Model, Models, SimpleStreamOptions } from "@earendil-works/pi-ai/compat";
import { completeSimple } from "@earendil-works/pi-ai/compat";

/** Request auth + optional streaming transport injected by pi into every completion. */
export interface CompactionModelsAuth {
	/** API key resolved by pi's auth flow. */
	apiKey?: string;
	/** Custom HTTP headers merged with provider defaults. */
	headers?: Record<string, string>;
	/** Provider-scoped environment values. */
	env?: Record<string, string>;
	/**
	 * Optional streaming transport. When present the completion is routed through it and the
	 * final message awaited via `stream.result()`; otherwise the non-streaming compat
	 * `completeSimple` is used.
	 */
	streamFn?: StreamFn;
}

/**
 * Build a `Models` provider object whose `completeSimple` wraps pi's compat `completeSimple`
 * (or `streamFn`) and injects the supplied auth into the harness-provided options.
 *
 * Only `completeSimple` is implemented; harness compaction does not call any other member.
 */
export function createCompactionModels(auth: CompactionModelsAuth): Models {
	const models = {
		completeSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessage> {
			// harness passes { maxTokens, signal, reasoning? }; inject pi's request auth.
			const merged: SimpleStreamOptions = {
				...options,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
			};
			if (auth.streamFn) {
				return Promise.resolve(auth.streamFn(model, context, merged)).then((stream) => stream.result());
			}
			return completeSimple(model, context, merged);
		},
	};
	// Only completeSimple is exercised by harness compaction; the remaining Models members
	// are not called on this instance, so the partial object is cast to the full interface.
	return models as unknown as Models;
}
