/**
 * Magenta Brand Configuration
 */

import type { BrandConfig } from "../brand.interface.ts";

export const BRAND_CONFIG: BrandConfig = {
	/** Agent/product name (used in CLI, TUI, docs) */
	name: "Magenta",

	/** Product version (independent of infrastructure versions) */
	version: "0.0.19",

	/** NPM package scope for product-specific packages */
	packageScope: "@magenta",

	/** Default config directory name */
	configDirName: ".magenta",

	/** Visual theme */
	theme: {
		primaryColor: "#E91E63",      // Pink/Magenta
		accentColor: "#9C27B0",       // Purple
		successColor: "#4CAF50",      // Green
		warningColor: "#FF9800",      // Orange
		errorColor: "#F44336",        // Red
	},

	/** CLI configuration */
	cli: {
		binaryName: "magenta",
		description: "AI coding assistant with read, bash, edit, write tools",
		welcomeMessage: "Welcome to Magenta 🎨",
		prompt: "magenta>",
	},

	/** Project URLs */
	urls: {
		homepage: "https://github.com/Minions-Land/Magenta",
		docs: "https://github.com/Minions-Land/Magenta/tree/main/docs",
		issues: "https://github.com/Minions-Land/Magenta/issues",
		repository: "https://github.com/Minions-Land/Magenta.git",
	},

	/** Infrastructure layer versions (reference only, synced from upstream) */
	infra: {
		/** pi/* packages version (from upstream @earendil-works/pi-*) */
		piVersion: "0.80.2",

		/** harness version (Magenta's execution layer, evolves with pi) */
		harnessVersion: "0.1.0",

		/** Keep package names from upstream or rename to @magenta scope?
		 * false = @earendil-works/pi-* (track upstream, easier to pull updates)
		 * true = @magenta/* (full fork, independent evolution)
		 */
		renamePiPackages: false,
	},

	/** Product-layer packages (Magenta-specific, use product version) */
	productPackages: [
		// Currently none - all packages are infra layer
		// Future: @magenta/extensions, @magenta/themes, @magenta/config-presets
	],
};
