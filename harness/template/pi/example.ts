/**
 * Example implementation for a harness module.
 *
 * This file demonstrates the standard structure for pi-sourced implementations.
 */

// Import from other harness modules using relative paths
// Example: import type { Session } from "../../session/pi/session.ts";

/**
 * Example configuration interface
 */
export interface ExampleOptions {
	someOption?: string;
}

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
