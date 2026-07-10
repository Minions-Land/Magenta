import type { Models } from "@earendil-works/pi-ai";

export type EmbeddingModels = Models & {
	embed(request: { model: string; input: string[] }): Promise<{
		embeddings: Array<{ embedding: number[] }>;
	}>;
};

/**
 * Adapter for a Models collection that has an embedding endpoint installed by
 * the host. The stock pi-ai Models surface is generation-only, so callers must
 * inject the additional typed operation explicitly.
 */
export class ModelsEmbeddingProvider {
	readonly models: EmbeddingModels;
	readonly model: string;

	constructor(models: EmbeddingModels, model: string = "voyage-3") {
		this.models = models;
		this.model = model;
	}

	async embed(text: string): Promise<number[]> {
		const result = await this.embedBatch([text]);
		return result[0];
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		try {
			const response = await this.models.embed({
				model: this.model,
				input: texts,
			});

			return response.embeddings.map((entry) => entry.embedding);
		} catch (error) {
			throw new Error(`Failed to generate embeddings: ${error}`);
		}
	}
}

/**
 * Simple hash-based embedding for testing (not for production)
 */
export class SimpleHashEmbedding {
	readonly dimensions = 384;

	async embed(text: string): Promise<number[]> {
		return this.hashToVector(text);
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		return texts.map((text) => this.hashToVector(text));
	}

	hashToVector(text: string): number[] {
		// Simple deterministic hash-based embedding
		const vector: number[] = new Array(this.dimensions).fill(0);
		const normalized = text.toLowerCase().trim();

		for (let i = 0; i < normalized.length; i++) {
			const char = normalized.charCodeAt(i);
			const idx = (char * (i + 1)) % this.dimensions;
			vector[idx] += 1;
		}

		// Normalize
		const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
		return norm > 0 ? vector.map((v) => v / norm) : vector;
	}
}
