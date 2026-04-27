import { extractJsonObject } from "../ingestion/graphPayload.js";

export class OllamaProvider {
	constructor({ baseUrl, model }) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
	}

	async generateText({ systemPrompt, prompt }) {
		const response = await fetch(`${this.baseUrl}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				system: systemPrompt,
				prompt,
				stream: false,
			}),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ""}`);
    }

		const body = await response.json();
		return body.response ?? "";
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
