import { parseGraphExtraction } from "../ingestion/graphPayload.js";

function buildPrompt({ systemPrompt, prompt }) {
	return [systemPrompt, prompt].filter(Boolean).join("\n\n");
}

export class CustomHttpProvider {
	constructor(customConfig) {
		// console.log(customConfig);
		let { subProvider, extractionFormat = "json" } = customConfig;
		
		this.customConfig = customConfig;
		this.subProvider = subProvider;
		this.subProviderConfig = customConfig[this.subProvider];
		let endpoint = customConfig[subProvider].endpoint;
		this.extractionFormat = extractionFormat;
		
		if (!endpoint) {
			throw new Error(`Missing custom LLM endpoint. Subprovider - ${subProvider}`);
		}

	}

	generateFetchRequest(systemPrompt , prompt) {
		let spConfig = this.subProviderConfig;
		let endpoint = spConfig.endpoint;
		// console.log(endpoint);
		let requestObj = { 
			method: "POST",
			headers: {
				"accept": "text/plain, */*",
				"content-type": "application/json",
			}
		};

		if(this.subProvider == 'gemini') {
			const text = buildPrompt({ systemPrompt, prompt });
			requestObj.body = (JSON.stringify({
				endpoint : spConfig.bridgedEndpoint,
				method : 'POST',
				headers : {
					'Content-Type': 'application/json',
					'X-goog-api-key': spConfig.apiKey
				},
				body : {
					"contents": [
						{
							"parts": [
								{
									"text": text
								}
							]
						}
					]
				}
			}));
		} else if(this.subProvider == 'openai') {
			requestObj.body = JSON.stringify({
				endpoint : spConfig.bridgedEndpoint,
				method : 'POST',
				headers : {
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + spConfig.apiKey
				},
				body : {
					"model": spConfig.model,
					"messages": [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: prompt },
					]
				}
			})
		}
		
		return fetch(endpoint, requestObj);
	}

	async generateText({ systemPrompt, prompt }) {
		const response = await this.generateFetchRequest(systemPrompt, prompt);

		const responseJson = await response.json();
		const responseText = JSON.stringify(responseJson);

		if (!response.ok) {
			throw new Error(`Custom LLM request failed: ${response.status} ${response.statusText}${responseText ? ` - ${responseText}` : ""}`);
		}

		// console.log('#$#$ ' , JSON.stringify(responseJson));
		return this.extractCustomHttpText(responseJson)
		// return responseJson;
	}

	extractCustomHttpText(response) {
		if (typeof response === "string") {
			return response;
		}
		
		let llmText = '';
		if(this.subProvider == 'gemini') {
			llmText = response?.candidates?.[0]?.content?.parts?.find((part) => !part.thought)?.text;
		} else if(this.subProvider == 'openai') {
			llmText = response?.choices?.[0]?.message.content;
		}

		if (typeof llmText === "string") {
			return llmText;
		}

		// console.log('%%%% ' + llmText);

		throw new Error("Custom LLM response did not contain a non-thought text part.");
	}

	async extractGraphWithRawResponse({ text, systemPrompt, prompt, debugLogger }) {
		const extractionPrompt = prompt ?? `Extract graph data from this text:\n\n${text}`;
		const responseText = await this.generateText({
			systemPrompt,
			prompt: extractionPrompt,
		});

		// const responseText = this.extractCustomHttpText(response);

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
		let responseText = await this.generateText({
			systemPrompt,
			prompt: answerPrompt,
		});
		// const responseText = this.extractCustomHttpText(response);

		debugLogger?.section("Raw LLM Answer Response", responseText);

		return responseText;
	}
}
