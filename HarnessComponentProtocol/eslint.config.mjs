import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import unicorn from "eslint-plugin-unicorn";

const typescriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const HCP_EXPORT_NAME = /^(?:Hcp|HCP_)/u;

function exportedName(node) {
	if (!node) return undefined;
	if (node.type === "Identifier") return node.name;
	if (node.type === "Literal" && typeof node.value === "string") return node.value;
	return undefined;
}

function bindingNames(node) {
	if (!node) return [];
	switch (node.type) {
		case "Identifier":
			return [node.name];
		case "AssignmentPattern":
			return bindingNames(node.left);
		case "RestElement":
			return bindingNames(node.argument);
		case "ArrayPattern":
			return node.elements.flatMap(bindingNames);
		case "ObjectPattern":
			return node.properties.flatMap((property) =>
				property.type === "Property" ? bindingNames(property.value) : bindingNames(property.argument),
			);
		default:
			return [];
	}
}

function declarationNames(node) {
	if (!node) return [];
	if (node.type === "VariableDeclaration") {
		return node.declarations.flatMap((declaration) => bindingNames(declaration.id));
	}
	const name = exportedName(node.id);
	return name ? [name] : [];
}

const hcpExportsPlugin = {
	meta: {
		name: "hcp-exports",
		version: "1.0.0",
	},
	rules: {
		"require-prefix": {
			meta: {
				type: "problem",
				docs: {
					description: "Require governed HCP top-level declarations and exports to use an Hcp or HCP_ prefix",
				},
				schema: [],
				messages: {
					invalidName: 'HCP top-level or exported name "{{name}}" must start with "Hcp" or "HCP_".',
					namedOnly: 'Use a named export starting with "Hcp" or "HCP_".',
				},
			},
			create(context) {
				function checkName(node, name) {
					if (!HCP_EXPORT_NAME.test(name)) {
						context.report({ node, messageId: "invalidName", data: { name } });
					}
				}

				return {
					Program(node) {
						for (const statement of node.body) {
							const declaration =
								statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
							for (const name of declarationNames(declaration)) checkName(declaration, name);
						}
					},
					ExportNamedDeclaration(node) {
						for (const specifier of node.specifiers) {
							const name = exportedName(specifier.exported);
							if (name) checkName(specifier, name);
						}
					},
					ExportDefaultDeclaration(node) {
						context.report({ node, messageId: "namedOnly" });
					},
					ExportAllDeclaration(node) {
						const name = exportedName(node.exported);
						if (name) checkName(node, name);
						else context.report({ node, messageId: "namedOnly" });
					},
					TSExportAssignment(node) {
						context.report({ node, messageId: "namedOnly" });
					},
					TSImportEqualsDeclaration(node) {
						if (!node.isExport) return;
						const name = exportedName(node.id);
						if (name) checkName(node, name);
					},
					TSNamespaceExportDeclaration(node) {
						const name = exportedName(node.id);
						if (name) checkName(node, name);
					},
				};
			},
		},
	},
};

function exportedRoleClass(name) {
	return {
		"@typescript-eslint/naming-convention": [
			"error",
			{
				selector: "class",
				modifiers: ["exported"],
				format: ["PascalCase"],
				custom: { regex: `^${name}$`, match: true },
			},
		],
	};
}

export default [
	{
		linterOptions: {
			reportUnusedDisableDirectives: false,
		},
		ignores: [
			"**/dist/**",
			"**/node_modules/**",
			"**/target/**",
			"coverage/**",
		],
	},
	{
		files: typescriptFiles,
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: "module",
			parser: tsParser,
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
			"hcp-exports": hcpExportsPlugin,
			unicorn,
		},
	},
	{
		files: ["HcpClient.ts", "**/HcpServer.ts", "**/HcpMagnet.ts"],
		rules: {
			"unicorn/filename-case": ["error", { case: "pascalCase", checkDirectories: false }],
		},
	},
	{
		files: ["HcpClient.ts", ".HCP/**/*.ts"],
		rules: {
			"hcp-exports/require-prefix": "error",
		},
	},
	{
		files: ["HcpClient.ts"],
		rules: exportedRoleClass("HcpClient"),
	},
	{
		files: ["**/HcpServer.ts"],
		rules: exportedRoleClass("HcpServer"),
	},
	{
		files: ["**/HcpMagnet.ts"],
		rules: exportedRoleClass("HcpMagnet"),
	},
];
