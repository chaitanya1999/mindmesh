import { GoogleGenAI } from "@google/genai";
import { parseGraphExtraction } from "../ingestion/graphPayload.js";

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

	async extractGraphWithRawResponse({ text, systemPrompt, prompt, debugLogger }) {
		const extractionPrompt = prompt ?? `Extract graph data from this text:\n\n${text}`;
		const responseText = await this.generateText({
			systemPrompt,
			prompt: extractionPrompt,
		});

		debugLogger?.section("Raw LLM Extraction Response", responseText);

		return {
			graph: parseGraphExtraction(responseText),
			rawResponse: responseText,
		};
	}

	async extractGraph(options) {
		return (await this.extractGraphWithRawResponse(options)).graph;
	}

	async generateAnswer({ systemPrompt, context, query, prompt, debugLogger }) {
		const answerPrompt = prompt ?? `Graph context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`;
		const responseText = await this.generateText({
			systemPrompt,
			prompt: answerPrompt,
		});

		debugLogger?.section("Raw LLM Answer Response", responseText);

		return responseText;
	}
}
