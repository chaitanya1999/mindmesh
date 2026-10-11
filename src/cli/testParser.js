import { extractCustomGraph, formatGraphRecords, normalizeGraphPayload, parseGraphExtraction, validatePropertyConstraints } from "../ingestion/graphPayload.js";
import { resolveGraphPayload } from "../ingestion/graphResolution.js";
import { formatFieldGuidance, formatSchemaCatalog } from "../schema/graphSchema.js";
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
	"NODE|outside_node|Outside Node|screen|This line must be ignored.",
	"<start#$#$>",
	"NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
	"NODE|pan_api|PAN API|api|API that verifies PAN details.",
	"RELATION|ekyc_screen|pan_api|uses|EKYC Screen uses PAN API.|Used during verification.",
	"</end#$#$>",
	"NODE|after_node|After Node|screen|This line must also be ignored.",
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
	nodeTypes: [
		{ name: "screen", description: "UI screen." },
		{ name: "api", description: "API." },
	],
	relationshipTypes: [
		{ name: "uses", description: "Uses target." },
	],
};
const serviceGraphSchema = {
	...schema,
	nodeTypes: [
		...schema.nodeTypes,
		{ name: "person", description: "Human individual." },
	],
	relationshipTypes: [
		...schema.relationshipTypes,
		{ name: "contains", description: "Source contains target." },
		{ name: "manages", description: "Source manages target." },
		{ name: "owned_by", description: "Source is owned by target." },
		{ name: "requested_by", description: "Source was requested by target." },
	],
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
	"NODE|xyz_screen|XYZ Screen|screen|Revised description.",
].join("\n")));
assert(duplicateNodePayload.nodes.length === 1, "Normalizer should dedupe identical node names.");
assert(duplicateNodePayload.nodes[0].description === "Revised description.", "Normalizer should prefer newer node description over longer existing one.");

const strictPayload = normalizeGraphPayload(suggestionPayload, { schema });
assert(strictPayload.relations[0].relation === "validates_with", "Strict schema should preserve unknown relation for review.");
assert(strictPayload.schemaWarnings.length === 1, "Strict schema warning failed.");
assert(strictPayload.schemaViolations[0]?.kind === "relationshipType", "Strict schema violation failed.");

const suggestionReviewPayload = normalizeGraphPayload(suggestionPayload, { schema });
assert(suggestionReviewPayload.relations[0].relation === "validates_with", "Schema suggestion relation should be preserved for HITL review.");
assert(suggestionReviewPayload.schemaViolations[0]?.kind === "relationshipType", "Schema violations must still be detected for review.");

const pendingSuggestionPayload = normalizeGraphPayload({
	nodes: [{ name: "search_step", label: "Search Step", type: "journey_step" }],
	relations: [],
}, { schema });
assert(pendingSuggestionPayload.nodes[0].type === "journey_step", "Implicit node suggestion should preserve extracted type.");
assert(pendingSuggestionPayload.schemaSuggestions.nodeTypes[0].name === "journey_step", "Implicit node suggestion was not captured.");
assert(pendingSuggestionPayload.schemaViolations[0]?.kind === "nodeType", "Implicit node suggestion must still require schema approval.");

// Relations never create nodes, and there are no fallback types.
const relationOnlyPayload = normalizeGraphPayload(extractCustomGraph("RELATION_CREATE|ekyc_screen|pan_api|uses|||"), { schema });
assert(relationOnlyPayload.nodes.length === 0, "A relation must not create endpoint nodes.");
assert(relationOnlyPayload.relations[0].sourceId === "node:ekyc_screen" && relationOnlyPayload.relations[0].targetId === "node:pan_api", "Relation endpoints should reference nodes by id.");
assert(relationOnlyPayload.schemaViolations.length === 0, "A relation with an approved type should pass schema normalization.");

const untypedPayload = normalizeGraphPayload(extractCustomGraph([
	"NODE_CREATE|abc|ABC||",
	"NODE_CREATE|xyz|XYZ|screen|",
	"RELATION_CREATE|abc|xyz||||",
].join("\n")), { schema });
assert(untypedPayload.nodes.find((node) => node.name === "abc")?.type === "", "A blank node type must stay blank, not become a fallback.");
assert(untypedPayload.relations[0].relation === "", "A blank relation type must stay blank, not become a fallback.");
assert(untypedPayload.schemaViolations.some((violation) => violation.kind === "nodeType" && violation.message.includes("has no node type")), "A blank node type must be a schema violation.");
assert(untypedPayload.schemaViolations.some((violation) => violation.kind === "relationshipType" && violation.message.includes("has no relationship type")), "A blank relation type must be a schema violation.");
assert(untypedPayload.schemaSuggestions.nodeTypes.length === 0 && untypedPayload.schemaSuggestions.relationshipTypes.length === 0, "Blank types must not become type suggestions.");

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
const serviceSchemaDir = await fs.mkdtemp(path.join(os.tmpdir(), "kg-schema-"));
const serviceSchemaPath = path.join(serviceSchemaDir, "graphSchema.json");
await fs.writeFile(serviceSchemaPath, `${JSON.stringify(serviceGraphSchema, null, "\t")}\n`, "utf8");
const serviceGraphSchemaConfig = { path: serviceSchemaPath };
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
		async getExistingNodeIds() {
			return [];
		},
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
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
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
		async getExistingNodeIds() {
			return [];
		},
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
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
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
let mutationStoredNote = null;
const mutationExtraction = {
	nodes: [{ name: "new_screen", label: "New Screen", type: "screen", description: "Newly captured screen." }],
	relations: [{ sourceName: "new_screen", targetName: "pan_api", relation: "uses", information: "during onboarding" }],
	nodeDeletes: [{ name: "old_screen" }],
	relationDeletes: [{ sourceName: "xyz_screen", targetName: "old_owner", relation: "owned_by" }],
	schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
};
const mutationService = new IngestionService({
	llmProvider: {
		async extractGraph() {
			return structuredClone(mutationExtraction);
		},
	},
	graphStore: {
		async getExistingNodeIds(ids) {
			// pan_api is an existing node that the extracted relation references without a node record.
			return ids.filter((id) => id === "node:pan_api");
		},
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
		async upsertHitlNote(note) {
			mutationStoredNote = note;
			return { id: note.id, document: note.llmResponse, metadata: { createdAt: note.createdAt } };
		},
	},
		prompts: {
			...runtimePrompts,
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		},
	ingestion: {
		contextEnabled: true,
		contextTopK: 1,
		contextDepth: 1,
	},
});
// Auto mode never applies deletes; they become a HITL proposal.
const autoDeleteResult = await mutationService.ingestText({ text: "Apply graph mutations.", source: "test" });
assert(autoDeleteResult.status === "pending_hitl", "Auto mode must send a payload with deletes to HITL.");
assert(autoDeleteResult.reviewReasons.some((reason) => reason.includes("node delete")) && autoDeleteResult.reviewReasons.some((reason) => reason.includes("relation delete")), "Auto-mode review reasons should name the deletes.");
assert(mutationStoredNote?.llmResponse.includes("NODE_DELETE|old_screen"), "The forced proposal should keep the delete records.");
assert(deletedNodes.length === 0 && deletedRelations.length === 0 && mutationUpsertGraph === null, "Auto mode must not touch the graph when deletes are present.");

// Delete mechanics through applyGraphPayload(), the path HITL approval uses.
const mutationResult = await mutationService.applyGraphPayload(
	normalizeGraphPayload(structuredClone(mutationExtraction), { schema: serviceGraphSchema }),
	{ source: "test", debugLogger: { log() {} } },
);
assert(deletedRelations.length === 1, "Ingestion service should delete extracted relation deletes.");
assert(deletedNodes[0] === "node:old_screen", "Ingestion service should delete extracted node deletes.");
assert(deletedVectorNodes[0] === "node:old_screen", "Ingestion service should delete node vectors.");
assert(deletedVectorRelations.includes("rel:detached_from_node"), "Ingestion service should delete relation vectors detached by node deletion.");
assert(mutationUpsertGraph?.nodes?.[0]?.id === "node:new_screen", "Ingestion service should upsert mutation node records.");
assert(mutationIndexedGraph?.relations?.length === 1, "Ingestion service should index mutation relation upserts.");
assert(mutationResult.deletedNodeIds[0] === "node:old_screen", "Ingestion result should expose deleted node IDs.");

// Auto mode applies only clean creates and updates; review signals force HITL.
function autoModeService(extraction, existingNodeIds = []) {
	const calls = { stored: null, applied: null };
	const autoService = new IngestionService({
		llmProvider: {
			async extractGraph() {
				return structuredClone(extraction);
			},
		},
		graphStore: {
			async getExistingNodeIds(ids) {
				return ids.filter((id) => existingNodeIds.includes(id));
			},
			async expandFromNodes() {
				return { nodes: [], relations: [] };
			},
			async upsertGraph(graph) {
				calls.applied = graph;
				return graph;
			},
		},
		vectorStore: {
			async queryNodes() {
				return [];
			},
			async upsertGraphIndex() {},
			async upsertHitlNote(note) {
				calls.stored = note;
				return { id: note.id, document: note.llmResponse, metadata: { createdAt: note.createdAt } };
			},
		},
		prompts: {
			...runtimePrompts,
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		},
		ingestion: { mode: "auto", contextEnabled: true, contextTopK: 1, contextDepth: 1 },
	});
	return { autoService, calls };
}

const ambiguousAuto = autoModeService({
	nodes: [{ name: "rajat", label: "Rajat", type: "person", description: "", metadata: "AMBIGUITY:multiple users match" }],
	relations: [],
});
const ambiguousAutoResult = await ambiguousAuto.autoService.ingestText({ text: "Rajat joined.", source: "test" });
assert(ambiguousAutoResult.status === "pending_hitl" && ambiguousAuto.calls.applied === null, "Auto mode must send an ambiguity to HITL.");
assert(ambiguousAutoResult.reviewReasons.some((reason) => reason.includes("ambiguity")), "Review reasons should name the ambiguity.");

const contradictionAuto = autoModeService({
	nodes: [],
	relations: [{ sourceName: "xyz_screen", targetName: "pan_api", relation: "uses", operation: "update", metadata: "CONTRADICTION:existing graph differs" }],
}, ["node:xyz_screen", "node:pan_api"]);
const contradictionAutoResult = await contradictionAuto.autoService.ingestText({ text: "XYZ does not use PAN.", source: "test" });
assert(contradictionAutoResult.status === "pending_hitl" && contradictionAuto.calls.applied === null, "Auto mode must send a contradiction to HITL.");
assert(contradictionAutoResult.reviewReasons.some((reason) => reason.includes("contradiction")), "Review reasons should name the contradiction.");

const convertedCreateAuto = autoModeService({
	nodes: [{ name: "xyz_screen", label: "XYZ Screen", type: "screen", description: "Guessed description.", operation: "create" }],
	relations: [],
}, ["node:xyz_screen"]);
const convertedCreateAutoResult = await convertedCreateAuto.autoService.ingestText({ text: "XYZ screen exists.", source: "test" });
assert(convertedCreateAutoResult.status === "pending_hitl" && convertedCreateAuto.calls.applied === null, "Auto mode must not apply a create for a node that already exists.");

const cleanUpdateAuto = autoModeService({
	nodes: [{ name: "xyz_screen", label: "XYZ Screen", type: "screen", description: "New detail.", operation: "update" }],
	relations: [{ sourceName: "xyz_screen", targetName: "pan_api", relation: "uses", operation: "create" }],
}, ["node:xyz_screen", "node:pan_api"]);
const cleanUpdateAutoResult = await cleanUpdateAuto.autoService.ingestText({ text: "XYZ screen uses PAN.", source: "test" });
assert(cleanUpdateAutoResult.status !== "pending_hitl" && cleanUpdateAuto.calls.stored === null, "Auto mode should apply clean creates and updates.");
assert(cleanUpdateAuto.calls.applied?.nodes?.[0]?.id === "node:xyz_screen" && cleanUpdateAuto.calls.applied?.relations?.length === 1, "Clean auto-mode updates should reach the graph.");

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
		async getExistingNodeIds() {
			return [];
		},
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
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
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

let forcedHitlStoredNote = null;
let forcedHitlGraphTouched = false;
const forcedHitlService = new IngestionService({
	llmProvider: {
		async extractGraph() {
			return {
				nodes: [{ name: "mystery_box", label: "Mystery Box", type: "hallucinated_widget", description: "" }],
				relations: [{ sourceName: "mystery_box", targetName: "pan_api", relation: "imagines", information: "" }],
				schemaSuggestions: { nodeTypes: [], relationshipTypes: [] },
			};
		},
	},
	graphStore: {
		async getExistingNodeIds() {
			return [];
		},
		async expandFromNodes() {
			return { nodes: [], relations: [] };
		},
		async upsertGraph() {
			forcedHitlGraphTouched = true;
			throw new Error("Forced HITL schema test should not touch graph DB.");
		},
	},
	vectorStore: {
		async queryNodes() {
			return [];
		},
		async upsertHitlNote(note) {
			forcedHitlStoredNote = note;
			return { id: note.id, document: note.llmResponse, metadata: { createdAt: note.createdAt } };
		},
	},
		prompts: {
			...runtimePrompts,
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
		},
	ingestion: {
		mode: "auto",
		contextEnabled: true,
		contextTopK: 1,
		contextDepth: 1,
	},
});
const forcedHitlResult = await forcedHitlService.ingestText({ text: "Mystery box imagines PAN API.", source: "test" });
assert(forcedHitlResult.status === "pending_hitl", "Schema violations should force HITL even when ingestion mode is auto.");
assert(forcedHitlResult.schemaViolations.length >= 2, "Forced HITL result should expose schema violations.");
assert(forcedHitlResult.schemaSuggestions.nodeTypes.some((entry) => entry.name === "hallucinated_widget"), "Unknown node type should be captured as a schema suggestion.");
assert(forcedHitlStoredNote?.llmResponse.includes("hallucinated_widget"), "Forced HITL should store the violating payload for review.");
assert(forcedHitlGraphTouched === false, "Forced HITL should not apply graph mutations.");

let duplicatePendingHitlStoredNote = null;
const duplicatePendingHitlService = new IngestionService({
	llmProvider: {
		async extractGraphWithRawResponse() {
			return {
				rawResponse: [
					"<start#$#$>",
					"NODE_CREATE|sales_journey_flow|Sales Journey Flow|screen|Duplicate create emitted by model.|",
					"NODE_CREATE|apple_stage|Apple Stage|screen||",
					"RELATION_CREATE|sales_journey_flow|apple_stage|contains|||",
					"</end#$#$>",
				].join("\n"),
				graph: {
					nodes: [
						{ name: "sales_journey_flow", label: "Sales Journey Flow", type: "screen", description: "Duplicate create emitted by model.", operation: "create" },
						{ name: "apple_stage", label: "Apple Stage", type: "screen", description: "", operation: "create" },
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
		async getExistingNodeIds() {
			return [];
		},
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
					"NODE_CREATE|sales_journey_flow|Sales Journey Flow|screen||",
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
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
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

// Graph-aware checks: existing endpoints are references, missing ones are violations.
const resolverGraphStore = {
	async getExistingNodeIds(ids) {
		return ids.filter((id) => id === "node:ekyc_screen" || id === "node:pan_api");
	},
};
const referenceResolution = await resolveGraphPayload(relationOnlyPayload, resolverGraphStore);
assert(referenceResolution.graphPayload.schemaViolations.length === 0, "Existing relation endpoints should be accepted as references.");
assert(referenceResolution.graphPayload.nodes.length === 0, "Existing relation endpoints must never be written.");
assert(referenceResolution.changed === false, "A valid relation-only payload should not be rewritten.");

const typoPayload = normalizeGraphPayload(extractCustomGraph("RELATION_CREATE|ekyc_scren|pan_api|uses|||"), { schema });
const typoResolution = await resolveGraphPayload(typoPayload, resolverGraphStore);
assert(typoResolution.graphPayload.schemaViolations.some((violation) => violation.kind === "relationEndpoint" && violation.message.includes("\"ekyc_scren\" does not exist")), "A relation to a missing node must be a violation.");
assert(typoResolution.graphPayload.nodes.length === 0, "A relation to a missing node must not create it.");
assert(countReviewSignals(typoResolution.graphPayload).ambiguityCount === 1, "A missing endpoint should be flagged on the relation for review.");

const deletedEndpointResolution = await resolveGraphPayload(normalizeGraphPayload(extractCustomGraph([
	"NODE_DELETE|pan_api|",
	"RELATION_CREATE|ekyc_screen|pan_api|uses|||",
].join("\n")), { schema }), resolverGraphStore);
assert(deletedEndpointResolution.graphPayload.schemaViolations.some((violation) => violation.message.includes("is deleted by this proposal")), "A relation to a node deleted by the same payload must be a violation.");

const existingCreateResolution = await resolveGraphPayload(normalizeGraphPayload(extractCustomGraph("NODE_CREATE|ekyc_screen|EKYC Screen|screen|New detail.|"), { schema }), resolverGraphStore);
assert(existingCreateResolution.graphPayload.nodes[0].operation === "update", "NODE_CREATE for an existing node should be applied as an update.");
assert(existingCreateResolution.changed === true, "A converted create should mark the payload as changed.");
assert(countReviewSignals(existingCreateResolution.graphPayload).ambiguityCount === 1, "A converted create should carry an ambiguity review signal.");
assert(formatGraphRecords(existingCreateResolution.graphPayload).includes("NODE_UPDATE|ekyc_screen|EKYC Screen|screen|New detail.|AMBIGUITY:"), "The stored proposal should show the converted update and its signal.");

let rejectedApplyTouchedGraph = false;
const applyGuardService = new IngestionService({
	llmProvider: null,
	graphStore: {
		...resolverGraphStore,
		async upsertGraph() {
			rejectedApplyTouchedGraph = true;
			return { nodes: [], relations: [] };
		},
	},
	vectorStore: {},
	prompts: runtimePrompts,
});
let applyRejected = false;
try {
	await applyGuardService.applyGraphPayload(typoPayload, { source: "test", debugLogger: { log() {} } });
} catch (error) {
	applyRejected = error.status === 400 && error.message.includes("does not exist");
}
assert(applyRejected, "applyGraphPayload must reject a relation to a missing node.");
assert(rejectedApplyTouchedGraph === false, "A rejected apply must not touch the graph.");

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
		async getExistingNodeIds() {
			return [];
		},
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
			graphSchema: serviceGraphSchemaConfig,
			extractionSystemTemplate: "Schema:\n{{GRAPH_SCHEMA}}\nContext:\n{{EXISTING_GRAPH_CONTEXT}}\nInput:\n{{USER_INPUT}}",
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

// Property field guidance tests
const propertyGuidanceSchema = {
	...schema,
	nodeProperties: {
		required: ["name", "label", "type"],
		optional: ["description"],
		fields: [
			{ name: "name", description: "Unique node identifier.", constraints: { pattern: "^[a-z0-9_]+$", immutable: true } },
			{ name: "label", description: "Human-readable display name." },
			{ name: "type", description: "Node taxonomy." },
			{ name: "description", description: "Optional free-text context." },
		],
	},
	relationshipProperties: {
		required: ["sourceName", "targetName", "relation"],
		optional: ["information", "description"],
		fields: [
			{ name: "sourceName", description: "Source node name.", constraints: { immutable: true } },
			{ name: "targetName", description: "Target node name.", constraints: { immutable: true } },
			{ name: "relation", description: "Relation type.", constraints: { pattern: "^[a-z_]+$", immutable: true } },
			{ name: "information", description: "Single-line contextual note." },
			{ name: "description", description: "Optional longer rationale." },
		],
	},
};

// formatFieldGuidance should produce node and relationship field sections
const fieldGuidance = formatFieldGuidance(propertyGuidanceSchema);
assert(fieldGuidance.includes("Node fields:"), "formatFieldGuidance should include node field section.");
assert(fieldGuidance.includes("Relationship fields:"), "formatFieldGuidance should include relationship field section.");
assert(fieldGuidance.includes("pattern: ^[a-z0-9_]+$"), "formatFieldGuidance should render pattern constraints.");
assert(fieldGuidance.includes("immutable"), "formatFieldGuidance should render immutable constraints.");
assert(fieldGuidance.includes("Unique node identifier."), "formatFieldGuidance should render property descriptions.");

// formatSchemaCatalog should NOT include field guidance (it's separate via {{FIELD_GUIDANCE}})
const schemaCatalog = formatSchemaCatalog(propertyGuidanceSchema);
assert(!schemaCatalog.includes("Node fields:"), "formatSchemaCatalog should NOT include field guidance sections.");
assert(!schemaCatalog.includes("Relationship fields:"), "formatSchemaCatalog should NOT include relationship field guidance.");

// Constraint validation tests
// Test with raw (pre-normalization) payload so constraint violations on `name` are visible
// before toSnakeCase normalizes them
const rawValidPayload = extractCustomGraph([
	"NODE|valid_node|Valid Node|screen|A valid node.",
	"RELATION|valid_node|pan_api|uses|for testing|",
].join("\n"));
const rawValidValidation = validatePropertyConstraints(rawValidPayload, propertyGuidanceSchema);
assert(rawValidValidation.violations.length === 0, "Valid raw payload should have no constraint violations.");

const rawInvalidNamePayload = extractCustomGraph([
	"NODE|Invalid-Name!|Invalid Name|screen|Has invalid characters.",
].join("\n"));
const rawInvalidNameValidation = validatePropertyConstraints(rawInvalidNamePayload, propertyGuidanceSchema);
assert(rawInvalidNameValidation.violations.length === 1, "Invalid raw node name should produce a constraint violation.");
assert(rawInvalidNameValidation.violations[0].field === "name", "Violation should reference the 'name' field.");
assert(rawInvalidNameValidation.violations[0].message.includes("does not match required pattern"), "Violation message should mention pattern mismatch.");

// Strict mode test
const strictValidation = validatePropertyConstraints(rawInvalidNamePayload, propertyGuidanceSchema, { strict: true });
assert(strictValidation.errors.length === 1, "Strict mode should return errors.");
assert(strictValidation.violations.length === 1, "Strict mode should still return violations.");

// Test with normalized payload: pattern validation passes after toSnakeCase normalization
const normalizedValidPayload = normalizeGraphPayload(extractCustomGraph([
	"NODE|valid_name|Valid Name|screen||",
].join("\n")));
const normalizedValidValidation = validatePropertyConstraints(normalizedValidPayload, propertyGuidanceSchema);
assert(normalizedValidValidation.violations.length === 0, "Normalized payload with valid name should have no pattern violations.");

const noConstraintsSchema = {
	...schema,
	nodeProperties: { required: ["name"], fields: [] },
	relationshipProperties: { required: ["sourceName"], fields: [] },
};
const noConstraintsPayload = normalizeGraphPayload(extractCustomGraph([
	"NODE|any_name|Any Name|screen||",
].join("\n")));
const noConstraintsValidation = validatePropertyConstraints(noConstraintsPayload, noConstraintsSchema);
assert(noConstraintsValidation.violations.length === 0, "No constraints should produce no violations.");

// Verify field guidance is rendered via {{FIELD_GUIDANCE}} placeholder in extraction prompt
const promptWithGuidance = buildExtractionPrompt("Guidance:\n{{FIELD_GUIDANCE}}\nSchema:\n{{GRAPH_SCHEMA}}\nInput:\n{{USER_INPUT}}", {
	graphSchema: propertyGuidanceSchema,
	userInput: "test input",
});
assert(promptWithGuidance.includes("Node fields:"), "Extraction prompt via {{FIELD_GUIDANCE}} should include node field section.");
assert(promptWithGuidance.includes("Relationship fields:"), "Extraction prompt via {{FIELD_GUIDANCE}} should include relationship field section.");
assert(!promptWithGuidance.includes("Node property guidance:"), "Old section title should not appear.");

// Verify formatFieldGuidance returns fallback for empty fields
const emptyFieldGuidance = formatFieldGuidance({
	...schema,
	nodeProperties: { required: ["name"], fields: [] },
	relationshipProperties: { required: ["sourceName"], fields: [] },
});
assert(emptyFieldGuidance === "No field descriptions defined in schema.", "Empty fields should produce fallback message.");

await fs.rm(serviceSchemaDir, { recursive: true, force: true });
console.log("[PASS] graph extraction parser smoke tests");
