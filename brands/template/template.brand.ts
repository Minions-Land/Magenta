/**
 * Brand Configuration Template
 *
 * Copy this file to create a new brand configuration:
 * 1. Copy brands/template/ to brands/yourbrand/
 * 2. Rename to yourbrand.brand.ts
 * 3. Edit all fields below
 * 4. Register in brands/registry.toml
 * 5. Run `npm run sync-brand`
 */

import type { BrandConfig } from "../brand.interface.ts";

export const BRAND_CONFIG: BrandConfig = {
	/** Agent name (shown in CLI, TUI, documentation) */
	name: "YourAgent",

	/** Product version (semantic versioning: major.minor.patch) */
	version: "0.0.1",

	/** NPM package scope (e.g., @yourcompany, @yourusername) */
	packageScope: "@youragent",

	/** Visual theme - choose your brand colors (hex format) */
	theme: {
		primaryColor: "#007ACC",      // Main brand color
		accentColor: "#00A0E3",       // Accent/highlight color
		successColor: "#4CAF50",      // Success state (usually green)
		warningColor: "#FF9800",      // Warning state (usually orange)
		errorColor: "#F44336",        // Error state (usually red)
	},

	/** CLI configuration */
	cli: {
		/** Command name users will type (e.g., 'youragent', 'ai', 'code') */
		binaryName: "youragent",

		/** One-line description for --help */
		description: "AI coding assistant with advanced execution capabilities",

		/** Welcome message shown on startup */
		welcomeMessage: "Welcome to YourAgent 🚀",

		/** REPL prompt (interactive mode) */
		prompt: "youragent>",
	},

	/** Project URLs (used in package.json, docs, error messages) */
	urls: {
		homepage: "https://github.com/youruser/youragent",
		docs: "https://docs.youragent.dev",
		issues: "https://github.com/youruser/youragent/issues",
		repository: "https://github.com/youruser/youragent.git",
	},

	/** Infrastructure layer versions (foundation packages) */
	infra: {
		/** Version of pi/* packages (ai, tui, agent-core, coding-agent) */
		piVersion: "0.80.2",

		/** Version of harness package (tool execution layer) */
		harnessVersion: "0.1.0",

		/** Should pi packages be renamed to @{packageScope}/*?
		 * false = Keep @earendil-works/pi-* (easier to sync upstream changes)
		 * true = Rename to @youragent/* (full fork, independent evolution)
		 */
		renamePiPackages: false,
	},

	/** Product-specific packages (optional, use product version) */
	productPackages: [
		// Example: "@youragent/extensions", "@youragent/themes"
	],
};
