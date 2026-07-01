/**
 * Vector similarity utilities
 */

/** Calculate cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have same length");
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denominator = Math.sqrt(normA) * Math.sqrt(normB);
	if (denominator === 0) return 0;

	return dotProduct / denominator;
}

/** Calculate Euclidean distance between two vectors */
export function euclideanDistance(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have same length");
	}

	let sum = 0;
	for (let i = 0; i < a.length; i++) {
		const diff = a[i] - b[i];
		sum += diff * diff;
	}

	return Math.sqrt(sum);
}

/** Normalize a vector to unit length */
export function normalize(vector: number[]): number[] {
	const norm = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
	if (norm === 0) return vector;
	return vector.map((val) => val / norm);
}
