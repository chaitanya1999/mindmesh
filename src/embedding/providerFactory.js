import { GeminiEmbeddingProvider } from "./geminiEmbeddingProvider.js";
import { HubEmbeddingProvider } from "./hubEmbeddingProvider.js";

export function createEmbeddingProvider(config) {
	const provider = config.embedding.provider;

	if (provider === "gemini") {
		return new GeminiEmbeddingProvider(config.embedding.gemini);
	}

	if (provider === "hub") {
		return new HubEmbeddingProvider(config.embedding.hub);
	}

	if (provider === "chroma") {
		return null;
	}

	throw new Error(`Unsupported embedding provider: ${provider}`);
}
