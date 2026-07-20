import { clipboard } from "../src/utils/clipboard-native.ts";

if (!clipboard) {
	throw new Error("Packaged clipboard runtime is unavailable");
}
if (typeof clipboard.hasImage !== "function" || typeof clipboard.getImageBinary !== "function") {
	throw new Error("Packaged clipboard runtime does not expose image APIs");
}

console.log("Packaged clipboard runtime loaded successfully");
