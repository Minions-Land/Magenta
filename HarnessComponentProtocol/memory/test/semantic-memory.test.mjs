import assert from "node:assert/strict";
import test from "node:test";
import {
	InMemoryStore,
	ModelsEmbeddingProvider,
	SimpleHashEmbedding,
} from "../dist/pi/index.js";

test("stores and retrieves memory through an injected embedding provider", async () => {
	const store = new InMemoryStore(new SimpleHashEmbedding());
	const entry = await store.create({
		content: "Prefer TypeScript examples",
		description: "Language preference",
		type: "user",
		tags: ["language"],
	});

	assert.equal((await store.get(entry.id))?.content, "Prefer TypeScript examples");
	const results = await store.search({ query: "TypeScript examples", tags: ["language"] });
	assert.equal(results[0]?.entry.id, entry.id);
});

test("falls back to text search when no embedding provider is configured", async () => {
	const store = new InMemoryStore();
	const entry = await store.create({
		content: "Keep the HCP entity tree flat",
		description: "Architecture constraint",
		type: "project",
	});

	const results = await store.search({ query: "entity tree" });
	assert.equal(results[0]?.entry.id, entry.id);
});

test("regenerates embeddings when an update intentionally writes an empty string", async () => {
	let calls = 0;
	const embeddingProvider = {
		async embed() {
			calls += 1;
			return [1, 0];
		},
		async embedBatch(texts) {
			return Promise.all(texts.map((text) => this.embed(text)));
		},
	};
	const store = new InMemoryStore(embeddingProvider);
	const entry = await store.create({ content: "temporary", description: "draft", type: "project" });

	await store.update(entry.id, { content: "" });
	assert.equal(calls, 2);
});

test("adapts a host-provided embedding operation without changing pi-ai Models", async () => {
	const calls = [];
	const provider = new ModelsEmbeddingProvider(
		{
			async embed(request) {
				calls.push(request);
				return { embeddings: request.input.map((text) => ({ embedding: [text.length] })) };
			},
		},
		"host-embedding-model",
	);

	assert.deepEqual(await provider.embedBatch(["a", "abcd"]), [[1], [4]]);
	assert.deepEqual(calls, [{ model: "host-embedding-model", input: ["a", "abcd"] }]);
});
