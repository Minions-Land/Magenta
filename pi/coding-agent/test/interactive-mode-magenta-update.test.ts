import { beforeEach, describe, expect, it, vi } from "vitest";

const magentaUpdateMocks = vi.hoisted(() => ({
	checkForMagentaUpdate: vi.fn(),
	runMagentaUpdate: vi.fn(),
}));

vi.mock("../src/utils/magenta-update.ts", () => magentaUpdateMocks);

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createFakeInteractiveMode() {
	return {
		setMagentaUpdateStatus: vi.fn(),
		showMagentaUpdateBanner: vi.fn(),
	};
}

async function runCheck(fakeThis: ReturnType<typeof createFakeInteractiveMode>): Promise<void> {
	await (InteractiveMode as any).prototype.checkAndAutoUpdateMagenta.call(fakeThis);
}

describe("InteractiveMode Magenta auto-update status", () => {
	const savedSkip = process.env.MAGENTA_SKIP_UPDATE;
	const savedOffline = process.env.PI_OFFLINE;

	beforeEach(() => {
		magentaUpdateMocks.checkForMagentaUpdate.mockReset();
		magentaUpdateMocks.runMagentaUpdate.mockReset();
		if (savedSkip === undefined) delete process.env.MAGENTA_SKIP_UPDATE;
		else process.env.MAGENTA_SKIP_UPDATE = savedSkip;
		if (savedOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = savedOffline;
	});

	it("shows an up-to-date footer status when the checkout is current", async () => {
		const fakeThis = createFakeInteractiveMode();
		magentaUpdateMocks.checkForMagentaUpdate.mockResolvedValue({
			repoRoot: "/repo",
			behind: 0,
			localSha: "aaa111",
			remoteSha: "aaa111",
			clean: true,
			fastForwardable: true,
		});

		await runCheck(fakeThis);

		expect(fakeThis.setMagentaUpdateStatus.mock.calls.map(([text]) => text)).toEqual([
			"Auto-update: checking",
			"Auto-update: up to date (aaa111)",
		]);
		expect(fakeThis.showMagentaUpdateBanner).not.toHaveBeenCalled();
		expect(magentaUpdateMocks.runMagentaUpdate).not.toHaveBeenCalled();
	});

	it("shows a skipped footer status when the working tree is dirty", async () => {
		const fakeThis = createFakeInteractiveMode();
		magentaUpdateMocks.checkForMagentaUpdate.mockResolvedValue({
			repoRoot: "/repo",
			behind: 1,
			localSha: "aaa111",
			remoteSha: "bbb222",
			clean: false,
			fastForwardable: true,
		});

		await runCheck(fakeThis);

		expect(fakeThis.setMagentaUpdateStatus.mock.calls.map(([text]) => text)).toEqual([
			"Auto-update: checking",
			"Auto-update: skipped (dirty)",
		]);
		expect(fakeThis.showMagentaUpdateBanner).toHaveBeenCalledWith(
			"Magenta is 1 commit(s) behind bbb222.",
			"Working tree has uncommitted changes — auto-update skipped.",
		);
		expect(magentaUpdateMocks.runMagentaUpdate).not.toHaveBeenCalled();
	});

	it("shows updating and updated footer statuses around a successful fast-forward", async () => {
		const fakeThis = createFakeInteractiveMode();
		const status = {
			repoRoot: "/repo",
			behind: 2,
			localSha: "aaa111",
			remoteSha: "bbb222",
			clean: true,
			fastForwardable: true,
		};
		magentaUpdateMocks.checkForMagentaUpdate.mockResolvedValue(status);
		magentaUpdateMocks.runMagentaUpdate.mockResolvedValue({ ok: true, newSha: "ccc333" });

		await runCheck(fakeThis);

		expect(magentaUpdateMocks.runMagentaUpdate).toHaveBeenCalledWith(status);
		expect(fakeThis.setMagentaUpdateStatus.mock.calls.map(([text]) => text)).toEqual([
			"Auto-update: checking",
			"Auto-update: updating aaa111 -> bbb222",
			"Auto-update: updated (ccc333)",
		]);
		expect(fakeThis.showMagentaUpdateBanner).toHaveBeenLastCalledWith(
			"Magenta updated to ccc333.",
			"Restart Magenta to run the new version.",
		);
	});
});
