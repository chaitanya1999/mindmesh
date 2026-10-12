import { describeRuntime } from "../config.js";

// Admin panel logic: overview, consistency check and repair, backup, wipes, reindex, and trial queries.
// Access control (session; password re-entry and the confirmation word for wipes) is enforced by the routes in
// src/server/adminRoutes.js; graph and vector writes go through GraphWriteService.

// Typed confirmation word a wipe needs, in addition to the password. Reindex and repair only rebuild derived
// vectors, so a session is enough for them.
export const CONFIRM_WORD = "DELETE";
export const WIPE_TARGETS = ["graph", "vectors", "proposals", "all"];

const SAMPLE_SIZE = 50;
const BACKUP_NODE_LIMIT = 10000;

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function difference(items, other) {
	const exclude = new Set(other);
	return items.filter((item) => !exclude.has(item));
}

export class AdminService {
	constructor({ config, graphStore, vectorStore, graphReadService, graphWriteService, hitlService }) {
		this.config = config;
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
		this.graphReadService = graphReadService;
		this.graphWriteService = graphWriteService;
		this.hitlService = hitlService;
	}

	async overview() {
		const [database, schema, collections, pending] = await Promise.all([
			this.graphStore.getDatabaseInfo(),
			this.graphReadService.getSchemaOverview(),
			this.vectorStore.listCollectionsWithCounts(),
			this.vectorStore.listHitlNotePage({ status: "pending", limit: 1 }),
		]);
		const chroma = this.config.vector?.chroma ?? {};

		return {
			runtime: describeRuntime(this.config),
			neo4j: {
				...database,
				totals: schema.totals,
				nodeTypes: schema.nodeTypes.map((type) => ({ type: type.name, count: type.nodeCount })).filter((row) => row.count > 0),
				relationTypes: schema.relationTypes.map((type) => ({ type: type.name, count: type.relationCount })).filter((row) => row.count > 0),
			},
			chroma: { url: chroma.path, tenant: chroma.tenant, database: chroma.database, collections },
			proposals: { pending: pending.total },
			schemaHealth: {
				unapprovedTypesInGraph: schema.unapprovedTypesInGraph,
				unusedNodeTypes: schema.nodeTypes.filter((type) => type.nodeCount === 0).map((type) => type.name),
				unusedRelationTypes: schema.relationTypes.filter((type) => type.relationCount === 0).map((type) => type.name),
			},
		};
	}

	// Compares Neo4j ids with the vector index: records without a vector, and vectors without a record.
	async consistency() {
		const graph = await this.graphStore.listIds();
		const vectors = await this.vectorStore.listIndexIds();
		const ids = {
			missingNodeIds: difference(graph.nodeIds, vectors.nodeIds),
			missingRelationIds: difference(graph.relationIds, vectors.relationIds),
			orphanNodeIds: difference(vectors.nodeIds, graph.nodeIds),
			orphanRelationIds: difference(vectors.relationIds, graph.relationIds),
		};
		const summary = (list) => ({ count: list.length, sample: list.slice(0, SAMPLE_SIZE) });

		return {
			inSync: Object.values(ids).every((list) => list.length === 0),
			counts: {
				graphNodes: graph.nodeIds.length,
				nodeVectors: vectors.nodeIds.length,
				graphRelations: graph.relationIds.length,
				relationVectors: vectors.relationIds.length,
			},
			nodesWithoutVector: summary(ids.missingNodeIds),
			relationsWithoutVector: summary(ids.missingRelationIds),
			vectorsWithoutNode: summary(ids.orphanNodeIds),
			vectorsWithoutRelation: summary(ids.orphanRelationIds),
			ids,
		};
	}

	async repairVectorIndex() {
		const { ids } = await this.consistency();
		const repaired = await this.graphWriteService.repairVectorIndex(ids);
		const after = await this.consistency();
		return { ...repaired, inSync: after.inSync };
	}

	// Everything needed to rebuild MindMesh: the graph (vectors are derived from it) and the pending
	// proposals, which exist nowhere else.
	async backup() {
		const graph = await this.graphStore.getGraphSnapshot(BACKUP_NODE_LIMIT);
		const proposals = await this.hitlService.exportProposals();
		return {
			format: "mindmesh-backup",
			version: 1,
			exportedAt: new Date().toISOString(),
			source: {
				neo4jDatabase: this.config.graph?.neo4j?.database,
				chromaDatabase: this.config.vector?.chroma?.database,
				hitlCollection: this.config.vector?.chroma?.hitlCollection,
			},
			graph: {
				nodes: graph.nodes,
				relations: graph.relations,
				truncated: graph.nodes.length >= BACKUP_NODE_LIMIT,
			},
			proposals,
		};
	}

	async wipe(target) {
		if (!WIPE_TARGETS.includes(target)) {
			throw httpError(`target must be one of ${WIPE_TARGETS.join(", ")}.`, 400);
		}
		const result = {};
		if (target === "graph" || target === "all") {
			result.graph = await this.graphWriteService.wipeGraph();
		}
		if (target === "vectors") {
			result.vectors = await this.graphWriteService.clearGraphVectors();
		}
		if (target === "proposals" || target === "all") {
			result.proposals = await this.hitlService.clearAllProposals();
		}
		return { target, ...result };
	}

	async reindexVectors() {
		return this.graphWriteService.reindexVectors({ fresh: true });
	}

	async queryCypher({ cypher, params, limit }) {
		return this.graphReadService.queryCypher({ cypher, params: params ?? {}, limit });
	}

	async vectorMatch({ query, collections, topK }) {
		const text = String(query ?? "").trim();
		if (!text) {
			throw httpError("query is required.", 400);
		}
		if (!Array.isArray(collections) || collections.length === 0) {
			throw httpError("Pick at least one collection.", 400);
		}
		return {
			query: text,
			results: await this.vectorStore.queryCollections(collections.map(String), text, Math.max(1, Math.min(Number(topK) || 5, 20))),
		};
	}
}
