import { GeminiProvider } from "./geminiProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";

export function createLlmProvider(config, overrideProvider) {
  const provider = overrideProvider || config.llm.provider;

  if (provider === "gemini") {
    return new GeminiProvider(config.llm.gemini);
  }

  if (provider === "ollama") {
    return new OllamaProvider(config.llm.ollama);
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}
