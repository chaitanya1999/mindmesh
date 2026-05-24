import { ChromaVectorStore } from "./chromaVectorStore.js";
import { createEmbeddingProvider } from "../embedding/providerFactory.js";

export function createVectorStore(config) {
	if (config.vector.provider === "chroma") {
		return new ChromaVectorStore(config.vector.chroma, {
			embeddingProvider: createEmbeddingProvider(config),
		});
	}

	throw new Error(`Unsupported vector provider: ${config.vector.provider}`);
}
