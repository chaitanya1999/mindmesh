function trimTrailingSlash(value) {
	return String(value ?? "").replace(/\/$/, "");
}

function positiveInteger(value, fallback) {
	const numberValue = Number(value);
	return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback;
}

function assertEmbedding(value, context) {
	if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
		throw new Error(`Hub embedding response did not contain a valid numeric embedding for ${context}.`);
	}

	return value;
}

export class HubEmbeddingProvider {
	constructor({ baseUrl, apiKey, model = "embeddings", encodingFormat = "float", dimensions = 512, batchSize = 64 }) {
		if (!baseUrl) {
			throw new Error("Missing Hub embedding base URL. Set KG_HUB_EMBEDDING_BASE_URL, embedding.hub.baseUrl, or llm.hub.baseUrl.");
		}

		if (!apiKey) {
			throw new Error("Missing Hub embedding API key. Set KG_HUB_EMBEDDING_API_KEY, KG_HUB_LLM_API_KEY, embedding.hub.apiKey, or llm.hub.apiKey.");
		}

		this.baseUrl = trimTrailingSlash(baseUrl);
		this.apiKey = apiKey;
		this.model = model || "embeddings";
		this.encodingFormat = encodingFormat || "float";
		this.dimensions = positiveInteger(dimensions, 512);
		this.batchSize = positiveInteger(batchSize, 64);
	}

	async requestEmbeddings(texts, batchOffset) {
		const response = await fetch(`${this.baseUrl}/v1/embeddings`, {
			method: "POST",
			headers: {
				"accept": "application/json",
				"authorization": `Bearer ${this.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				input: texts.map((text) => String(text ?? "")),
				encoding_format: this.encodingFormat,
				dimensions: this.dimensions,
			}),
		});
		const responseText = await response.text();
		let responseBody = null;

		try {
			responseBody = responseText ? JSON.parse(responseText) : {};
		} catch {
			if (!response.ok) {
				throw new Error(`Hub embedding request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
			}

			throw new Error("Hub embedding response was not valid JSON.");
		}

		if (!response.ok) {
			throw new Error(`Hub embedding request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		const data = responseBody?.data;
		if (!Array.isArray(data)) {
			throw new Error("Hub embedding response did not contain a data array.");
		}

		if (data.length !== texts.length) {
			throw new Error(`Hub embedding response count mismatch. Expected ${texts.length}, received ${data.length}.`);
		}

		const embeddings = new Array(texts.length);
		for (const [position, item] of data.entries()) {
			const index = Number.isInteger(item?.index) ? item.index : position;
			if (index < 0 || index >= texts.length) {
				throw new Error(`Hub embedding response contained out-of-range index ${index}.`);
			}

			if (embeddings[index]) {
				throw new Error(`Hub embedding response contained duplicate index ${index}.`);
			}

			embeddings[index] = assertEmbedding(item?.embedding, `input ${batchOffset + index + 1}`);
		}

		const missingIndex = embeddings.findIndex((embedding) => !embedding);
		if (missingIndex !== -1) {
			throw new Error(`Hub embedding response was missing embedding for input ${batchOffset + missingIndex + 1}.`);
		}

		return embeddings;
	}

	async embedTexts(texts) {
		if (texts.length === 0) {
			return [];
		}

		const embeddings = [];
		for (let start = 0; start < texts.length; start += this.batchSize) {
			const batch = texts.slice(start, start + this.batchSize);
			embeddings.push(...await this.requestEmbeddings(batch, start));
		}

		if (embeddings.length !== texts.length) {
			throw new Error(`Hub embedding response count mismatch. Expected ${texts.length}, received ${embeddings.length}.`);
		}

		return embeddings;
	}

	async embedDocuments(texts) {
		return this.embedTexts(texts);
	}

	async embedQuery(text) {
		const [embedding] = await this.embedTexts([text]);
		return embedding;
	}
}
