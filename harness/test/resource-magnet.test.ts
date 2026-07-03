import { describe, expect, it } from "vitest";
import { CapabilityMagnet, ResourceMagnet } from "../assembly/magnet/universal.ts";
import type { UniversalMagnetDescriptor } from "../assembly/magnet/universal.ts";

function descriptor(kind: string, name: string): UniversalMagnetDescriptor {
	return {
		target: `${kind}://${name}`,
		kind,
		name,
		implementation: "resource",
	};
}

describe("ResourceMagnet (the Resource primitive, spec §5)", () => {
	it("produces a resource binding, never a tool or a capability", () => {
		const magnet = new ResourceMagnet({
			descriptor: descriptor("system-prompt", "system-prompt"),
			source: "AutOmicScience",
			contentPath: "/packages/AutOmicScience/SYSTEM.md",
		});

		// One-of invariant: a resource magnet must NOT expose toTool/toCapability.
		expect(magnet.toTool).toBeUndefined();
		expect((magnet as { toCapability?: unknown }).toCapability).toBeUndefined();
		expect(typeof magnet.toResource).toBe("function");

		expect(magnet.toResource()).toEqual({
			kind: "system-prompt",
			name: "system-prompt",
			source: "AutOmicScience",
			mergeMode: "replace",
			contentPath: "/packages/AutOmicScience/SYSTEM.md",
			content: undefined,
		});
	});

	it("defaults to replace semantics and honors append", () => {
		const replace = new ResourceMagnet({
			descriptor: descriptor("system-prompt", "system-prompt"),
			source: "pkg",
			content: "base prompt",
		});
		expect(replace.toResource().mergeMode).toBe("replace");

		const append = new ResourceMagnet({
			descriptor: descriptor("append-system-prompt", "append-system-prompt"),
			source: "pkg",
			mergeMode: "append",
			content: "extra layer",
		});
		expect(append.toResource().mergeMode).toBe("append");
	});

	it("resolves its content THROUGH HCP (instance() returns the resource binding)", () => {
		const magnet = new ResourceMagnet({
			descriptor: descriptor("system-prompt", "system-prompt"),
			source: "pkg",
			content: "hello",
		});
		const server = magnet.toHcpServer();
		const resolved = server.instance?.<ReturnType<ResourceMagnet["toResource"]>>();
		expect(resolved).toMatchObject({ kind: "system-prompt", source: "pkg", content: "hello" });
	});

	it("carries the same HCP management surface as other magnets (describe)", () => {
		const magnet = new ResourceMagnet({
			descriptor: descriptor("system-prompt", "system-prompt"),
			source: "pkg",
			content: "hello",
		});
		const described = magnet.toHcpServer().describe();
		expect(described).toMatchObject({ target: "system-prompt://system-prompt", kind: "system-prompt" });
	});

	it("is structurally distinct from a CapabilityMagnet for the same slot", () => {
		// A CapabilityMagnet (code provider) exposes toCapability; a ResourceMagnet
		// (content) exposes toResource. This is the guard against the §5.1 category
		// error where content was mis-routed as a capability.
		const capability = new CapabilityMagnet({
			descriptor: descriptor("system-prompt", "system-prompt"),
			source: "pi",
			instance: { formatSkillsForSystemPrompt: () => "" },
		});
		expect(typeof capability.toCapability).toBe("function");
		expect((capability as { toResource?: unknown }).toResource).toBeUndefined();
	});
});
