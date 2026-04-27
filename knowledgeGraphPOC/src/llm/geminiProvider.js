import { GoogleGenAI } from "@google/genai";
import { extractJsonObject } from "../ingestion/graphPayload.js";

export class GeminiProvider {
	constructor({ apiKey, model }) {
		if (!apiKey) {
			throw new Error("Missing Gemini API key. Set GEMINI_API_KEY, GOOGLE_API_KEY, or config.json apiKey.");
		}

		this.model = model;
		this.ai = new GoogleGenAI({ apiKey });
	}

	async generateText({ systemPrompt, prompt }) {
		const response = await this.ai.models.generateContent({
			model: this.model,
			contents: `${systemPrompt}\n\n${prompt}`,
		});

		return response.text;
	}

	async extractGraph({ text, systemPrompt }) {
		const responseText = await this.generateText({
			systemPrompt,
			prompt: `Extract graph data from this text:\n\n${text}`,
		});

		return extractJsonObject(responseText);
	}

	async generateAnswer({ systemPrompt, context, query }) {
		return this.generateText({
			systemPrompt,
			prompt: `Graph context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		});
	}
}
