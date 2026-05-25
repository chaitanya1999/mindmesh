import { extractCustomGraph, normalizeGraphPayload, parseGraphExtraction } from "../ingestion/graphPayload.js";
import { IngestionService } from "../ingestion/ingestionService.js";
import { countReviewSignals } from "../ingestion/reviewSignals.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getConfig } from "../config.js";
import { buildExtractionPrompt, loadPrompts } from "../prompts/promptRegistry.js";
import { formatExtractionGraphContext } from "../rag/graphContext.js";
import { buildOllamaMessages, extractOllamaText, OllamaProvider } from "../llm/ollamaProvider.js";
import { buildHubMessages, extractHubChatContent } from "../llm/hubChatProvider.js";

const customGraph = [
	"NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
	"NODE|pan_api|PAN API|api|API that verifies PAN details.",
	"RELATION|ekyc_screen|pan_api|uses|EKYC Screen uses PAN API.|Used during verification.",
].join("\n");
const customGraphWithSuggestion = [
	"NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
	"NODE|pan_api|PAN API|api|API that verifies PAN details.",
	"RELATION|ekyc_screen|pan_api|validates_with|EKYC Screen validates with PAN API.|Used during verification.",
	"RELATION_TYPE_SUGGESTION|validates_with|Source validates data using target.|More specific than uses.",
].join("\n");
const customGraphWithDelimitedNoise = [
	"Thought process: I should identify nodes and relations before answering.",
	"NODE|outside_node|Outside Node|concept|This line must be ignored.",
	"<start#$#$>",
	"NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
	"NODE|pan_api|PAN API|api|API that verifies PAN details.",
	"RELATION|ekyc_screen|pan_api|uses|EKYC Screen uses PAN API.|Used during verification.",
	"</end#$#$>",
	"NODE|after_node|After Node|concept|This line must also be ignored.",
].join("\n");
const customGraphWithMutations = [
	"<start#$#$>",
	"NODE_UPDATE|xyz_screen|XYZ Screen|screen|Created primarily due to a request from John Smith.|",
	"NODE_CREATE|john_smith|John Smith|person||AMBIGUITY:full identity not confirmed",
	"RELATION_CREATE|xyz_screen|john_smith|requested_by|primary request source||",
	"RELATION_DELETE|xyz_screen|old_owner|owned_by|CONTRADICTION:owner changed",
	"NODE_DELETE|old_owner|AMBIGUITY:old owner identity unclear",
	"NODE_TYPE_SUGGESTION|person|A human individual.|The input names a person but no approved person node type fits.",
	"RELATION_TYPE_SUGGESTION|requested_by|Source exists or changed because of a request from target.|No approved relationship type captures request origin.",
	"</end#$#$>",
].join("\n");

const schema = {
	path: "",
	fallbacks: {
		nodeType: "concept",
		relationshipType: "relates_to",
	},
	nodeTypes: [
		{ name: "concept", description: "Fallback." },
		{ name: "screen", description: "UI screen." },
		{ name: "api", description: "API." },
	],
	relationshipTypes: [
		{ name: "relates_to", description: "Fallback." },
		{ name: "uses", description: "Uses target." },
	],
	suggestions: {
		nodeTypes: [{ name: "journey_step", description: "Pending node suggestion." }],
		relationshipTypes: [{ name: "validates_with", description: "Pending relationship suggestion." }],
	},
};

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

// JSON LLM extraction support was removed; tests focus on custom pipeline parsing.

const customPayload = normalizeGraphPayload(extractCustomGraph(customGraph));
assert(customPayload.nodes.length === 2, "Custom graph parser failed.");
assert(customPayload.relations[0].relation === "uses", "Custom relation parser failed.");

const switchedPayload = normalizeGraphPayload(parseGraphExtraction(customGraph));
assert(switchedPayload.nodes[0].id === "node:ekyc_screen", "Parser failed.");

// Escaped field tests
const escapedNewline = extractCustomGraph("NODE_CREATE|abc|ABC|screen|Line one\\nLine two|");
assert(escapedNewline.nodes[0].description === "Line one\nLine two", "Escaped newline decode failed.");

const escapedPipe = extractCustomGraph("NODE_CREATE|abc|ABC|screen|Uses value A\\|B|");
assert(escapedPipe.nodes[0].description === "Uses value A|B", "Escaped pipe decode failed.");

const escapedBackslash = extractCustomGraph("NODE_CREATE|abc|ABC|screen|Has \\\\ slash|");
assert(escapedBackslash.nodes[0].description === "Has \\ slash", "Escaped backslash decode failed.");

const escapedLiteralBackslashN = extractCustomGraph("NODE_CREATE|abc|ABC|screen|Literal \\\\n text|");
assert(escapedLiteralBackslashN.nodes[0].description === "Literal \\n text", "Escaped literal backslash-n decode failed.");

const escapedRelationFields = extractCustomGraph("RELATION_CREATE|abc|xyz|uses|Line one\\nLine two|Description with A\\|B|");
assert(escapedRelationFields.relations[0].information === "Line one\nLine two", "Escaped relation information decode failed.");
assert(escapedRelationFields.relations[0].description === "Description with A|B", "Escaped relation description decode failed.");

const suggestionPayload = extractCustomGraph(customGraphWithSuggestion);
assert(suggestionPayload.schemaSuggestions.relationshipTypes[0].name === "validates_with", "Custom schema suggestion parser failed.");

const delimitedPayload = normalizeGraphPayload(extractCustomGraph(customGraphWithDelimitedNoise));
assert(delimitedPayload.nodes.length === 2, "Delimited custom parser did not isolate tagged graph records.");
assert(delimitedPayload.relations.length === 1, "Delimited custom parser failed to parse tagged relation.");
assert(!delimitedPayload.nodes.some((node) => node.name === "outside_node" || node.name === "after_node"), "Delimited custom parser consumed text outside markers.");

const emptyCustomPayload = normalizeGraphPayload(extractCustomGraph([
	"<start#$#$>",
	"No graph mutations are needed for this input.",
	"</end#$#$>",
].join("\n")));
assert(emptyCustomPayload.nodes.length === 0, "Empty custom extraction should not create nodes.");
assert(emptyCustomPayload.relations.length === 0, "Empty custom extraction should not create relations.");
assert(emptyCustomPayload.schemaWarnings.some((warning) => warning.includes("did not contain graph mutation records")), "Empty custom extraction should return an informative warning.");

const mutationPayload = extractCustomGraph(customGraphWithMutations);
assert(mutationPayload.nodes[0].operation === "update", "Custom mutation parser failed to capture node update operation.");
assert(mutationPayload.nodes[1].metadata === "AMBIGUITY:full identity not confirmed", "Custom mutation parser failed to capture node metadata.");
assert(mutationPayload.relations[0].operation === "create", "Custom mutation parser failed to capture relation create operation.");
assert(mutationPayload.nodeDeletes[0].name === "old_owner", "Custom mutation parser failed to capture node delete.");
assert(mutationPayload.nodeDeletes[0].metadata === "AMBIGUITY:old owner identity unclear", "Custom mutation parser failed to capture node delete metadata.");
assert(mutationPayload.relationDeletes[0].relation === "owned_by", "Custom mutation parser failed to capture relation delete.");
assert(mutationPayload.relationDeletes[0].metadata === "CONTRADICTION:owner changed", "Custom mutation parser failed to capture relation delete metadata.");
const normalizedMutationPayload = normalizeGraphPayload(mutationPayload);
assert(normalizedMutationPayload.nodes.length === 2, "Mutation normalization failed to keep node upserts.");
assert(normalizedMutationPayload.relations.length === 1, "Mutation normalization failed to keep relation upserts.");
assert(normalizedMutationPayload.nodeDeletes[0].id === "node:old_owner", "Mutation normalization failed to normalize node delete ID.");
assert(normalizedMutationPayload.nodeDeletes[0].metadata === "AMBIGUITY:old owner identity unclear", "Mutation normalization failed to keep node delete metadata.");
assert(normalizedMutationPayload.relationDeletes[0].sourceId === "node:xyz_screen", "Mutation normalization failed to normalize relation delete source.");
assert(normalizedMutationPayload.relationDeletes[0].metadata === "CONTRADICTION:owner changed", "Mutation normalization failed to keep relation delete metadata.");
const mutationReviewSignals = countReviewSignals(normalizedMutationPayload);
assert(mutationReviewSignals.ambiguityCount === 2, "Review signal counter failed to count ambiguity metadata.");
assert(mutationReviewSignals.contradictionCount === 1, "Review signal counter failed to count contradiction metadata.");

const legacyDeletePayload = normalizeGraphPayload(extractCustomGraph([
	"NODE_DELETE|legacy_owner",
	"RELATION_DELETE|legacy_screen|legacy_owner|owned_by",
].join("\n")));
assert(legacyDeletePayload.nodeDeletes[0].id === "node:legacy_owner", "Legacy node delete syntax should still parse.");
assert(legacyDeletePayload.nodeDeletes[0].metadata === "", "Legacy node delete syntax should default metadata to empty.");
assert(legacyDeletePayload.relationDeletes[0].relation === "owned_by", "Legacy relation delete syntax should still parse.");
assert(legacyDeletePayload.relationDeletes[0].metadata === "", "Legacy relation delete syntax should default metadata to empty.");

const emptyRelationInfoPayload = normalizeGraphPayload(extractCustomGraph([
	"NODE|varun|Varun|person|",
	"NODE|rajat|Rajat|person|",
	"RELATION|varun|rajat|manages||",
].join("\n")));
assert(emptyRelationInfoPayload.relations[0].information === "", "Normalizer should preserve empty relation information.");

const duplicateRelationPayload = normalizeGraphPayload(extractCustomGraph([
	"NODE|varun|Varun|person|",
	"NODE|rajat|Rajat|person|",
	"RELATION|varun|rajat|manages||",
	"RELATION|varun|rajat|manages|for the ABC project|",
].join("\n")));
assert(duplicateRelationPayload.relations.length === 1, "Normalizer should dedupe identical normalized relations.");
assert(duplicateRelationPayload.relations[0].information === "for the ABC project", "Normalizer should keep useful relation information when deduping.");

const duplicateNodePayload = normalizeGraphPayload(extractCustomGraph([
	"NODE|xyz_screen|XYZ Screen|screen|Created primarily due to a request from John Smith.",
	"NODE|xyz_screen|XYZ Screen|screen|",
].join("\n")));
assert(duplicateNodePayload.nodes.length === 1, "Normalizer should dedupe identical node names.");
assert(duplicateNodePayload.nodes[0].description === "Created primarily due to a request from John Smith.", "Normalizer should keep useful node descriptions when deduping.");

const strictPayload = normalizeGraphPayload(suggestionPayload, { schema, autoApplySuggestions: false });
assert(strictPayload.relations[0].relation === "relates_to", "Strict schema fallback failed.");
assert(strictPayload.schemaWarnings.length === 1, "Strict schema warning failed.");

const autoAppliedPayload = normalizeGraphPayload(suggestionPayload, { schema, autoApplySuggestions: true });
assert(autoAppliedPayload.relations[0].relation === "validates_with", "Auto-applied schema suggestion failed.");

const pendingSuggestionPayload = normalizeGraphPayload({
	nodes: [{ name: "search_step", label: "Search Step", type: "journey_step" }],
	relations: [],
}, { schema, autoApplySuggestions: true });
assert(pendingSuggestionPayload.nodes[0].type === "journey_step", "Auto-applied implicit node suggestion failed.");
assert(pendingSuggestionPayload.schemaSuggestions.nodeTypes[0].name === "journey_step", "Implicit node suggestion was not captured.");

const renderedPrompt = buildExtractionPrompt("Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}", {
	graphSchema: schema,
	existingGraphContext: "node:existing_varun | label: Varun",
	userInput: "there is one more Varun",
});
assert(renderedPrompt.includes("Approved node types:"), "Extraction prompt did not render schema.");
assert(renderedPrompt.includes("node:existing_varun"), "Extraction prompt did not render existing graph context.");
assert(renderedPrompt.includes("there is one more Varun"), "Extraction prompt did not render user input.");

const extractionContext = formatExtractionGraphContext({
	nodes: [
		{ id: "node:varun", label: "Varun", name: "varun", type: "person", description: "" },
		{ id: "node:rajat", label: "Rajat", name: "rajat", type: "person", description: "" },
	],
	relations: [
		{
			id: "rel:manages",
			sourceId: "node:varun",
			targetId: "node:rajat",
			relation: "manages",
			information: "for the ABC project",
			description: "",
		},
	],
});
assert(extractionContext.includes("[node:varun] Varun manages [node:rajat] Rajat."), "Extraction graph context should render readable relation sentences.");
assert(extractionContext.includes("Extra: for the ABC project."), "Extraction graph context should preserve extra relation information.");
assert(!extractionContext.includes("[rel:manages]"), "Extraction graph context should not include relation IDs.");

const hubMessages = buildHubMessages({ systemPrompt: "System instructions", prompt: "User request" });
assert(hubMessages[0].role === "system" && hubMessages[1].role === "user", "Hub provider should preserve system/user messages when both are present.");
const hubSingleMessage = buildHubMessages({ systemPrompt: "Fully rendered extraction prompt", prompt: "" });
assert(hubSingleMessage.length === 1 && hubSingleMessage[0].role === "user", "Hub provider should send rendered single prompts as a user message.");
assert(extractHubChatContent({ choices: [{ message: { content: "hello" } }] }) === "hello", "Hub provider failed to extract string chat content.");
assert(extractHubChatContent({ choices: [{ message: { content: [{ type: "text", text: "hello" }] } }] }) === "hello", "Hub provider failed to extract array chat content.");
const ollamaMessages = buildOllamaMessages({ systemPrompt: "System instructions", prompt: "User request" });
assert(ollamaMessages[0].role === "system" && ollamaMessages[1].role === "user", "Ollama provider should preserve system/user messages in chat mode.");
assert(extractOllamaText({ message: { content: "<think>hidden</think>hello" } }) === "hello", "Ollama provider should strip inline thinking markup from chat content.");
const ollamaChatProvider = new OllamaProvider({ baseUrl: "http://localhost:11434/", model: "mistral", think: false, temperature: 0 });
assert(ollamaChatProvider.buildRequestBody({ systemPrompt: "S", prompt: "P" }).messages.length === 2, "Ollama chat mode should build messages.");

const runtimePrompts = loadPrompts(getConfig());
let capturedVectorQuery = null;
let capturedGraphExpansion = null;
let capturedExtractionRequest = null;
let indexedGraph = null;
const service = new IngestionService({
	llmProvider: {
		async extractGraph(request) {
			capturedExtractionRequest = request;
			return {
				nodes: [
					{ name: "varun_2", label: "Varun", type: "person", description: "Another person named Varun." },
				],
				relations: [],
				schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
			};
		},
	},
	graphStore: {
		async expandFromNodes(nodeIds, depth) {
			capturedGraphExpansion = { nodeIds, depth };
			return {
				nodes: [
					{ id: "node:varun", label: "Varun", name: "varun", type: "person", description: "Existing Varun." },
				],
				relations: [],
			};
		},
		async upsertGraph(graph) {
			return graph;
		},
	},
	vectorStore: {
		async queryNodes(query, topK) {
			capturedVectorQuery = { query, topK };
			return [{ id: "node:varun", metadata: { label: "Varun" }, distance: 0.1 }];
		},
		async upsertGraphIndex(graph) {
			indexedGraph = graph;
		},
	},
		prompts: {
			...runtimePrompts,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
			schemaAutoApplySuggestions: false,
		},
	ingestion: {
		contextEnabled: true,
		contextTopK: 2,
		contextDepth: 1,
	},
});
await service.ingestText({ text: "There is one more Varun.", source: "test" });
assert(capturedVectorQuery?.query === "There is one more Varun.", "Ingestion service did not query vector context with input text.");
assert(capturedVectorQuery?.topK === 2, "Ingestion service did not use ingestion context topK.");
assert(capturedGraphExpansion?.depth === 1, "Ingestion service did not use ingestion context depth.");
assert(capturedExtractionRequest?.systemPrompt.includes("node:varun"), "Ingestion extraction prompt did not include retrieved graph context.");
assert(capturedExtractionRequest?.systemPrompt.includes("There is one more Varun."), "Ingestion extraction prompt did not include user input.");
assert(capturedExtractionRequest?.prompt === "", "Ingestion extraction should render dynamic values into the extraction template.");
assert(indexedGraph?.nodes?.[0]?.id === "node:varun_2", "Ingestion service did not index normalized stored graph.");

let pendingContextExtractionRequest = null;
const pendingContextService = new IngestionService({
	llmProvider: {
		async extractGraph(request) {
			pendingContextExtractionRequest = request;
			return {
				nodes: [],
				relations: [],
				schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
			};
		},
	},
	graphStore: {
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async upsertGraph(graph) {
			return graph;
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async queryHitlNotes(query, topK) {
			assert(query === "Sales Journey Flow contains apple stage", "Pending HITL context should query with input text.");
			assert(topK === 2, "Pending HITL context should reuse ingestion context topK.");
			return [{
				id: "hitl:pending_sales_journey",
				userName: "Frontend User",
				llmResponse: [
					"<start#$#$>",
					"NODE_CREATE|sales_journey_flow|Sales Journey Flow|flow||",
					"</end#$#$>",
				].join("\n"),
			}];
		},
		async upsertGraphIndex() {},
	},
		prompts: {
			...runtimePrompts,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
			schemaAutoApplySuggestions: false,
		},
	ingestion: {
		contextEnabled: true,
		contextTopK: 2,
		contextDepth: 1,
	},
});
await pendingContextService.ingestText({ text: "Sales Journey Flow contains apple stage", source: "test" });
assert(pendingContextExtractionRequest?.systemPrompt.includes("Pending HITL context"), "Ingestion prompt should include pending HITL context.");
assert(pendingContextExtractionRequest?.systemPrompt.includes("[node:sales_journey_flow] Sales Journey Flow"), "Pending HITL context should expose pending node IDs for reuse.");

const deletedRelations = [];
const deletedNodes = [];
const deletedVectorRelations = [];
const deletedVectorNodes = [];
let mutationUpsertGraph = null;
let mutationIndexedGraph = null;
const mutationService = new IngestionService({
	llmProvider: {
		async extractGraph() {
			return {
				nodes: [{ name: "new_screen", label: "New Screen", type: "screen", description: "Newly captured screen." }],
				relations: [{ sourceName: "new_screen", targetName: "pan_api", relation: "uses", information: "during onboarding" }],
				nodeDeletes: [{ name: "old_screen" }],
				relationDeletes: [{ sourceName: "xyz_screen", targetName: "old_owner", relation: "owned_by" }],
				schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
			};
		},
	},
	graphStore: {
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async deleteRelation(relationId) {
			deletedRelations.push(relationId);
			return { relationId };
		},
		async deleteNode(nodeId) {
			deletedNodes.push(nodeId);
			return { nodeId, relationIds: ["rel:detached_from_node"] };
		},
		async upsertGraph(graph) {
			mutationUpsertGraph = graph;
			return graph;
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async deleteNodes(ids) {
			deletedVectorNodes.push(...ids);
		},
		async deleteRelations(ids) {
			deletedVectorRelations.push(...ids);
		},
		async upsertGraphIndex(graph) {
			mutationIndexedGraph = graph;
		},
	},
	prompts: {
		...runtimePrompts,
		extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		schemaAutoApplySuggestions: false,
	},
	ingestion: {
		contextEnabled: true,
		contextTopK: 1,
		contextDepth: 1,
	},
});
const mutationResult = await mutationService.ingestText({ text: "Apply graph mutations.", source: "test" });
assert(deletedRelations.length === 1, "Ingestion service should delete extracted relation deletes.");
assert(deletedNodes[0] === "node:old_screen", "Ingestion service should delete extracted node deletes.");
assert(deletedVectorNodes[0] === "node:old_screen", "Ingestion service should delete node vectors.");
assert(deletedVectorRelations.includes("rel:detached_from_node"), "Ingestion service should delete relation vectors detached by node deletion.");
assert(mutationUpsertGraph?.nodes?.[0]?.id === "node:new_screen", "Ingestion service should upsert mutation node records.");
assert(mutationIndexedGraph?.relations?.length === 1, "Ingestion service should index mutation relation upserts.");
assert(mutationResult.deletedNodeIds[0] === "node:old_screen", "Ingestion result should expose deleted node IDs.");

let hitlStoredNote = null;
let hitlGraphTouched = false;
const hitlService = new IngestionService({
	llmProvider: {
		async extractGraphWithRawResponse() {
			return {
				rawResponse: "<start#$#$>\nNODE_CREATE|draft_screen|Draft Screen|screen||\n<end#$#$>",
				graph: {
					nodes: [{ name: "draft_screen", label: "Draft Screen", type: "screen", description: "" }],
					relations: [],
					schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
				},
			};
		},
	},
	graphStore: {
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async upsertGraph() {
			hitlGraphTouched = true;
			return { nodes: [], relations: [] };
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async upsertHitlNote(note) {
			hitlStoredNote = note;
			return { id: note.id, document: note.llmResponse, metadata: { createdAt: note.createdAt } };
		},
	},
	prompts: {
		...runtimePrompts,
		extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		schemaAutoApplySuggestions: false,
	},
	ingestion: {
		mode: "hitl",
		hitlDefaultUserName: "reviewer",
		contextEnabled: true,
		contextTopK: 1,
		contextDepth: 1,
	},
});
const hitlResult = await hitlService.ingestText({ text: "Draft screen exists.", source: "test", userName: "Frontend User" });
assert(hitlResult.status === "pending_hitl", "HITL ingestion should return a pending status.");
assert(hitlStoredNote?.userName === "Frontend User", "HITL ingestion should store the request user name.");
assert(hitlStoredNote?.userInput === "Draft screen exists.", "HITL ingestion should store the human input.");
assert(hitlStoredNote?.llmResponse.includes("NODE_CREATE|draft_screen"), "HITL ingestion should store the raw LLM response.");
assert(hitlGraphTouched === false, "HITL ingestion should not apply graph mutations immediately.");

let duplicatePendingHitlStoredNote = null;
const duplicatePendingHitlService = new IngestionService({
	llmProvider: {
		async extractGraphWithRawResponse() {
			return {
				rawResponse: [
					"<start#$#$>",
					"NODE_CREATE|sales_journey_flow|Sales Journey Flow|concept|Duplicate create emitted by model.|",
					"NODE_CREATE|apple_stage|Apple Stage|concept||",
					"RELATION_CREATE|sales_journey_flow|apple_stage|contains|||",
					"</end#$#$>",
				].join("\n"),
				graph: {
					nodes: [
						{ name: "sales_journey_flow", label: "Sales Journey Flow", type: "concept", description: "Duplicate create emitted by model.", operation: "create" },
						{ name: "apple_stage", label: "Apple Stage", type: "concept", description: "", operation: "create" },
					],
					relations: [
						{ sourceName: "sales_journey_flow", targetName: "apple_stage", relation: "contains", operation: "create" },
					],
					schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
				},
			};
		},
	},
	graphStore: {
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async upsertGraph() {
			throw new Error("HITL duplicate guard test should not touch graph DB.");
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async queryHitlNotes() {
			return [{
				id: "hitl:pending_sales_journey",
				userName: "Frontend User",
				llmResponse: [
					"<start#$#$>",
					"NODE_CREATE|sales_journey_flow|Sales Journey Flow|concept||",
					"</end#$#$>",
				].join("\n"),
			}];
		},
		async upsertHitlNote(note) {
			duplicatePendingHitlStoredNote = note;
			return { id: note.id, document: note.llmResponse, metadata: { createdAt: note.createdAt } };
		},
	},
		prompts: {
			...runtimePrompts,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
			schemaAutoApplySuggestions: false,
		},
	ingestion: {
		mode: "hitl",
		contextEnabled: true,
		contextTopK: 2,
		contextDepth: 1,
	},
});
await duplicatePendingHitlService.ingestText({ text: "Sales Journey Flow contains apple stage", source: "test", userName: "Frontend User" });
assert(duplicatePendingHitlStoredNote?.llmResponse.includes("NODE_UPDATE|sales_journey_flow"), "Pending duplicate node creates should be rewritten as updates.");
assert(!duplicatePendingHitlStoredNote?.llmResponse.includes("NODE_CREATE|sales_journey_flow"), "Pending duplicate node creates should not remain in stored HITL response.");
assert(duplicatePendingHitlStoredNote?.llmResponse.includes("NODE_CREATE|apple_stage"), "New nodes should remain creates after pending duplicate reconciliation.");

const failingLogDir = await fs.mkdtemp(path.join(os.tmpdir(), "kg-ingest-debug-"));
const failingService = new IngestionService({
	llmProvider: {
		async extractGraph() {
			return {
				nodes: [{ name: "varun", label: "Varun", type: "person", description: "" }],
				relations: [],
			};
		},
	},
	graphStore: {
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async upsertGraph(graph) {
			return graph;
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async upsertGraphIndex() {
			throw new Error("vector failure");
		},
	},
	prompts: {
		...runtimePrompts,
		extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		schemaAutoApplySuggestions: false,
	},
	logging: {
		enabled: true,
		directory: failingLogDir,
		scopes: ["ingest"],
	},
	ingestion: {
		contextEnabled: true,
		contextTopK: 1,
		contextDepth: 1,
	},
});
let failureLogged = false;
try {
	await failingService.ingestText({ text: "Varun exists.", source: "test" });
} catch {
	const [logFile] = await fs.readdir(failingLogDir);
	const logText = await fs.readFile(path.join(failingLogDir, logFile), "utf8");
	failureLogged = logText.includes("## Ingestion Error") && logText.includes("vector failure");
}
await fs.rm(failingLogDir, { recursive: true, force: true });
assert(failureLogged, "Ingestion service should write debug log details when ingest fails.");

let invalidFailed = false;
try {
	const invalidPayload = extractCustomGraph("not json");
	invalidFailed = invalidPayload.warnings?.some((warning) => warning.includes("did not contain graph mutation records"));
} catch {
	invalidFailed = true;
}
assert(invalidFailed, "Invalid extraction did not fail.");

console.log("[PASS] graph extraction parser smoke tests");
