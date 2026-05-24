import { GoogleGenAI } from "@google/genai";

function optionalPositiveNumber(value) {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

export class GeminiEmbeddingProvider {
	constructor({ apiKey, model, outputDimensionality }) {
		if (!apiKey) {
			throw new Error("Missing Gemini embedding API key. Set GEMINI_API_KEY, GOOGLE_API_KEY, or embedding.gemini.apiKey.");
		}

		this.model = model;
		this.outputDimensionality = optionalPositiveNumber(outputDimensionality);
		this.ai = new GoogleGenAI({ apiKey });
	}

	async embedTexts(texts, taskType) {
		if (texts.length === 0) {
			return [];
		}

		const config = { taskType };
		if (this.outputDimensionality) {
			config.outputDimensionality = this.outputDimensionality;
		}

		const response = await this.ai.models.embedContent({
			model: this.model,
			contents: texts,
			config,
		});
		const embeddings = response.embeddings?.map((embedding) => embedding.values ?? []) ?? [];

		if (embeddings.length !== texts.length) {
			throw new Error(`Gemini embedding response count mismatch. Expected ${texts.length}, received ${embeddings.length}.`);
		}

		return embeddings;
	}

	async embedDocuments(texts) {
		return this.embedTexts(texts, "RETRIEVAL_DOCUMENT");
	}

	async embedQuery(text) {
		const [embedding] = await this.embedTexts([text], "RETRIEVAL_QUERY");
		return embedding;
	}
}
