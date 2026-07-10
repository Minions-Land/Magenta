import { parse } from "smol-toml";

export type TomlValue = string | number | boolean | Date | TomlValue[] | TomlTable;

export type TomlTable = {
	[key: string]: TomlValue;
};

export function parseToml(source: string): TomlTable {
	return parse(source) as TomlTable;
}
