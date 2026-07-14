import { describe, expect, it } from "vitest";
import { EventStream } from "../src/utils/event-stream.ts";

describe("EventStream termination", () => {
	it("propagates failures to iteration and result consumers", async () => {
		const stream = new EventStream<string, string>(
			() => false,
			(event) => event,
		);
		const iterator = stream[Symbol.asyncIterator]();
		const next = iterator.next();

		stream.fail(new Error("stream failed"));

		await expect(next).rejects.toThrow("stream failed");
		await expect(stream.result()).rejects.toThrow("stream failed");
	});

	it("atomically fails when terminal result extraction throws", async () => {
		const stream = new EventStream<{ done: boolean }, string>(
			(event) => event.done,
			() => {
				throw new Error("invalid terminal event");
			},
		);
		const next = stream[Symbol.asyncIterator]().next();

		expect(() => stream.push({ done: true })).toThrow("invalid terminal event");
		await expect(next).rejects.toThrow("invalid terminal event");
		await expect(stream.result()).rejects.toThrow("invalid terminal event");
	});

	it("allows result settlement after iteration has ended", async () => {
		const resolved = new EventStream<string, string>(
			() => false,
			(event) => event,
		);
		resolved.end();
		resolved.end("late result");
		await expect(resolved.result()).resolves.toBe("late result");

		const rejected = new EventStream<string, string>(
			() => false,
			(event) => event,
		);
		rejected.end();
		rejected.fail(new Error("late failure"));
		await expect(rejected.result()).rejects.toThrow("late failure");
	});

	it("releases additional iterators as soon as a terminal event arrives", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const first = stream[Symbol.asyncIterator]();
		const second = stream[Symbol.asyncIterator]();
		const firstNext = first.next();
		const secondNext = second.next();

		stream.push("done");

		await expect(firstNext).resolves.toEqual({ value: "done", done: false });
		await expect(secondNext).resolves.toEqual({ value: undefined, done: true });
		await expect(stream.result()).resolves.toBe("done");
	});
});
