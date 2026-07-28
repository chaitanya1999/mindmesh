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
	constructor({ baseUrl, apiKey, model, temperature = null }) {
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

// 		return `
// <start#$#$>
// NODE_CREATE|cdp_screen|CDP Screen|screen|||
// NODE_CREATE|ckyc_search_screen|CKYC Search Screen|screen|||
// NODE_CREATE|ckyc_search_section|CKYC Search Section|ui_section|||
// NODE_CREATE|ckyc_search_integration|CKYC Search Integration|integration_api|||
// NODE_CREATE|sersai_system|SERSAI System|external_system|||
// NODE_CREATE|ckyc_download_integration|CKYC Download Integration|integration_api|||
// NODE_CREATE|dms_integration|DMS Integration|integration_api|||
// NODE_CREATE|filenet|Filenet|external_system|||
// NODE_CREATE|karza_name_match_integration|KARZA_NAME_MATCH Integration|integration_api|||
// NODE_CREATE|ekyc_biometric_inbound_integration|EKYC_BIOMETRIC Inbound Integration|integration_api|||
// NODE_CREATE|so_app|SO App|external_system|||
// NODE_CREATE|ekyc_checkvalidloanid_inbound_integration|EKYC_CheckValidLoanID Inbound Integration|integration_api|||
// NODE_CREATE|ekyc_api_uidai_integration|EKYC Api UIDAI|integration_api|||
// NODE_CREATE|ekyc_at_pre_da_section|EKYC at Pre DA Section|ui_section|||
// NODE_CREATE|dedupe_integration|DEDUPE Integration|integration_api|||
// NODE_CREATE|ekyc_timer_section|EKYC Timer Section|ui_section|||
// NODE_CREATE|ekyc_timer_screen|EKYC Timer Screen|screen|||
// NODE_CREATE|ekyc_download_section|EKYC Download Section|ui_section|||
// NODE_CREATE|ekyc_download_screen|EKYC Download Screen|screen|||
// NODE_CREATE|rate_approval_section|Rate Approval Section|ui_section|||
// NODE_CREATE|pre_da_screen|Pre DA Screen|screen|||
// NODE_CREATE|co_applicant_kyc|Co-Applicant KYC|functionality_feature|||
// NODE_CREATE|dedupe_and_prospect_integration|DEDUPE_AND_PROSPECT Integration|integration_api|||
// NODE_CREATE|posidex_pending_screen|Posidex Pending Screen|screen|||
// NODE_CREATE|dde_screen|DDE Screen|screen|||
// NODE_CREATE|ckyc_download_section|CKYC Download Section|ui_section|||
// NODE_CREATE|ckyc_download_screen|CKYC Download Screen|screen|||
// NODE_CREATE|qde_screen|QDE Screen|screen|||
// NODE_CREATE|co_applicant_screen|Co-Applicant Screen|screen|||
// NODE_CREATE|bu_router_screen|BU Router screen|screen|||
// NODE_CREATE|cdp_customer_search_integration|CDP_CUSTOMER_SEARCH Integration|integration_api|||
// NODE_CREATE|customer_data_platform_cdp_system|Customer Data Platform (CDP) System|external_system|||
// NODE_CREATE|mobile_number|Mobile Number|ui_field|required to fetch customer data||
// NODE_CREATE|single_kyc_search|Single KYC Search|system_logic|||
// RELATION_TYPE_SUGGESTION|uses|Indicates a feature, screen, or process consumes a UI section or component.|Input repeatedly used "Uses" and no approved relation covers consumption/usage.
// RELATION_TYPE_SUGGESTION|relates_to|Non-hierarchical association or extension between components or integrations.|Input used "Relates To" to express an extension/association; no approved relation fits.
// RELATION_CREATE|cdp_screen|ckyc_search_screen|followed_by|on Single KYC success or CDP success with new customer option or Single KYC fail with CDP fail|||
// RELATION_CREATE|ckyc_search_screen|ckyc_search_section|contains||| 
// RELATION_CREATE|ckyc_search_section|ckyc_search_integration|invokes||| 
// RELATION_CREATE|ckyc_search_integration|sersai_system|is_provided_by||| 
// RELATION_CREATE|ckyc_download_integration|sersai_system|is_provided_by||| 
// RELATION_CREATE|ckyc_download_integration|dms_integration|invokes|to upload CKYC documents||| 
// RELATION_CREATE|dms_integration|filenet|is_provided_by||| 
// RELATION_CREATE|karza_name_match_integration|dms_integration|invokes|after EKYC at Pre DA success||| 
// RELATION_CREATE|ekyc_biometric_inbound_integration|karza_name_match_integration|invokes|on success response at Pre DA||| 
// RELATION_CREATE|ekyc_biometric_inbound_integration|dms_integration|invokes|to upload EKYC documents for Pre QDE EKYC||| 
// RELATION_CREATE|so_app|ekyc_biometric_inbound_integration|invokes|via Mule||| 
// RELATION_CREATE|so_app|ekyc_checkvalidloanid_inbound_integration|invokes|via Mule||| 
// RELATION_CREATE|so_app|ekyc_api_uidai_integration|invokes|obtains customer information||| 
// RELATION_CREATE|ekyc_at_pre_da_section|ekyc_biometric_inbound_integration|waits_for|SoApp performs EKYC after EKYC_CheckValidLoanID success||| 
// RELATION_CREATE|ekyc_at_pre_da_section|dedupe_integration|invokes|after EKYC success||| 
// RELATION_CREATE|ekyc_at_pre_da_section|ekyc_checkvalidloanid_inbound_integration|waits_for|SOApp validates SFDC conditions before proceeding for EKYC||| 
// RELATION_CREATE|rate_approval_section|ekyc_at_pre_da_section|followed_by|after rate approval completes and EKYC at Pre DA applicable||| 
// RELATION_CREATE|pre_da_screen|ekyc_at_pre_da_section|contains||| 
// RELATION_CREATE|ekyc_timer_section|ekyc_biometric_inbound_integration|waits_for|SoApp performs EKYC after EKYC_CheckValidLoanID success||| 
// RELATION_CREATE|ekyc_timer_section|ekyc_checkvalidloanid_inbound_integration|waits_for|SOApp validates SFDC conditions before proceeding for EKYC||| 
// RELATION_CREATE|ekyc_timer_screen|ekyc_timer_section|contains||| 
// RELATION_CREATE|co_applicant_kyc|ekyc_timer_section|uses|for ekyc||| 
// RELATION_CREATE|dedupe_and_prospect_integration|karza_name_match_integration|invokes|on QDE||| 
// RELATION_CREATE|dedupe_and_prospect_integration|dedupe_integration|relates_to|extension of DEDUPE with extra APIs and logic||| 
// RELATION_CREATE|posidex_pending_screen|dedupe_and_prospect_integration|invokes||| 
// RELATION_CREATE|posidex_pending_screen|dde_screen|followed_by|automatically after integrations respond||| 
// RELATION_CREATE|co_applicant_screen|posidex_pending_screen|followed_by|on click of Next button||| 
// RELATION_CREATE|ckyc_download_section|ckyc_download_integration|invokes||| 
// RELATION_CREATE|ckyc_download_screen|ckyc_download_section|contains||| 
// RELATION_CREATE|ckyc_download_screen|qde_screen|followed_by||| 
// RELATION_CREATE|qde_screen|co_applicant_screen|followed_by|on click of Next button||| 
// RELATION_CREATE|co_applicant_screen|co_applicant_kyc|triggers|initiated via Add Co-Applicant button||| 
// RELATION_CREATE|bu_router_screen|qde_screen|followed_by|corporate loan (pre QDE skipped)||| 
// RELATION_CREATE|bu_router_screen|cdp_screen|followed_by||| 
// RELATION_CREATE|ckyc_search_screen|qde_screen|followed_by|via Skip option when CKYC Search or single KYC success||| 
// RELATION_CREATE|ckyc_search_screen|ekyc_timer_screen|followed_by|Single KYC success or CKYC search success/failure with Aadhaar as OVD||| 
// RELATION_CREATE|ckyc_search_screen|ckyc_download_screen|followed_by|when CKYC search success||| 
// RELATION_CREATE|co_applicant_kyc|ckyc_download_section|uses|for ckyc download after ckyc search success||| 
// RELATION_CREATE|co_applicant_kyc|ckyc_search_section|uses|for ckyc search||| 
// RELATION_CREATE|co_applicant_kyc|ekyc_download_section|uses|for ekyc||| 
// RELATION_CREATE|ckyc_search_integration|sersai_system|is_provided_by||| 
// RELATION_CREATE|cdp_screen|mobile_number|contains|required to fetch customer data||| 
// RELATION_CREATE|cdp_screen|single_kyc_search|triggers|on click of Search button||| 
// RELATION_CREATE|cdp_screen|cdp_customer_search_integration|invokes||| 
// RELATION_CREATE|cdp_customer_search_integration|customer_data_platform_cdp_system|is_provided_by||| 
// </end#$#$>`;
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
