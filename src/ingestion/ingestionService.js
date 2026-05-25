import crypto from "node:crypto";
import { normalizeGraphPayload, parseGraphExtraction, toSnakeCase, encodePipelineField } from "./graphPayload.js";
import { countReviewSignals } from "./reviewSignals.js";
import { createDebugLogger } from "../logging/debugLogger.js";
import { buildExtractionPrompt } from "../prompts/promptRegistry.js";
import { formatExtractionGraphContext } from "../rag/graphContext.js";
import { loadGraphSchema, persistGraphSchemaSuggestions, promoteGraphSchemaSuggestions } from "../schema/graphSchema.js";

function previewText(value, maxLength = 180) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function logIngest(debugLogger, message) {
	console.log(message);
	debugLogger.log(message);
}

function errorDetails(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			status: error.status,
			code: error.code,
			cause: error.cause ? errorDetails(error.cause) : undefined,
		};
	}

	return {
		name: typeof error,
		message: String(error),
		value: error,
	};
}

function isNotFoundError(error) {
	return Number(error?.status) === 404 || /not found/i.test(String(error?.message ?? ""));
}

function normalizeIngestionMode(value) {
	const mode = String(value || "auto").trim().toLowerCase();
	return mode === "hitl" ? "hitl" : "auto";
}

function createHitlNoteId() {
	return `hitl:${Date.now().toString(36)}:${crypto.randomBytes(6).toString("hex")}`;
}

function countSchemaSuggestions(schemaSuggestions = {}) {
	return (schemaSuggestions.nodeTypes?.length ?? 0) + (schemaSuggestions.relationshipTypes?.length ?? 0);
}

function compact(value) {
	return String(value ?? "").trim();
}

function relationPhrase(relation) {
	return String(relation ?? "relates_to").replaceAll("_", " ");
}

function graphNameFromId(value) {
	return String(value ?? "").replace(/^node:/i, "");
}

function normalizeGraphName(value) {
	return toSnakeCase(graphNameFromId(value));
}

function pendingRelationKey(sourceName, relation, targetName) {
	return [
		normalizeGraphName(sourceName),
		toSnakeCase(relation || "relates_to") || "relates_to",
		normalizeGraphName(targetName),
	].join("|");
}

function nodeReference(node, fallbackId) {
	const id = node?.id || fallbackId;
	const label = node?.label || node?.name || id;
	return `[${id}] ${label}`;
}

function sentence(value) {
	const text = compact(value);
	if (!text) {
		return "";
	}

	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function addUniqueById(targetMap, item) {
	if (item?.id && !targetMap.has(item.id)) {
		targetMap.set(item.id, item);
	}
}

function pendingNoteLlmResponse(note) {
	return compact(note?.llmResponse)
		|| String(note?.document ?? "").split("LLM proposed graph mutations:").slice(1).join("LLM proposed graph mutations:").trim();
}

function formatPendingHitlContext({ notes = [], graph = { nodes: [], relations: [] }, nodeDeletes = [], relationDeletes = [] }) {
	const nodes = graph.nodes ?? [];
	const relations = graph.relations ?? [];
	if (nodes.length === 0 && relations.length === 0 && nodeDeletes.length === 0 && relationDeletes.length === 0) {
		return "";
	}

	const noteById = new Map(notes.map((note) => [note.id, note]));
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const nodeLines = nodes.map((node) => {
		const note = noteById.get(node.hitlNoteId);
		const details = [
			`name: ${node.name || node.id}`,
			`type: ${node.type || "concept"}`,
			`pending: ${node.operation || "upsert"}`,
			note?.userName ? `ingested by: ${note.userName}` : "",
		].filter(Boolean);
		const description = compact(node.description);
		return `- ${nodeReference(node, node.id)} (${details.join(", ")}).${description ? ` Detail: ${sentence(description)}` : ""}`;
	});
	const relationLines = relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);
		const note = noteById.get(relation.hitlNoteId);
		const details = [
			`pending: ${relation.operation || "upsert"}`,
			note?.userName ? `ingested by: ${note.userName}` : "",
		].filter(Boolean);
		const information = compact(relation.information);
		const description = compact(relation.description);
		return [
			`- ${nodeReference(source, relation.sourceId)} ${relationPhrase(relation.relation)} ${nodeReference(target, relation.targetId)} (${details.join(", ")}).`,
			information ? `Extra: ${sentence(information)}` : "",
			description ? `Details: ${sentence(description)}` : "",
		].filter(Boolean).join(" ");
	});
	const nodeDeleteLines = nodeDeletes.map((nodeDelete) =>
		`- [${nodeDelete.id}] ${nodeDelete.name || nodeDelete.id} is pending deletion.`,
	);
	const relationDeleteLines = relationDeletes.map((relationDelete) =>
		`- ${nodeReference(nodeById.get(relationDelete.sourceId), relationDelete.sourceId)} ${relationPhrase(relationDelete.relation)} ${nodeReference(nodeById.get(relationDelete.targetId), relationDelete.targetId)} is pending deletion.`,
	);

	return [
		"Pending HITL context below is not approved yet. Use it only for identity resolution, node reuse, and avoiding duplicate pending nodes or relations.",
		"If new input refers to a pending node, reuse that exact node ID/name. Do not create another node for the same entity just because it is pending approval.",
		"If a pending node must appear as a relationship endpoint in your output, emit NODE_UPDATE for that pending node, never NODE_CREATE.",
		"If a pending relation already captures the same source, target, and relation type, emit RELATION_UPDATE instead of RELATION_CREATE.",
		"",
		"Pending HITL nodes:",
		nodeLines.length > 0 ? nodeLines.join("\n") : "- No pending HITL nodes found.",
		"",
		"Pending HITL facts:",
		relationLines.length > 0 ? relationLines.join("\n") : "- No pending HITL relations found.",
		"",
		"Pending HITL deletions:",
		[...nodeDeleteLines, ...relationDeleteLines].length > 0 ? [...nodeDeleteLines, ...relationDeleteLines].join("\n") : "- No pending HITL deletions found.",
	].join("\n");
}

function reconcileExtractionWithPendingHitl(extractedGraph, pendingHitl) {
	const pendingNodeNames = new Set((pendingHitl?.graph?.nodes ?? [])
		.map((node) => normalizeGraphName(node.name || node.id))
		.filter(Boolean));
	const pendingRelationKeys = new Set((pendingHitl?.graph?.relations ?? [])
		.map((relation) => pendingRelationKey(relation.sourceId, relation.relation, relation.targetId))
		.filter((key) => !key.startsWith("|") && !key.endsWith("|")));

	if (pendingNodeNames.size === 0 && pendingRelationKeys.size === 0) {
		return extractedGraph;
	}

	return {
		...extractedGraph,
		nodes: (extractedGraph.nodes ?? []).map((node) => {
			const name = normalizeGraphName(node.name || node.label || node.id);
			if (pendingNodeNames.has(name) && String(node.operation ?? "").toLowerCase() === "create") {
				return { ...node, operation: "update" };
			}

			return node;
		}),
		relations: (extractedGraph.relations ?? []).map((relation) => {
			const sourceName = relation.sourceName || relation.source || relation.sourceId;
			const targetName = relation.targetName || relation.target || relation.targetId;
			const key = pendingRelationKey(sourceName, relation.relation, targetName);
			if (pendingRelationKeys.has(key) && String(relation.operation ?? "").toLowerCase() === "create") {
				return { ...relation, operation: "update" };
			}

			return relation;
		}),
	};
}

function safePipeField(value) {
	return encodePipelineField(value);
}

function graphRecordLine(recordType, fields) {
	return [recordType, ...fields].map(safePipeField).join("|");
}

function customGraphResponseFromPayload(graphPayload) {
	const lines = [];
	for (const node of graphPayload.nodes ?? []) {
		lines.push(graphRecordLine(node.operation === "update" ? "NODE_UPDATE" : "NODE_CREATE", [
			node.name || graphNameFromId(node.id),
			node.label || node.name || graphNameFromId(node.id),
			node.type || "concept",
			node.description || "",
			node.metadata || "",
		]));
	}
	for (const nodeDelete of graphPayload.nodeDeletes ?? []) {
		lines.push(graphRecordLine("NODE_DELETE", [
			nodeDelete.name || graphNameFromId(nodeDelete.id),
		]));
	}
	for (const relation of graphPayload.relations ?? []) {
		lines.push(graphRecordLine(relation.operation === "update" ? "RELATION_UPDATE" : "RELATION_CREATE", [
			graphNameFromId(relation.sourceId),
			graphNameFromId(relation.targetId),
			relation.relation || "relates_to",
			relation.information || "",
			relation.description || "",
			relation.metadata || "",
		]));
	}
	for (const relationDelete of graphPayload.relationDeletes ?? []) {
		lines.push(graphRecordLine("RELATION_DELETE", [
			graphNameFromId(relationDelete.sourceId),
			graphNameFromId(relationDelete.targetId),
			relationDelete.relation || "relates_to",
		]));
	}
	for (const suggestion of graphPayload.schemaSuggestions?.nodeTypes ?? []) {
		lines.push(graphRecordLine("NODE_TYPE_SUGGESTION", [
			suggestion.name,
			suggestion.description,
			suggestion.reason,
		]));
	}
	for (const suggestion of graphPayload.schemaSuggestions?.relationshipTypes ?? []) {
		lines.push(graphRecordLine("RELATION_TYPE_SUGGESTION", [
			suggestion.name,
			suggestion.description,
			suggestion.reason,
		]));
	}

	return [
		"<start#$#$>",
		...lines,
		"</end#$#$>",
	].join("\n");
}

async function retrievePendingHitlNotes(vectorStore, text, topK) {
	const byId = new Map();
	if (typeof vectorStore.queryHitlNotes === "function") {
		for (const note of await vectorStore.queryHitlNotes(text, topK)) {
			if (note?.id) {
				byId.set(note.id, note);
			}
		}
	}

	if (typeof vectorStore.listHitlNotes === "function") {
		const recentLimit = Math.max(topK * 5, 20);
		for (const note of await vectorStore.listHitlNotes({ status: "pending", limit: recentLimit })) {
			if (note?.id && !byId.has(note.id)) {
				byId.set(note.id, note);
			}
		}
	}

	return [...byId.values()];
}

export class IngestionService {
	constructor({ llmProvider, graphStore, vectorStore, prompts, logging = null, ingestion = {} }) {
		this.llmProvider = llmProvider;
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
		this.prompts = prompts;
		this.logging = logging;
		this.ingestion = {
			mode: normalizeIngestionMode(ingestion.mode),
			hitlDefaultUserName: ingestion.hitlDefaultUserName || "web-user",
			contextEnabled: ingestion.contextEnabled ?? true,
			contextTopK: ingestion.contextTopK ?? 5,
			contextDepth: ingestion.contextDepth ?? 1,
		};
	}

	async retrievePendingHitlContext({ text, graphSchema }) {
		if (typeof this.vectorStore.queryHitlNotes !== "function" && typeof this.vectorStore.listHitlNotes !== "function") {
			return {
				notes: [],
				graph: { nodes: [], relations: [] },
				nodeDeletes: [],
				relationDeletes: [],
				context: "",
				warnings: [],
			};
		}

		const notes = await retrievePendingHitlNotes(this.vectorStore, text, this.ingestion.contextTopK);
		const nodeMap = new Map();
		const relationMap = new Map();
		const nodeDeleteMap = new Map();
		const relationDeleteMap = new Map();
		const warnings = [];

		for (const note of notes) {
			const llmResponse = pendingNoteLlmResponse(note);
			if (!llmResponse) {
				continue;
			}

			try {
				const extractedGraph = parseGraphExtraction(llmResponse);
				const graphPayload = normalizeGraphPayload(extractedGraph, {
					schema: graphSchema,
					autoApplySuggestions: this.prompts.schemaAutoApplySuggestions,
				});

				for (const node of graphPayload.nodes) {
					addUniqueById(nodeMap, {
						...node,
						hitlNoteId: note.id,
					});
				}
				for (const relation of graphPayload.relations) {
					addUniqueById(relationMap, {
						...relation,
						hitlNoteId: note.id,
					});
				}
				for (const nodeDelete of graphPayload.nodeDeletes) {
					addUniqueById(nodeDeleteMap, {
						...nodeDelete,
						hitlNoteId: note.id,
					});
				}
				for (const relationDelete of graphPayload.relationDeletes) {
					addUniqueById(relationDeleteMap, {
						...relationDelete,
						hitlNoteId: note.id,
					});
				}
			} catch (error) {
				warnings.push(`Skipped pending HITL note ${note.id}: ${error.message}`);
			}
		}

		const graph = {
			nodes: [...nodeMap.values()],
			relations: [...relationMap.values()],
		};
		const nodeDeletes = [...nodeDeleteMap.values()];
		const relationDeletes = [...relationDeleteMap.values()];

		return {
			notes,
			graph,
			nodeDeletes,
			relationDeletes,
			context: formatPendingHitlContext({ notes, graph, nodeDeletes, relationDeletes }),
			warnings,
		};
	}

	async retrieveExistingContext({ text, graphSchema }) {
		if (!this.ingestion.contextEnabled) {
			return {
				entryNodes: [],
				graph: { nodes: [], relations: [] },
				pendingHitl: {
					notes: [],
					graph: { nodes: [], relations: [] },
					nodeDeletes: [],
					relationDeletes: [],
					context: "",
					warnings: [],
				},
				context: "Existing graph context retrieval is disabled.",
			};
		}

		const entryNodes = await this.vectorStore.queryNodes(text, this.ingestion.contextTopK);
		const nodeIds = [...new Set(entryNodes.map((node) => node.id).filter(Boolean))];
		const graph = nodeIds.length > 0
			? await this.graphStore.expandFromNodes(nodeIds, this.ingestion.contextDepth)
			: { nodes: [], relations: [] };
		const pendingHitl = await this.retrievePendingHitlContext({ text, graphSchema });
		const contextParts = [formatExtractionGraphContext(graph)];
		if (pendingHitl.context) {
			contextParts.push(pendingHitl.context);
		}

		return {
			entryNodes,
			graph,
			pendingHitl,
			context: contextParts.join("\n\n"),
		};
	}

	async extractGraphWithRawResponse({ text, extractionPrompt, debugLogger }) {
		if (typeof this.llmProvider.extractGraphWithRawResponse === "function") {
			const result = await this.llmProvider.extractGraphWithRawResponse({
				text,
				systemPrompt: extractionPrompt,
				prompt: "",
				debugLogger,
			});

			return {
				extractedGraph: result.graph,
				rawResponse: result.rawResponse ?? "",
			};
		}

		const extractedGraph = await this.llmProvider.extractGraph({
			text,
			systemPrompt: extractionPrompt,
			prompt: "",
			debugLogger,
		});

		return {
			extractedGraph,
			rawResponse: "",
		};
	}

	async applyGraphPayload(graphPayload, { source, debugLogger }) {
		const deletedNodeIds = new Set();
		const deletedRelationIds = new Set();

		for (const relationDelete of graphPayload.relationDeletes ?? []) {
			try {
				const result = await this.graphStore.deleteRelation(relationDelete.id);
				deletedRelationIds.add(result.relationId);
			} catch (error) {
				if (!isNotFoundError(error)) {
					throw error;
				}

				deletedRelationIds.add(relationDelete.id);
				logIngest(debugLogger, `[ingest] Relation delete skipped because ${relationDelete.id} was not found.`);
			}
		}

		for (const nodeDelete of graphPayload.nodeDeletes ?? []) {
			const result = await this.graphStore.deleteNode(nodeDelete.id);
			deletedNodeIds.add(result.nodeId);
			for (const relationId of result.relationIds ?? []) {
				deletedRelationIds.add(relationId);
			}
		}

		if (deletedNodeIds.size > 0) {
			await this.vectorStore.deleteNodes([...deletedNodeIds]);
		}

		if (deletedRelationIds.size > 0) {
			await this.vectorStore.deleteRelations([...deletedRelationIds]);
		}

		const storedGraph = await this.graphStore.upsertGraph(graphPayload, { source });
		if (storedGraph.nodes.length > 0 || storedGraph.relations.length > 0) {
			await this.vectorStore.upsertGraphIndex(storedGraph);
		}

		return {
			...storedGraph,
			nodeDeletes: graphPayload.nodeDeletes ?? [],
			relationDeletes: graphPayload.relationDeletes ?? [],
			deletedNodeIds: [...deletedNodeIds],
			deletedRelationIds: [...deletedRelationIds],
		};
	}

	async storeHitlProposal({ text, source, userName, rawResponse, graphPayload, debugLogger }) {
		if (typeof this.vectorStore.upsertHitlNote !== "function") {
			throw new Error("The configured vector store does not support HITL notes.");
		}

		const reviewSignals = countReviewSignals(graphPayload);
		const hitlNote = await this.vectorStore.upsertHitlNote({
			id: createHitlNoteId(),
			status: "pending",
			userName: userName || this.ingestion.hitlDefaultUserName,
			source,
			createdAt: new Date().toISOString(),
			userInput: text,
			llmResponse: rawResponse,
			nodeCount: graphPayload.nodes.length,
			relationCount: graphPayload.relations.length,
			nodeDeleteCount: graphPayload.nodeDeletes.length,
			relationDeleteCount: graphPayload.relationDeletes.length,
			schemaSuggestionCount: countSchemaSuggestions(graphPayload.schemaSuggestions),
			ambiguityCount: reviewSignals.ambiguityCount,
			contradictionCount: reviewSignals.contradictionCount,
		});

		debugLogger.json("Stored HITL Proposal", {
			id: hitlNote.id,
			collection: hitlNote.collection,
			metadata: hitlNote.metadata,
			nodeCount: graphPayload.nodes.length,
			relationCount: graphPayload.relations.length,
			nodeDeleteCount: graphPayload.nodeDeletes.length,
			relationDeleteCount: graphPayload.relationDeletes.length,
			schemaSuggestionCount: countSchemaSuggestions(graphPayload.schemaSuggestions),
			ambiguityCount: reviewSignals.ambiguityCount,
			contradictionCount: reviewSignals.contradictionCount,
		});
		debugLogger.section("Stored HITL Chroma Document", hitlNote.document);

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
			schemaWarnings: graphPayload.schemaWarnings,
			persistedSchemaSuggestions: null,
		};
	}

	async ingestText({ text, source, userName }) {
		const startedAt = Date.now();
		const debugLogger = createDebugLogger({
			...this.logging,
			name: "ingest",
		});

		try {
			logIngest(debugLogger, `[ingest] Started ingestion flow${source ? ` from ${source}` : ""}.`);
			logIngest(debugLogger, `[ingest] Input preview: ${previewText(text)}`);
			logIngest(
				debugLogger,
				`[ingest] Context settings: enabled=${this.ingestion.contextEnabled}, topK=${this.ingestion.contextTopK}, depth=${this.ingestion.contextDepth}`,
			);

			logIngest(debugLogger, "[ingest] Loading graph schema...");
			const graphSchema = loadGraphSchema({ schema: this.prompts.graphSchema });
			logIngest(debugLogger, `[ingest] Graph schema loaded from ${graphSchema.path}.`);

			logIngest(debugLogger, this.ingestion.contextEnabled
				? "[ingest] Retrieving existing graph context..."
				: "[ingest] Existing graph context retrieval is disabled.");
			const existingContext = await this.retrieveExistingContext({ text, graphSchema });
			logIngest(
				debugLogger,
				`[ingest] Retrieved ${existingContext.entryNodes.length} context entry node(s); expanded graph has ${existingContext.graph.nodes.length} node(s) and ${existingContext.graph.relations.length} relation(s); pending HITL context has ${existingContext.pendingHitl.graph.nodes.length} node(s) and ${existingContext.pendingHitl.graph.relations.length} relation(s).`,
			);

			logIngest(debugLogger, "[ingest] Rendering extraction prompt...");
			const extractionPrompt = buildExtractionPrompt(this.prompts.extractionSystemTemplate, {
				graphSchema,
				existingGraphContext: existingContext.context,
				userInput: text,
			});

			debugLogger.section("Runtime", {
				source,
				userName: userName || this.ingestion.hitlDefaultUserName,
				ingestionMode: this.ingestion.mode,
				schemaAutoApplySuggestions: this.prompts.schemaAutoApplySuggestions,
				schemaPath: graphSchema.path,
				ingestContextEnabled: this.ingestion.contextEnabled,
				ingestContextTopK: this.ingestion.contextTopK,
				ingestContextDepth: this.ingestion.contextDepth,
			});
			debugLogger.json("Retrieved Ingestion Context", {
				entryNodes: existingContext.entryNodes,
				nodes: existingContext.graph.nodes.length,
				relations: existingContext.graph.relations.length,
				pendingHitlNotes: existingContext.pendingHitl.notes.length,
				pendingHitlNodes: existingContext.pendingHitl.graph.nodes.length,
				pendingHitlRelations: existingContext.pendingHitl.graph.relations.length,
				pendingHitlNodeDeletes: existingContext.pendingHitl.nodeDeletes.length,
				pendingHitlRelationDeletes: existingContext.pendingHitl.relationDeletes.length,
				pendingHitlWarnings: existingContext.pendingHitl.warnings,
			});
			debugLogger.section("Existing Graph Context", existingContext.context);
			debugLogger.section("Rendered Extraction Prompt", extractionPrompt);

			logIngest(debugLogger, "[ingest] Sending extraction prompt to LLM...");
			const { extractedGraph: rawExtractedGraph, rawResponse } = await this.extractGraphWithRawResponse({
				text,
				debugLogger,
				extractionPrompt,
			});
			const extractedGraph = reconcileExtractionWithPendingHitl(rawExtractedGraph, existingContext.pendingHitl);
			debugLogger.json("Parsed Extraction Payload", extractedGraph);
			logIngest(
				debugLogger,
				`[ingest] LLM extraction parsed ${extractedGraph.nodes?.length ?? 0} node upsert record(s), ${extractedGraph.relations?.length ?? 0} relation upsert record(s), ${extractedGraph.nodeDeletes?.length ?? 0} node delete record(s), and ${extractedGraph.relationDeletes?.length ?? 0} relation delete record(s).`,
			);

			logIngest(debugLogger, "[ingest] Normalizing graph payload...");
			const graphPayload = normalizeGraphPayload(extractedGraph, {
				schema: graphSchema,
				autoApplySuggestions: this.prompts.schemaAutoApplySuggestions,
			});
			debugLogger.json("Normalized Graph Payload", graphPayload);
			logIngest(
				debugLogger,
				`[ingest] Normalized payload has ${graphPayload.nodes.length} node upsert(s), ${graphPayload.relations.length} relation upsert(s), ${graphPayload.nodeDeletes.length} node delete(s), ${graphPayload.relationDeletes.length} relation delete(s), and ${graphPayload.schemaWarnings.length} schema warning(s).`,
			);

			if (this.ingestion.mode === "hitl") {
				logIngest(debugLogger, "[ingest] HITL mode enabled; storing pending proposal in vector store.");
				const hitlResponse = customGraphResponseFromPayload(graphPayload);
				const pendingProposal = await this.storeHitlProposal({
					text,
					source,
					userName: userName || this.ingestion.hitlDefaultUserName,
					rawResponse: hitlResponse,
					graphPayload,
					debugLogger,
				});
				logIngest(debugLogger, `[ingest] Stored HITL proposal ${pendingProposal.hitlNote.id} in ${Date.now() - startedAt} ms. No graph mutations were applied.`);

				if (debugLogger.enabled) {
					logIngest(debugLogger, `Ingest debug log written to ${debugLogger.path}`);
				}

				return pendingProposal;
			}

			logIngest(debugLogger, "[ingest] Persisting schema suggestions...");
			graphPayload.persistedSchemaSuggestions = this.prompts.schemaAutoApplySuggestions
				? promoteGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions)
				: persistGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions);
			debugLogger.json("Persisted Schema Suggestions", graphPayload.persistedSchemaSuggestions);
			logIngest(
				debugLogger,
				`[ingest] Persisted schema suggestions: nodeTypesAdded=${graphPayload.persistedSchemaSuggestions.nodeTypesAdded}, relationshipTypesAdded=${graphPayload.persistedSchemaSuggestions.relationshipTypesAdded}.`,
			);

			logIngest(debugLogger, "[ingest] Applying graph mutations to graph store and vector index...");
			const storedGraph = await this.applyGraphPayload(graphPayload, { source, debugLogger });
			debugLogger.json("Applied Graph Mutations", {
				upsertedNodes: storedGraph.nodes.length,
				upsertedRelations: storedGraph.relations.length,
				deletedNodeIds: storedGraph.deletedNodeIds,
				deletedRelationIds: storedGraph.deletedRelationIds,
			});
			logIngest(
				debugLogger,
				`[ingest] Applied mutations in ${Date.now() - startedAt} ms: upserted ${storedGraph.nodes.length} node(s), upserted ${storedGraph.relations.length} relation(s), deleted ${storedGraph.deletedNodeIds.length} node(s), deleted ${storedGraph.deletedRelationIds.length} relation(s).`,
			);

			if (debugLogger.enabled) {
				logIngest(debugLogger, `Ingest debug log written to ${debugLogger.path}`);
			}

			return storedGraph;
		} catch (error) {
			logIngest(debugLogger, `[ingest] Failed after ${Date.now() - startedAt} ms: ${error?.message ?? String(error)}`);
			const details = errorDetails(error);
			debugLogger.json("Ingestion Error", details);
			debugLogger.json("Exception", details);

			if (debugLogger.enabled) {
				logIngest(debugLogger, `Ingest debug log written to ${debugLogger.path}`);
			}

			throw error;
		}
	}
}
