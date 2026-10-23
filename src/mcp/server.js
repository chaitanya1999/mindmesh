import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import { getConfig } from "../config.js";
import { createDebugLogger } from "../logging/debugLogger.js";
import { createMindMesh, isMainModule } from "../mindmesh.js";
import { buildExtractionPrompt } from "../prompts/promptRegistry.js";
import { readEditableGraphSchema } from "../schema/graphSchema.js";
import { normalizeScopeFilter, scopeAllowedValues, scopeEnabled } from "../schema/scope.js";

// MCP server for coding agents. The agent does all reasoning: MindMesh retrieves context, hands out its
// extraction prompts, and stores the agent's records through the same HITL path as the web UI. Transport only:
// the logic lives in GraphReadService, HitlService, IngestionService, and HybridRagService.

const DEFAULT_GRAPH_LIMIT = 150;
const DEFAULT_HITL_LIMIT = 100;
const RECORD_BLOCK = "the complete pipe-delimited record block, including the <start#$#$> and </end#$#$> markers";

// Tool annotations (hints for the client). Read tools only look; nothing outside MindMesh is reached.
const READ_ONLY_TOOL = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const DECISION_TOOL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

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

// Short reference shown on HITL cards, e.g. "hitl:muzxnk3c:d964dbbae577" -> "#d964db".
function hitlShortRef(id) {
	return id ? `#${String(id).split(":").pop().slice(0, 6)}` : null;
}

function toolError(toolName, error) {
	const message = `${toolName} failed: ${error?.message ?? String(error)}`;
	const status = Number(error?.status);
	return new McpError(status === 400 || status === 404 ? ErrorCode.InvalidParams : ErrorCode.InternalError, message);
}

// Short list form of a pending proposal, shared by search_proposals and list_proposals.
function proposalSummary(item) {
	return {
		ref: hitlShortRef(item.id),
		id: item.id,
		verified: false,
		author: item.userName,
		source: item.source,
		scope: item.scope || "",
		createdAt: item.createdAt,
		inputPreview: item.inputPreview,
		counts: {
			nodes: item.nodeCount,
			relations: item.relationCount,
			nodeDeletes: item.nodeDeleteCount,
			relationDeletes: item.relationDeleteCount,
			typeSuggestions: item.schemaSuggestionCount,
		},
		signals: { ambiguity: item.ambiguityCount, contradiction: item.contradictionCount },
		reviewerNotes: item.reviewerNotes,
		...(item.distance === undefined ? {} : { distance: item.distance }),
	};
}

function compactNode(node) {
	return { id: node.id, label: node.label, type: node.type, scope: node.scope ?? [] };
}

function payloadCounts(graphPayload) {
	return {
		nodes: graphPayload.nodes?.length ?? 0,
		relations: graphPayload.relations?.length ?? 0,
		nodeDeletes: graphPayload.nodeDeletes?.length ?? 0,
		relationDeletes: graphPayload.relationDeletes?.length ?? 0,
		typeSuggestions: (graphPayload.schemaSuggestions?.nodeTypes?.length ?? 0) + (graphPayload.schemaSuggestions?.relationshipTypes?.length ?? 0),
	};
}

// How well MindMesh's own retrieval covered the text, so the agent knows when to look entities up itself.
function retrievalQuality(existingContext) {
	const entryNodes = existingContext.entryNodes ?? [];
	const distances = entryNodes.map((entry) => entry.distance).filter(Number.isFinite);
	const closestDistance = distances.length > 0 ? Math.min(...distances) : null;
	return {
		entryNodeCount: entryNodes.length,
		retrievedNodeCount: existingContext.graph.nodes.length,
		pendingNodeCount: existingContext.pendingHitl.graph.nodes.length,
		closestDistance,
		note: entryNodes.length === 0
			? "MindMesh retrieved no existing nodes for this text. Every entity is either new or named differently in the graph: look each one up with search_nodes before creating it."
			: `MindMesh retrieved ${existingContext.graph.nodes.length} node(s) with one search over the whole text (closest distance ${closestDistance?.toFixed?.(3) ?? "n/a"}; lower is closer). Entities named differently in the graph can be missing: look up every entity in the text that is not in retrievedNodes or pendingNodes.`,
	};
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

const INGEST_INSTRUCTIONS = [
	"1. Treat `extractionSystemPrompt` as your extraction instructions and follow its record format exactly.",
	"2. The text is the only source of new facts. `retrievedNodes`, `pendingNodes`, and the context inside the prompt are only for recognising entities that already exist.",
	"3. Before extracting, check every entity the text mentions against `retrievedNodes` and `pendingNodes` (see `retrievalQuality`). For each one that is missing, call `search_nodes` (match \"text\" with its name, then \"semantic\" with a short description) and `get_node` to confirm; reuse the exact existing name. Create a node only when nothing matches.",
	"4. Write the complete record block between <start#$#$> and </end#$#$>.",
	"5. Call `submit_ingest` with `records` (the whole block), `text` (the original text), `author` (the user, if known), and the same `scope` as here when scopes are in use.",
	"6. Tell the user the outcome: applied, or pending with its ref and review reasons.",
].join("\n");

const REGENERATE_INSTRUCTIONS = [
	"1. Treat `extractionSystemPrompt` as your extraction instructions; it already contains the original input, the context, the reviewer notes, and the previous proposal.",
	"2. The reviewer notes have the highest priority: apply them without breaking the schema or the record format.",
	"3. Keep every record of `previousProposal` unchanged unless the notes ask for a change.",
	"4. If the notes mention entities that are not in `retrievedNodes`, look them up with `search_nodes` / `get_node` first and reuse exact names.",
	"5. Write the COMPLETE revised block (not a diff) between <start#$#$> and </end#$#$>.",
	"6. Call `submit_regeneration` with `ref`, `records`, and `notes` (the `reviewerNotes` returned here).",
	"7. Tell the user the proposal was regenerated and give its ref; it stays pending for approval.",
].join("\n");

const QUERY_CYPHER_DESCRIPTION = [
	"Runs one read-only Cypher query on the approved graph, for questions the other tools would need many calls for (for example every screen with its sections and their fields). ",
	"Graph model: (:KnowledgeNode {id, name, label, type, description, scope, createdAt, updatedAt})-[:RELATES_TO {id, relation, sourceId, targetId, information, description, scope}]->(:KnowledgeNode). ",
	"`scope` is a list of strings, or absent when unscoped; for example WHERE 'uc' IN n.scope OR 'common' IN n.scope OR n.scope IS NULL. ",
	"Every node has the label KnowledgeNode and every relationship the type RELATES_TO; the meaning is in the `type` and `relation` properties. Node ids are \"node:<name>\". ",
	"Example: MATCH (s:KnowledgeNode {type: 'screen'})-[:RELATES_TO {relation: 'contains'}]->(x:KnowledgeNode) RETURN s.label, collect(x.label). ",
	"Neo4j checks that the query only reads; writes, schema changes, LOAD CSV, dbms.* and apoc.* are refused. 10 second timeout, at most `limit` rows. Pending proposals are not in Neo4j.",
].join("");

// Builds the MCP server with its tools and resources, without connecting a transport, so tests can use
// an in-memory transport. Review decisions (approve / reject) are registered only when
// config.mcp.allowReviewDecisions is true.
export function createMcpServer(services) {
	// There is no LLM provider: the calling agent performs all reasoning, and these services are used only
	// for retrieval, normalization, and persistence.
	const { config, prompts, graphStore, vectorStore, graphReadService, hitlService, ingestionService, ragService } = services;
	const allowReviewDecisions = config.mcp?.allowReviewDecisions === true;
	// In auto mode submit_ingest can apply updates directly, which overwrite stored values.
	const submitIngestAnnotations = {
		readOnlyHint: false,
		destructiveHint: ingestionService.ingestion.mode !== "hitl",
		idempotentHint: false,
		openWorldHint: false,
	};

	// Scope arguments take one value; the allowed values are read from the schema when the server is built. They
	// exist only for the kinds of scope switched on in config (scope.nodes, scope.relations).
	const nodeScopes = scopeEnabled("node");
	const scopeValues = scopeAllowedValues(hitlService.currentSchema(), "node");
	const scopeChoices = scopeValues ? ` Allowed values: ${scopeValues.join(", ")}.` : "";
	const filterArgument = z.string().optional().describe(`Scope filter: only items in this scope, items scoped common, and unscoped items. Omit for no filter.${scopeChoices}`);
	const scopeFilter = nodeScopes ? { scope: filterArgument } : {};
	const relationScopeFilter = scopeEnabled("relation") ? { scope: filterArgument } : {};
	const ingestScope = nodeScopes
		? { scope: z.string().describe(`The scope (business unit) the text belongs to; it frames the extraction, it does not filter the context.${scopeChoices} Required: if the user has not said which scope the text is for, ask them before calling; pass "" only when they say it has no scope.`) }
		: {};

	const server = new McpServer(
		{
			name: "mindmesh",
			version: "0.2.0",
			description: "MindMesh knowledge graph: explore approved knowledge and pending proposals, and propose new knowledge through human review (HITL). The calling agent performs all reasoning.",
		},
		{
			capabilities: {
				tools: {},
				resources: {},
			},
			instructions: [
				"MindMesh is a human-reviewed knowledge graph (Neo4j + Chroma). Approved facts are in the graph; new knowledge becomes a pending proposal that a person reviews.",
				"",
				"Questions: start with `search_context`; use `search_nodes`, `search_relations`, `get_node`, `explore_graph`, `find_paths`, and `query_cypher` to go deeper. Cite node and relation ids. Pending proposals (`search_proposals`, includePending) are unverified: keep them separate from approved facts.",
				nodeScopes
					? "Ingestion: `get_ingest_prompt` with the user's text and its scope (ask the user for the scope if they did not give it), look up any entity it did not retrieve, extract records, then `submit_ingest` with the same scope."
					: "Ingestion: `get_ingest_prompt` with the user's text, look up any entity it did not retrieve, extract records, then `submit_ingest`.",
				nodeScopes ? "Scope: nodes can carry a scope, a list such as [\"uc\"]; unscoped nodes are shared or not classified yet. When the user works on one scope, pass it as `scope` to the search tools." : "",
				"Reviewing: `list_proposals` and `get_proposal`; `save_reviewer_notes`; regenerate with `get_regenerate_prompt` then `submit_regeneration`.",
				allowReviewDecisions
					? "Decisions: `approve_proposal` and `reject_proposal` are enabled. Use them only when the user explicitly asks for that proposal."
					: "Decisions: approving and rejecting are done by a person in the MindMesh HITL UI (not available over MCP on this server).",
				"Proposals are named by id or short ref such as #d964db.",
			].filter(Boolean).join("\n"),
		},
	);

	function registerTool(name, annotations, title, description, inputSchema, handler) {
		server.registerTool(
			name,
			{ title, description, inputSchema, annotations },
			async (args) => {
				try {
					return textContent(await handler(args));
				} catch (error) {
					throw toolError(name, error);
				}
			},
		);
	}

	const readTool = (name, ...rest) => registerTool(name, READ_ONLY_TOOL, ...rest);

	// ---------------------------------------------------------------------------
	// Read tools: the approved graph
	// ---------------------------------------------------------------------------

	readTool(
		"search_context",
		"Search Context",
		[
			"Builds MindMesh's ready-made context for a question: the closest nodes by meaning, expanded through the graph. ",
			"Use it as the first step for a question; use search_nodes, get_node, and the other read tools when it misses something. ",
			"Cite node and relation ids in square brackets for graph-backed claims. With includePending, pending proposals are added as unverified knowledge: keep them separate from approved facts and say who contributed them.",
		].join(""),
		{
			query: z.string().describe("The question or topic to build context for."),
			includePending: z.boolean().optional().describe("Also include pending (unapproved) proposals as unverified knowledge. Default false."),
			depth: z.number().int().min(0).max(4).optional().describe("How many relation hops to expand from the closest nodes. Default: the server setting."),
			...scopeFilter,
		},
		async ({ query, includePending = false, depth, scope }) => {
			const result = await ragService.retrieveContext({ query, includeUnverifiedKnowledge: includePending, depth, scope });
			return {
				query,
				depth: result.depth,
				scope: result.scope,
				context: result.context,
				entryNodes: result.entryNodes.map((entry) => ({
					id: entry.id,
					label: entry.metadata?.label ?? "",
					type: entry.metadata?.type ?? "",
					distance: entry.distance,
				})),
				...(includePending ? {
					pending: {
						verified: false,
						context: result.unverifiedContext,
						proposals: result.unverifiedNotes.map((note) => ({ ref: hitlShortRef(note.id), id: note.id, author: note.userName, verified: false })),
					},
				} : {}),
			};
		},
	);

	readTool(
		"search_nodes",
		"Search Nodes",
		[
			"Finds approved graph nodes. match \"semantic\" (default) ranks by meaning; match \"text\" matches names, labels, and descriptions as text, which finds exact names such as API or field names that meaning search can miss. ",
			"Use it to check whether an entity already exists before proposing it, trying text first for exact names. Results are full node records with ids.",
		].join(""),
		{
			query: z.string().describe("Name, phrase, or description to search for."),
			match: z.enum(["semantic", "text"]).optional().describe("semantic (default) or text."),
			type: z.string().optional().describe("Only nodes of this node type (see get_schema)."),
			...scopeFilter,
			limit: z.number().int().min(1).max(50).optional().describe("Maximum results. Default 10."),
		},
		async ({ query, match, type, scope, limit }) => graphReadService.searchNodes({ query, match, type, scope, limit }),
	);

	readTool(
		"search_relations",
		"Search Relations",
		"Finds approved relations (facts between two nodes) by meaning, optionally of one relation type. Each result has the relation, its information and description, and both endpoint nodes.",
		{
			query: z.string().describe("The fact or relationship to search for."),
			relationType: z.string().optional().describe("Only relations of this type (see get_schema)."),
			...relationScopeFilter,
			limit: z.number().int().min(1).max(50).optional().describe("Maximum results. Default 10."),
		},
		async ({ query, relationType, scope, limit }) => graphReadService.searchRelations({ query, relationType, scope, limit }),
	);

	readTool(
		"get_node",
		"Get Node",
		"One approved node by id (node:ekyc_screen) or exact name (ekyc_screen), with its relations grouped by direction (outgoing, incoming) and relation type. With includePending (default), also lists pending proposals that would change the node or its relations, marked unverified. If the node is not found, use search_nodes.",
		{
			node: z.string().describe("Node id (node:...) or exact node name."),
			includePending: z.boolean().optional().describe("Include pending proposals touching this node. Default true."),
		},
		async ({ node, includePending = true }) => {
			const result = await graphReadService.getNode({ node });
			if (!includePending) {
				return result;
			}
			const pendingChanges = await hitlService.proposalsTouchingNode(result.node.id);
			return { ...result, pendingChanges: pendingChanges.map((item) => ({ ref: hitlShortRef(item.id), ...item })) };
		},
	);

	readTool(
		"explore_graph",
		"Explore Graph",
		"Walks the approved graph out from one node, up to `depth` hops (1-4), for impact and dependency questions: direction \"out\" follows relations the node starts (what it uses), \"in\" follows relations pointing at it (what uses it), \"both\" (default) follows all. Optional relation-type and node-type filters. Each node carries its hop `distance`; `truncated` is true when `limit` cut the result.",
		{
			from: z.string().describe("Start node id (node:...) or exact name."),
			depth: z.number().int().min(1).max(4).optional().describe("Hops to walk. Default 1."),
			direction: z.enum(["both", "out", "in"]).optional().describe("both (default), out, or in."),
			relationTypes: z.array(z.string()).optional().describe("Only follow relations of these types."),
			nodeTypes: z.array(z.string()).optional().describe("Only reach nodes of these types."),
			...scopeFilter,
			limit: z.number().int().min(1).max(500).optional().describe("Maximum nodes. Default 100."),
		},
		async ({ from, depth, direction, relationTypes, nodeTypes, scope, limit }) => graphReadService.exploreGraph({ from, depth, direction, relationTypes, nodeTypes, scope, limit }),
	);

	readTool(
		"find_paths",
		"Find Paths",
		"Shortest paths between two approved nodes, following relations in either direction, up to `maxDepth` relations (1-6): how X is connected to Y. Each path has a one-line summary with relation directions, plus its nodes and relations.",
		{
			from: z.string().describe("Start node id (node:...) or exact name."),
			to: z.string().describe("End node id (node:...) or exact name."),
			maxDepth: z.number().int().min(1).max(6).optional().describe("Longest path to look for. Default 4."),
			relationTypes: z.array(z.string()).optional().describe("Only paths made of these relation types."),
			limit: z.number().int().min(1).max(20).optional().describe("Maximum paths. Default 5."),
		},
		async ({ from, to, maxDepth, relationTypes, limit }) => graphReadService.findPaths({ from, to, maxDepth, relationTypes, limit }),
	);

	readTool(
		"query_cypher",
		"Query Cypher",
		QUERY_CYPHER_DESCRIPTION,
		{
			cypher: z.string().describe("A read-only Cypher query. Use $name placeholders for values."),
			params: z.record(z.string(), z.any()).optional().describe("Values for the $name placeholders."),
			limit: z.number().int().min(1).max(500).optional().describe("Maximum rows. Default 100."),
		},
		async ({ cypher, params, limit }) => graphReadService.queryCypher({ cypher, params, limit }),
	);

	readTool(
		"get_schema",
		"Get Schema",
		"The approved node and relation types with descriptions and how many nodes or relations use each, totals, types still used in the graph but no longer approved, and field guidance (what each record field should contain). Use it to learn what the graph holds and which types to use.",
		{},
		async () => graphReadService.getSchemaOverview(),
	);

	// ---------------------------------------------------------------------------
	// Read tools: pending proposals (unverified)
	// ---------------------------------------------------------------------------

	readTool(
		"search_proposals",
		"Search Proposals",
		"Finds pending (unapproved) proposals by meaning. Results are unverified knowledge, never approved facts. Use get_proposal with a result's ref for details.",
		{
			query: z.string().describe("Topic or text to search pending proposals for."),
			limit: z.number().int().min(1).max(50).optional().describe("Maximum results. Default 10."),
		},
		async ({ query, limit }) => ({
			results: (await hitlService.searchProposals({ query, limit })).map(proposalSummary),
		}),
	);

	readTool(
		"list_proposals",
		"List Proposals",
		"The pending proposal review queue, oldest first, with counts and review signals (ambiguity, contradiction). Filters apply to all pending proposals. Use get_proposal with a ref for details.",
		{
			signal: z.enum(["ambiguity", "contradiction"]).optional().describe("Only proposals with this review signal."),
			operation: z.enum(["create", "update", "delete"]).optional().describe("Only proposals containing this kind of change."),
			author: z.string().optional().describe("Only proposals by this user."),
			source: z.string().optional().describe("Only proposals from this source (for example web, mcp, manual)."),
			...(nodeScopes ? { scope: z.string().optional().describe("Only proposals ingested with this scope.") } : {}),
			limit: z.number().int().min(1).max(100).optional().describe("Maximum results. Default 20."),
		},
		async ({ signal, operation, author, source, scope, limit = 20 }) => {
			const { notes, total } = await hitlService.listProposals({ limit, filter: { signal, operation, author, source, scope } });
			return { total, results: notes.map(proposalSummary) };
		},
	);

	readTool(
		"get_proposal",
		"Get Proposal",
		"One pending proposal by id or short ref (#d964db): the original input, the proposal text, the parsed records, and for every record the proposed value next to the current graph value (null when the record is new). Use it to review or summarize a proposal for the user. Reviewing never approves.",
		{
			ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
		},
		async ({ ref }) => {
			const { proposal, changes } = await hitlService.getProposalReview({ ref });
			return { ref: hitlShortRef(proposal.id), verified: false, proposal, changes };
		},
	);

	// ---------------------------------------------------------------------------
	// Proposing knowledge: ingestion and regeneration
	// ---------------------------------------------------------------------------

	readTool(
		"get_ingest_prompt",
		"Get Ingest Prompt",
		[
			"Step 1 of adding knowledge from the user's text. Runs MindMesh's own retrieval and returns its exact extraction prompt (record format, schema types, field guidance, retrieved context), the retrieved and pending nodes, a retrieval quality note, and instructions. ",
			"MindMesh's retrieval is one search over the whole text and can miss entities named differently: check every entity the text mentions against retrievedNodes and pendingNodes, and look up the missing ones with search_nodes / get_node before extracting. Then call submit_ingest.",
			nodeScopes ? " The scope is required: if the user has not said which scope (business unit) the text is for, ask them first." : "",
		].join(""),
		{
			text: z.string().describe("The text to add to the knowledge graph."),
			...ingestScope,
		},
		async ({ text, scope: requestedScope }) => {
			const graphSchema = hitlService.currentSchema();
			const scope = normalizeScopeFilter(requestedScope, graphSchema);
			const existingContext = await ingestionService.retrieveExistingContext({ text, graphSchema });
			return {
				scope,
				extractionSystemPrompt: buildExtractionPrompt(prompts.extractionSystemTemplate, {
					graphSchema,
					existingGraphContext: existingContext.context,
					userInput: text,
					scope,
				}),
				retrievedNodes: existingContext.graph.nodes.map(compactNode),
				pendingNodes: existingContext.pendingHitl.graph.nodes.map((node) => ({
					...compactNode(node),
					ref: hitlShortRef(node.hitlNoteId),
					verified: false,
				})),
				retrievalQuality: retrievalQuality(existingContext),
				ingestionMode: ingestionService.ingestion.mode,
				instructions: INGEST_INSTRUCTIONS,
			};
		},
	);

	registerTool(
		"submit_ingest",
		submitIngestAnnotations,
		"Submit Ingest",
		[
			"Step 2 of adding knowledge: submits the records you extracted following get_ingest_prompt. ",
			"MindMesh checks them against the schema and the graph, reconciles them with pending proposals, then applies clean creates and updates directly in auto mode, or stores a pending proposal for human review (always in hitl mode, and for any schema violation, ambiguity, contradiction, or delete). ",
			"Returns the status, the proposal ref when pending, and the review reasons.",
		].join(""),
		{
			records: z.string().describe(`The extracted records: ${RECORD_BLOCK}.`),
			text: z.string().describe("The original text the records were extracted from."),
			...ingestScope,
			author: z.string().optional().describe("Who provided the text. Default mcp-agent."),
			source: z.string().optional().describe("Short source label. Default mcp."),
		},
		async ({ records, text, scope, author, source }) => {
			const result = await hitlService.submitRecords({
				graphRecords: records,
				text,
				scope,
				userName: String(author || "mcp-agent").trim() || "mcp-agent",
				source: String(source || "mcp").trim() || "mcp",
				debugLogger: createDebugLogger({ ...config.logging, name: "ingest" }),
			});
			const status = result.status ?? "applied";
			return {
				status,
				applied: status === "applied",
				ref: hitlShortRef(result.hitlNote?.id),
				id: result.hitlNote?.id ?? null,
				reviewReasons: result.reviewReasons ?? [],
				counts: payloadCounts(result),
				nodeIds: (result.nodes ?? []).map((node) => node.id),
				relationIds: (result.relations ?? []).map((relation) => relation.id),
				schemaViolations: result.schemaViolations ?? [],
				schemaWarnings: result.schemaWarnings ?? [],
			};
		},
	);

	readTool(
		"get_regenerate_prompt",
		"Get Regenerate Prompt",
		[
			"Step 1 of revising a pending proposal with reviewer notes. Accepts the proposal id or short ref; notes given here (from chat) win over notes saved in the HITL UI, and one of them is required. ",
			"Returns the extraction prompt plus the reviewer-revision section (notes and previous proposal), the original text, the retrieved nodes, and instructions. Then call submit_regeneration.",
		].join(""),
		{
			ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
			notes: z.string().optional().describe("The user's instructions for the revision. Omit to use the notes saved on the proposal."),
		},
		async ({ ref, notes }) => {
			const noteId = await hitlService.resolveRef(ref);
			const note = await hitlService.getProposal(noteId);
			const { reviewerNotes, notesSource } = resolveReviewerNotes(notes, note);
			const { existingContext, extractionPrompt } = await ingestionService.buildHitlRegenerationPrompt({
				note,
				reviewerNotes,
				previousProposal: note.llmResponse,
			});
			return {
				ref: hitlShortRef(noteId),
				id: noteId,
				reviewerNotes,
				notesSource,
				originalText: note.userInput,
				scope: note.scope || "",
				previousProposal: note.llmResponse,
				extractionSystemPrompt: extractionPrompt,
				retrievedNodes: existingContext.graph.nodes.map(compactNode),
				instructions: REGENERATE_INSTRUCTIONS,
			};
		},
	);

	registerTool(
		"submit_regeneration",
		{ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		"Submit Regeneration",
		"Step 2 of revising a pending proposal: overwrites it with your complete revised records and saves the reviewer notes on it. The records are checked before anything is written, so an invalid block leaves the proposal unchanged. The proposal stays pending for human approval.",
		{
			ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
			records: z.string().describe(`The revised records: ${RECORD_BLOCK}.`),
			notes: z.string().optional().describe("The reviewer notes used for this revision. Omit to keep the notes saved on the proposal."),
			author: z.string().optional().describe("Who asked for the revision. Default mcp-agent."),
		},
		async ({ ref, records, notes, author }) => {
			const noteId = await hitlService.resolveRef(ref);
			const note = await hitlService.getProposal(noteId);
			const { reviewerNotes } = resolveReviewerNotes(notes, note);
			const { note: updatedNote, graphPayload } = await hitlService.storeRegeneration({
				note,
				rawResponse: records,
				reviewerNotes,
				regeneratedBy: String(author || "mcp-agent").trim() || "mcp-agent",
				origin: "agent",
			});
			return {
				status: "pending_hitl",
				ref: hitlShortRef(noteId),
				id: noteId,
				regeneratedBy: updatedNote.regeneratedBy,
				regeneratedAt: updatedNote.regeneratedAt,
				reviewerNotes: updatedNote.reviewerNotes,
				counts: payloadCounts(graphPayload),
				schemaViolations: graphPayload.schemaViolations ?? [],
				schemaWarnings: graphPayload.schemaWarnings ?? [],
			};
		},
	);

	registerTool(
		"save_reviewer_notes",
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		"Save Reviewer Notes",
		"Saves reviewer notes on a pending proposal (replacing earlier notes), for a human reviewer or a later regeneration. The proposal itself is not changed.",
		{
			ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
			notes: z.string().describe("The notes to save."),
		},
		async ({ ref, notes }) => {
			const noteId = await hitlService.resolveRef(ref);
			const note = await hitlService.saveReviewerNotes({ noteId, reviewerNotes: notes });
			return { ref: hitlShortRef(noteId), id: noteId, reviewerNotes: note.reviewerNotes };
		},
	);

	// ---------------------------------------------------------------------------
	// Review decisions: only when config.mcp.allowReviewDecisions is true
	// ---------------------------------------------------------------------------

	if (allowReviewDecisions) {
		registerTool(
			"approve_proposal",
			DECISION_TOOL,
			"Approve Proposal",
			"Applies a pending proposal to the knowledge graph, exactly like Approve in the HITL UI: type suggestions in it become approved schema types, and the proposal is removed. Use it only when the user explicitly asks to approve this proposal; review it with get_proposal first. Optionally approve edited records instead of the stored ones.",
			{
				ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
				reviewer: z.string().min(1).describe("The person approving (the user)."),
				records: z.string().optional().describe(`Edited records to approve instead of the stored ones: ${RECORD_BLOCK}.`),
			},
			async ({ ref, reviewer, records }) => {
				const noteId = await hitlService.resolveRef(ref);
				const { storedGraph } = await hitlService.approve({ noteId, reviewedBy: reviewer, llmResponse: records });
				console.error(`[mcp] Approved ${hitlShortRef(noteId)} (${noteId}) for ${reviewer}.`);
				return {
					status: "approved",
					ref: hitlShortRef(noteId),
					id: noteId,
					reviewer,
					nodeIds: storedGraph.nodes.map((node) => node.id),
					relationIds: storedGraph.relations.map((relation) => relation.id),
					deletedNodeIds: storedGraph.deletedNodeIds,
					deletedRelationIds: storedGraph.deletedRelationIds,
				};
			},
		);

		registerTool(
			"reject_proposal",
			DECISION_TOOL,
			"Reject Proposal",
			"Deletes a pending proposal without changing the graph, like Reject in the HITL UI. This cannot be undone. Use it only when the user explicitly asks to reject this proposal.",
			{
				ref: z.string().describe("Proposal id (hitl:...) or short ref such as #d964db."),
				reviewer: z.string().min(1).describe("The person rejecting (the user)."),
				reason: z.string().min(1).describe("Why it is rejected (logged; MindMesh keeps no proposal history yet)."),
			},
			async ({ ref, reviewer, reason }) => {
				const noteId = await hitlService.resolveRef(ref);
				await hitlService.reject({ noteId });
				console.error(`[mcp] Rejected ${hitlShortRef(noteId)} (${noteId}) for ${reviewer}: ${reason}`);
				return { status: "rejected", ref: hitlShortRef(noteId), id: noteId, reviewer, reason };
			},
		);
	}

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
			description: "Editable MindMesh graph schema (approved node types, relationship types, property descriptors).",
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

	return server;
}

// ---------------------------------------------------------------------------
// Startup / shutdown
// ---------------------------------------------------------------------------

async function main() {
	// stdout carries the MCP protocol; anything else printed there would corrupt it. Services log steps with
	// console.log, so all console output goes to stderr in this process.
	console.log = (...args) => console.error(...args);
	console.info = (...args) => console.error(...args);

	const services = createMindMesh(getConfig(), { withLlm: false });
	const server = createMcpServer(services);

	async function shutdown() {
		try {
			await services.close();
		} catch {}
		process.exit(0);
	}

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	const transport = new StdioServerTransport();
	await server.connect(transport);
}

if (isMainModule(import.meta.url)) {
	await main();
}
