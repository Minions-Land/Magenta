#!/usr/bin/env node
/**
 * Brand Sync Script
 *
 * Reads brands/registry.toml to find the active brand, loads its configuration,
 * and updates all brand-related fields across the project:
 * - Product packages (@magenta/*) → version = BRAND_CONFIG.version
 * - Infra packages (pi/*, harness) → version = infra.piVersion / harnessVersion
 * - CLI binary name, description
 * - Package names if renamePiPackages = true
 *
 * Usage: node scripts/sync-brand.mjs [--dry-run] [--brand=<name>]
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = join(__dirname, "..");

const DRY_RUN = process.argv.includes("--dry-run");
const brandOverride = process.argv.find(arg => arg.startsWith("--brand="))?.split("=")[1];

// Load brand registry
const registryPath = join(ROOT, "brands/registry.toml");
const registrySource = readFileSync(registryPath, "utf-8");

// Parse active brand (naive TOML parsing - just find the line)
const activeMatch = registrySource.match(/^active = "([^"]+)"/m);
if (!activeMatch) {
	console.error("❌ Could not find 'active' brand in brands/registry.toml");
	process.exit(1);
}

const activeBrand = brandOverride || activeMatch[1];
console.log(`🎨 Brand Sync - Active: ${activeBrand}${brandOverride ? ' (override)' : ''}\n`);

// Find brand path in registry
const brandPathMatch = registrySource.match(new RegExp(`\\[\\[brands\\]\\]\\s+name = "${activeBrand}"\\s+path = "([^"]+)"`));
if (!brandPathMatch) {
	console.error(`❌ Brand '${activeBrand}' not found in registry.toml`);
	console.error(`   Available brands: ${[...registrySource.matchAll(/name = "([^"]+)"/g)].map(m => m[1]).join(", ")}`);
	process.exit(1);
}

const brandConfigPath = join(ROOT, "brands", brandPathMatch[1]);

// Load brand config
let brandConfigSource;
try {
	brandConfigSource = readFileSync(brandConfigPath, "utf-8");
} catch (e) {
	console.error(`❌ Could not read brand config at ${brandConfigPath}`);
	console.error(`   ${e.message}`);
	process.exit(1);
}

// Parse the config (extract BRAND_CONFIG object)
const configMatch = brandConfigSource.match(/export const BRAND_CONFIG[^=]*= (\{[\s\S]+?\n\});/);
if (!configMatch) {
	console.error(`❌ Could not parse BRAND_CONFIG from ${brandConfigPath}`);
	console.error(`   Expected: export const BRAND_CONFIG: BrandConfig = { ... };`);
	process.exit(1);
}

// Evaluate the config object (safe since it's our own file)
const BRAND_CONFIG = eval(`(${configMatch[1]})`);

console.log(`   Name: ${BRAND_CONFIG.name}`);
console.log(`   Version: ${BRAND_CONFIG.version}`);
console.log(`   Scope: ${BRAND_CONFIG.packageScope}`);
console.log(`   Infra: pi@${BRAND_CONFIG.infra.piVersion}, harness@${BRAND_CONFIG.infra.harnessVersion}`);
console.log(`   Rename pi packages: ${BRAND_CONFIG.infra.renamePiPackages}\n`);

if (DRY_RUN) {
	console.log("🔍 DRY RUN - no files will be modified\n");
}

// Package update rules
const PACKAGES = [
	// Root monorepo
	{ path: "package.json", version: BRAND_CONFIG.version, name: null },

	// Product packages (use product version)
	{ path: "harness/package.json", version: BRAND_CONFIG.version, name: `${BRAND_CONFIG.packageScope}/harness` },
	{ path: "pi/memory/package.json", version: BRAND_CONFIG.version, name: `${BRAND_CONFIG.packageScope}/memory` },

	// Infra packages (use infra version, optionally rename)
	{
		path: "pi/ai/package.json",
		version: BRAND_CONFIG.infra.piVersion,
		name: BRAND_CONFIG.infra.renamePiPackages ? `${BRAND_CONFIG.packageScope}/ai` : "@earendil-works/pi-ai",
		oldName: "@earendil-works/pi-ai",
	},
	{
		path: "pi/tui/package.json",
		version: BRAND_CONFIG.infra.piVersion,
		name: BRAND_CONFIG.infra.renamePiPackages ? `${BRAND_CONFIG.packageScope}/tui` : "@earendil-works/pi-tui",
		oldName: "@earendil-works/pi-tui",
	},
	{
		path: "pi/agent/package.json",
		version: BRAND_CONFIG.infra.piVersion,
		name: BRAND_CONFIG.infra.renamePiPackages ? `${BRAND_CONFIG.packageScope}/agent-core` : "@earendil-works/pi-agent-core",
		oldName: "@earendil-works/pi-agent-core",
	},
	{
		path: "pi/coding-agent/package.json",
		version: BRAND_CONFIG.infra.piVersion,
		name: BRAND_CONFIG.infra.renamePiPackages ? `${BRAND_CONFIG.packageScope}/coding-agent` : "@earendil-works/pi-coding-agent",
		oldName: "@earendil-works/pi-coding-agent",
	},
];

let updated = 0;

for (const pkg of PACKAGES) {
	const fullPath = join(ROOT, pkg.path);
	let content = readFileSync(fullPath, "utf-8");
	const original = content;

	// Parse package.json
	const parsed = JSON.parse(content);

	// Update version
	if (parsed.version !== pkg.version) {
		parsed.version = pkg.version;
		console.log(`  ✓ ${pkg.path}: version → ${pkg.version}`);
	}

	// Update name if specified
	if (pkg.name && parsed.name !== pkg.name) {
		parsed.name = pkg.name;
		console.log(`  ✓ ${pkg.path}: name → ${pkg.name}`);
	}

	// Update dependencies (rename old package names to new ones if renamePiPackages)
	if (BRAND_CONFIG.infra.renamePiPackages) {
		for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
			if (!parsed[depType]) continue;
			for (const oldName of ["@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"]) {
				if (parsed[depType][oldName]) {
					const newName = oldName.replace("@earendil-works/pi-", `${BRAND_CONFIG.packageScope}/`).replace("agent-core", "agent-core");
					parsed[depType][newName] = BRAND_CONFIG.infra.piVersion;
					delete parsed[depType][oldName];
					console.log(`  ✓ ${pkg.path}: dependency ${oldName} → ${newName}`);
				}
			}
		}
	}

	// Update workspace dependencies to use correct versions
	for (const depType of ["dependencies", "devDependencies", "peerDependencies"]) {
		if (!parsed[depType]) continue;

		// Product packages (@magenta/harness, @magenta/memory) → product version
		if (parsed[depType][`${BRAND_CONFIG.packageScope}/harness`]) {
			parsed[depType][`${BRAND_CONFIG.packageScope}/harness`] = BRAND_CONFIG.version;
		}
		if (parsed[depType][`${BRAND_CONFIG.packageScope}/memory`]) {
			parsed[depType][`${BRAND_CONFIG.packageScope}/memory`] = BRAND_CONFIG.version;
		}

		// Infra packages (@earendil-works/pi-*) → infra version
		for (const piPkg of ["@earendil-works/pi-ai", "@earendil-works/pi-tui", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent"]) {
			if (parsed[depType][piPkg]) {
				parsed[depType][piPkg] = BRAND_CONFIG.infra.piVersion;
			}
		}
	}

	// Write back
	content = JSON.stringify(parsed, null, "\t") + "\n";

	if (content !== original) {
		if (!DRY_RUN) {
			writeFileSync(fullPath, content);
		}
		updated++;
	}
}

console.log(`\n✅ ${updated > 0 ? `Updated ${updated} package(s)` : 'All packages up to date'}`);

if (!DRY_RUN && updated > 0) {
	console.log("\n💡 Next steps:");
	console.log("   npm install          # Update lockfile");
	console.log("   npm run build        # Rebuild with new versions");
}
