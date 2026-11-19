import { describeRuntime } from "../config.js";
import { normalizeEditableGraphSchema, readEditableGraphSchema, saveEditableGraphSchema } from "../schema/graphSchema.js";

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

const BACKUP_FORMAT = "mindmesh-backup";
// Version 2 added the schema. Version 1 files (no schema) are not restorable.
const BACKUP_VERSION = 2;
const MAX_LISTED_PROBLEMS = 5;

const text = (value) => (typeof value === "string" ? value.trim() : "");

// Checks a backup file before anything is deleted and returns its parts. Every problem is collected, so the
// owner sees what is wrong with the file at once (the first few, with a count).
export function validateBackup(backup) {
	if (!backup || typeof backup !== "object" || Array.isArray(backup) || backup.format !== BACKUP_FORMAT) {
		throw httpError(`Not a MindMesh backup (format must be "${BACKUP_FORMAT}").`, 400);
	}
	if (backup.version !== BACKUP_VERSION) {
		throw httpError(`Backup version ${backup.version} cannot be restored; only version ${BACKUP_VERSION} (backups that include the schema).`, 400);
	}
	let schema;
	try {
		schema = normalizeEditableGraphSchema(backup.schema);
	} catch (error) {
		throw httpError(`The backup's schema is invalid: ${error.message}`, 400);
	}
	const nodes = Array.isArray(backup.graph?.nodes) ? backup.graph.nodes : null;
	const relations = Array.isArray(backup.graph?.relations) ? backup.graph.relations : null;
	const proposals = Array.isArray(backup.proposals) ? backup.proposals : null;
	if (!nodes || !relations || !proposals) {
		throw httpError("The backup needs graph.nodes, graph.relations and proposals lists.", 400);
	}

	const problems = [];
	const nodeIds = new Set();
	nodes.forEach((node, index) => {
		const name = text(node?.name);
		if (!name || node.id !== `node:${name}`) {
			problems.push(`node ${index + 1}: id must be node:<name> (got ${JSON.stringify(node?.id)})`);
		} else if (nodeIds.has(node.id)) {
			problems.push(`node ${index + 1}: duplicate id ${node.id}`);
		}
		if (!text(node?.type)) {
			problems.push(`node ${index + 1} (${node?.id}): type is empty`);
		}
		nodeIds.add(node?.id);
	});
	const relationIds = new Set();
	relations.forEach((relation, index) => {
		const label = `relation ${index + 1} (${relation?.id})`;
		if (!text(relation?.id).startsWith("rel:")) {
			problems.push(`${label}: id must start with rel:`);
		} else if (relationIds.has(relation.id)) {
			problems.push(`${label}: duplicate id`);
		}
		relationIds.add(relation?.id);
		if (!text(relation?.relation)) {
			problems.push(`${label}: relation type is empty`);
		}
		for (const end of ["sourceId", "targetId"]) {
			if (!nodeIds.has(relation?.[end])) {
				problems.push(`${label}: ${end} ${relation?.[end]} is not a node in the backup`);
			}
		}
	});
	const proposalIds = new Set();
	proposals.forEach((proposal, index) => {
		const id = text(proposal?.id);
		if (!id || proposalIds.has(id)) {
			problems.push(`proposal ${index + 1}: ${id ? `duplicate id ${id}` : "id is empty"}`);
		}
		proposalIds.add(id);
		if (typeof proposal?.llmResponse !== "string") {
			problems.push(`proposal ${index + 1} (${id}): llmResponse must be text`);
		}
	});
	if (problems.length > 0) {
		const more = problems.length > MAX_LISTED_PROBLEMS ? ` (and ${problems.length - MAX_LISTED_PROBLEMS} more)` : "";
		throw httpError(`The backup has ${problems.length} problem(s), nothing was changed: ${problems.slice(0, MAX_LISTED_PROBLEMS).join("; ")}${more}.`, 400);
	}
	return { schema, nodes, relations, proposals, truncated: Boolean(backup.graph.truncated) };
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

	// Everything needed to rebuild MindMesh: the graph schema (types and scope dimensions the graph relies on),
	// the graph (vectors are derived from it) and the pending proposals, which exist nowhere else.
	async backup() {
		const graph = await this.graphStore.getGraphSnapshot(BACKUP_NODE_LIMIT);
		const proposals = await this.hitlService.exportProposals();
		return {
			format: BACKUP_FORMAT,
			version: BACKUP_VERSION,
			exportedAt: new Date().toISOString(),
			schema: readEditableGraphSchema(this.config).schema,
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

	// Replaces everything with a backup: the whole file is checked first, so a bad file changes nothing. Then
	// the schema file is written, the graph, its vectors and the proposals are deleted, and the backed-up graph
	// (through GraphWriteService, vectors indexed from what Neo4j stored) and proposals are written back.
	async restore(backup) {
		const { schema, nodes, relations, proposals, truncated } = validateBackup(backup);
		const wiped = await this.wipe("all");
		saveEditableGraphSchema(this.config, { schema });
		const graph = await this.graphWriteService.restoreGraph({ nodes, relations });
		const restored = await this.hitlService.importProposals(proposals);
		return {
			exportedAt: backup.exportedAt ?? "",
			deleted: {
				nodes: wiped.graph.deletedNodes,
				relations: wiped.graph.deletedRelations,
				proposals: wiped.proposals.deletedProposals,
			},
			restored: { schema: true, nodes: graph.nodes, relations: graph.relations, proposals: restored.restoredProposals },
			truncated,
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
