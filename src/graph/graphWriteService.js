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
}
