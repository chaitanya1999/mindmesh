import crypto from "node:crypto";
import { GraphWriteService } from "../graph/graphWriteService.js";
import { formatGraphRecords, normalizeGraphPayload, parseGraphExtraction, toSnakeCase } from "../ingestion/graphPayload.js";
import { resolveGraphPayload } from "../ingestion/graphResolution.js";
import { countReviewSignals, reviewReasons } from "../ingestion/reviewSignals.js";
import { createDebugLogger, errorDetails, logStep } from "../logging/debugLogger.js";
import { buildApprovalSchema, loadGraphSchema, mergeSchemaTypes } from "../schema/graphSchema.js";

// Human-in-the-loop: decides whether a change may enter the graph, and keeps the proposals for the ones that
// need a reviewer. Owns the proposal lifecycle (submit, list, preview, reviewer notes, regenerate, approve,
// reject) and direct reviewer edits. Writing itself goes through GraphWriteService.
//
// Proposals are stored as pipe-delimited records (the extraction format) in the vector store's HITL
// collection; reads return both that text (`llmResponse`) and the parsed records (`records`).

const PREVIEW_NOTE_LIMIT = 500;

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function requireString(value, fieldName) {
	const text = String(value ?? "").trim();
	if (!text) {
		throw httpError(`${fieldName} is required.`, 400);
	}

	return text;
}

function requireUserName(value) {
	const userName = String(value ?? "").trim();
	if (!userName) {
		throw httpError("User name is required.", 400);
	}

	return userName;
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

function graphNameFromId(id) {
	return String(id ?? "").replace(/^node:/, "");
}

function createHitlNoteId() {
	return `hitl:${Date.now().toString(36)}:${crypto.randomBytes(6).toString("hex")}`;
}

function countSchemaSuggestions(schemaSuggestions = {}) {
	return (schemaSuggestions.nodeTypes?.length ?? 0) + (schemaSuggestions.relationshipTypes?.length ?? 0);
}

function recordCount(graph) {
	return (graph.nodes?.length ?? 0)
		+ (graph.relations?.length ?? 0)
		+ (graph.nodeDeletes?.length ?? 0)
		+ (graph.relationDeletes?.length ?? 0)
		+ (graph.schemaSuggestions?.nodeTypes?.length ?? 0)
		+ (graph.schemaSuggestions?.relationshipTypes?.length ?? 0);
}

function schemaViolationError(graphPayload) {
	const messages = (graphPayload.schemaViolations ?? []).map((violation) => violation.message);
	const error = httpError(`Schema validation failed: ${messages.join("; ")}`, 400);
	error.schemaViolations = graphPayload.schemaViolations ?? [];
	return error;
}

// The structured form of a proposal, returned next to its pipe-delimited text.
function proposalRecords(graphPayload) {
	return {
		nodes: graphPayload.nodes,
		relations: graphPayload.relations,
		nodeDeletes: graphPayload.nodeDeletes,
		relationDeletes: graphPayload.relationDeletes,
		schemaSuggestions: graphPayload.schemaSuggestions,
		schemaViolations: graphPayload.schemaViolations ?? [],
		schemaWarnings: graphPayload.schemaWarnings ?? [],
	};
}

function nodeFields(node) {
	return { name: node.name, label: node.label, type: node.type, description: node.description ?? "" };
}

function relationFields(relation) {
	return {
		relation: relation.relation,
		sourceId: relation.sourceId,
		targetId: relation.targetId,
		information: relation.information ?? "",
		description: relation.description ?? "",
	};
}

// The records of a proposal that would touch one node: its own records and relations that use it.
function changesTouchingNode(graphPayload, nodeId) {
	const touches = (relation) => relation.sourceId === nodeId || relation.targetId === nodeId;
	return [
		...graphPayload.nodes.filter((node) => node.id === nodeId).map((node) => ({ kind: "node", operation: node.operation, proposed: nodeFields(node) })),
		...graphPayload.nodeDeletes.filter((node) => node.id === nodeId).map(() => ({ kind: "node", operation: "delete" })),
		...graphPayload.relations.filter(touches).map((relation) => ({ kind: "relation", operation: relation.operation, id: relation.id, proposed: relationFields(relation) })),
		...graphPayload.relationDeletes.filter(touches).map((relation) => ({ kind: "relation", operation: "delete", id: relation.id, proposed: relationFields(relation) })),
	];
}

// List filters. signal: "ambiguity" | "contradiction"; operation: "create" | "update" | "delete";
// author / source: case-insensitive exact match.
function matchesProposalFilter(item, { signal, operation, author, source }) {
	if (signal === "ambiguity" && !(item.ambiguityCount > 0)) {
		return false;
	}
	if (signal === "contradiction" && !(item.contradictionCount > 0)) {
		return false;
	}
	if (operation) {
		const records = item.records ?? { nodes: [], relations: [], nodeDeletes: [], relationDeletes: [] };
		const upserts = [...records.nodes, ...records.relations];
		const found = operation === "delete"
			? records.nodeDeletes.length + records.relationDeletes.length > 0
			// Legacy NODE / RELATION records parse as "upsert"; they count as creates.
			: upserts.some((record) => (record.operation === "upsert" ? "create" : record.operation) === operation);
		if (!found) {
			return false;
		}
	}
	const same = (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
	if (author && !same(item.userName, author)) {
		return false;
	}
	if (source && !same(item.source, source)) {
		return false;
	}

	return true;
}

// Manual and reviewer edits arrive as form fields.

function normalizeManualNode(body, existingId = "") {
	// A node's id is node:<name>, so the name of an existing node is fixed; only the label is free text.
	const existingName = existingId.replace(/^node:/, "");
	if (existingName && body?.name && toSnakeCase(body.name) !== existingName) {
		throw httpError(`Node names are permanent identifiers (${existingId}); renaming is not supported. Change the label instead.`, 400);
	}
	const name = existingName || toSnakeCase(body?.name || body?.label);
	if (!name) {
		throw httpError("Node name or label is required.", 400);
	}

	return {
		id: existingId || body?.id || `node:${name}`,
		label: String(body?.label || labelFromName(name)).trim(),
		name,
		type: requireString(toSnakeCase(body?.type), "Node type"),
		description: String(body?.description ?? "").trim(),
	};
}

// Accepts a node id ("node:ekyc_screen") or a bare name typed into the relation form.
function manualNodeId(value, fieldName) {
	const text = requireString(value, fieldName);
	return text.startsWith("node:") ? text : `node:${toSnakeCase(text)}`;
}

function normalizeManualRelation(body, existingId = "") {
	const sourceId = manualNodeId(body?.sourceId, "sourceId");
	const targetId = manualNodeId(body?.targetId, "targetId");
	const relation = requireString(toSnakeCase(body?.relation), "Relation type");

	return {
		id: existingId || body?.id || `rel:${stableHash(`${sourceId}:${relation}:${targetId}`)}`,
		sourceId,
		targetId,
		relation,
		information: String(body?.information ?? "").trim(),
		description: String(body?.description ?? "").trim(),
	};
}

// Graph previews: a proposal merged over the approved graph, with markers for the review UI.

function pendingMarker(note, operation) {
	return {
		pendingHitl: true,
		pendingOperation: operation || "upsert",
		hitlNoteId: note.id,
		ingestedBy: note.userName,
	};
}

// The approved DB version of a graph item, kept so reviewers can compare it with the pending proposal.
function approvedSnapshot(existing) {
	if (!existing) {
		return undefined;
	}

	return existing.pendingHitl ? existing.approved : existing;
}

function mergePendingNode(nodeMap, node, note, operation) {
	const existing = nodeMap.get(node.id);
	nodeMap.set(node.id, {
		...(existing ?? {}),
		...node,
		...pendingMarker(note, operation || node.operation),
		approved: approvedSnapshot(existing),
	});
}

function mergePendingRelation(relationMap, relation, note, operation) {
	const existing = relationMap.get(relation.id);
	relationMap.set(relation.id, {
		...(existing ?? {}),
		...relation,
		...pendingMarker(note, operation || relation.operation),
		approved: approvedSnapshot(existing),
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
		type: "",
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
			type: "",
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

// Readable source -> relation -> target rows for API responses.
export function buildTriplets(graph) {
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

export class HitlService {
	// `schemaConfig` locates the schema file (a config with `schema.path`, or `{ schema: { path } }`).
	constructor({ ingestionService, graphStore, vectorStore, graphWriter = null, schemaConfig, logging = null }) {
		this.ingestionService = ingestionService;
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
		this.graphWriter = graphWriter ?? new GraphWriteService({ graphStore, vectorStore });
		this.schemaConfig = schemaConfig;
		this.logging = logging;
	}

	get mode() {
		return this.ingestionService.ingestion.mode;
	}

	get defaultUserName() {
		return this.ingestionService.ingestion.hitlDefaultUserName;
	}

	currentSchema() {
		return loadGraphSchema(this.schemaConfig);
	}

	requireProposalStore() {
		if (
			typeof this.vectorStore.listHitlNotes !== "function"
			|| typeof this.vectorStore.getHitlNote !== "function"
			|| typeof this.vectorStore.deleteHitlNotes !== "function"
		) {
			throw httpError("The configured vector store does not support HITL notes.", 501);
		}
	}

	requireDirectEditSupport() {
		if (
			typeof this.graphStore.upsertNode !== "function"
			|| typeof this.graphStore.deleteNode !== "function"
			|| typeof this.graphStore.upsertRelation !== "function"
			|| typeof this.graphStore.deleteRelation !== "function"
		) {
			throw httpError("The configured graph store does not support direct HITL CRUD.", 501);
		}
	}

	// Parses proposal text and normalizes it against the current schema (graph-blind; see resolveGraphPayload).
	parseRecords(llmResponse) {
		try {
			const graphSchema = this.currentSchema();
			const graphPayload = normalizeGraphPayload(parseGraphExtraction(llmResponse), { schema: graphSchema });
			return { graphSchema, graphPayload };
		} catch (error) {
			error.status = 400;
			throw error;
		}
	}

	// Card fields for the review list. Signal counts come from the current text, so edits are reflected.
	noteSummary(note) {
		let reviewSignals = {
			ambiguityCount: Number(note.ambiguityCount ?? note.metadata?.ambiguityCount ?? 0),
			contradictionCount: Number(note.contradictionCount ?? note.metadata?.contradictionCount ?? 0),
		};
		let records = null;
		if (note.llmResponse) {
			try {
				const { graphPayload } = this.parseRecords(note.llmResponse);
				reviewSignals = countReviewSignals(graphPayload);
				records = proposalRecords(graphPayload);
			} catch {
				// keep the stored counts
			}
		}

		return {
			summary: {
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
				reviewerNotes: note.reviewerNotes ?? "",
				regenerated: Boolean(note.regenerated),
				regeneratedBy: note.regeneratedBy ?? "",
				regeneratedAt: note.regeneratedAt ?? "",
				regenerationOrigin: note.regenerationOrigin ?? "",
			},
			records,
		};
	}

	noteDetail(note) {
		const { summary, records } = this.noteSummary(note);
		return {
			...summary,
			userInput: note.userInput,
			prompt: note.userInput,
			llmResponse: note.llmResponse,
			records,
		};
	}

	// ---------------------------------------------------------------------------------------------------
	// Reading proposals
	// ---------------------------------------------------------------------------------------------------

	async getProposal(noteId) {
		this.requireProposalStore();
		const note = await this.vectorStore.getHitlNote(noteId);
		if (!note) {
			throw httpError(`HITL note not found: ${noteId}`, 404);
		}

		return note;
	}

	// Accepts a full note id ("hitl:muzxnk3c:d964dbbae577") or a short reference such as "#d964db".
	async resolveRef(reference) {
		const value = String(reference ?? "").trim();
		if (value.startsWith("hitl:")) {
			return value;
		}

		const suffix = value.replace(/^#/, "").toLowerCase();
		if (suffix.length < 4) {
			throw httpError("A HITL reference needs at least 4 characters, for example #d964db.", 400);
		}

		const notes = await this.vectorStore.listHitlNotes({ status: "pending", limit: 0 });
		const matches = notes.filter((note) => String(note.id).split(":").pop().startsWith(suffix));
		if (matches.length !== 1) {
			throw httpError(matches.length === 0
				? `No pending HITL proposal matches "${value}".`
				: `"${value}" matches ${matches.length} pending HITL proposals; use more characters or the full id.`, 400);
		}

		return matches[0].id;
	}

	listItem(note) {
		const { summary, records } = this.noteSummary(note);
		return { ...summary, llmResponse: note.llmResponse, records };
	}

	// Oldest first. llmResponse lets the review list show per-operation counts parsed exactly like the detail view.
	// Filters (signal, operation, author, source) apply to every pending proposal before the page is cut.
	async listProposals({ limit, filter = {} }) {
		this.requireProposalStore();
		if (!Object.values(filter).some(Boolean)) {
			const { notes, total } = await this.vectorStore.listHitlNotePage({ status: "pending", limit });
			return { notes: notes.map((note) => this.listItem(note)), total };
		}

		const all = await this.vectorStore.listHitlNotes({ status: "pending", limit: 0 });
		const matching = all.map((note) => this.listItem(note)).filter((item) => matchesProposalFilter(item, filter));
		return { notes: matching.slice(0, limit), total: matching.length };
	}

	// Admin maintenance -----------------------------------------------------------------------------------

	// Every pending proposal with its stored fields, for the admin backup (proposals cannot be rebuilt).
	async exportProposals() {
		this.requireProposalStore();
		const notes = await this.vectorStore.listHitlNotes({ status: "pending", limit: 0 });
		return notes.map((note) => ({
			id: note.id,
			status: note.status,
			userName: note.userName,
			source: note.source,
			createdAt: note.createdAt,
			userInput: note.userInput,
			llmResponse: note.llmResponse,
			reviewerNotes: note.reviewerNotes,
			regenerated: note.regenerated,
			regeneratedBy: note.regeneratedBy,
			regeneratedAt: note.regeneratedAt,
			regenerationOrigin: note.regenerationOrigin,
		}));
	}

	// Pending proposals matching every given filter: author / source (case-insensitive exact), olderThanDays,
	// text (case-insensitive, in the input or the records). At least one filter is required.
	async findProposalsForCleanup({ author = "", source = "", olderThanDays, text = "" } = {}) {
		this.requireProposalStore();
		const hasAge = olderThanDays !== undefined && olderThanDays !== null && olderThanDays !== "";
		if (!author && !source && !text && !hasAge) {
			throw httpError("Give at least one cleanup filter (author, source, olderThanDays, or text).", 400);
		}
		const cutoff = hasAge ? Date.now() - Number(olderThanDays) * 24 * 60 * 60 * 1000 : null;
		const same = (left, right) => String(left ?? "").toLowerCase() === String(right ?? "").toLowerCase();
		const needle = String(text).toLowerCase();
		const notes = await this.vectorStore.listHitlNotes({ status: "pending", limit: 0 });

		return notes.filter((note) => (!author || same(note.userName, author))
			&& (!source || same(note.source, source))
			&& (cutoff === null || (Date.parse(note.createdAt || "") || 0) < cutoff)
			&& (!needle || `${note.userInput}\n${note.llmResponse}`.toLowerCase().includes(needle)))
			.map((note) => this.noteSummary(note).summary);
	}

	async deleteProposals(noteIds) {
		this.requireProposalStore();
		await this.vectorStore.deleteHitlNotes(noteIds);
		return noteIds.length;
	}

	// Drops the whole proposal collection (admin wipe).
	async clearAllProposals() {
		const count = (await this.vectorStore.listHitlNotePage({ status: "", limit: 1 })).total;
		const clearedCollections = await this.vectorStore.clearHitlCollection();
		return { deletedProposals: count, clearedCollections };
	}

	// Pending proposals ranked by meaning (vector search over the proposal collection). Always unverified.
	async searchProposals({ query, limit = 10 }) {
		this.requireProposalStore();
		const notes = await this.vectorStore.queryHitlNotes(query, limit);
		return notes.map((note) => ({ ...this.listItem(note), distance: note.distance, verified: false }));
	}

	// Pending changes that would touch one node: its own records and relations that use it.
	async proposalsTouchingNode(nodeId) {
		this.requireProposalStore();
		const notes = await this.vectorStore.listHitlNotes({ status: "pending", limit: PREVIEW_NOTE_LIMIT });
		const touching = [];
		for (const note of notes) {
			let graphPayload;
			try {
				({ graphPayload } = this.parseRecords(note.llmResponse));
			} catch {
				continue;
			}
			const changes = changesTouchingNode(graphPayload, nodeId);
			if (changes.length > 0) {
				touching.push({ id: note.id, author: note.userName, createdAt: note.createdAt, verified: false, changes });
			}
		}

		return touching;
	}

	// One proposal for review: its detail, plus every record next to the current graph value it would change.
	async getProposalReview({ ref }) {
		const note = await this.getProposal(await this.resolveRef(ref));
		const proposal = this.noteDetail(note);
		const records = proposal.records ?? { nodes: [], relations: [], nodeDeletes: [], relationDeletes: [] };
		const currentNodes = new Map((await this.graphStore.getNodesByIds(
			[...records.nodes, ...records.nodeDeletes].map((record) => record.id),
		)).map((node) => [node.id, node]));
		const currentRelations = new Map((await this.graphStore.getRelationsByIds(
			[...records.relations, ...records.relationDeletes].map((record) => record.id),
		)).map((relation) => [relation.id, relation]));

		const changes = [
			...records.nodes.map((record) => ({
				kind: "node",
				operation: record.operation,
				id: record.id,
				proposed: nodeFields(record),
				current: currentNodes.has(record.id) ? nodeFields(currentNodes.get(record.id)) : null,
				reviewSignal: record.metadata || "",
			})),
			...records.nodeDeletes.map((record) => ({
				kind: "node",
				operation: "delete",
				id: record.id,
				proposed: null,
				current: currentNodes.has(record.id) ? nodeFields(currentNodes.get(record.id)) : null,
				reviewSignal: record.metadata || "",
			})),
			...records.relations.map((record) => ({
				kind: "relation",
				operation: record.operation,
				id: record.id,
				proposed: relationFields(record),
				current: currentRelations.has(record.id) ? relationFields(currentRelations.get(record.id)) : null,
				reviewSignal: record.metadata || "",
			})),
			...records.relationDeletes.map((record) => ({
				kind: "relation",
				operation: "delete",
				id: record.id,
				proposed: null,
				current: currentRelations.has(record.id) ? relationFields(currentRelations.get(record.id)) : null,
				reviewSignal: record.metadata || "",
			})),
		];

		return { proposal, changes };
	}

	// One proposal merged over the approved graph around it. `llmResponse` previews unsaved edits.
	async previewProposal({ noteId, depth = 2, llmResponse }) {
		const note = await this.getProposal(noteId);
		const text = llmResponse === undefined ? note.llmResponse : requireString(llmResponse, "llmResponse");
		const { graphPayload } = this.parseRecords(text);
		const pendingNodeIds = new Set();
		for (const node of graphPayload.nodes) {
			pendingNodeIds.add(node.id);
		}
		for (const nodeDelete of graphPayload.nodeDeletes) {
			pendingNodeIds.add(nodeDelete.id);
		}
		for (const item of [...graphPayload.relations, ...graphPayload.relationDeletes]) {
			pendingNodeIds.add(item.sourceId);
			pendingNodeIds.add(item.targetId);
		}

		const approvedContext = pendingNodeIds.size > 0
			? await this.graphStore.expandFromNodes([...pendingNodeIds], depth)
			: { nodes: [], relations: [] };

		return {
			...mergeHitlPayloadIntoGraph(approvedContext, note, graphPayload),
			depth,
			note: this.noteSummary(note).summary,
			schema: this.currentSchema(),
		};
	}

	// Every pending proposal merged over the approved graph preview.
	async previewAll(limit) {
		this.requireProposalStore();
		const approvedGraph = await this.graphStore.getGraphPreview(limit);
		const notes = await this.vectorStore.listHitlNotes({ status: "pending", limit: PREVIEW_NOTE_LIMIT });
		let previewGraph = {
			nodes: approvedGraph.nodes ?? [],
			relations: approvedGraph.relations ?? [],
		};
		const warnings = [];
		for (const note of notes) {
			try {
				const { graphPayload } = this.parseRecords(note.llmResponse);
				previewGraph = mergeHitlPayloadIntoGraph(previewGraph, note, graphPayload);
			} catch (error) {
				warnings.push({ id: note.id, message: error.message });
			}
		}

		return {
			...previewGraph,
			limit,
			pendingNotes: notes.map((note) => this.noteSummary(note).summary),
			warnings,
			schema: this.currentSchema(),
		};
	}

	// ---------------------------------------------------------------------------------------------------
	// Submitting extractions
	// ---------------------------------------------------------------------------------------------------

	// Text ingestion: IngestionService extracts, then submit() decides between applying and proposing.
	async ingestText({ text, source, userName }) {
		return this.ingestionService.ingestText({
			text,
			source,
			userName,
			submit: (prepared) => this.submit(prepared),
		});
	}

	// Records an external agent extracted (MCP apply-ingestion). Prepared exactly like a text ingestion,
	// including reconciliation with pending proposals.
	async submitRecords({ graphRecords, text, userName, source, debugLogger }) {
		const graphSchema = this.currentSchema();
		const pendingHitl = await this.ingestionService.retrievePendingHitlContext({ text, graphSchema });
		const { graphPayload, proposalText } = await this.ingestionService.prepareExtraction({
			extractedGraph: parseGraphExtraction(graphRecords),
			rawResponse: graphRecords,
			pendingHitl,
			graphSchema,
		});

		return this.submit({ text, source, userName, graphPayload, proposalText, debugLogger });
	}

	// Auto mode applies only clean creates and updates; hitl mode, or any review reason, stores a proposal.
	async submit({ text, source, userName, graphPayload, proposalText, debugLogger = null, startedAt = Date.now() }) {
		const pendingReasons = reviewReasons(graphPayload);
		if (this.mode === "hitl" || pendingReasons.length > 0) {
			logStep(debugLogger, this.mode === "hitl"
				? "[ingest] HITL mode enabled; storing pending proposal in vector store."
				: `[ingest] Review required (${pendingReasons.join(", ")}); forcing HITL proposal instead of applying graph mutations.`);
			const pendingProposal = await this.storeProposal({
				text,
				source,
				userName: userName || this.defaultUserName,
				proposalText,
				graphPayload,
				debugLogger,
			});
			logStep(debugLogger, `[ingest] Stored HITL proposal ${pendingProposal.hitlNote.id} in ${Date.now() - startedAt} ms. No graph mutations were applied.`);
			return pendingProposal;
		}

		logStep(debugLogger, "[ingest] Applying graph mutations to graph store and vector index...");
		const storedGraph = await this.graphWriter.applyPayload(graphPayload, { debugLogger });
		debugLogger?.json("Applied Graph Mutations", {
			upsertedNodes: storedGraph.nodes.length,
			upsertedRelations: storedGraph.relations.length,
			deletedNodeIds: storedGraph.deletedNodeIds,
			deletedRelationIds: storedGraph.deletedRelationIds,
		});
		logStep(
			debugLogger,
			`[ingest] Applied mutations in ${Date.now() - startedAt} ms: upserted ${storedGraph.nodes.length} node(s), upserted ${storedGraph.relations.length} relation(s), deleted ${storedGraph.deletedNodeIds.length} node(s), deleted ${storedGraph.deletedRelationIds.length} relation(s).`,
		);
		return storedGraph;
	}

	async storeProposal({ text, source, userName, proposalText, graphPayload, debugLogger = null }) {
		if (typeof this.vectorStore.upsertHitlNote !== "function") {
			throw new Error("The configured vector store does not support HITL notes.");
		}

		const reviewSignals = countReviewSignals(graphPayload);
		const counts = {
			nodeCount: graphPayload.nodes.length,
			relationCount: graphPayload.relations.length,
			nodeDeleteCount: graphPayload.nodeDeletes.length,
			relationDeleteCount: graphPayload.relationDeletes.length,
			schemaSuggestionCount: countSchemaSuggestions(graphPayload.schemaSuggestions),
			ambiguityCount: reviewSignals.ambiguityCount,
			contradictionCount: reviewSignals.contradictionCount,
		};
		const hitlNote = await this.vectorStore.upsertHitlNote({
			id: createHitlNoteId(),
			status: "pending",
			userName: userName || this.defaultUserName,
			source,
			createdAt: new Date().toISOString(),
			userInput: text,
			llmResponse: proposalText,
			...counts,
		});

		debugLogger?.json("Stored HITL Proposal", {
			id: hitlNote.id,
			collection: hitlNote.collection,
			metadata: hitlNote.metadata,
			...counts,
		});
		debugLogger?.section("Stored HITL Chroma Document", hitlNote.document);

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
			schemaSuggestions: graphPayload.schemaSuggestions,
			schemaViolations: graphPayload.schemaViolations ?? [],
			schemaWarnings: graphPayload.schemaWarnings,
			reviewReasons: reviewReasons(graphPayload),
		};
	}

	// ---------------------------------------------------------------------------------------------------
	// Reviewing proposals
	// ---------------------------------------------------------------------------------------------------

	async saveReviewerNotes({ noteId, reviewerNotes }) {
		const note = await this.getProposal(noteId);
		await this.vectorStore.upsertHitlNote({
			...note,
			reviewerNotes: String(reviewerNotes ?? "").trim(),
		});

		return this.getProposal(noteId);
	}

	// Approves the proposal text, or the reviewer's edited text. Type suggestions in it count as approved;
	// they are written to the schema only after the graph apply succeeds.
	async approve({ noteId, reviewedBy, llmResponse }) {
		const note = await this.getProposal(noteId);
		requireString(reviewedBy, "reviewedBy");
		const text = requireString(llmResponse ?? note.llmResponse, "llmResponse");

		const extractedGraph = parseGraphExtraction(text);
		const baseSchema = this.currentSchema();
		const approvalSchema = buildApprovalSchema(baseSchema, extractedGraph.schemaSuggestions);
		const graphPayload = normalizeGraphPayload(extractedGraph, { schema: approvalSchema });
		if ((graphPayload.schemaViolations?.length ?? 0) > 0) {
			throw schemaViolationError(graphPayload);
		}

		// Also checks relation endpoints against the graph.
		const storedGraph = await this.graphWriter.applyPayload(graphPayload);
		mergeSchemaTypes(baseSchema, extractedGraph.schemaSuggestions);
		await this.vectorStore.deleteHitlNotes([note.id]);

		return { note, storedGraph, graphPayload };
	}

	async reject({ noteId }) {
		const note = await this.getProposal(noteId);
		await this.vectorStore.deleteHitlNotes([note.id]);
		return note;
	}

	// UI regeneration: re-runs the extraction on the original input with the reviewer notes and the current
	// draft as baseline, then overwrites the proposal. The note is untouched if anything fails.
	async regenerate({ noteId, reviewerNotes, previousProposal, regeneratedBy }) {
		const note = await this.getProposal(noteId);
		requireString(regeneratedBy, "reviewedBy");
		const startedAt = Date.now();
		const debugLogger = createDebugLogger({
			...this.logging,
			name: "ingest-regenerate",
			scope: "ingest",
		});

		try {
			const notes = String(reviewerNotes ?? note.reviewerNotes ?? "").trim();
			const baseline = String(previousProposal || note.llmResponse || "").trim();
			logStep(debugLogger, `[regenerate] Regenerating HITL proposal ${note.id} for ${regeneratedBy || "unknown"}.`);

			const { graphSchema, existingContext, extractionPrompt } = await this.ingestionService.buildHitlRegenerationPrompt({
				note,
				reviewerNotes: notes,
				previousProposal: baseline,
			});
			debugLogger.section("Reviewer Notes", notes);
			debugLogger.section("Rendered Regeneration Prompt", extractionPrompt);

			logStep(debugLogger, "[regenerate] Sending regeneration prompt to LLM...");
			const { extractedGraph, rawResponse } = await this.ingestionService.extractGraphWithRawResponse({
				text: note.userInput,
				extractionPrompt,
				debugLogger,
			});
			debugLogger.section("Raw Regeneration Response", rawResponse);

			const result = await this.storeRegeneration({
				note,
				rawResponse,
				extractedGraph,
				existingContext,
				graphSchema,
				reviewerNotes: notes,
				regeneratedBy,
				origin: "ui",
			});
			logStep(debugLogger, `[regenerate] Overwrote HITL proposal ${note.id} in ${Date.now() - startedAt} ms.`);
			return result;
		} catch (error) {
			logStep(debugLogger, `[regenerate] Failed after ${Date.now() - startedAt} ms: ${error?.message ?? String(error)}`);
			debugLogger.json("Regeneration Error", errorDetails(error));
			throw error;
		}
	}

	// Overwrites the note's proposal (UI regeneration, or MCP apply-regeneration with an agent's records).
	// Parsing happens first, so an unparseable response leaves the note untouched.
	async storeRegeneration({
		note,
		rawResponse,
		extractedGraph = null,
		existingContext = null,
		graphSchema = null,
		reviewerNotes,
		regeneratedBy,
		origin,
	}) {
		const schema = graphSchema ?? this.currentSchema();
		const parsedGraph = extractedGraph ?? parseGraphExtraction(rawResponse);
		// The parser returns an empty graph for unparseable text; never overwrite a proposal with nothing.
		if (recordCount(parsedGraph) === 0) {
			throw httpError("The regenerated response contains no graph records, so the proposal was not changed.", 400);
		}
		const pendingHitl = existingContext?.pendingHitl ?? await this.ingestionService.retrievePendingHitlContext({
			text: note.userInput,
			graphSchema: schema,
			excludeNoteIds: [note.id],
		});
		const { graphPayload, proposalText } = await this.ingestionService.prepareExtraction({
			extractedGraph: parsedGraph,
			rawResponse,
			pendingHitl,
			graphSchema: schema,
		});
		const reviewSignals = countReviewSignals(graphPayload);

		await this.vectorStore.upsertHitlNote({
			...note,
			llmResponse: proposalText,
			nodeCount: graphPayload.nodes.length,
			relationCount: graphPayload.relations.length,
			nodeDeleteCount: graphPayload.nodeDeletes.length,
			relationDeleteCount: graphPayload.relationDeletes.length,
			schemaSuggestionCount: countSchemaSuggestions(graphPayload.schemaSuggestions),
			ambiguityCount: reviewSignals.ambiguityCount,
			contradictionCount: reviewSignals.contradictionCount,
			reviewerNotes: String(reviewerNotes ?? "").trim(),
			regenerated: true,
			regeneratedBy: regeneratedBy || "unknown",
			regeneratedAt: new Date().toISOString(),
			regenerationOrigin: origin,
		});

		return {
			note: await this.getProposal(note.id),
			graphPayload,
		};
	}

	// ---------------------------------------------------------------------------------------------------
	// Manual proposals (main page) and direct reviewer edits (/hitl)
	// ---------------------------------------------------------------------------------------------------

	// Stores hand-made records as a proposal, checked against the graph like any extraction.
	async proposeRecords({ records, userInput, userName }) {
		this.requireProposalStore();
		const requestedText = formatGraphRecords(records);
		const { graphPayload: parsedPayload } = this.parseRecords(requestedText);
		const { graphPayload, changed } = await resolveGraphPayload(parsedPayload, this.graphStore);
		const proposal = await this.storeProposal({
			text: userInput,
			source: "manual",
			userName,
			proposalText: changed ? formatGraphRecords(graphPayload) : requestedText,
			graphPayload,
		});

		return { ...proposal, triplets: buildTriplets(graphPayload) };
	}

	// A relation implies both nodes exist; a typo in the relation form must not create a node.
	async requireExistingEndpoints(relation) {
		const endpointIds = [...new Set([relation.sourceId, relation.targetId])];
		const existingIds = new Set(await this.graphStore.getExistingNodeIds(endpointIds));
		const missingIds = endpointIds.filter((id) => !existingIds.has(id));
		if (missingIds.length > 0) {
			throw httpError(`Relation endpoints must be existing nodes. Not found: ${missingIds.join(", ")}.`, 400);
		}
	}

	async proposeNode({ body, nodeId = "", userName }) {
		const node = normalizeManualNode(body, nodeId);
		const user = requireUserName(userName);
		return this.proposeRecords({
			records: { nodes: [{ ...node, operation: nodeId ? "update" : "create" }] },
			userInput: `${user} requested node ${nodeId ? "update" : "creation"} for ${node.label}.`,
			userName: user,
		});
	}

	async proposeNodeDelete({ nodeId, userName }) {
		const user = requireUserName(userName);
		const existingNode = await this.graphStore.getNode(nodeId);
		const nodeName = graphNameFromId(nodeId);
		return this.proposeRecords({
			records: { nodeDeletes: [{ name: nodeName }] },
			userInput: `${user} requested node deletion for ${existingNode?.label || nodeName}.`,
			userName: user,
		});
	}

	// An edit of an existing relation is proposed as a delete of the old relation plus a create of the new one.
	async proposeRelation({ body, relationId = "", userName }) {
		const relation = normalizeManualRelation(body, relationId);
		const user = requireUserName(userName);
		await this.requireExistingEndpoints(relation);
		const existingRelation = relationId ? await this.graphStore.getRelation(relationId) : null;
		const records = existingRelation
			? { relationDeletes: [existingRelation], relations: [{ ...relation, operation: "create" }] }
			: { relations: [{ ...relation, operation: relationId ? "update" : "create" }] };
		return this.proposeRecords({
			records,
			userInput: `${user} requested relation ${relationId ? "update" : "creation"} for ${relation.relation}.`,
			userName: user,
		});
	}

	async proposeRelationDelete({ relationId, userName }) {
		const user = requireUserName(userName);
		const relation = await this.graphStore.getRelation(relationId);
		if (!relation) {
			throw httpError("Relation was not found.", 404);
		}
		return this.proposeRecords({
			records: { relationDeletes: [relation] },
			userInput: `${user} requested relation deletion for ${relation.relation}.`,
			userName: user,
		});
	}

	// A reviewer's direct edit is written at once when it fits the schema; otherwise it becomes a proposal,
	// so a new type can still be approved through HITL. Returns { pending } or { node } / { relation }.
	async proposalIfSchemaInvalid({ records, userInput, reviewedBy }) {
		const { graphPayload } = this.parseRecords(formatGraphRecords(records));
		if ((graphPayload.schemaViolations?.length ?? 0) === 0) {
			return null;
		}

		return this.proposeRecords({ records, userInput, userName: reviewedBy });
	}

	async editNode({ body, nodeId = "", reviewedBy }) {
		this.requireDirectEditSupport();
		const reviewer = requireString(reviewedBy, "reviewedBy");
		const node = normalizeManualNode(body, nodeId);
		const pending = await this.proposalIfSchemaInvalid({
			records: { nodes: [{ ...node, operation: nodeId ? "update" : "create" }] },
			userInput: `${reviewer} requested node ${nodeId ? "update" : "creation"} for ${node.label}.`,
			reviewedBy: reviewer,
		});
		if (pending) {
			return { pending };
		}

		return { node: await this.graphWriter.writeNode(node) };
	}

	async deleteNode({ nodeId, reviewedBy }) {
		this.requireDirectEditSupport();
		requireString(reviewedBy, "reviewedBy");
		return this.graphWriter.deleteNode(nodeId);
	}

	// The id is recomputed from source, relation and target, so a changed relation or endpoint gets its
	// canonical id; the old relation is replaced in the same write.
	async editRelation({ body, relationId = "", reviewedBy }) {
		this.requireDirectEditSupport();
		const reviewer = requireString(reviewedBy, "reviewedBy");
		const relation = normalizeManualRelation(body);
		await this.requireExistingEndpoints(relation);
		const pending = await this.proposalIfSchemaInvalid({
			records: { relations: [{ ...relation, operation: relationId ? "update" : "create" }] },
			userInput: `${reviewer} requested relation ${relationId ? "update" : "creation"} for ${relation.relation}.`,
			reviewedBy: reviewer,
		});
		if (pending) {
			return { pending };
		}

		return { relation: await this.graphWriter.writeRelation(relation, { replaceId: relationId }) };
	}

	async deleteRelation({ relationId, reviewedBy }) {
		this.requireDirectEditSupport();
		requireString(reviewedBy, "reviewedBy");
		return this.graphWriter.deleteRelation(relationId);
	}
}
