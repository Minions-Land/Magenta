import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertMatchingVersions, readVersionExport, verifyBrandVersion } from "./verify-brand-version.mjs";

function createFixture(version = "0.0.29") {
	const root = mkdtempSync(join(tmpdir(), "magenta-brand-version-"));
	mkdirSync(join(root, "brands/magenta"), { recursive: true });
	mkdirSync(join(root, "pi/coding-agent/src"), { recursive: true });
	mkdirSync(join(root, "pi/coding-agent/dist/release"), { recursive: true });
	writeFileSync(
		join(root, "brands/registry.toml"),
		["active = 'magenta'", "", "[[brands]]", "name = 'magenta'", "path = 'magenta/magenta.brand.ts'", ""].join(
			"\n",
		),
	);
	writeFileSync(
		join(root, "brands/magenta/magenta.brand.ts"),
		`export const BRAND_CONFIG = {\n\tname: "Magenta",\n\tversion: "${version}",\n};\n`,
	);
	writeFileSync(
		join(root, "pi/coding-agent/src/brand-version.generated.ts"),
		`export const BRAND_VERSION = "${version}";\n`,
	);
	writeFileSync(
		join(root, "pi/coding-agent/dist/brand-version.generated.js"),
		`export const BRAND_VERSION = "${version}";\n`,
	);
	writeFileSync(
		join(root, "pi/coding-agent/dist/release/magenta-release.json"),
		`${JSON.stringify({ version })}\n`,
	);
	return root;
}

test("reads an exact generated version export", () => {
	assert.equal(readVersionExport('export const BRAND_VERSION: string = "0.0.29";\n', "BRAND_VERSION", "fixture"), "0.0.29");
	assert.throws(
		() =>
			readVersionExport(
				'// export const BRAND_VERSION = "0.0.28";\nexport const BRAND_VERSION = "0.0.29";\nexport const BRAND_VERSION = "0.0.30";\n',
				"BRAND_VERSION",
				"fixture",
			),
		/exactly one/u,
	);
});

test("accepts matching brand, generated, compiled, marker, and expected versions", () => {
	const root = createFixture();
	try {
		const result = verifyBrandVersion({
			expectedVersion: "0.0.29",
			requireDist: true,
			resourceMarker: "pi/coding-agent/dist/release/magenta-release.json",
			root,
		});
		assert.equal(result.version, "0.0.29");
		assert.deepEqual(
			result.entries.map(([label]) => label),
			["active brand", "generated source", "compiled dist", "resource marker"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects stale ignored dist and resource artifacts", () => {
	const root = createFixture();
	try {
		writeFileSync(
			join(root, "pi/coding-agent/dist/brand-version.generated.js"),
			'export const BRAND_VERSION = "0.0.27";\n',
		);
		writeFileSync(
			join(root, "pi/coding-agent/dist/release/magenta-release.json"),
			'{"version":"0.0.26"}\n',
		);
		assert.throws(
			() =>
				verifyBrandVersion({
					requireDist: true,
					resourceMarker: "pi/coding-agent/dist/release/magenta-release.json",
					root,
				}),
			/active brand=0\.0\.29.*compiled dist=0\.0\.27.*resource marker=0\.0\.26.*npm run build/u,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("rejects malformed and expected-version mismatches", () => {
	assert.throws(
		() =>
			assertMatchingVersions(
				[
					["active brand", "0.0.29"],
					["generated source", "0.0.29"],
				],
				"0.0.30",
			),
		/expected release=0\.0\.30/u,
	);
	assert.throws(() => assertMatchingVersions([["active brand", "01.0.0"]]), /Invalid active brand/u);
});
