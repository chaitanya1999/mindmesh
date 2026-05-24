import { parseGraphExtraction } from "../ingestion/graphPayload.js";

function trimTrailingSlash(value) {
	return String(value ?? "").replace(/\/$/, "");
}

export function buildOllamaMessages({ systemPrompt, prompt }) {
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

	throw new Error("Ollama request requires a systemPrompt or prompt.");
}

function normalizeThink(value) {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}

	if (typeof value === "boolean") {
		return value;
	}

	const text = String(value).trim().toLowerCase();
	if (text === "true") {
		return true;
	}

	if (text === "false") {
		return false;
	}

	return String(value).trim();
}

function stripThinkingMarkup(text) {
	return String(text ?? "")
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.trim();
}

export function extractOllamaText(body) {
	if (typeof body?.message?.content === "string") {
		return stripThinkingMarkup(body.message.content);
	}

	throw new Error("Ollama chat response did not contain message.content.");
}

export class OllamaProvider {
	constructor({ baseUrl, model, extractionFormat = "json", think = false, temperature = null }) {
		if (!baseUrl) {
			throw new Error("Missing Ollama base URL. Set OLLAMA_BASE_URL or llm.ollama.baseUrl.");
		}

		if (!model) {
			throw new Error("Missing Ollama model. Set OLLAMA_MODEL or llm.ollama.model.");
		}

		this.baseUrl = trimTrailingSlash(baseUrl);
		this.model = model;
		this.extractionFormat = extractionFormat;
		this.think = normalizeThink(think);
		this.temperature = temperature;
	}

	buildRequestBody({ systemPrompt, prompt }) {
		const body = {
			model: this.model,
			stream: false,
		};

		if (this.think !== undefined) {
			body.think = this.think;
		}

		if (this.temperature !== null && this.temperature !== undefined && this.temperature !== "") {
			body.options = {
				temperature: Number(this.temperature),
			};
		}

		body.messages = buildOllamaMessages({ systemPrompt, prompt });
		return body;
	}

	async generateText({ systemPrompt, prompt }) {
		const response = await fetch(`${this.baseUrl}/api/chat`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(this.buildRequestBody({ systemPrompt, prompt })),
		});
		const responseText = await response.text();

		console.log('#$#$ ' + responseText);

		if (!response.ok) {
			throw new Error(`Ollama request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		let body = null;
		try {
			body = responseText ? JSON.parse(responseText) : {};
		} catch {
			throw new Error("Ollama response was not valid JSON.");
		}

		return extractOllamaText(body);
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
		const response = await fetch(`${this.baseUrl}/api/tags`, {
			headers: { "accept": "application/json" },
		});
		const responseText = await response.text();

		if (!response.ok) {
			throw new Error(`Ollama health check failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		return responseText;
	}
}
