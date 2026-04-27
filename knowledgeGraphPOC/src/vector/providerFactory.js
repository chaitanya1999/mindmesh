import { ChromaVectorStore } from "./chromaVectorStore.js";

export function createVectorStore(config) {
  if (config.vector.provider === "chroma") {
    return new ChromaVectorStore(config.vector.chroma);
  }

  throw new Error(`Unsupported vector provider: ${config.vector.provider}`);
}
