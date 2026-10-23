import neo4j from "neo4j-driver";
import { parseScope, scopeMatchValues } from "../schema/scope.js";

// Upper bound on nodes returned by one expansion.
const EXPANSION_NODE_LIMIT = 2000;

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

// Neo4j values as plain JSON: integers as numbers, nodes and relationships as their properties.
function toPlainValue(value) {
	if (neo4j.isInt(value)) {
		return neo4j.integer.inSafeRange(value) ? neo4j.integer.toNumber(value) : neo4j.integer.toString(value);
	}
	if (neo4j.isNode(value)) {
		return { labels: value.labels, ...toPlainValue(value.properties) };
	}
	if (neo4j.isRelationship(value)) {
		return { type: value.type, ...toPlainValue(value.properties) };
	}
	if (neo4j.isPath(value)) {
		return {
			nodes: [value.start, ...value.segments.map((segment) => segment.end)].map(toPlainValue),
			relationships: value.segments.map((segment) => toPlainValue(segment.relationship)),
		};
	}
	if (Array.isArray(value)) {
		return value.map(toPlainValue);
	}
	if (value && typeof value === "object") {
		// Temporal and spatial values print as their Cypher literal.
		if (value.constructor && value.constructor !== Object) {
			return String(value);
		}
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlainValue(item)]));
	}
	return value;
}

function formatNode(node) {
	return {
		id: node.properties.id,
		label: node.properties.label,
		name: node.properties.name,
		type: node.properties.type,
		description: node.properties.description ?? "",
		scope: parseScope(node.properties.scope),
		createdAt: node.properties.createdAt,
		updatedAt: node.properties.updatedAt,
	};
}

function formatRelationship(relationship) {
	return {
		id: relationship.properties.id,
		sourceId: relationship.properties.sourceId,
		targetId: relationship.properties.targetId,
		relation: relationship.properties.relation,
		information: relationship.properties.information ?? "",
		description: relationship.properties.description ?? "",
		scope: parseScope(relationship.properties.scope),
		createdAt: relationship.properties.createdAt,
		updatedAt: relationship.properties.updatedAt,
	};
}

function formatRelationshipWithEndpoints(relationship, sourceId, targetId) {
	return {
		...formatRelationship(relationship),
		sourceId,
		targetId,
	};
}

function compactString(value) {
	return String(value ?? "").trim();
}

// Cypher condition for the scope filter on node `n` (or relation) bound to `variable`: unscoped items
// always match. Pass $scopeValues from scopeMatchValues(); an empty list disables the filter.
function scopeCondition(variable) {
	return `(size($scopeValues) = 0 OR coalesce(size(${variable}.scope), 0) = 0 OR any(s IN ${variable}.scope WHERE s IN $scopeValues))`;
}

function sessionOptions(config) {
	// Omitting the database uses the server's default database (the only user
	// database on Community Edition).
	if (!config.database || config.database === "neo4j") {
		return {};
	}

	return { database: config.database };
}

export class Neo4jGraphStore {
	constructor(config) {
		this.config = config;
		this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
		this.sessionOptions = sessionOptions(config);
	}

	async verifyConnectivity() {
		await this.driver.verifyConnectivity();
	}

	// Uniqueness of the custom `id` is enforced by Neo4j constraints, created once per process before
	// the first write. Requires Neo4j 5.23+ (calendar versions such as 2025.x count as newer).
	ensureConstraints() {
		this.constraintsReady ??= this.createConstraints().catch((error) => {
			this.constraintsReady = null;
			throw error;
		});
		return this.constraintsReady;
	}

	async createConstraints() {
		const session = this.driver.session(this.sessionOptions);

		try {
			const versionResult = await session.run("CALL dbms.components() YIELD versions RETURN versions[0] AS version");
			const version = String(versionResult.records[0]?.get("version") ?? "");
			const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10) || 0);
			// 5.23 is the oldest version with the CALL (variables) { ... } subquery syntax used by expandFromNodes().
			if (major < 5 || (major === 5 && minor < 23)) {
				throw new Error(`MindMesh needs Neo4j 5.23 or later; the server reports version ${version || "unknown"}.`);
			}

			try {
				await session.run("CREATE CONSTRAINT knowledge_node_id IF NOT EXISTS FOR (n:KnowledgeNode) REQUIRE n.id IS UNIQUE");
			} catch (error) {
				throw new Error(`Could not enforce unique KnowledgeNode ids (duplicate ids may exist): ${error.message}`);
			}

			await session.run("CREATE CONSTRAINT relates_to_id IF NOT EXISTS FOR ()-[r:RELATES_TO]-() REQUIRE r.id IS UNIQUE");
			// Type filters in search, traversal, and agent queries.
			await session.run("CREATE INDEX knowledge_node_type IF NOT EXISTS FOR (n:KnowledgeNode) ON (n.type)");
			await session.run("CREATE INDEX relates_to_relation IF NOT EXISTS FOR ()-[r:RELATES_TO]-() ON (r.relation)");
		} finally {
			await session.close();
		}
	}

	// Applies a whole payload in ONE transaction: relation deletes, node deletes, node upserts, relation
	// upserts. Either everything is committed or nothing is. Deletes of items that are already gone are
	// no-ops, so applying the same payload again is safe. Returns what Neo4j actually stored, so vector
	// documents match the graph exactly (same as a reindex).
	async applyGraph(graphPayload) {
		await this.ensureConstraints();
		const session = this.driver.session(this.sessionOptions);
		const now = new Date().toISOString();
		const storedNodes = [];
		const storedRelations = [];
		const deletedNodeIds = new Set();
		const deletedRelationIds = new Set();

		try {
			await session.executeWrite(async (tx) => {
				// executeWrite may retry the function on transient errors, so start from empty results.
				storedNodes.length = 0;
				storedRelations.length = 0;
				deletedNodeIds.clear();
				deletedRelationIds.clear();

				for (const relationDelete of graphPayload.relationDeletes ?? []) {
					await tx.run("MATCH ()-[r:RELATES_TO {id: $id}]->() DELETE r", { id: relationDelete.id });
					deletedRelationIds.add(relationDelete.id);
				}

				for (const nodeDelete of graphPayload.nodeDeletes ?? []) {
					const deleteResult = await tx.run(
						`
						MATCH (n:KnowledgeNode {id: $id})
						OPTIONAL MATCH (n)-[r:RELATES_TO]-()
						WITH n, collect(r.id) AS relationIds
						DETACH DELETE n
						RETURN relationIds
						`,
						{ id: nodeDelete.id },
					);
					deletedNodeIds.add(nodeDelete.id);
					for (const relationId of deleteResult.records[0]?.get("relationIds") ?? []) {
						if (relationId) {
							deletedRelationIds.add(relationId);
						}
					}
				}

				for (const node of graphPayload.nodes ?? []) {
					const nodeResult = await tx.run(
						`
						MERGE (n:KnowledgeNode {id: $id})
						ON CREATE SET n.createdAt = $now
						SET n.label = $label,
								n.name = $name,
								n.type = $type,
								n.description = CASE WHEN $description = "" THEN coalesce(n.description, "") ELSE $description END,
								n.scope = CASE WHEN size($scope) = 0 THEN n.scope ELSE $scope END,
								n.updatedAt = $now
						RETURN n
						`,
						{
							...node,
							description: compactString(node.description),
							scope: parseScope(node.scope),
							now,
						},
					);
					storedNodes.push(...nodeResult.records.map((record) => formatNode(record.get("n"))));
				}

				for (const relation of graphPayload.relations ?? []) {
					const relationResult = await tx.run(
						`
						MATCH (source:KnowledgeNode {id: $sourceId})
						MATCH (target:KnowledgeNode {id: $targetId})
						MERGE (source)-[r:RELATES_TO {id: $id}]->(target)
						ON CREATE SET r.createdAt = $now
						SET r.sourceId = $sourceId,
								r.targetId = $targetId,
								r.relation = $relation,
								r.information = CASE WHEN $information = "" THEN coalesce(r.information, "") ELSE $information END,
								r.description = CASE WHEN $description = "" THEN coalesce(r.description, "") ELSE $description END,
								r.scope = CASE WHEN size($scope) = 0 THEN r.scope ELSE $scope END,
								r.updatedAt = $now
						RETURN r, source.id AS sourceId, target.id AS targetId
						`,
						{
							...relation,
							information: compactString(relation.information),
							description: compactString(relation.description),
							scope: parseScope(relation.scope),
							now,
						},
					);
					// Endpoints are checked before apply; a missing one here means the graph changed meanwhile.
					if (relationResult.records.length === 0) {
						const error = new Error(`Relation ${relation.sourceId} -> ${relation.targetId} was not stored: an endpoint node does not exist.`);
						error.status = 409;
						throw error;
					}
					storedRelations.push(...relationResult.records.map((record) => (
						formatRelationshipWithEndpoints(record.get("r"), record.get("sourceId"), record.get("targetId"))
					)));
				}
			});

			return {
				nodes: storedNodes,
				relations: storedRelations,
				deletedNodeIds: [...deletedNodeIds],
				deletedRelationIds: [...deletedRelationIds],
			};
		} finally {
			await session.close();
		}
	}

	// Breadth-first expansion: one query per hop, so the cost follows the size of the neighbourhood instead of
	// the number of paths (a variable-length path query explodes on dense graphs). Returns the start nodes,
	// every node within `depth` hops (each with its hop `distance`), and every relation traversed.
	// Options (explore_graph): direction "both" | "out" | "in", relationTypes, nodeTypes, limit (max nodes),
	// scope (a scope filter value: neighbours and relations scoped only to other values are not followed).
	async expandFromNodes(nodeIds, depth, { direction = "both", relationTypes = [], nodeTypes = [], limit = EXPANSION_NODE_LIMIT, scope = "" } = {}) {
		const safeDepth = Math.max(0, Math.min(Number(depth) || 0, 8));
		const ids = [...new Set((nodeIds ?? []).filter(Boolean))];
		const pattern = direction === "out"
			? "(n)-[r:RELATES_TO]->(m:KnowledgeNode)"
			: direction === "in"
				? "(n)<-[r:RELATES_TO]-(m:KnowledgeNode)"
				: "(n)-[r:RELATES_TO]-(m:KnowledgeNode)";
		const session = this.driver.session(this.sessionOptions);
		const nodes = new Map();
		const relations = new Map();
		let truncated = false;

		try {
			const startResult = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode) WHERE n.id IN $ids RETURN n", { ids }),
			);
			for (const record of startResult.records) {
				const node = formatNode(record.get("n"));
				nodes.set(node.id, { ...node, distance: 0 });
			}

			let frontier = [...nodes.keys()];
			for (let hop = 1; hop <= safeDepth && frontier.length > 0; hop += 1) {
				const hopResult = await session.executeRead((tx) =>
					tx.run(
						`
						MATCH (n:KnowledgeNode)
						WHERE n.id IN $frontier
						MATCH ${pattern}
						WHERE (size($relationTypes) = 0 OR r.relation IN $relationTypes)
							AND (size($nodeTypes) = 0 OR m.type IN $nodeTypes)
							AND ${scopeCondition("m")}
							AND ${scopeCondition("r")}
						RETURN r, startNode(r).id AS sourceId, endNode(r).id AS targetId, m
						`,
						{ frontier, relationTypes, nodeTypes, scopeValues: scopeMatchValues(scope) },
					),
				);
				const next = [];
				for (const record of hopResult.records) {
					const neighbour = formatNode(record.get("m"));
					if (!nodes.has(neighbour.id)) {
						if (nodes.size >= limit) {
							truncated = true;
							continue;
						}
						nodes.set(neighbour.id, { ...neighbour, distance: hop });
						next.push(neighbour.id);
					}
					const relation = formatRelationshipWithEndpoints(record.get("r"), record.get("sourceId"), record.get("targetId"));
					relations.set(relation.id, relation);
				}
				frontier = next;
			}

			return { nodes: [...nodes.values()], relations: [...relations.values()], truncated };
		} finally {
			await session.close();
		}
	}

	// Shortest paths between two nodes, in either direction, up to maxDepth (1..6) relations.
	async findPaths(fromId, toId, { maxDepth = 4, relationTypes = [], limit = 5 } = {}) {
		const depth = Math.max(1, Math.min(Number(maxDepth) || 4, 6));
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (a:KnowledgeNode {id: $fromId}), (b:KnowledgeNode {id: $toId})
					MATCH p = allShortestPaths((a)-[:RELATES_TO*..${depth}]-(b))
					WHERE size($relationTypes) = 0 OR all(r IN relationships(p) WHERE r.relation IN $relationTypes)
					RETURN nodes(p) AS pathNodes,
						[r IN relationships(p) | {relationship: r, sourceId: startNode(r).id, targetId: endNode(r).id}] AS pathRelations
					LIMIT $limit
					`,
					{ fromId, toId, relationTypes, limit: neo4j.int(Math.max(1, Math.min(Number(limit) || 5, 20))) },
				),
			);

			return result.records.map((record) => ({
				nodes: record.get("pathNodes").map(formatNode),
				relations: record.get("pathRelations").map((item) => formatRelationshipWithEndpoints(item.relationship, item.sourceId, item.targetId)),
			}));
		} finally {
			await session.close();
		}
	}

	// Runs an agent's Cypher only if Neo4j itself reports it as read-only (EXPLAIN query type "r"), in a read
	// transaction with a timeout, returning at most `limit` rows as plain JSON values.
	async runReadOnlyQuery(cypher, params = {}, { limit = 100, timeoutMs = 10000 } = {}) {
		const text = String(cypher ?? "").trim();
		if (!text) {
			throw httpError("A Cypher query is required.", 400);
		}
		if (/\bLOAD\s+CSV\b/i.test(text) || /\b(dbms|apoc)\s*\./i.test(text)) {
			throw httpError("LOAD CSV, dbms.* and apoc.* are not allowed in query_cypher.", 400);
		}
		// SHOW SETTINGS, SHOW TRANSACTIONS and similar reveal server configuration or other sessions, not graph knowledge.
		if (/^\s*SHOW\b/i.test(text) && !/^\s*SHOW\s+(?:\w+\s+)?(?:INDEX|INDEXES|CONSTRAINT|CONSTRAINTS)\b/i.test(text)) {
			throw httpError("Only SHOW INDEXES and SHOW CONSTRAINTS are allowed in query_cypher.", 400);
		}

		const session = this.driver.session({ ...this.sessionOptions, defaultAccessMode: neo4j.session.READ });
		try {
			let plan;
			try {
				plan = await session.run(`EXPLAIN ${text}`, params);
			} catch (error) {
				throw httpError(`Invalid Cypher: ${error.message}`, 400);
			}
			const queryType = plan.summary.queryType;
			if (queryType !== "r") {
				throw httpError(`query_cypher runs read-only queries only; Neo4j reports this query as "${queryType}" (r = read, rw/w = write, s = schema).`, 400);
			}

			return await session.executeRead(async (tx) => {
				const result = tx.run(text, params);
				const rows = [];
				let truncated = false;
				for await (const record of result) {
					if (rows.length >= limit) {
						truncated = true;
						break;
					}
					rows.push(Object.fromEntries(record.keys.map((key) => [key, toPlainValue(record.get(key))])));
				}
				return { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows, truncated };
			}, { timeout: timeoutMs });
		} finally {
			await session.close();
		}
	}

	async getGraphPreview(limit = 150) {
		const session = this.driver.session(this.sessionOptions);
		const safeLimit = Math.max(1, Math.min(Number(limit) || 150, 500));

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (n:KnowledgeNode)
					WITH n
					ORDER BY coalesce(n.updatedAt, n.createdAt, "") DESC, n.label ASC
					LIMIT $limit
					WITH collect(n) AS nodes
					OPTIONAL MATCH (source:KnowledgeNode)-[relationship:RELATES_TO]->(target:KnowledgeNode)
					WHERE source IN nodes AND target IN nodes
					RETURN nodes, collect(DISTINCT relationship) AS relationships
					`,
					{ limit: neo4j.int(safeLimit) },
				),
			);

			if (result.records.length === 0) {
				return { nodes: [], relations: [] };
			}

			const record = result.records[0];
			const nodes = (record.get("nodes") ?? []).filter(Boolean).map(formatNode);
			const relations = (record.get("relationships") ?? []).filter(Boolean).map(formatRelationship);

			return { nodes, relations };
		} finally {
			await session.close();
		}
	}

	async getGraphSnapshot(limit = 5000) {
		const session = this.driver.session(this.sessionOptions);
		const safeLimit = Math.max(1, Math.min(Number(limit) || 5000, 10000));

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (n:KnowledgeNode)
					WITH n
					ORDER BY coalesce(n.updatedAt, n.createdAt, "") DESC, n.label ASC
					LIMIT $limit
					WITH collect(n) AS nodes
					OPTIONAL MATCH (source:KnowledgeNode)-[relationship:RELATES_TO]->(target:KnowledgeNode)
					WHERE source IN nodes AND target IN nodes
					RETURN nodes, collect(DISTINCT relationship) AS relationships
					`,
					{ limit: neo4j.int(safeLimit) },
				),
			);

			if (result.records.length === 0) {
				return { nodes: [], relations: [] };
			}

			const record = result.records[0];
			const nodes = (record.get("nodes") ?? []).filter(Boolean).map(formatNode);
			const relations = (record.get("relationships") ?? []).filter(Boolean).map(formatRelationship);

			return { nodes, relations };
		} finally {
			await session.close();
		}
	}

	async getRandomNode() {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (n:KnowledgeNode)
					RETURN n
					ORDER BY rand()
					LIMIT 1
					`,
				),
			);

			return result.records[0] ? formatNode(result.records[0].get("n")) : null;
		} finally {
			await session.close();
		}
	}

	// Case-insensitive substring match on id, label, name, type, and description; exact label/name matches first.
	async searchNodes(query, limit = 20, { type = "", scope = "" } = {}) {
		const session = this.driver.session(this.sessionOptions);
		const text = compactString(query).toLowerCase();
		const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));

		if (!text) {
			return [];
		}

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (n:KnowledgeNode)
					WHERE ($type = "" OR n.type = $type)
						AND ${scopeCondition("n")}
						AND (toLower(coalesce(n.id, "")) CONTAINS $query
						OR toLower(coalesce(n.label, "")) CONTAINS $query
						OR toLower(coalesce(n.name, "")) CONTAINS $query
						OR toLower(coalesce(n.type, "")) CONTAINS $query
						OR toLower(coalesce(n.description, "")) CONTAINS $query)
					RETURN n
					ORDER BY
						CASE
							WHEN toLower(coalesce(n.label, "")) = $query THEN 0
							WHEN toLower(coalesce(n.name, "")) = $query THEN 1
							WHEN toLower(coalesce(n.label, "")) STARTS WITH $query THEN 2
							WHEN toLower(coalesce(n.name, "")) STARTS WITH $query THEN 3
							ELSE 4
						END,
						n.label ASC
					LIMIT $limit
					`,
					{ query: text, type: compactString(type), scopeValues: scopeMatchValues(scope), limit: neo4j.int(safeLimit) },
				),
			);

			return result.records.map((record) => formatNode(record.get("n")));
		} finally {
			await session.close();
		}
	}

	async getNodesByIds(nodeIds) {
		const ids = [...new Set((nodeIds ?? []).filter(Boolean))];
		if (ids.length === 0) {
			return [];
		}

		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode) WHERE n.id IN $ids RETURN n", { ids }),
			);

			return result.records.map((record) => formatNode(record.get("n")));
		} finally {
			await session.close();
		}
	}

	async getRelationsByIds(relationIds) {
		const ids = [...new Set((relationIds ?? []).filter(Boolean))];
		if (ids.length === 0) {
			return [];
		}

		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (source:KnowledgeNode)-[relationship:RELATES_TO]->(target:KnowledgeNode)
					WHERE relationship.id IN $ids
					RETURN relationship, source.id AS sourceId, target.id AS targetId
					`,
					{ ids },
				),
			);

			return result.records.map((record) => formatRelationshipWithEndpoints(record.get("relationship"), record.get("sourceId"), record.get("targetId")));
		} finally {
			await session.close();
		}
	}

	// How many nodes use each node type and how many relations use each relation type.
	async countByType() {
		const session = this.driver.session(this.sessionOptions);

		try {
			const nodeResult = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode) RETURN n.type AS type, count(n) AS count ORDER BY count DESC, type ASC"),
			);
			const relationResult = await session.executeRead((tx) =>
				tx.run("MATCH ()-[r:RELATES_TO]->() RETURN r.relation AS type, count(r) AS count ORDER BY count DESC, type ASC"),
			);
			const rows = (result) => result.records.map((record) => ({
				type: record.get("type") ?? "",
				count: neo4j.integer.toNumber(record.get("count")),
			}));

			return { nodeTypes: rows(nodeResult), relationTypes: rows(relationResult) };
		} finally {
			await session.close();
		}
	}

	// Admin wipe: deletes every KnowledgeNode and its relations (MindMesh's data only; other labels in the
	// same database are left alone), in batches so a large graph does not need one huge transaction.
	async deleteAllKnowledge() {
		await this.ensureConstraints();
		const session = this.driver.session(this.sessionOptions);

		try {
			const before = await session.run(`
				MATCH (n:KnowledgeNode)
				OPTIONAL MATCH (n)-[r:RELATES_TO]->()
				RETURN count(DISTINCT n) AS nodes, count(r) AS relations
			`);
			await session.run("MATCH (n:KnowledgeNode) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS");
			const record = before.records[0];
			return {
				deletedNodes: neo4j.integer.toNumber(record.get("nodes")),
				deletedRelations: neo4j.integer.toNumber(record.get("relations")),
			};
		} finally {
			await session.close();
		}
	}

	// Every node and relation id, for the admin consistency check against the vector index.
	async listIds() {
		const session = this.driver.session(this.sessionOptions);

		try {
			const nodes = await session.executeRead((tx) => tx.run("MATCH (n:KnowledgeNode) RETURN n.id AS id"));
			const relations = await session.executeRead((tx) => tx.run("MATCH ()-[r:RELATES_TO]->() RETURN r.id AS id"));
			return {
				nodeIds: nodes.records.map((record) => record.get("id")),
				relationIds: relations.records.map((record) => record.get("id")),
			};
		} finally {
			await session.close();
		}
	}

	// Version, edition, database, data outside MindMesh, constraints, and indexes, for the admin overview.
	async getDatabaseInfo() {
		const session = this.driver.session(this.sessionOptions);

		try {
			const component = (await session.run("CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition")).records[0];
			const other = (await session.run("MATCH (n) WHERE NOT n:KnowledgeNode RETURN count(n) AS count")).records[0];
			const constraints = await session.run("SHOW CONSTRAINTS YIELD name, type, entityType, labelsOrTypes, properties RETURN name, type, entityType, labelsOrTypes, properties");
			const indexes = await session.run("SHOW INDEXES YIELD name, type, state, entityType, labelsOrTypes, properties RETURN name, type, state, entityType, labelsOrTypes, properties");
			const rows = (result) => result.records.map((record) => Object.fromEntries(record.keys.map((key) => [key, toPlainValue(record.get(key))])));

			return {
				name: component?.get("name") ?? "",
				version: component?.get("version") ?? "",
				edition: component?.get("edition") ?? "",
				database: this.config.database || "(default)",
				nodesOutsideMindMesh: neo4j.integer.toNumber(other.get("count")),
				constraints: rows(constraints),
				indexes: rows(indexes),
			};
		} finally {
			await session.close();
		}
	}

	async getNode(nodeId) {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode {id: $nodeId}) RETURN n", { nodeId }),
			);

			return result.records[0] ? formatNode(result.records[0].get("n")) : null;
		} finally {
			await session.close();
		}
	}

	async getExistingNodeIds(nodeIds) {
		const ids = [...new Set((nodeIds ?? []).filter(Boolean))];
		if (ids.length === 0) {
			return [];
		}

		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode) WHERE n.id IN $ids RETURN n.id AS id", { ids }),
			);

			return result.records.map((record) => record.get("id"));
		} finally {
			await session.close();
		}
	}

	async getNodeNeighborhood(nodeId, depth = 1) {
		return this.expandFromNodes([nodeId], depth);
	}

	async getRelationsForNode(nodeId) {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (source:KnowledgeNode)-[relationship:RELATES_TO]->(target:KnowledgeNode)
					WHERE source.id = $nodeId OR target.id = $nodeId
					RETURN relationship, source.id AS sourceId, target.id AS targetId
					ORDER BY relationship.relation ASC
					`,
					{ nodeId },
				),
			);

			return result.records.map((record) => formatRelationshipWithEndpoints(
				record.get("relationship"),
				record.get("sourceId"),
				record.get("targetId"),
			));
		} finally {
			await session.close();
		}
	}

	async getRelation(relationId) {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (source:KnowledgeNode)-[relationship:RELATES_TO {id: $relationId}]->(target:KnowledgeNode)
					RETURN relationship, source.id AS sourceId, target.id AS targetId
					`,
					{ relationId },
				),
			);

			if (result.records.length === 0) {
				return null;
			}

			const record = result.records[0];
			return formatRelationshipWithEndpoints(record.get("relationship"), record.get("sourceId"), record.get("targetId"));
		} finally {
			await session.close();
		}
	}

	async upsertNode(node) {
		await this.ensureConstraints();
		const session = this.driver.session(this.sessionOptions);
		const now = new Date().toISOString();

		try {
			const result = await session.executeWrite((tx) =>
				tx.run(
					`
					MERGE (n:KnowledgeNode {id: $id})
					ON CREATE SET n.createdAt = $now
					SET n.label = $label,
							n.name = $name,
							n.type = $type,
							n.description = $description,
							n.scope = CASE WHEN size($scope) = 0 THEN null ELSE $scope END,
							n.updatedAt = $now
					RETURN n
					`,
					{
						id: node.id,
						label: compactString(node.label),
						name: compactString(node.name),
						type: compactString(node.type),
						description: compactString(node.description),
						scope: parseScope(node.scope),
						now,
					},
				),
			);

			return formatNode(result.records[0].get("n"));
		} finally {
			await session.close();
		}
	}

	async deleteNode(nodeId) {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeWrite((tx) =>
				tx.run(
					`
					MATCH (n:KnowledgeNode {id: $nodeId})
					OPTIONAL MATCH (n)-[relationship:RELATES_TO]-()
					WITH n, collect(relationship.id) AS relationIds
					DETACH DELETE n
					RETURN relationIds
					`,
					{ nodeId },
				),
			);

			return {
				nodeId,
				relationIds: [...new Set((result.records[0]?.get("relationIds") ?? []).filter(Boolean))],
			};
		} finally {
			await session.close();
		}
	}

	// Writes the relation exactly as given. With `replaceId` (a direct edit that changed the relation's id),
	// the old relation is deleted in the same transaction, so a failed write never loses it. The earliest
	// createdAt of the replaced relations is kept.
	async upsertRelation(relation, { replaceId = "" } = {}) {
		await this.ensureConstraints();
		const session = this.driver.session(this.sessionOptions);
		const now = new Date().toISOString();
		const replaceIds = [...new Set([relation.id, replaceId].filter(Boolean))];

		try {
			const result = await session.executeWrite((tx) =>
				tx.run(
					`
					MATCH (source:KnowledgeNode {id: $sourceId})
					MATCH (target:KnowledgeNode {id: $targetId})
					OPTIONAL MATCH ()-[old:RELATES_TO]->()
					WHERE old.id IN $replaceIds
					WITH source, target, collect(old) AS olds
					WITH source, target, olds, coalesce(reduce(earliest = null, o IN olds |
						CASE WHEN earliest IS NULL OR o.createdAt < earliest THEN o.createdAt ELSE earliest END), $now) AS createdAt
					FOREACH (o IN olds | DELETE o)
					CREATE (source)-[relationship:RELATES_TO {
						id: $id,
						sourceId: $sourceId,
						targetId: $targetId,
						relation: $relation,
						information: $information,
						description: $description,
						scope: CASE WHEN size($scope) = 0 THEN null ELSE $scope END,
						createdAt: createdAt,
						updatedAt: $now
					}]->(target)
					RETURN relationship, source.id AS sourceId, target.id AS targetId
					`,
					{
						id: relation.id,
						sourceId: relation.sourceId,
						targetId: relation.targetId,
						relation: compactString(relation.relation),
						information: compactString(relation.information),
						description: compactString(relation.description),
						scope: parseScope(relation.scope),
						replaceIds,
						now,
					},
				),
			);

			if (result.records.length === 0) {
				const error = new Error("Source or target node was not found.");
				error.status = 404;
				throw error;
			}

			const record = result.records[0];
			return formatRelationshipWithEndpoints(record.get("relationship"), record.get("sourceId"), record.get("targetId"));
		} finally {
			await session.close();
		}
	}

	async deleteRelation(relationId) {
		const session = this.driver.session(this.sessionOptions);

		try {
			const result = await session.executeWrite((tx) =>
				tx.run(
					`
					MATCH ()-[relationship:RELATES_TO {id: $relationId}]->()
					DELETE relationship
					RETURN $relationId AS relationId
					`,
					{ relationId },
				),
			);

			if (result.records.length === 0) {
				const error = new Error("Relation was not found.");
				error.status = 404;
				throw error;
			}

			return { relationId };
		} finally {
			await session.close();
		}
	}

	async smokeTest() {
		const session = this.driver.session(this.sessionOptions);
		const id = `node:kg_poc_smoke_${Date.now()}`;

		try {
			await session.executeWrite((tx) =>
				tx.run(
					`
					CREATE (n:KnowledgeNode {
						id: $id,
						label: "KG POC Smoke",
						name: "kg_poc_smoke",
						type: "smoke_test",
						description: "Temporary connection test node",
						createdAt: $now,
						updatedAt: $now
					})
					RETURN n
					`,
					{ id, now: new Date().toISOString() },
				),
			);

			const readResult = await session.executeRead((tx) =>
				tx.run("MATCH (n:KnowledgeNode {id: $id}) RETURN n", { id }),
			);

			if (readResult.records.length !== 1) {
				throw new Error("Neo4j smoke node was not readable after write.");
			}
		} finally {
			await session.executeWrite((tx) =>
				tx.run("MATCH (n:KnowledgeNode {id: $id}) DETACH DELETE n", { id }),
			);
			await session.close();
		}
	}

	async close() {
		await this.driver.close();
	}
}
