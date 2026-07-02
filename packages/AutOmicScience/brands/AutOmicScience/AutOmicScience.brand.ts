/**
 * Package-local brand override for AutOmicScience.
 *
 * Colors are migrated from BioAgent/AutOmicScience/crates/aose-tui/src/theme.rs.
 */

import type { BrandConfig } from "../../../../brands/brand.interface.ts";

export const BRAND_CONFIG: BrandConfig = {
	name: "AutOmicScience",
	version: "0.1.0",
	packageScope: "@automic-science",

	theme: {
		primaryColor: "#006633",
		accentColor: "#008080",
		successColor: "#006633",
		warningColor: "#BF5700",
		errorColor: "#CC0000",
	},

	cli: {
		binaryName: "aose",
		description: "Rust-native omics analysis and bioinformatics research agent",
		welcomeMessage: "Welcome to AutOmicScience",
		prompt: "aose>",
	},

	urls: {
		homepage: "https://github.com/Minions-Land/AutOmicScience",
		docs: "https://github.com/Minions-Land/AutOmicScience/tree/main/docs",
		issues: "https://github.com/Minions-Land/AutOmicScience/issues",
		repository: "https://github.com/Minions-Land/AutOmicScience.git",
	},

	infra: {
		piVersion: "0.80.2",
		harnessVersion: "0.1.0",
		renamePiPackages: false,
	},

	productPackages: [],
};
