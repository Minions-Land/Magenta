import type { Models } from "@earendil-works/pi-ai";
import type { EmbeddingProvider } from "./types.ts";

/**
 * Embedding provider using Claude's text embedding API
 */
export class ClaudeEmbeddingProvider implements EmbeddingProvider {
	models: Models;
	model: string;

	constructor(models: Models, model: string = "voyage-3") {
		this.models = models;
		this.model = model;
	}

	async embed(text: string): Promise<number[]> {
		const result = await this.embedBatch([text]);
		return result[0];
	}

	async embedBatch(texts: string[]): Promise<number[][]> {
		// Use the embedding API from pi-ai
		// Note: This assumes the Models interface supports embeddings
		// If not, we'll need to add a custom implementation
		try {
			// @ts-expect-error - embedding API might not be typed yet
			const response = await this.models.embed({
				model: this.model,
				input: texts,
			});

			return response.embeddings.map((e: any) => e.embedding);
		} catch (error) {
			throw new Error(`Failed to generate embeddings: ${error}`);
		}
	}
}

/**
 * Simple hash-based embedding for testing (not for production)
 */
export class SimpleHashEmbedding implements EmbeddingProvider {
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
