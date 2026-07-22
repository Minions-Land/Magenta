import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

const testRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function testSourceFiles(root: string): string[] {
	const files: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) continue;
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && path.endsWith(".ts")) files.push(path);
		}
	}
	return files;
}

function isSessionManagerCreate(node: ts.CallExpression): boolean {
	return (
		ts.isPropertyAccessExpression(node.expression) &&
		ts.isIdentifier(node.expression.expression) &&
		node.expression.expression.text === "SessionManager" &&
		node.expression.name.text === "create"
	);
}

describe("test Session isolation", () => {
	it("requires an explicit session directory for persisted test Sessions", () => {
		const violations: string[] = [];
		for (const path of testSourceFiles(testRoot)) {
			const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && isSessionManagerCreate(node) && node.arguments.length < 2) {
					const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
					violations.push(`${relative(testRoot, path)}:${line + 1}:${character + 1}`);
				}
				ts.forEachChild(node, visit);
			};
			visit(source);
		}

		expect(violations, "Single-argument SessionManager.create() writes to the user's real config directory").toEqual(
			[],
		);
	});
});
