import { resolveGraphPayload } from "../ingestion/graphResolution.js";

// The one gate for graph writes. Every change to Neo4j goes through here, followed by the matching Chroma
// vector update, so the two stores stay in step. Callers decide *whether* something may be written
// (HITL review, schema rules); this service decides *how*.
//
// Chroma cannot join a Neo4j transaction, so vectors are synced after the commit. Every step is repeatable,
// and a sync failure becomes a VECTOR_SYNC_FAILED error that says the graph was saved.

// The graph is committed but Chroma is behind. `expose` lets the web error handler show this message
// instead of the generic server error, so the user knows the graph changed and how to repair the index.
export function vectorSyncError(cause) {
	const error = new Error(
		`Graph changes were saved, but the vector index could not be updated (${cause?.message ?? String(cause)}). `
		+ "Retry the same action (for a HITL approval, approve again), or run `npm run kg:reindex-vectors`.",
	);
	error.status = 503;
	error.code = "VECTOR_SYNC_FAILED";
	error.expose = true;
	error.cause = cause;
	return error;
}

function violationError(graphPayload) {
	const error = new Error(`Cannot apply graph payload with violations: ${graphPayload.schemaViolations.map((violation) => violation.message).join("; ")}`);
	error.status = 400;
	return error;
}

export class GraphWriteService {
	constructor({ graphStore, vectorStore }) {
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
	}

	async syncVectors(sync, debugLogger) {
		try {
			await sync();
		} catch (error) {
			debugLogger?.log?.(`[graph] Graph saved, but the vector index sync failed: ${error?.message ?? String(error)}`);
			throw vectorSyncError(error);
		}
	}

	// Applies a normalized payload (auto ingest, MCP auto mode, HITL approval). It is checked against the
	// current graph first, so a relation can never create or rewrite a node, whatever the caller checked.
	async applyPayload(normalizedPayload, { debugLogger } = {}) {
		const { graphPayload } = await resolveGraphPayload(normalizedPayload, this.graphStore);
		if ((graphPayload.schemaViolations?.length ?? 0) > 0) {
			throw violationError(graphPayload);
		}

		// One Neo4j transaction for all deletes and upserts. Record metadata only carries HITL review
		// signals; the graph store does not persist it.
		const storedGraph = await this.graphStore.applyGraph(graphPayload);

		// Relation vectors of deleted nodes are found by their stored endpoints, not by what Neo4j returned
		// this time, so a retry also cleans them.
		await this.syncVectors(async () => {
			if (storedGraph.deletedNodeIds.length > 0) {
				await this.vectorStore.deleteNodes(storedGraph.deletedNodeIds);
				await this.vectorStore.deleteRelationsForNodes(storedGraph.deletedNodeIds);
			}
			if (storedGraph.deletedRelationIds.length > 0) {
				await this.vectorStore.deleteRelations(storedGraph.deletedRelationIds);
			}
			if (storedGraph.nodes.length > 0 || storedGraph.relations.length > 0) {
				await this.vectorStore.upsertGraphIndex(storedGraph);
			}
		}, debugLogger);

		return {
			...storedGraph,
			nodeDeletes: graphPayload.nodeDeletes ?? [],
			relationDeletes: graphPayload.relationDeletes ?? [],
		};
	}

	// Direct reviewer edits. Fields are written exactly as given (an empty description clears it).

	async writeNode(node) {
		const storedNode = await this.graphStore.upsertNode(node);
		await this.syncVectors(() => this.vectorStore.upsertNode(storedNode));
		return storedNode;
	}

	async deleteNode(nodeId) {
		const result = await this.graphStore.deleteNode(nodeId);
		await this.syncVectors(async () => {
			await this.vectorStore.deleteNodes([result.nodeId]);
			await this.vectorStore.deleteRelations(result.relationIds ?? []);
			await this.vectorStore.deleteRelationsForNodes([result.nodeId]);
		});
		return result;
	}

	// With `replaceId` (an edit that changed the relation's id), the old relation is replaced in the same
	// Neo4j transaction and its vector removed.
	async writeRelation(relation, { replaceId = "" } = {}) {
		const storedRelation = await this.graphStore.upsertRelation(relation, { replaceId });
		await this.syncVectors(async () => {
			if (replaceId && replaceId !== storedRelation.id) {
				await this.vectorStore.deleteRelations([replaceId]);
			}
			await this.vectorStore.upsertRelation(storedRelation);
		});
		return storedRelation;
	}

	async deleteRelation(relationId) {
		const result = await this.graphStore.deleteRelation(relationId);
		await this.syncVectors(() => this.vectorStore.deleteRelations([result.relationId]));
		return result;
	}

	// Admin maintenance (password-protected admin panel and CLI only; not knowledge changes).

	// Deletes all MindMesh graph data and, to keep the stores in step, its node and relation vectors.
	async wipeGraph() {
		const deleted = await this.graphStore.deleteAllKnowledge();
		const clearedCollections = await this.vectorStore.clearGraphIndex();
		return { ...deleted, clearedCollections };
	}

	// Drops the node and relation vectors only; reindexVectors() rebuilds them from Neo4j.
	async clearGraphVectors() {
		return { clearedCollections: await this.vectorStore.clearGraphIndex() };
	}

	// Rebuilds the vectors from what Neo4j stores. `fresh` empties the collections first, so vectors of items
	// deleted in Neo4j disappear too. The graph is read before anything is deleted.
	async reindexVectors({ fresh = true, limit = 10000 } = {}) {
		const graph = await this.graphStore.getGraphSnapshot(limit);
		if (fresh && graph.nodes.length >= limit) {
			throw Object.assign(new Error(`The graph has at least ${limit} nodes, so a fresh reindex would drop vectors beyond the limit. Use a higher limit.`), { status: 400 });
		}
		const clearedCollections = fresh ? await this.vectorStore.clearGraphIndex() : [];
		await this.vectorStore.upsertGraphIndex(graph);
		return { fresh, clearedCollections, nodes: graph.nodes.length, relations: graph.relations.length };
	}

	// Brings the vector index in line with Neo4j: indexes records that have no vector and deletes vectors
	// whose record is gone (see AdminService.consistency()).
	async repairVectorIndex({ missingNodeIds = [], missingRelationIds = [], orphanNodeIds = [], orphanRelationIds = [] }) {
		const nodes = await this.graphStore.getNodesByIds(missingNodeIds);
		const relations = await this.graphStore.getRelationsByIds(missingRelationIds);
		if (nodes.length > 0 || relations.length > 0) {
			await this.vectorStore.upsertGraphIndex({ nodes, relations });
		}
		await this.vectorStore.deleteNodes(orphanNodeIds);
		await this.vectorStore.deleteRelations(orphanRelationIds);
		return {
			indexedNodes: nodes.length,
			indexedRelations: relations.length,
			deletedNodeVectors: orphanNodeIds.length,
			deletedRelationVectors: orphanRelationIds.length,
		};
	}
}
