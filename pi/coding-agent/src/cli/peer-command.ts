import { handlePeerCommand as handleHcpPeerCommand } from "@magenta/harness";
import { getPeerMessageDbPath } from "../config.ts";

export function handlePeerCommand(args: string[]): Promise<boolean> {
	return handleHcpPeerCommand(args, { defaultDbPath: getPeerMessageDbPath() });
}
