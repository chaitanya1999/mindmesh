import { parseGraphExtraction } from "../ingestion/graphPayload.js";

export class OllamaProvider {
	constructor({ baseUrl, model, extractionFormat = "json" }) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
		this.extractionFormat = extractionFormat;
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

	async extractGraph({ text, systemPrompt, prompt, debugLogger }) {
		const extractionPrompt = prompt ?? `Extract graph data from this text:\n\n${text}`;
		const responseText = await this.generateText({
			systemPrompt,
			prompt: extractionPrompt,
		});

		debugLogger?.section("Raw LLM Extraction Response", responseText);

		return parseGraphExtraction(responseText, { format: this.extractionFormat });
	}

	async generateAnswer({ systemPrompt, context, query }) {
		return this.generateText({
			systemPrompt,
			prompt: `Graph context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
		});
	}
}
