import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const harnessRoot = resolve(scriptsRoot, "..");
export const repoRoot = resolve(harnessRoot, "..");

export function pathLabel(path, root = repoRoot) {
	return relative(root, path) || ".";
}

export function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function readToml(path) {
	return parseToml(readFileSync(path, "utf8"));
}

function stripComment(line) {
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (quote) {
			if (ch === quote && line[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") quote = ch;
		else if (ch === "#") return line.slice(0, i);
	}
	return line;
}

function splitTopLevel(input) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let current = "";
	for (let i = 0; i < input.length; i++) {
		const ch = input[i];
		if (quote) {
			current += ch;
			if (ch === quote && input[i - 1] !== "\\") quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === "[") depth++;
		if (ch === "]") depth--;
		if (ch === "," && depth === 0) {
			if (current.trim()) parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current.trim());
	return parts;
}

function parseScalar(raw) {
	const value = raw.trim();
	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		return inner ? splitTopLevel(inner).map(parseScalar) : [];
	}
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		const body = value.slice(1, -1);
		if (value.startsWith("'")) return body;
		return body
			.replace(/\\n/g, "\n")
			.replace(/\\t/g, "\t")
			.replace(/\\r/g, "\r")
			.replace(/\\"/g, '"')
			.replace(/\\\\/g, "\\");
	}
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^[+-]?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
	return value;
}

export function parseToml(source) {
	const root = {};
	let current = root;
	let pendingKey;
	let pendingArray = "";

	const descend = (path) => {
		let node = root;
		for (const key of path) {
			if (node[key] && typeof node[key] === "object" && !Array.isArray(node[key])) {
				node = node[key];
			} else {
				node[key] = {};
				node = node[key];
			}
		}
		return node;
	};

	for (const rawLine of source.split(/\r?\n/)) {
		const line = stripComment(rawLine).trim();
		if (!line) continue;

		if (pendingKey) {
			pendingArray = `${pendingArray}\n${line}`;
			if (line.endsWith("]")) {
				current[pendingKey] = parseScalar(pendingArray);
				pendingKey = undefined;
				pendingArray = "";
			}
			continue;
		}

		if (line.startsWith("[[") && line.endsWith("]]")) {
			const path = line
				.slice(2, -2)
				.trim()
				.split(".")
				.map((part) => part.trim());
			const key = path[path.length - 1];
			const parent = descend(path.slice(0, -1));
			parent[key] = Array.isArray(parent[key]) ? parent[key] : [];
			const entry = {};
			parent[key].push(entry);
			current = entry;
			continue;
		}

		if (line.startsWith("[") && line.endsWith("]")) {
			current = descend(
				line
					.slice(1, -1)
					.trim()
					.split(".")
					.map((part) => part.trim()),
			);
			continue;
		}

		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const rawValue = line.slice(eq + 1).trim();
		if (rawValue.startsWith("[") && !rawValue.endsWith("]")) {
			pendingKey = key;
			pendingArray = rawValue;
			continue;
		}
		current[key] = parseScalar(rawValue);
	}

	return root;
}
