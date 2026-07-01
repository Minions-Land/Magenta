/**
 * Pi Brand Configuration
 *
 * Original upstream agent configuration from @earendil-works/pi-*
 */

import type { BrandConfig } from "../brand.interface.ts";

export const BRAND_CONFIG: BrandConfig = {
	name: "Pi",
	version: "0.80.2",
	packageScope: "@earendil-works",

	theme: {
		primaryColor: "#2196F3",      // Blue (pi's original color)
		accentColor: "#03A9F4",       // Light blue
		successColor: "#4CAF50",      // Green
		warningColor: "#FF9800",      // Orange
		errorColor: "#F44336",        // Red
	},

	cli: {
		binaryName: "pi",
		description: "AI coding assistant from Earendil Works",
		welcomeMessage: "Welcome to Pi",
		prompt: "pi>",
	},

	urls: {
		homepage: "https://github.com/earendil-works/pi",
		docs: "https://pi.earendil.dev",
		issues: "https://github.com/earendil-works/pi/issues",
		repository: "https://github.com/earendil-works/pi.git",
	},

	infra: {
		piVersion: "0.80.2",
		harnessVersion: "0.1.0",
		renamePiPackages: false,  // Keep upstream package names
	},

	productPackages: [],
};
