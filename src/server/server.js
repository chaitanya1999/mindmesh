import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";
import { getConfig, describeRuntime } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { IngestionService } from "../ingestion/ingestionService.js";
import { encodePipelineField, normalizeGraphPayload, parseGraphExtraction, toSnakeCase } from "../ingestion/graphPayload.js";
import { countReviewSignals } from "../ingestion/reviewSignals.js";
import { KgJobsService } from "../jobs/kgJobsService.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { HybridRagService } from "../rag/hybridRagService.js";
import {
	loadGraphSchema,
	persistGraphSchemaSuggestions,
	promoteGraphSchemaSuggestions,
	readEditableGraphSchema,
	saveEditableGraphSchema,
} from "../schema/graphSchema.js";
import { createVectorStore } from "../vector/providerFactory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const DEFAULT_GRAPH_LIMIT = 150;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_NEIGHBORHOOD_DEPTH = 1;
const DEFAULT_JOB_DEPTH = 2;
const MAX_INGEST_FILES = 10;
const MAX_INGEST_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_INGEST_FILE_EXTENSIONS = new Set(["pdf", "docx", "doc"]);
const port = Number(process.env.KG_WEB_PORT || process.env.PORT || 3000);

const wordExtractor = new WordExtractor();

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: MAX_INGEST_FILE_SIZE_BYTES,
		files: MAX_INGEST_FILES,
	},
	fileFilter(_req, file, callback) {
		if (SUPPORTED_INGEST_FILE_EXTENSIONS.has(fileExtension(file))) {
			callback(null, true);
			return;
		}

		const error = new Error("Only PDF, DOCX, or DOC files can be uploaded.");
		error.status = 400;
		callback(error);
	},
});

function parseLimit(value) {
	return Math.max(1, Math.min(Number(value) || DEFAULT_GRAPH_LIMIT, 500));
}

function parseSearchLimit(value) {
	return Math.max(1, Math.min(Number(value) || DEFAULT_SEARCH_LIMIT, 100));
}

function parseDepth(value) {
	return Math.max(0, Math.min(Number(value) || DEFAULT_NEIGHBORHOOD_DEPTH, 4));
}

function parseJobDepth(value) {
	return Math.max(0, Math.min(Number(value) || DEFAULT_JOB_DEPTH, 4));
}

function stableHash(value) {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function labelFromName(name) {
	return name
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function requireString(value, fieldName) {
	const text = String(value ?? "").trim();
	if (!text) {
		const error = new Error(`${fieldName} is required.`);
		error.status = 400;
		throw error;
	}

	return text;
}

function normalizeManualNode(body, existingId = "") {
	const name = toSnakeCase(body?.name || body?.label || existingId.replace(/^node:/, ""));
	if (!name) {
		const error = new Error("Node name or label is required.");
		error.status = 400;
		throw error;
	}

	return {
		id: existingId || body?.id || `node:${name}`,
		label: String(body?.label || labelFromName(name)).trim(),
		name,
		type: toSnakeCase(body?.type || "concept") || "concept",
		description: String(body?.description ?? "").trim(),
	};
}

function normalizeManualRelation(body, existingId = "") {
	const sourceId = requireString(body?.sourceId, "sourceId");
	const targetId = requireString(body?.targetId, "targetId");
	const relation = toSnakeCase(body?.relation || "relates_to") || "relates_to";

	return {
		id: existingId || body?.id || `rel:${stableHash(`${sourceId}:${relation}:${targetId}`)}`,
		sourceId,
		targetId,
		relation,
		information: String(body?.information ?? "").trim(),
		description: String(body?.description ?? "").trim(),
	};
}

function requireText(body) {
	const text = String(body?.text ?? "").trim();
	if (!text) {
		const error = new Error("Text is required.");
		error.status = 400;
		throw error;
	}

	return text;
}

function optionalSessionId(body) {
	const text = String(body?.sessionId ?? "").trim();
	return text || undefined;
}

function optionalMemoryMessages(body) {
	return Array.isArray(body?.memoryMessages) ? body.memoryMessages : [];
}

function fileExtension(file) {
	return String(file?.originalname ?? "")
		.split(".")
		.pop()
		?.toLowerCase() ?? "";
}

function uploadedFiles(req) {
	if (Array.isArray(req.files)) {
		return req.files;
	}

	if (req.files && typeof req.files === "object") {
		return Object.values(req.files).flat();
	}

	return [];
}

async function extractPdfText(file) {
	const parser = new PDFParse({ data: file.buffer });
	try {
		const result = await parser.getText();
		return result.text;
	} finally {
		await parser.destroy().catch(() => {});
	}
}

async function extractWordText(file) {
	const extension = fileExtension(file);

	if (extension === "docx") {
		const result = await mammoth.extractRawText({ buffer: file.buffer });
		return result.value;
	}

	const document = await wordExtractor.extract(file.buffer);
	return document.getBody();
}

async function extractUploadedText(file) {
	const extension = fileExtension(file);

	if (extension === "pdf") {
		return extractPdfText(file);
	}

	if (extension === "doc" || extension === "docx") {
		return extractWordText(file);
	}

	const error = new Error("Only PDF, DOCX, or DOC files can be uploaded.");
	error.status = 400;
	throw error;
}

async function buildIngestText(req) {
	const text = String(req.body?.text ?? "").trim();
	const files = uploadedFiles(req);

	if (files.length === 0) {
		return requireText(req.body);
	}

	const extractedTexts = await Promise.all(files.map(async (file) => (
		String(await extractUploadedText(file) ?? "").trim()
	)));
	const combinedText = [text, ...extractedTexts]
		.filter(Boolean)
		.join("\n\n");

	if (!combinedText) {
		const error = new Error("Uploaded files did not contain readable text.");
		error.status = 400;
		throw error;
	}

	return combinedText;
}

function requireIngestUserName(req) {
	const userName = String(req.body?.userName ?? "").trim();
	if (!userName) {
		const error = new Error("User name is required for ingestion.");
		error.status = 400;
		throw error;
	}

	return userName;
}

function requireUserName(body, fieldName = "userName") {
	const userName = String(body?.[fieldName] ?? "").trim();
	if (!userName) {
		const error = new Error("User name is required.");
		error.status = 400;
		throw error;
	}

	return userName;
}

function createHitlNoteId() {
	return `hitl:${Date.now().toString(36)}:${crypto.randomBytes(6).toString("hex")}`;
}

function graphNameFromId(id) {
	return String(id ?? "").replace(/^node:/, "");
}

function safePipeField(value) {
	return encodePipelineField(value);
}

function nodePipelineRecord(recordType, node) {
	return [
		recordType,
		graphNameFromId(node.name || node.id),
		node.label || labelFromName(graphNameFromId(node.name || node.id)),
		node.type || "concept",
		node.description || "",
		node.metadata || "",
	].map(safePipeField).join("|");
}

function nodeDeletePipelineRecord(nodeName, metadata = "") {
	return [
		"NODE_DELETE",
		graphNameFromId(nodeName),
		metadata,
	].map(safePipeField).join("|");
}

function relationPipelineRecord(recordType, relation) {
	return [
		recordType,
		graphNameFromId(relation.sourceId),
		graphNameFromId(relation.targetId),
		relation.relation || "relates_to",
		relation.information || "",
		relation.description || "",
		relation.metadata || "",
	].map(safePipeField).join("|");
}

function relationDeletePipelineRecord(relation, metadata = relation?.metadata ?? "") {
	return [
		"RELATION_DELETE",
		graphNameFromId(relation.sourceId),
		graphNameFromId(relation.targetId),
		relation.relation || "relates_to",
		metadata,
	].map(safePipeField).join("|");
}

function pipelinePayload(lines) {
	return [
		"<start#$#$>",
		...lines.filter(Boolean),
		"</end#$#$>",
	].join("\n");
}

async function storeManualHitlProposal({ llmResponse, userInput, userName }) {
	requireHitlNotesSupport();
	const { graphPayload } = parseHitlResponse(llmResponse);
	const reviewSignals = countReviewSignals(graphPayload);
	const hitlNote = await vectorStore.upsertHitlNote({
		id: createHitlNoteId(),
		status: "pending",
		userName,
		source: "manual",
		createdAt: new Date().toISOString(),
		userInput,
		llmResponse,
		nodeCount: graphPayload.nodes.length,
		relationCount: graphPayload.relations.length,
		nodeDeleteCount: graphPayload.nodeDeletes.length,
		relationDeleteCount: graphPayload.relationDeletes.length,
		schemaSuggestionCount: countSchemaSuggestions(graphPayload.schemaSuggestions),
		ambiguityCount: reviewSignals.ambiguityCount,
		contradictionCount: reviewSignals.contradictionCount,
	});
	const graph = await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT);

	return {
		status: "pending_hitl",
		applied: false,
		hitlNote,
		nodes: graphPayload.nodes,
		relations: graphPayload.relations,
		nodeDeletes: graphPayload.nodeDeletes,
		relationDeletes: graphPayload.relationDeletes,
		deletedNodeIds: [],
		deletedRelationIds: [],
		triplets: buildTriplets(graphPayload),
		schemaSuggestions: graphPayload.schemaSuggestions,
		schemaWarnings: graphPayload.schemaWarnings,
		persistedSchemaSuggestions: null,
		graph,
	};
}

function countSchemaSuggestions(schemaSuggestions = {}) {
	return (schemaSuggestions.nodeTypes?.length ?? 0) + (schemaSuggestions.relationshipTypes?.length ?? 0);
}

function noteReviewSignals(note) {
	const storedSignals = {
		ambiguityCount: Number(note.ambiguityCount ?? note.metadata?.ambiguityCount ?? 0),
		contradictionCount: Number(note.contradictionCount ?? note.metadata?.contradictionCount ?? 0),
	};

	if (!note.llmResponse) {
		return storedSignals;
	}

	try {
		const { graphPayload } = parseHitlResponse(note.llmResponse);
		return countReviewSignals(graphPayload);
	} catch {
		return storedSignals;
	}
}

function buildTriplets(graph) {
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

	return graph.relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);

		return {
			sourceId: relation.sourceId,
			sourceLabel: source?.label ?? relation.sourceId,
			relation: relation.relation,
			targetId: relation.targetId,
			targetLabel: target?.label ?? relation.targetId,
			information: relation.information ?? "",
		};
	});
}

function requireHitlNotesSupport() {
	if (
		typeof vectorStore.listHitlNotes !== "function"
		|| typeof vectorStore.getHitlNote !== "function"
		|| typeof vectorStore.deleteHitlNotes !== "function"
	) {
		const error = new Error("The configured vector store does not support HITL notes.");
		error.status = 501;
		throw error;
	}
}

function requireDirectGraphCrudSupport() {
	if (
		typeof graphStore.upsertNode !== "function"
		|| typeof graphStore.deleteNode !== "function"
		|| typeof graphStore.upsertRelation !== "function"
		|| typeof graphStore.deleteRelation !== "function"
	) {
		const error = new Error("The configured graph store does not support direct HITL CRUD.");
		error.status = 501;
		throw error;
	}
}

function hitlNoteSummary(note) {
	const reviewSignals = noteReviewSignals(note);
	return {
		id: note.id,
		status: note.status,
		userName: note.userName,
		ingestedBy: note.userName,
		source: note.source,
		createdAt: note.createdAt,
		inputPreview: note.inputPreview,
		llmPreview: note.llmPreview,
		nodeCount: note.nodeCount,
		relationCount: note.relationCount,
		nodeDeleteCount: note.nodeDeleteCount,
		relationDeleteCount: note.relationDeleteCount,
		schemaSuggestionCount: note.schemaSuggestionCount,
		ambiguityCount: reviewSignals.ambiguityCount,
		contradictionCount: reviewSignals.contradictionCount,
	};
}

function hitlNoteDetail(note) {
	return {
		...hitlNoteSummary(note),
		userInput: note.userInput,
		prompt: note.userInput,
		llmResponse: note.llmResponse,
	};
}

async function requireHitlNote(id) {
	requireHitlNotesSupport();
	const note = await vectorStore.getHitlNote(id);
	if (!note) {
		const error = new Error("HITL note was not found.");
		error.status = 404;
		throw error;
	}

	return note;
}

function parseHitlResponse(llmResponse) {
	try {
		const graphSchema = loadGraphSchema({ schema: prompts.graphSchema });
		const extractedGraph = parseGraphExtraction(llmResponse);
		const graphPayload = normalizeGraphPayload(extractedGraph, {
			schema: graphSchema,
			autoApplySuggestions: prompts.schemaAutoApplySuggestions,
		});

		return { graphSchema, graphPayload };
	} catch (error) {
		error.status = 400;
		throw error;
	}
}

function persistHitlSchemaSuggestions(graphSchema, graphPayload) {
	graphPayload.persistedSchemaSuggestions = prompts.schemaAutoApplySuggestions
		? promoteGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions)
		: persistGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions);
}

function pendingMarker(note, operation) {
	return {
		pendingHitl: true,
		pendingOperation: operation || "upsert",
		hitlNoteId: note.id,
		ingestedBy: note.userName,
	};
}

function mergePendingNode(nodeMap, node, note, operation) {
	const existing = nodeMap.get(node.id);
	nodeMap.set(node.id, {
		...(existing ?? {}),
		...node,
		...pendingMarker(note, operation || node.operation),
	});
}

function mergePendingRelation(relationMap, relation, note, operation) {
	const existing = relationMap.get(relation.id);
	relationMap.set(relation.id, {
		...(existing ?? {}),
		...relation,
		...pendingMarker(note, operation || relation.operation),
	});
}

function ensurePendingEndpointNode(nodeMap, nodeId, note) {
	if (!nodeId || nodeMap.has(nodeId)) {
		return;
	}

	const name = String(nodeId).replace(/^node:/, "");
	nodeMap.set(nodeId, {
		id: nodeId,
		name,
		label: labelFromName(name),
		type: "concept",
		description: "",
		...pendingMarker(note, "placeholder"),
	});
}

function mergeHitlPayloadIntoGraph(baseGraph, note, graphPayload) {
	const nodeMap = new Map(baseGraph.nodes.map((node) => [node.id, node]));
	const relationMap = new Map(baseGraph.relations.map((relation) => [relation.id, relation]));

	for (const node of graphPayload.nodes) {
		mergePendingNode(nodeMap, node, note, node.operation);
	}

	for (const nodeDelete of graphPayload.nodeDeletes) {
		const existingNode = nodeMap.get(nodeDelete.id);
		mergePendingNode(nodeMap, existingNode ? {
			...existingNode,
			metadata: nodeDelete.metadata || existingNode.metadata || "",
		} : {
			id: nodeDelete.id,
			name: nodeDelete.name,
			label: labelFromName(nodeDelete.name),
			type: "concept",
			description: "",
			metadata: nodeDelete.metadata || "",
		}, note, "delete");
	}

	for (const relation of graphPayload.relations) {
		ensurePendingEndpointNode(nodeMap, relation.sourceId, note);
		ensurePendingEndpointNode(nodeMap, relation.targetId, note);
		mergePendingRelation(relationMap, relation, note, relation.operation);
	}

	for (const relationDelete of graphPayload.relationDeletes) {
		ensurePendingEndpointNode(nodeMap, relationDelete.sourceId, note);
		ensurePendingEndpointNode(nodeMap, relationDelete.targetId, note);
		const existingRelation = relationMap.get(relationDelete.id);
		mergePendingRelation(relationMap, existingRelation ? {
			...existingRelation,
			...relationDelete,
			metadata: relationDelete.metadata || existingRelation.metadata || "",
		} : relationDelete, note, "delete");
	}

	return {
		nodes: [...nodeMap.values()],
		relations: [...relationMap.values()],
	};
}

async function buildHitlGraphPreview(limit) {
	requireHitlNotesSupport();
	const approvedGraph = await graphStore.getGraphPreview(limit);
	const notes = await vectorStore.listHitlNotes({ status: "pending", limit: 500 });
	let previewGraph = {
		nodes: approvedGraph.nodes ?? [],
		relations: approvedGraph.relations ?? [],
	};
	const warnings = [];

	for (const note of notes) {
		try {
			const { graphPayload } = parseHitlResponse(note.llmResponse);
			previewGraph = mergeHitlPayloadIntoGraph(previewGraph, note, graphPayload);
		} catch (error) {
			warnings.push({
				id: note.id,
				message: error.message,
			});
		}
	}

	return {
		...previewGraph,
		limit,
		pendingNotes: notes.map(hitlNoteSummary),
		warnings,
	};
}

async function buildHitlNoteGraphPreview(note, { depth = 2, llmResponse = note.llmResponse } = {}) {
	const { graphPayload } = parseHitlResponse(llmResponse);
	const pendingNodeIds = new Set();

	for (const node of graphPayload.nodes) {
		pendingNodeIds.add(node.id);
	}
	for (const nodeDelete of graphPayload.nodeDeletes) {
		pendingNodeIds.add(nodeDelete.id);
	}
	for (const relation of graphPayload.relations) {
		pendingNodeIds.add(relation.sourceId);
		pendingNodeIds.add(relation.targetId);
	}
	for (const relationDelete of graphPayload.relationDeletes) {
		pendingNodeIds.add(relationDelete.sourceId);
		pendingNodeIds.add(relationDelete.targetId);
	}

	const approvedContext = pendingNodeIds.size > 0
		? await graphStore.expandFromNodes([...pendingNodeIds], depth)
		: { nodes: [], relations: [] };
	const previewGraph = mergeHitlPayloadIntoGraph(approvedContext, note, graphPayload);

	return {
		...previewGraph,
		depth,
		note: hitlNoteSummary(note),
	};
}

function asyncRoute(handler) {
	return async (req, res, next) => {
		try {
			await handler(req, res);
		} catch (error) {
			next(error);
		}
	};
}

const config = getConfig();
const prompts = loadPrompts(config);
const llmProvider = createLlmProvider(config);
const graphStore = createGraphStore(config);
const vectorStore = createVectorStore(config);
const ingestionService = new IngestionService({
	llmProvider,
	graphStore,
	vectorStore,
	prompts,
	logging: config.logging,
	ingestion: config.ingestion,
});
const ragService = new HybridRagService({
	llmProvider,
	graphStore,
	vectorStore,
	prompts,
	topK: config.rag.topK,
	depth: config.rag.depth,
	logging: config.logging,
	memoryEnabled: config.rag.memory.enabled,
	memoryMaxMessages: config.rag.memory.maxMessages,
	memoryMaxMessageChars: config.rag.memory.maxMessageChars,
	rewriteQueryWithMemory: config.rag.memory.rewriteQueryEnabled,
});
const jobsService = new KgJobsService({
	llmProvider,
	graphStore,
	prompts,
});

const app = express();

app.use(express.json({ limit: "25mb" }));
app.use(express.static(publicDir));

app.get("/api/graph", asyncRoute(async (req, res) => {
	const limit = parseLimit(req.query.limit);
	const graph = await graphStore.getGraphPreview(limit);

	res.json({
		...graph,
		limit,
	});
}));

app.get("/api/nodes/search", asyncRoute(async (req, res) => {
	const query = String(req.query.q ?? "").trim();
	const limit = parseSearchLimit(req.query.limit);
	const nodes = await graphStore.searchNodes(query, limit);

	res.json({ nodes, query, limit });
}));

app.get("/api/nodes/:id/neighborhood", asyncRoute(async (req, res) => {
	const depth = parseDepth(req.query.depth);
	const graph = await graphStore.getNodeNeighborhood(req.params.id, depth);

	res.json({ ...graph, depth });
}));

app.get("/api/nodes/:id/relations", asyncRoute(async (req, res) => {
	const relations = await graphStore.getRelationsForNode(req.params.id);

	res.json({ relations });
}));

app.post("/api/nodes", asyncRoute(async (req, res) => {
	const node = normalizeManualNode(req.body);
	const userName = requireUserName(req.body);
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested node creation for ${node.label}.`,
		llmResponse: pipelinePayload([nodePipelineRecord("NODE_CREATE", node)]),
	});

	res.status(202).json(result);
}));

app.put("/api/nodes/:id", asyncRoute(async (req, res) => {
	const node = normalizeManualNode(req.body, req.params.id);
	const userName = requireUserName(req.body);
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested node update for ${node.label}.`,
		llmResponse: pipelinePayload([nodePipelineRecord("NODE_UPDATE", node)]),
	});

	res.status(202).json(result);
}));

app.delete("/api/nodes/:id", asyncRoute(async (req, res) => {
	const userName = requireUserName(req.body);
	const existingNode = await graphStore.getNode(req.params.id);
	const nodeName = graphNameFromId(req.params.id);
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested node deletion for ${existingNode?.label || nodeName}.`,
		llmResponse: pipelinePayload([nodeDeletePipelineRecord(nodeName)]),
	});

	res.status(202).json(result);
}));

app.post("/api/relations", asyncRoute(async (req, res) => {
	const relation = normalizeManualRelation(req.body);
	const userName = requireUserName(req.body);
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested relation creation for ${relation.relation}.`,
		llmResponse: pipelinePayload([relationPipelineRecord("RELATION_CREATE", relation)]),
	});

	res.status(202).json(result);
}));

app.put("/api/relations/:id", asyncRoute(async (req, res) => {
	const relation = normalizeManualRelation(req.body, req.params.id);
	const userName = requireUserName(req.body);
	const existingRelation = typeof graphStore.getRelation === "function"
		? await graphStore.getRelation(req.params.id)
		: null;
	const lines = existingRelation
		? [
			relationDeletePipelineRecord(existingRelation),
			relationPipelineRecord("RELATION_CREATE", relation),
		]
		: [relationPipelineRecord("RELATION_UPDATE", relation)];
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested relation update for ${relation.relation}.`,
		llmResponse: pipelinePayload(lines),
	});

	res.status(202).json(result);
}));

app.delete("/api/relations/:id", asyncRoute(async (req, res) => {
	const userName = requireUserName(req.body);
	const relation = typeof graphStore.getRelation === "function"
		? await graphStore.getRelation(req.params.id)
		: null;
	if (!relation) {
		const error = new Error("Relation was not found.");
		error.status = 404;
		throw error;
	}
	const result = await storeManualHitlProposal({
		userName,
		userInput: `${userName} requested relation deletion for ${relation.relation}.`,
		llmResponse: pipelinePayload([relationDeletePipelineRecord(relation)]),
	});

	res.status(202).json(result);
}));

app.post("/api/ask", asyncRoute(async (req, res) => {
	const text = requireText(req.body);
	const result = await ragService.answer({
		query: text,
		source: "web",
		sessionId: optionalSessionId(req.body),
		memoryMessages: optionalMemoryMessages(req.body),
		includeUnverifiedKnowledge: Boolean(req.body?.includeUnverifiedKnowledge),
	});

	res.json({
		answer: result.answer,
		entryNodes: result.entryNodes,
		graph: result.graph,
		depth: result.depth,
		sessionId: result.sessionId,
	});
}));

app.post("/api/jobs/scanner", asyncRoute(async (req, res) => {
	const result = await jobsService.runJob({
		jobType: "scanner",
		depth: parseJobDepth(req.body?.depth),
		nodeId: req.body?.nodeId,
	});

	res.json(result);
}));

app.post("/api/jobs/nugget", asyncRoute(async (req, res) => {
	const result = await jobsService.runJob({
		jobType: "nugget",
		depth: parseJobDepth(req.body?.depth),
		nodeId: req.body?.nodeId,
	});

	res.json(result);
}));

app.get("/api/schema", asyncRoute(async (_req, res) => {
	res.json(readEditableGraphSchema(config));
}));

app.put("/api/schema", asyncRoute(async (req, res) => {
	try {
		const result = saveEditableGraphSchema(config, {
			rawJson: req.body?.rawJson,
			schema: req.body?.schema,
		});

		res.json({
			...result,
			status: "saved",
		});
	} catch (error) {
		error.status = 400;
		throw error;
	}
}));

app.get("/api/hitl/notes", asyncRoute(async (req, res) => {
	requireHitlNotesSupport();
	const limit = parseSearchLimit(req.query.limit || 100);
	const notes = await vectorStore.listHitlNotes({ status: "pending", limit });

	res.json({
		notes: notes.map(hitlNoteSummary),
	});
}));

app.get("/api/hitl/notes/:id", asyncRoute(async (req, res) => {
	const note = await requireHitlNote(req.params.id);

	res.json({
		note: hitlNoteDetail(note),
	});
}));

app.get("/api/hitl/notes/:id/graph", asyncRoute(async (req, res) => {
	const note = await requireHitlNote(req.params.id);
	const depth = parseDepth(req.query.depth ?? 2);
	const graph = await buildHitlNoteGraphPreview(note, { depth });

	res.json(graph);
}));

app.post("/api/hitl/notes/:id/graph", asyncRoute(async (req, res) => {
	const note = await requireHitlNote(req.params.id);
	const depth = parseDepth(req.body?.depth ?? 2);
	const llmResponse = requireString(req.body?.llmResponse ?? note.llmResponse, "llmResponse");
	const graph = await buildHitlNoteGraphPreview(note, { depth, llmResponse });

	res.json(graph);
}));

app.get("/api/hitl/graph", asyncRoute(async (req, res) => {
	const limit = parseLimit(req.query.limit);
	const graph = await buildHitlGraphPreview(limit);

	res.json(graph);
}));

app.post("/api/hitl/nodes", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const node = normalizeManualNode(req.body);
	const storedNode = await graphStore.upsertNode(node);
	await vectorStore.upsertNode(storedNode);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		node: storedNode,
		graph,
	});
}));

app.put("/api/hitl/nodes/:id", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const node = normalizeManualNode(req.body, req.params.id);
	const storedNode = await graphStore.upsertNode(node);
	await vectorStore.upsertNode(storedNode);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		node: storedNode,
		graph,
	});
}));

app.delete("/api/hitl/nodes/:id", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const result = await graphStore.deleteNode(req.params.id);
	await vectorStore.deleteNodes([result.nodeId]);
	await vectorStore.deleteRelations(result.relationIds ?? []);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		deletedNodeId: result.nodeId,
		deletedRelationIds: result.relationIds ?? [],
		graph,
	});
}));

app.post("/api/hitl/relations", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const relation = normalizeManualRelation(req.body);
	const storedRelation = await graphStore.upsertRelation(relation);
	await vectorStore.upsertRelation(storedRelation);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		relation: storedRelation,
		graph,
	});
}));

app.put("/api/hitl/relations/:id", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const relation = normalizeManualRelation(req.body, req.params.id);
	const storedRelation = await graphStore.upsertRelation(relation);
	await vectorStore.upsertRelation(storedRelation);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		relation: storedRelation,
		graph,
	});
}));

app.delete("/api/hitl/relations/:id", asyncRoute(async (req, res) => {
	requireDirectGraphCrudSupport();
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const result = await graphStore.deleteRelation(req.params.id);
	await vectorStore.deleteRelations([result.relationId]);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "applied",
		applied: true,
		reviewedBy,
		deletedRelationId: result.relationId,
		graph,
	});
}));

app.post("/api/hitl/notes/:id/approve", asyncRoute(async (req, res) => {
	const note = await requireHitlNote(req.params.id);
	const reviewedBy = requireString(req.body?.reviewedBy, "reviewedBy");
	const llmResponse = requireString(req.body?.llmResponse ?? req.body?.editedResponse ?? note.llmResponse, "llmResponse");
	const { graphSchema, graphPayload } = parseHitlResponse(llmResponse);

	persistHitlSchemaSuggestions(graphSchema, graphPayload);
	const storedGraph = await ingestionService.applyGraphPayload(graphPayload, {
		source: `hitl:${note.id}`,
		debugLogger: {
			log: () => {},
		},
	});
	await vectorStore.deleteHitlNotes([note.id]);
	const graph = await buildHitlGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: "approved",
		applied: true,
		reviewedBy,
		nodes: storedGraph.nodes,
		relations: storedGraph.relations,
		nodeDeletes: storedGraph.nodeDeletes,
		relationDeletes: storedGraph.relationDeletes,
		deletedNodeIds: storedGraph.deletedNodeIds,
		deletedRelationIds: storedGraph.deletedRelationIds,
		triplets: buildTriplets(storedGraph),
		schemaSuggestions: graphPayload.schemaSuggestions,
		schemaWarnings: graphPayload.schemaWarnings,
		persistedSchemaSuggestions: graphPayload.persistedSchemaSuggestions,
		graph,
	});
}));

app.delete("/api/hitl/notes/:id", asyncRoute(async (req, res) => {
	const note = await requireHitlNote(req.params.id);
	await vectorStore.deleteHitlNotes([note.id]);

	res.json({
		status: "rejected",
		deleted: true,
		id: note.id,
	});
}));

app.post("/api/ingest", upload.fields([
	{ name: "files", maxCount: MAX_INGEST_FILES },
	{ name: "file", maxCount: MAX_INGEST_FILES },
]), asyncRoute(async (req, res) => {
	const text = await buildIngestText(req);
	const storedGraph = await ingestionService.ingestText({
		text,
		source: "web",
		userName: requireIngestUserName(req),
	});
	const graph = await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		status: storedGraph.status || "applied",
		applied: storedGraph.applied ?? true,
		hitlNote: storedGraph.hitlNote,
		nodes: storedGraph.nodes,
		relations: storedGraph.relations,
		nodeDeletes: storedGraph.nodeDeletes,
		relationDeletes: storedGraph.relationDeletes,
		deletedNodeIds: storedGraph.deletedNodeIds,
		deletedRelationIds: storedGraph.deletedRelationIds,
		triplets: buildTriplets(storedGraph),
		schemaSuggestions: storedGraph.schemaSuggestions,
		schemaWarnings: storedGraph.schemaWarnings,
		persistedSchemaSuggestions: storedGraph.persistedSchemaSuggestions,
		graph,
	});
}));

app.get(/^\/hitl\/?$/, (_req, res) => {
	res.sendFile(path.join(publicDir, "index.html"));
});

app.get(/^\/jobs\/?$/, (_req, res) => {
	res.sendFile(path.join(publicDir, "index.html"));
});

app.get(/^\/schema\/?$/, (_req, res) => {
	res.sendFile(path.join(publicDir, "index.html"));
});

app.use((req, res) => {
	res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, _next) => {
	const status = Number(error.status) || (error.name === "MulterError" ? 400 : 500);
	const message = status >= 500 ? "Server error. Check the terminal for details." : error.message;

	if (status >= 500) {
		console.error(error);
	}

	res.status(status).json({ error: message });
});

const server = app.listen(port, () => {
	console.log("MindMesh web server started.");
	console.log(JSON.stringify({
		...describeRuntime(config),
		port,
		url: `http://localhost:${port}`,
	}, null, 2));
});

async function shutdown(signal) {
	console.log(`\nReceived ${signal}. Closing MindMesh web server.`);
	server.close(async () => {
		try {
			await graphStore.close();
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
