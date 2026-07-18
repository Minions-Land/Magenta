export type ToolErrorCode =
	| "invalid_arguments"
	| "unauthorized"
	| "not_found"
	| "invalid_state"
	| "conflict"
	| "storage_error"
	| "spawn_failed";

export type ToolErrorDetails = {
	schemaVersion: 1;
	code: ToolErrorCode;
	message: string;
	retryable: boolean;
	target?: string;
	currentState?: string;
};

export class ToolExecutionError extends Error {
	readonly details: ToolErrorDetails;

	constructor(
		code: ToolErrorCode,
		message: string,
		options: { retryable?: boolean; target?: string; currentState?: string; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ToolExecutionError";
		this.details = {
			schemaVersion: 1,
			code,
			message,
			retryable: options.retryable ?? false,
			...(options.target === undefined ? {} : { target: options.target }),
			...(options.currentState === undefined ? {} : { currentState: options.currentState }),
		};
	}
}
