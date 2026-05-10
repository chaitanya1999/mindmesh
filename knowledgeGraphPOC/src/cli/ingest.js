import { getConfig, describeRuntime } from "../config.js";
import { readInput } from "../input/readInput.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";
import { IngestionService } from "../ingestion/ingestionService.js";

// const FALLBACK_TEXT = "EKYC Screen uses PAN Verification API. PAN Verification API validates customer PAN details for onboarding.";
const FALLBACK_TEXT = `
	Node: CDP screen
	CDP screen [Screen] Followed By CKYC Search Screen [Screen] - Single KYC Success , Single KYC Fail with CDP Fail or CDP success with new customer option chosen
	Node: CKYC Search Screen
	CKYC Search Screen [Screen] Contains CKYC Search Section [UI Section]
	Node: CKYC Search Section
	CKYC Search Section [UI Section] Invokes CKYC Search Integration [Integration (API)]
	Node: CKYC Search Integration
	CKYC Search Integration [Integration (API)] Is Provided By SERSAI System [External System]
	Node: SERSAI System
	CKYC Download Integration [Integration (API)] Is Provided By SERSAI System [External System]
	CKYC Search Integration [Integration (API)] Is Provided By SERSAI System [External System]
	CKYC Search Section [UI Section] Invokes CKYC Search Integration [Integration (API)]
	CKYC Search Screen [Screen] Contains CKYC Search Section [UI Section]
	Co-Applicant KYC [Functionality / Feature] Uses CKYC Search Section [UI Section] - for ckyc search
	Node: Co-Applicant KYC
	Co-Applicant KYC [Functionality / Feature] Uses CKYC Search Section [UI Section] - for ckyc search
	Co-Applicant KYC [Functionality / Feature] Uses CKYC Download Section [UI Section] - for ckyc download after ckyc search success
	Node: CKYC Download Section
	CKYC Download Section [UI Section] Invokes CKYC Download Integration [Integration (API)]
	CKYC Download Screen [Screen] Contains CKYC Download Section [UI Section]
	Co-Applicant KYC [Functionality / Feature] Uses CKYC Download Section [UI Section] - for ckyc download after ckyc search success
	Co-Applicant KYC [Functionality / Feature] Uses EKYC Timer Section [UI Section] - for ekyc
	Node: EKYC Timer Section
	EKYC Timer Section [UI Section] Waits For EKYC_CheckValidLoanID Inbound Integration [Integration (API)] - SOApp validates SFDC conditions before proceeding for EKYC
	EKYC Timer Section [UI Section] Waits For EKYC_BIOMETRIC Inbound Integration [Integration (API)] - SoApp performs EKYC after EKYC_CheckValidLoanID is success
	EKYC Timer Screen [Screen] Contains EKYC Timer Section [UI Section]
	Co-Applicant KYC [Functionality / Feature] Uses EKYC Timer Section [UI Section] - for ekyc
	Co-Applicant KYC [Functionality / Feature] Uses EKYC Download Section [UI Section] - for ekyc
	Node: EKYC Download Section
	Co-Applicant KYC [Functionality / Feature] Uses EKYC Download Section [UI Section] - for ekyc
	EKYC Download Screen [Screen] Contains EKYC Download Section [UI Section]
	Co-Applicant Screen [Screen] Triggers Co-Applicant KYC [Functionality / Feature] - initiated via Add Co-Applicant button
	Node: Co-Applicant Screen
	Co-Applicant Screen [Screen] Triggers Co-Applicant KYC [Functionality / Feature] - initiated via Add Co-Applicant button
	Co-Applicant Screen [Screen] Followed By Posidex Pending Screen [Screen] - On click of Next button
	QDE Screen [Screen] Followed By Co-Applicant Screen [Screen] - On click of Next button
	CKYC Search Screen [Screen] Followed By CKYC Download Screen [Screen] - When CKYC search success
	Node: CKYC Download Screen
	CKYC Download Screen [Screen] Followed By QDE Screen [Screen]
	Node: QDE Screen
	QDE Screen [Screen] Followed By Co-Applicant Screen [Screen] - On click of Next button
	BU Router screen [Screen] Followed By QDE Screen [Screen] - corporate loan (pre QDE skipped)
	Node: BU Router screen
	BU Router screen [Screen] Followed By CDP screen [Screen]
	BU Router screen [Screen] Followed By QDE Screen [Screen] - corporate loan (pre QDE skipped)
	CKYC Search Screen [Screen] Followed By QDE Screen [Screen] - via Skip option when CKYC Search or single KYC success
	CKYC Download Screen [Screen] Followed By QDE Screen [Screen]
	EKYC Download Screen [Screen] Followed By QDE Screen [Screen] - ekyc process finished
	Node: EKYC Download Screen
	EKYC Download Screen [Screen] Contains EKYC Download Section [UI Section]
	EKYC Download Screen [Screen] Followed By QDE Screen [Screen] - ekyc process finished
	EKYC Timer Screen [Screen] Followed By EKYC Download Screen [Screen]
	EKYC Timer Screen [Screen] Leads To QDE Screen [Screen] - when EKYC fail
	Node: EKYC Timer Screen
	EKYC Timer Screen [Screen] Followed By EKYC Download Screen [Screen]
	EKYC Timer Screen [Screen] Leads To QDE Screen [Screen] - when EKYC fail
	EKYC Timer Screen [Screen] Contains EKYC Timer Section [UI Section]
	CKYC Search Screen [Screen] Followed By EKYC Timer Screen [Screen] - Single KYC Success / CKYC Search success or failure with Aadhaar as OVD
	CKYC Download Screen [Screen] Contains CKYC Download Section [UI Section]
	CKYC Search Screen [Screen] Followed By CKYC Download Screen [Screen] - When CKYC search success
	CKYC Search Screen [Screen] Followed By EKYC Timer Screen [Screen] - Single KYC Success / CKYC Search success or failure with Aadhaar as OVD
	CKYC Search Screen [Screen] Followed By QDE Screen [Screen] - via Skip option when CKYC Search or single KYC success
	CDP screen [Screen] Followed By CKYC Search Screen [Screen] - Single KYC Success , Single KYC Fail with CDP Fail or CDP success with new customer option chosen
	CDP screen [Screen] Contains Mobile Number [UI Field] - required to fetch customer data
	Node: Mobile Number
	CDP screen [Screen] Contains Mobile Number [UI Field] - required to fetch customer data
	CDP screen [Screen] Triggers Single KYC Search [System Logic] - on click of Search button
	Node: Single KYC Search
	CDP screen [Screen] Triggers Single KYC Search [System Logic] - on click of Search button
	CDP screen [Screen] Invokes CDP_CUSTOMER_SEARCH Integration [Integration (API)]
	Node: CDP_CUSTOMER_SEARCH Integration
	CDP_CUSTOMER_SEARCH Integration [Integration (API)] Is Provided By Customer Data Platform (CDP) System [External System]
	Node: Customer Data Platform (CDP) System
	CDP_CUSTOMER_SEARCH Integration [Integration (API)] Is Provided By Customer Data Platform (CDP) System [External System]
	CDP screen [Screen] Invokes CDP_CUSTOMER_SEARCH Integration [Integration (API)]
	BU Router screen [Screen] Followed By CDP screen [Screen]
`;

async function main() {
	const input = await readInput({
		argv: process.argv.slice(2),
		fallback: FALLBACK_TEXT,
		prompt: "Text to ingest: ",
	});
	const config = getConfig();
	const prompts = loadPrompts(config);
	const llmProvider = createLlmProvider(config, input.options.provider);
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);

	try {
		const service = new IngestionService({
			llmProvider,
			graphStore,
			vectorStore,
			prompts,
			logging: config.logging,
		});
		const graph = await service.ingestText({ text: input.text, source: input.source });

		console.log("Knowledge Graph POC ingestion complete.");
		console.log(JSON.stringify({
			...describeRuntime(config),
			llmProvider: input.options.provider || config.llm.provider,
			inputSource: input.source,
			nodes: graph.nodes.length,
			relations: graph.relations.length,
			schemaSuggestions: {
				nodeTypes: graph.schemaSuggestions?.nodeTypes?.length ?? 0,
				relationshipTypes: graph.schemaSuggestions?.relationshipTypes?.length ?? 0,
			},
			schemaWarnings: graph.schemaWarnings?.length ?? 0,
			persistedSchemaSuggestions: graph.persistedSchemaSuggestions,
		}, null, 2));

		console.log("\nExtracted nodes:");
		for (const node of graph.nodes) {
			console.log(`- ${node.id} | ${node.label} | ${node.name} | ${node.type}`);
		}

		console.log("\nExtracted relations:");
		for (const relation of graph.relations) {
			console.log(`- ${relation.id} | ${relation.sourceId} -[${relation.relation}]-> ${relation.targetId}`);
		}

		if (graph.schemaWarnings?.length > 0) {
			console.log("\nSchema warnings:");
			for (const warning of graph.schemaWarnings) {
				console.log(`- ${warning}`);
			}
		}

		const suggestedNodeTypes = graph.schemaSuggestions?.nodeTypes ?? [];
		const suggestedRelationshipTypes = graph.schemaSuggestions?.relationshipTypes ?? [];
		if (suggestedNodeTypes.length > 0 || suggestedRelationshipTypes.length > 0) {
			console.log("\nSchema suggestions:");
			for (const suggestion of suggestedNodeTypes) {
				console.log(`- node type ${suggestion.name}: ${suggestion.description}${suggestion.reason ? ` (${suggestion.reason})` : ""}`);
			}
			for (const suggestion of suggestedRelationshipTypes) {
				console.log(`- relationship type ${suggestion.name}: ${suggestion.description}${suggestion.reason ? ` (${suggestion.reason})` : ""}`);
			}
		}
	} finally {
		await graphStore.close();
	}
}

main().catch((error) => {
	console.error("Knowledge Graph POC ingestion failed.");
	console.error(error.message);
	process.exit(1);
});
