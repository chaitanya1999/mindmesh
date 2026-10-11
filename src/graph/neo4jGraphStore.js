import neo4j from "neo4j-driver";

function formatNode(node) {
	return {
		id: node.properties.id,
		label: node.properties.label,
		name: node.properties.name,
		type: node.properties.type,
		description: node.properties.description ?? "",
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
								n.updatedAt = $now
						RETURN n
						`,
						{
							...node,
							description: compactString(node.description),
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
								r.updatedAt = $now
						RETURN r, source.id AS sourceId, target.id AS targetId
						`,
						{
							...relation,
							information: compactString(relation.information),
							description: compactString(relation.description),
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

	async expandFromNodes(nodeIds, depth) {
		const session = this.driver.session(this.sessionOptions);
		const safeDepth = Math.max(0, Math.min(Number(depth) || 0, 8));

		try {
			const result = await session.executeRead((tx) =>
				tx.run(
					`
					MATCH (start:KnowledgeNode)
					WHERE start.id IN $nodeIds
					OPTIONAL MATCH path = (start)-[:RELATES_TO*0..${safeDepth}]-(connected:KnowledgeNode)
					WITH collect(DISTINCT start) + collect(DISTINCT connected) AS rawNodes, collect(path) AS paths
					UNWIND rawNodes AS node
					WITH collect(DISTINCT node) AS nodes, paths
					CALL (paths) {
						UNWIND paths AS path
						WITH path
						WHERE path IS NOT NULL
						UNWIND relationships(path) AS relationship
						RETURN collect(DISTINCT relationship) AS relationships
					}
					RETURN nodes, relationships
					`,
					{ nodeIds },
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

	async searchNodes(query, limit = 20) {
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
					WHERE toLower(coalesce(n.id, "")) CONTAINS $query
						OR toLower(coalesce(n.label, "")) CONTAINS $query
						OR toLower(coalesce(n.name, "")) CONTAINS $query
						OR toLower(coalesce(n.type, "")) CONTAINS $query
						OR toLower(coalesce(n.description, "")) CONTAINS $query
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
					{ query: text, limit: neo4j.int(safeLimit) },
				),
			);

			return result.records.map((record) => formatNode(record.get("n")));
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
							n.updatedAt = $now
					RETURN n
					`,
					{
						id: node.id,
						label: compactString(node.label),
						name: compactString(node.name),
						type: compactString(node.type),
						description: compactString(node.description),
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
