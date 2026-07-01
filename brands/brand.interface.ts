/**
 * Brand Configuration Interface
 *
 * All brand configuration files must export a constant named `BRAND_CONFIG`
 * that conforms to this interface.
 */

export interface BrandConfig {
	/** Agent/product name (used in CLI, TUI, docs) */
	name: string;

	/** Product version (independent of infrastructure versions) */
	version: string;

	/** NPM package scope for product-specific packages */
	packageScope: string;

	/** Visual theme */
	theme: {
		primaryColor: string;      // Main brand color (hex)
		accentColor: string;       // Accent color (hex)
		successColor: string;      // Success state (hex)
		warningColor: string;      // Warning state (hex)
		errorColor: string;        // Error state (hex)
	};

	/** CLI configuration */
	cli: {
		binaryName: string;        // CLI command name
		description: string;       // One-line description
		welcomeMessage: string;    // Welcome banner
		prompt: string;            // REPL prompt
	};

	/** Project URLs */
	urls: {
		homepage: string;
		docs: string;
		issues: string;
		repository: string;
	};

	/** Infrastructure layer versions (reference only, synced from upstream) */
	infra: {
		/** pi/* packages version (from upstream @earendil-works/pi-*) */
		piVersion: string;

		/** harness version */
		harnessVersion: string;

		/** Keep package names from upstream or rename to @{packageScope} scope?
		 * false = @earendil-works/pi-* (track upstream, easier to pull updates)
		 * true = @{packageScope}/* (full fork, independent evolution)
		 */
		renamePiPackages: boolean;
	};

	/** Product-layer packages (brand-specific, use product version) */
	productPackages?: string[];
}
