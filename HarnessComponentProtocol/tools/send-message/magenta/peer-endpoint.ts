import { createHash } from "node:crypto";

export function peerEndpointId(remote: string, port?: number): string {
	return `ssh:${createHash("sha256")
		.update(`${remote}\0${port ?? 22}`)
		.digest("hex")
		.slice(0, 16)}`;
}
