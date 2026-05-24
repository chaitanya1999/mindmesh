import { parseGraphExtraction } from "../ingestion/graphPayload.js";

function trimTrailingSlash(value) {
	return String(value ?? "").replace(/\/$/, "");
}

export function buildHubMessages({ systemPrompt, prompt }) {
	const systemText = String(systemPrompt ?? "").trim();
	const userText = String(prompt ?? "").trim();

	if (systemText && userText) {
		return [
			{ role: "system", content: systemText },
			{ role: "user", content: userText },
		];
	}

	if (systemText) {
		return [{ role: "user", content: systemText }];
	}

	if (userText) {
		return [{ role: "user", content: userText }];
	}

	throw new Error("Hub LLM request requires a systemPrompt or prompt.");
}

export function extractHubChatContent(body) {
	const content = body?.choices?.[0]?.message?.content;

	if (typeof content === "string") {
		return content;
	}

	if (Array.isArray(content)) {
		const text = content
			.map((part) => {
				if (typeof part === "string") {
					return part;
				}

				if (part?.type === "text" && typeof part.text === "string") {
					return part.text;
				}

				if (typeof part?.text === "string") {
					return part.text;
				}

				return "";
			})
			.join("")
			.trim();

		if (text) {
			return text;
		}
	}

	throw new Error("Hub LLM response did not contain choices[0].message.content.");
}

export class HubChatProvider {
	constructor({ baseUrl, apiKey, model, extractionFormat = "json", temperature = null }) {
		if (!baseUrl) {
			throw new Error("Missing Hub LLM base URL. Set KG_HUB_LLM_BASE_URL or llm.hub.baseUrl.");
		}

		if (!apiKey) {
			throw new Error("Missing Hub LLM API key. Set KG_HUB_LLM_API_KEY or llm.hub.apiKey.");
		}

		if (!model) {
			throw new Error("Missing Hub LLM model. Set KG_HUB_LLM_MODEL or llm.hub.model.");
		}

		this.baseUrl = trimTrailingSlash(baseUrl);
		this.apiKey = apiKey;
		this.model = model;
		this.extractionFormat = extractionFormat;
		this.temperature = temperature;
	}

	async generateText({ systemPrompt, prompt }) {
		const body = {
			model: this.model,
			messages: buildHubMessages({ systemPrompt, prompt }),
		};

		if (this.temperature !== null && this.temperature !== undefined && this.temperature !== "") {
			body.temperature = Number(this.temperature);
		}

		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"accept": "application/json",
				"authorization": `Bearer ${this.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const responseText = await response.text();
		let responseBody = null;

		try {
			responseBody = responseText ? JSON.parse(responseText) : {};
		} catch {
			if (!response.ok) {
				throw new Error(`Hub LLM request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
			}

			throw new Error("Hub LLM response was not valid JSON.");
		}

		if (!response.ok) {
			throw new Error(`Hub LLM request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		return extractHubChatContent(responseBody);
	}

	async extractGraphWithRawResponse({ text, systemPrompt, prompt, debugLogger }) {
		const extractionPrompt = prompt ?? `Extract graph data from this text:\n\n${text}`;
		const responseText = await this.generateText({
			systemPrompt,
			prompt: extractionPrompt,
		});

		debugLogger?.section("Raw LLM Extraction Response", responseText);

		return {
			graph: parseGraphExtraction(responseText, { format: this.extractionFormat }),
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

	async verifyConnectivity() {
		const response = await fetch(`${this.baseUrl}/health?model=${encodeURIComponent(this.model)}`, {
			headers: {
				"accept": "application/json",
				"authorization": `Bearer ${this.apiKey}`,
			},
		});
		const responseText = await response.text();

		if (!response.ok) {
			throw new Error(`Hub LLM health check failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		return responseText;
	}
}
