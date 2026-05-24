import { GeminiProvider } from "./geminiProvider.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { CustomHttpProvider } from "./customHttpProvider.js";
import { HubChatProvider } from "./hubChatProvider.js";

export function createLlmProvider(config, overrideProvider) {
	const provider = overrideProvider || config.llm.provider;

	if (provider === "gemini") {
		return new GeminiProvider(config.llm.gemini);
	}

	if (provider === "ollama") {
		return new OllamaProvider(config.llm.ollama);
	}

	if (provider === "custom") {
		return new CustomHttpProvider(config.llm.custom);
	}

	if (provider === "hub") {
		return new HubChatProvider(config.llm.hub);
	}

	throw new Error(`Unsupported LLM provider: ${provider}`);
}
