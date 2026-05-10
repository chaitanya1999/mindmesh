import { GeminiEmbeddingProvider } from "./geminiEmbeddingProvider.js";

export function createEmbeddingProvider(config) {
	const provider = config.embedding.provider;

	if (provider === "gemini") {
		return new GeminiEmbeddingProvider(config.embedding.gemini);
	}

	if (provider === "chroma") {
		return null;
	}

	throw new Error(`Unsupported embedding provider: ${provider}`);
}
