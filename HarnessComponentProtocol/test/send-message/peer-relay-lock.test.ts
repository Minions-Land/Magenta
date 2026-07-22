import { describe, expect, it } from "vitest";
import { peerRelayProcessArgs } from "../../tools/send-message/magenta/peer-relay-lock.ts";

describe("peer relay self-spawn argv", () => {
	it("removes the embedded Bun entrypoint on Unix and Windows", () => {
		expect(
			peerRelayProcessArgs(["/tmp/magenta", "/$bunfs/root/magenta", "_peer", "relay", "--db", "/tmp/messages.db"]),
		).toEqual(["_peer", "relay", "--db", "/tmp/messages.db"]);
		expect(
			peerRelayProcessArgs(["C:\\Magenta\\magenta.exe", "B:\\~BUN\\root\\magenta.exe", "_peer", "relay"]),
		).toEqual(["_peer", "relay"]);
	});

	it("preserves a real script entrypoint for Node and strips fencing options", () => {
		expect(
			peerRelayProcessArgs([
				"/opt/homebrew/bin/node",
				"/repo/dist/cli.js",
				"_peer",
				"relay",
				"--generation",
				"old",
				"--stay-alive",
			]),
		).toEqual(["/repo/dist/cli.js", "_peer", "relay", "--stay-alive"]);
	});
});
