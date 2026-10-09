import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { getConfig } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";
import { loadPrompts, buildExtractionPrompt } from "../prompts/promptRegistry.js";
import { IngestionService } from "../ingestion/ingestionService.js";
import { HybridRagService } from "../rag/hybridRagService.js";
import { parseGraphExtraction, normalizeGraphPayload } from "../ingestion/graphPayload.js";
import { loadGraphSchema, readEditableGraphSchema, formatSchemaCatalog, formatFieldGuidance } from "../schema/graphSchema.js";
import { createDebugLogger } from "../logging/debugLogger.js";

const DEFAULT_GRAPH_LIMIT = 150;
const DEFAULT_HITL_LIMIT = 100;

const config = getConfig();
const prompts = loadPrompts(config);
const graphStore = createGraphStore(config);
const vectorStore = createVectorStore(config);

// No LLM provider is created: the calling agent performs all reasoning.
// These services are reused only for retrieval, normalization, and persistence.
const ingestionService = new IngestionService({
	llmProvider: null,
	graphStore,
	vectorStore,
	prompts,
	logging: config.logging,
	ingestion: config.ingestion,
});

const ragService = new HybridRagService({
	llmProvider: null,
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

function textContent(value) {
	return {
		content: [
			{
				type: "text",
				text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
			},
		],
	};
}

function currentGraphSchema() {
	return loadGraphSchema(config);
}

function hasSchemaViolations(graphPayload) {
	return (graphPayload.schemaViolations?.length ?? 0) > 0;
}

// Short reference shown on HITL cards, e.g. "hitl:muzxnk3c:d964dbbae577" -> "#d964db".
function hitlShortRef(id) {
	return id ? `#${String(id).split(":").pop().slice(0, 6)}` : null;
}

function toolError(toolName, error) {
	const message = `${toolName} failed: ${error?.message ?? String(error)}`;
	const status = Number(error?.status);
	return new McpError(status === 400 || status === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError, message);
}

// Notes passed in chat win over notes saved in the UI; one of them is required.
function resolveReviewerNotes(notes, note) {
	const chatNotes = String(notes ?? "").trim();
	if (chatNotes) {
		return { reviewerNotes: chatNotes, notesSource: "chat" };
	}

	const savedNotes = String(note.reviewerNotes ?? "").trim();
	if (savedNotes) {
		return { reviewerNotes: savedNotes, notesSource: "saved" };
	}

	const error = new Error(`Proposal ${hitlShortRef(note.id)} has no saved reviewer notes. Pass \`notes\` with the user's instructions.`);
	error.status = 400;
	throw error;
}

const ASK_INSTRUCTIONS = [
	"You are the answering agent. Use the tool result to answer the user's question.",
	"",
	"Instructions:",
	"1. Use ONLY the `context` (verified graph context) as the factual source for verified claims. Do not use outside knowledge.",
	"2. Use the `systemPrompt` as the system prompt governing your answer behavior.",
	"3. Cite node IDs and relation IDs in square brackets for every graph-backed claim.",
	"4. If `unverifiedNotes` are present, treat them as pending review, not confirmed fact. If you use any, put them under a separate heading 'Unverified knowledge - yet to be verified' and mention the contributor.",
	"5. If the context is insufficient, say the graph does not contain enough information yet.",
	"6. Be concise and answer directly in your final response to the user.",
].join("\n");

const INGEST_INSTRUCTIONS = [
	"You are the knowledge extraction agent. Your job is to extract graph records from the user's text for ingestion into the MindMesh knowledge graph.",
	"",
	"Instructions:",
	"1. Use the `extractionSystemPrompt` exactly as your system prompt for extraction output formatting.",
	"2. The user-provided text to ingest is the source of NEW graph facts.",
	"3. Use `context` (existing graph + pending HITL context) ONLY for identity resolution, exact node-name reuse, disambiguation, and avoiding duplicate facts. Do not extract new facts from it.",
	"4. Follow the extraction prompt's OUTPUT FORMAT precisely: emit one pipe-delimited record per line between <start#$#$> and </end#$#$> markers, using NODE_CREATE, NODE_UPDATE, NODE_DELETE, RELATION_CREATE, RELATION_UPDATE, RELATION_DELETE, NODE_TYPE_SUGGESTION, and RELATION_TYPE_SUGGESTION records.",
	"5. Reuse existing node names exactly when the new input refers to the same entity.",
	"6. Use only approved schema node types and relationship types from `schemaCatalog` when possible. Suggest new types only when nothing fits.",
	"7. Respect the AMBIGUITY and CONTRADICTION metadata rules in the extraction prompt when the input is underspecified or conflicts with existing context.",
	"8. Do not invent facts. Prefer omission over inference.",
	"9. After producing the graph records block, call the `apply-ingestion` tool with:",
	"   - `graphRecords`: the full pipe-delimited block (including markers)",
	"   - `text`: the original user text being ingested",
	"   - `userName`: the user who provided the text if known",
	"   - `source`: a short source identifier if known",
	"10. Report the `apply-ingestion` result to the user, including whether it was applied or stored as a pending HITL proposal.",
].join("\n");

const REGENERATE_INSTRUCTIONS = [
	"You are regenerating an existing pending HITL proposal using a human reviewer's notes.",
	"",
	"Instructions:",
	"1. Use the `extractionSystemPrompt` exactly as your system prompt. It already contains the original input, the graph context, the reviewer notes, and the previous proposal.",
	"2. The reviewer notes have the highest priority: apply them, but never break the schema or the output syntax.",
	"3. Treat `previousProposal` as the baseline. Keep its records unchanged unless the notes ask for a change.",
	"4. Output the COMPLETE revised proposal (not a diff) between <start#$#$> and </end#$#$> markers.",
	"5. Then call `apply-regeneration` with:",
	"   - `proposal`: the `noteId` returned here",
	"   - `graphRecords`: the full revised block (including markers)",
	"   - `notes`: the `reviewerNotes` returned here, so they are saved on the proposal",
	"6. Tell the user the proposal was regenerated and give its `shortRef` so they can review it in the HITL UI.",
].join("\n");

const server = new McpServer(
	{
		name: "mindmesh-ask-ingest",
		version: "0.1.0",
		description: "MindMesh ask and ingest context server. Provides graph context for answering questions and for retrieval-augmented graph extraction, plus application of extracted graph records. The calling agent performs all LLM reasoning.",
	},
	{
		capabilities: {
			tools: {},
			resources: {},
		},
		instructions: [
			"MindMesh MCP server for ask & ingest, backed by Neo4j + ChromaDB.",
			"",
			"Tools:",
			"- `ask`: retrieve verified graph context + answer system prompt + instructions to answer a user question.",
			"- `ingest-context`: retrieve retrieval-augmented extraction context (existing graph + pending HITL), the fully rendered extraction prompt, schema catalog, and instructions to extract graph records.",
			"- `apply-ingestion`: parse, normalize, and apply (or store as HITL proposal) the graph records an agent extracted.",
			"- `regenerate-context`: get the extraction prompt to regenerate a pending HITL proposal with reviewer notes (from chat or saved in the UI).",
			"- `apply-regeneration`: overwrite that HITL proposal with the regenerated graph records.",
			"",
			"Recommended flow for regenerating a HITL proposal (the user names it by id or short ref such as #d964db):",
			"1. Call `regenerate-context` with the proposal reference and any instructions the user gave in chat as `notes`.",
			"2. Produce the complete revised graph records following the returned `extractionSystemPrompt`.",
			"3. Call `apply-regeneration` with the same proposal reference, the records, and the notes.",
			"",
			"Recommended flow for ingestion:",
			"1. Call `ingest-context` with the user's text.",
			"2. Reason over the returned context and extract pipe-delimited graph records following the `extractionSystemPrompt`.",
			"3. Call `apply-ingestion` with the extracted records.",
			"",
			"Resources:",
			"- `mindmesh://schema`: the editable graph schema.",
			"- `mindmesh://graph`: graph preview.",
			"- `mindmesh://hitl/notes`: pending HITL proposals.",
			"- `mindmesh://nodes/{nodeId}`: a single graph node.",
			"- `mindmesh://relations/{relationId}`: a single graph relation.",
		].join("\n"),
	},
);

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
	"ask",
	{
		title: "Ask for Graph Context",
		description: [
			"Retrieve verified graph context for answering a user's question. ",
			"Returns the formatted graph context, the answering system prompt, and instructions for the calling agent on how to answer. No LLM is invoked by this server.",
		].join(""),
		inputSchema: {
			query: z.string().describe("The user's question to answer."),
			includeUnverifiedKnowledge: z.boolean().optional().describe("Whether to include pending HITL/fleeting notes as unverified knowledge context. Defaults to false."),
		},
	},
	async ({ query, includeUnverifiedKnowledge }) => {
		try {
			const result = await ragService.retrieveContext({
				query,
				includeUnverifiedKnowledge: Boolean(includeUnverifiedKnowledge),
			});
			
			return textContent({
				context: result.context,
				systemPrompt: prompts.answerSystem,
				instructions: ASK_INSTRUCTIONS,
				entryNodes: result.entryNodes,
				graph: result.graph,
				unverifiedNotes: result.unverifiedNotes,
				unverifiedContext: result.unverifiedContext,
				retrievalQuery: result.retrievalQuery,
				depth: result.depth,
			});
		} catch (error) {
			throw new McpError(ErrorCode.InternalError, `ask failed: ${error?.message ?? String(error)}`);
		}
	},
);

server.registerTool(
	"ingest-context",
	{
		title: "Ingest Context",
		description: [
			"Retrieve retrieval-augmented ingestion context for a piece of text the user wants to add to the knowledge graph. ",
			"Returns existing graph context, pending HITL context, the fully rendered extraction system prompt, schema catalog, field guidance, and instructions so the calling agent can extract graph records. No LLM is invoked by this server.",
		].join(""),
		inputSchema: {
			text: z.string().describe("The text to analyze for knowledge extraction and ingestion."),
		},
	},
	async ({ text }) => {
		try {
			const graphSchema = currentGraphSchema();
			const existingContext = await ingestionService.retrieveExistingContext({ text, graphSchema });
			const extractionSystemPrompt = buildExtractionPrompt(prompts.extractionSystemTemplate, {
				graphSchema,
				existingGraphContext: existingContext.context,
				userInput: text,
			});
			
			return textContent({
				context: existingContext.context,
				extractionSystemPrompt,
				schemaCatalog: formatSchemaCatalog(graphSchema),
				fieldGuidance: formatFieldGuidance(graphSchema),
				instructions: INGEST_INSTRUCTIONS,
				entryNodes: existingContext.entryNodes,
				graph: existingContext.graph,
				pendingHitl: {
					notes: existingContext.pendingHitl.notes,
					graph: existingContext.pendingHitl.graph,
					nodeDeletes: existingContext.pendingHitl.nodeDeletes,
					relationDeletes: existingContext.pendingHitl.relationDeletes,
					warnings: existingContext.pendingHitl.warnings,
				},
				ingestionMode: ingestionService.ingestion.mode,
			});
		} catch (error) {
			throw new McpError(ErrorCode.InternalError, `ingest-context failed: ${error?.message ?? String(error)}`);
		}
	},
);

server.registerTool(
	"apply-ingestion",
	{
		title: "Apply Ingestion",
		description: [
			"Parse, normalize, and apply extracted graph records to the knowledge graph. ",
			"Accepts the pipe-delimited graph records block an agent produced (including <start#$#$> and </end#$#$> markers). ",
			"Applies mutations directly when ingestion mode is 'auto' and no schema violations exist; otherwise stores a pending HITL proposal for human review.",
		].join(""),
		inputSchema: {
			graphRecords: z.string().describe("The pipe-delimited graph records block output by the extraction agent, enclosed between <start#$#$> and </end#$#$> markers."),
			text: z.string().describe("The original user text that was ingested."),
			userName: z.string().optional().describe("User name for attribution on HITL proposals. Defaults to 'mcp-agent'."),
			source: z.string().optional().describe("Source identifier for attribution. Defaults to 'mcp'."),
		},
	},
	async ({ graphRecords, text, userName, source }) => {
		const debugLogger = createDebugLogger({ ...config.logging, name: "ingest" });
		const resolvedUserName = String(userName || "mcp-agent").trim() || "mcp-agent";
		const resolvedSource = String(source || "mcp").trim() || "mcp";
		
		try {
			const graphSchema = currentGraphSchema();
			const extractedGraph = parseGraphExtraction(graphRecords);
			const graphPayload = normalizeGraphPayload(extractedGraph, { schema: graphSchema });
			
			let result;
			let status;
			let applied;
			if (ingestionService.ingestion.mode === "hitl" || hasSchemaViolations(graphPayload)) {
				const pending = await ingestionService.storeHitlProposal({
					text,
					source: resolvedSource,
					userName: resolvedUserName,
					rawResponse: graphRecords,
					graphPayload,
					debugLogger,
				});
				result = pending;
				status = pending.status ?? "pending_hitl";
				applied = false;
			} else {
				const appliedResult = await ingestionService.applyGraphPayload(graphPayload, {
					source: resolvedSource,
					debugLogger,
				});
				result = appliedResult;
				status = "applied";
				applied = true;
			}
			
			return textContent({
				status,
				applied,
				nodes: result.nodes ?? [],
				relations: result.relations ?? [],
				nodeDeletes: result.nodeDeletes ?? [],
				relationDeletes: result.relationDeletes ?? [],
				deletedNodeIds: result.deletedNodeIds ?? [],
				deletedRelationIds: result.deletedRelationIds ?? [],
				tripletCount: (result.relations ?? []).length,
				schemaSuggestions: result.schemaSuggestions ?? { nodeTypes: [], relationshipTypes: [] },
				schemaViolations: result.schemaViolations ?? [],
				schemaWarnings: result.schemaWarnings ?? [],
				hitlNoteId: result.hitlNote?.id ?? null,
				hitlNoteRef: hitlShortRef(result.hitlNote?.id),
				hitlNoteStatus: result.hitlNote?.status ?? null,
			});
		} catch (error) {
			const message = `apply-ingestion failed: ${error?.message ?? String(error)}`;
			if (Number(error?.status) === 400) {
				throw new McpError(ErrorCode.InvalidParams, message);
			}
			throw new McpError(ErrorCode.InternalError, message);
		}
	},
);

server.registerTool(
	"regenerate-context",
	{
		title: "Regenerate HITL Proposal Context",
		description: [
			"Get everything needed to regenerate a pending HITL proposal with reviewer notes. ",
			"Accepts the proposal's full id or its short reference (e.g. #d964db). Notes passed here take precedence over notes saved in the HITL UI; one of them is required. ",
			"Returns the extraction system prompt (same as ingestion, plus a reviewer revision section), the original input, the previous proposal, and instructions. No LLM is invoked by this server.",
		].join(""),
		inputSchema: {
			proposal: z.string().describe("HITL proposal id (hitl:...) or short reference such as #d964db."),
			notes: z.string().optional().describe("Reviewer instructions given in chat. Omit to use the notes saved on the proposal in the HITL UI."),
		},
	},
	async ({ proposal, notes }) => {
		try {
			const noteId = await ingestionService.resolveHitlNoteId(proposal);
			const note = await ingestionService.getHitlNote(noteId);
			const { reviewerNotes, notesSource } = resolveReviewerNotes(notes, note);
			const { existingContext, extractionPrompt } = await ingestionService.buildHitlRegenerationPrompt({
				note,
				reviewerNotes,
				previousProposal: note.llmResponse,
			});

			return textContent({
				noteId,
				shortRef: hitlShortRef(noteId),
				reviewerNotes,
				notesSource,
				originalText: note.userInput,
				previousProposal: note.llmResponse,
				context: existingContext.context,
				extractionSystemPrompt: extractionPrompt,
				instructions: REGENERATE_INSTRUCTIONS,
			});
		} catch (error) {
			throw toolError("regenerate-context", error);
		}
	},
);

server.registerTool(
	"apply-regeneration",
	{
		title: "Apply HITL Proposal Regeneration",
		description: [
			"Overwrite a pending HITL proposal with regenerated graph records and save the reviewer notes on it. ",
			"The records are parsed before anything is written, so an invalid block leaves the proposal unchanged. ",
			"The proposal stays pending for human approval in the HITL UI.",
		].join(""),
		inputSchema: {
			proposal: z.string().describe("HITL proposal id (hitl:...) or short reference such as #d964db."),
			graphRecords: z.string().describe("The complete revised pipe-delimited block, enclosed between <start#$#$> and </end#$#$> markers."),
			notes: z.string().optional().describe("The reviewer notes used for this regeneration. Omit to keep the notes saved on the proposal."),
			regeneratedBy: z.string().optional().describe("Who requested the regeneration. Defaults to 'mcp-agent'."),
		},
	},
	async ({ proposal, graphRecords, notes, regeneratedBy }) => {
		try {
			const noteId = await ingestionService.resolveHitlNoteId(proposal);
			const note = await ingestionService.getHitlNote(noteId);
			const { reviewerNotes } = resolveReviewerNotes(notes, note);
			const { note: updatedNote, graphPayload } = await ingestionService.storeHitlRegeneration({
				note,
				rawResponse: graphRecords,
				reviewerNotes,
				regeneratedBy: String(regeneratedBy || "mcp-agent").trim() || "mcp-agent",
				origin: "agent",
			});

			return textContent({
				status: "pending_hitl",
				noteId,
				shortRef: hitlShortRef(noteId),
				regeneratedBy: updatedNote.regeneratedBy,
				regeneratedAt: updatedNote.regeneratedAt,
				reviewerNotes: updatedNote.reviewerNotes,
				nodeCount: graphPayload.nodes.length,
				relationCount: graphPayload.relations.length,
				nodeDeleteCount: graphPayload.nodeDeletes.length,
				relationDeleteCount: graphPayload.relationDeletes.length,
				schemaViolations: graphPayload.schemaViolations ?? [],
				schemaWarnings: graphPayload.schemaWarnings ?? [],
			});
		} catch (error) {
			throw toolError("apply-regeneration", error);
		}
	},
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

async function handleResourceError(error) {
	if (error instanceof McpError) {
		throw error;
	}
	throw new McpError(ErrorCode.InternalError, error?.message ?? String(error));
}

server.registerResource(
	"graph-schema",
	"mindmesh://schema",
	{
		title: "Graph Schema",
		description: "Editable MindMesh graph schema (approved node types, relationship types, property descriptors, fallbacks).",
		mimeType: "application/json",
	},
	async (uri) => {
		try {
			const editable = readEditableGraphSchema(config);
			return {
				contents: [{ uri: uri.toString(), mimeType: "application/json", text: editable.formattedJson }],
			};
		} catch (error) {
			return handleResourceError(error);
		}
	},
);

server.registerResource(
	"graph-preview",
	"mindmesh://graph",
	{
		title: "Graph Preview",
		description: `Latest capped graph preview (up to ${DEFAULT_GRAPH_LIMIT} nodes and their relations).`,
		mimeType: "application/json",
	},
	async (uri) => {
		try {
			const graph = await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT);
			return {
				contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(graph, null, 2) }],
			};
		} catch (error) {
			return handleResourceError(error);
		}
	},
);

server.registerResource(
	"hitl-notes",
	"mindmesh://hitl/notes",
	{
		title: "Pending HITL Notes",
		description: `Summary of pending HITL ingestion proposals (up to ${DEFAULT_HITL_LIMIT}).`,
		mimeType: "application/json",
	},
	async (uri) => {
		try {
			if (typeof vectorStore.listHitlNotes !== "function") {
				throw new McpError(ErrorCode.InternalError, "The configured vector store does not support HITL notes.");
			}
			const notes = await vectorStore.listHitlNotes({ status: "pending", limit: DEFAULT_HITL_LIMIT });
			return {
				contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(notes, null, 2) }],
			};
		} catch (error) {
			return handleResourceError(error);
		}
	},
);

server.registerResource(
	"graph-node",
	new ResourceTemplate("mindmesh://nodes/{nodeId}", { list: undefined }),
	{
		title: "Graph Node",
		description: "A single graph node by node ID (e.g. node:ekyc_screen).",
		mimeType: "application/json",
	},
	async (uri, variables) => {
		try {
			const nodeId = String(Array.isArray(variables.nodeId) ? variables.nodeId[0] : variables.nodeId ?? "");
			const node = await graphStore.getNode(nodeId);
			if (!node) {
				throw new McpError(ErrorCode.InvalidParams, `Node not found: ${nodeId}`);
			}
			return {
				contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(node, null, 2) }],
			};
		} catch (error) {
			return handleResourceError(error);
		}
	},
);

server.registerResource(
	"graph-relation",
	new ResourceTemplate("mindmesh://relations/{relationId}", { list: undefined }),
	{
		title: "Graph Relation",
		description: "A single graph relation by relation ID (e.g. rel:xxxxxxxxxxxx).",
		mimeType: "application/json",
	},
	async (uri, variables) => {
		try {
			const relationId = String(Array.isArray(variables.relationId) ? variables.relationId[0] : variables.relationId ?? "");
			const relation = await graphStore.getRelation(relationId);
			if (!relation) {
				throw new McpError(ErrorCode.InvalidParams, `Relation not found: ${relationId}`);
			}
			return {
				contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(relation, null, 2) }],
			};
		} catch (error) {
			return handleResourceError(error);
		}
	},
);

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

async function shutdown() {
	try {
		await graphStore.close();
	} catch {}
	if (typeof vectorStore.close === "function") {
		try {
			await vectorStore.close();
		} catch {}
	}
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);