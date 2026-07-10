/**
 * Example implementation for a harness module.
 *
 * This file demonstrates the standard structure for pi-sourced implementations.
 */

// Import from other harness modules using relative paths
// Example: import type { Session } from "../_magenta/session/pi/session.ts";

/**
 * Example configuration type
 */
export type ExampleOptions = {
	someOption?: string;
};

/**
 * Example function - the main export of this module
 */
export function exampleFunction(input: string, _options?: ExampleOptions): string {
	return `Processed: ${input}`;
}

/**
 * Example constant
 */
export const EXAMPLE_CONSTANT = "example-value";
