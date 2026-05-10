import { parseGraphExtraction } from "../ingestion/graphPayload.js";

function buildPrompt({ systemPrompt, prompt }) {
	return [systemPrompt, prompt].filter(Boolean).join("\n\n");
}

export class CustomHttpProvider {
	constructor({ endpoint, extractionFormat = "json" }) {
		if (!endpoint) {
			throw new Error("Missing custom LLM endpoint. Set KG_CUSTOM_LLM_ENDPOINT or llm.custom.endpoint.");
		}

		this.endpoint = endpoint;
		this.extractionFormat = extractionFormat;
	}

	async generateText({ systemPrompt, prompt }) {
		const text = buildPrompt({ systemPrompt, prompt });
		const response = await fetch(this.endpoint, {
			method: "POST",
			headers: {
				"accept": "text/plain, */*",
				"content-type": "application/json",
			},
			body: JSON.stringify({ text }),
		});
		const responseText = await response.text();

		if (!response.ok) {
			throw new Error(`Custom LLM request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		// console.log('#$#$ ' + responseText);

		return JSON.parse(responseText);
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
