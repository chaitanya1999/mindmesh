import { toSnakeCase } from "../ingestion/graphPayload.js";
import { formatFieldGuidance, loadGraphSchema } from "../schema/graphSchema.js";

// Read-only views of the approved graph for agents (MCP). Chroma finds candidates by meaning; the records
// returned are always read from Neo4j, the source of truth. Pending proposals are HitlService's business.

const MAX_LIMIT = 50;
const QUERY_TIMEOUT_MS = 10000;

// "EKYC Screen -[uses]-> PAN API <-[calls]- Onboarding Flow": direction as stored, labels for readability.
function pathSummary(path) {
	let text = path.nodes[0]?.label ?? path.nodes[0]?.id ?? "";
	path.relations.forEach((relation, index) => {
		const previous = path.nodes[index];
		const next = path.nodes[index + 1];
		text += relation.sourceId === previous?.id
			? ` -[${relation.relation}]-> ${next?.label ?? next?.id}`
			: ` <-[${relation.relation}]- ${next?.label ?? next?.id}`;
	});
	return text;
}

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function safeLimit(value, fallback = 10) {
	return Math.max(1, Math.min(Number(value) || fallback, MAX_LIMIT));
}

// The one node shape every read tool returns.
export function nodeView(node) {
	return {
		id: node.id,
		name: node.name,
		label: node.label,
		type: node.type,
		description: node.description ?? "",
	};
}

// The one relation shape every read tool returns.
export function relationView(relation) {
	return {
		id: relation.id,
		relation: relation.relation,
		sourceId: relation.sourceId,
		targetId: relation.targetId,
		information: relation.information ?? "",
		description: relation.description ?? "",
	};
}

function nodeSummary(node, fallbackId) {
	return node
		? { id: node.id, label: node.label, type: node.type }
		: { id: fallbackId, label: fallbackId, type: "" };
}

export class GraphReadService {
	constructor({ graphStore, vectorStore, schemaConfig }) {
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
		this.schemaConfig = schemaConfig;
	}

	// Accepts a node id ("node:ekyc_screen") or a bare name ("ekyc_screen", "EKYC Screen").
	nodeId(reference) {
		const text = String(reference ?? "").trim();
		if (!text) {
			throw httpError("A node id or name is required.", 400);
		}

		return text.startsWith("node:") ? text : `node:${toSnakeCase(text)}`;
	}

	async nodesById(ids) {
		const nodes = await this.graphStore.getNodesByIds(ids);
		return new Map(nodes.map((node) => [node.id, node]));
	}

	// match "semantic" ranks by meaning (Chroma); "text" is a case-insensitive name/text match (Neo4j).
	async searchNodes({ query, match = "semantic", type = "", limit }) {
		const count = safeLimit(limit);
		const nodeType = toSnakeCase(type);
		if (match === "text") {
			const nodes = await this.graphStore.searchNodes(query, count, { type: nodeType });
			return { match, results: nodes.map(nodeView) };
		}

		const hits = await this.vectorStore.queryNodes(query, count, { type: nodeType });
		const byId = await this.nodesById(hits.map((hit) => hit.id));
		return {
			match: "semantic",
			// distance: lower is closer. Hits whose node is no longer in Neo4j (stale vectors) are skipped.
			results: hits.filter((hit) => byId.has(hit.id)).map((hit) => ({ ...nodeView(byId.get(hit.id)), distance: hit.distance })),
		};
	}

	async searchRelations({ query, relationType = "", limit }) {
		const hits = await this.vectorStore.queryRelations(query, safeLimit(limit), { relation: toSnakeCase(relationType) });
		const relations = await this.graphStore.getRelationsByIds(hits.map((hit) => hit.id));
		const relationById = new Map(relations.map((relation) => [relation.id, relation]));
		const endpoints = await this.nodesById(relations.flatMap((relation) => [relation.sourceId, relation.targetId]));

		return {
			results: hits.filter((hit) => relationById.has(hit.id)).map((hit) => {
				const relation = relationById.get(hit.id);
				return {
					...relationView(relation),
					source: nodeSummary(endpoints.get(relation.sourceId), relation.sourceId),
					target: nodeSummary(endpoints.get(relation.targetId), relation.targetId),
					distance: hit.distance,
				};
			}),
		};
	}

	// One node with its relations grouped by direction, then by relation type.
	async getNode({ node }) {
		const stored = await this.requireNode(node);
		const id = stored.id;

		const relations = await this.graphStore.getRelationsForNode(id);
		const neighbours = await this.nodesById(relations.map((relation) => (relation.sourceId === id ? relation.targetId : relation.sourceId)));
		const outgoing = {};
		const incoming = {};
		for (const relation of relations) {
			const isOutgoing = relation.sourceId === id;
			const group = isOutgoing ? outgoing : incoming;
			const otherId = isOutgoing ? relation.targetId : relation.sourceId;
			(group[relation.relation] ??= []).push({
				relationId: relation.id,
				[isOutgoing ? "target" : "source"]: nodeSummary(neighbours.get(otherId), otherId),
				information: relation.information ?? "",
				description: relation.description ?? "",
			});
		}

		return {
			node: nodeView(stored),
			relationCount: relations.length,
			outgoing,
			incoming,
		};
	}

	async requireNode(reference) {
		const id = this.nodeId(reference);
		const stored = await this.graphStore.getNode(id);
		if (!stored) {
			throw httpError(`Node not found: ${id}. Use search_nodes to find the exact name.`, 404);
		}

		return stored;
	}

	// Walks out from one node, `depth` hops (1..4). Nodes carry their hop `distance`; `truncated` is true when
	// `limit` cut the result.
	async exploreGraph({ from, depth = 1, direction = "both", relationTypes = [], nodeTypes = [], limit = 100 }) {
		const start = await this.requireNode(from);
		const hops = Math.max(1, Math.min(Number(depth) || 1, 4));
		const result = await this.graphStore.expandFromNodes([start.id], hops, {
			direction,
			relationTypes: relationTypes.map(toSnakeCase).filter(Boolean),
			nodeTypes: nodeTypes.map(toSnakeCase).filter(Boolean),
			limit: Math.max(1, Math.min(Number(limit) || 100, 500)),
		});

		return {
			from: start.id,
			depth: hops,
			direction,
			truncated: Boolean(result.truncated),
			nodes: result.nodes
				.map((node) => ({ ...nodeView(node), distance: node.distance }))
				.sort((left, right) => left.distance - right.distance || String(left.label).localeCompare(String(right.label))),
			relations: result.relations.map(relationView),
		};
	}

	// Shortest paths between two nodes (either direction), each with a readable one-line summary.
	async findPaths({ from, to, maxDepth = 4, relationTypes = [], limit = 5 }) {
		const source = await this.requireNode(from);
		const target = await this.requireNode(to);
		if (source.id === target.id) {
			throw httpError("from and to are the same node; use get_node instead.", 400);
		}
		const paths = await this.graphStore.findPaths(source.id, target.id, {
			maxDepth: Math.max(1, Math.min(Number(maxDepth) || 4, 6)),
			relationTypes: relationTypes.map(toSnakeCase).filter(Boolean),
			limit: Math.max(1, Math.min(Number(limit) || 5, 20)),
		});

		return {
			from: source.id,
			to: target.id,
			paths: paths.map((path) => ({
				length: path.relations.length,
				summary: pathSummary(path),
				nodes: path.nodes.map(nodeView),
				relations: path.relations.map(relationView),
			})),
		};
	}

	// A read-only Cypher query; Neo4jGraphStore.runReadOnlyQuery() enforces read-only, the timeout, and the row cap.
	async queryCypher({ cypher, params = {}, limit = 100 }) {
		if (params === null || typeof params !== "object" || Array.isArray(params)) {
			throw httpError("params must be an object of query parameters.", 400);
		}

		return this.graphStore.runReadOnlyQuery(cypher, params, {
			limit: Math.max(1, Math.min(Number(limit) || 100, 500)),
			timeoutMs: QUERY_TIMEOUT_MS,
		});
	}

	// Approved types with descriptions and how many nodes/relations use each, plus field guidance.
	async getSchemaOverview() {
		const schema = loadGraphSchema(this.schemaConfig);
		const counts = await this.graphStore.countByType();
		const nodeCounts = new Map(counts.nodeTypes.map((row) => [row.type, row.count]));
		const relationCounts = new Map(counts.relationTypes.map((row) => [row.type, row.count]));
		const approvedNodeTypes = new Set(schema.nodeTypes.map((entry) => entry.name));
		const approvedRelationTypes = new Set(schema.relationshipTypes.map((entry) => entry.name));

		return {
			nodeTypes: schema.nodeTypes.map((entry) => ({ name: entry.name, description: entry.description, nodeCount: nodeCounts.get(entry.name) ?? 0 })),
			relationTypes: schema.relationshipTypes.map((entry) => ({ name: entry.name, description: entry.description, relationCount: relationCounts.get(entry.name) ?? 0 })),
			// Types still used in the graph but no longer in the schema (for example removed in the editor).
			unapprovedTypesInGraph: {
				nodeTypes: counts.nodeTypes.filter((row) => !approvedNodeTypes.has(row.type)),
				relationTypes: counts.relationTypes.filter((row) => !approvedRelationTypes.has(row.type)),
			},
			totals: {
				nodes: counts.nodeTypes.reduce((sum, row) => sum + row.count, 0),
				relations: counts.relationTypes.reduce((sum, row) => sum + row.count, 0),
			},
			fieldGuidance: formatFieldGuidance(schema),
		};
	}
}
