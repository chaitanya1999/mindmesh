import neo4j from "neo4j-driver";

function formatNode(node) {
	return {
		id: node.properties.id,
		label: node.properties.label,
		name: node.properties.name,
		type: node.properties.type,
		description: node.properties.description ?? "",
		metadata: node.properties.metadata ?? "",
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
		metadata: relationship.properties.metadata ?? "",
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
	// Omitting the database lets Neo4j 3.x / single-database deployments use
	// their default database without triggering multi-database support checks.
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

	async upsertGraph(graphPayload) {
		const session = this.driver.session(this.sessionOptions);
		const now = new Date().toISOString();

		try {
			await session.executeWrite(async (tx) => {
				for (const node of graphPayload.nodes) {
					await tx.run(
						`
						MERGE (n:KnowledgeNode {id: $id})
						ON CREATE SET n.createdAt = $now
						SET n.label = $label,
								n.name = $name,
								n.type = $type,
								n.description = CASE WHEN $description = "" THEN coalesce(n.description, "") ELSE $description END,
								n.metadata = CASE WHEN $metadata = "" THEN coalesce(n.metadata, "") ELSE $metadata END,
								n.updatedAt = $now
						`,
						{
							...node,
							description: compactString(node.description),
							metadata: compactString(node.metadata),
							now,
						},
					);
				}

				for (const relation of graphPayload.relations) {
					await tx.run(
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
								r.metadata = CASE WHEN $metadata = "" THEN coalesce(r.metadata, "") ELSE $metadata END,
								r.updatedAt = $now
						`,
						{
							...relation,
							information: compactString(relation.information),
							description: compactString(relation.description),
							metadata: compactString(relation.metadata),
							now,
						},
					);
				}
			});

			return graphPayload;
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
					CALL {
						WITH paths
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
					WHERE coalesce(n.soft_deleted, false) <> true
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
					WHERE coalesce(n.soft_deleted, false) <> true
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
							n.metadata = $metadata,
							n.updatedAt = $now
					RETURN n
					`,
					{
						id: node.id,
						label: compactString(node.label),
						name: compactString(node.name),
						type: compactString(node.type),
						description: compactString(node.description),
						metadata: compactString(node.metadata),
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

	async upsertRelation(relation) {
		const session = this.driver.session(this.sessionOptions);
		const now = new Date().toISOString();

		try {
			const result = await session.executeWrite((tx) =>
				tx.run(
					`
					MATCH (source:KnowledgeNode {id: $sourceId})
					MATCH (target:KnowledgeNode {id: $targetId})
					OPTIONAL MATCH ()-[old:RELATES_TO {id: $id}]->()
					WITH source, target, old, coalesce(old.createdAt, $now) AS createdAt
					DELETE old
					CREATE (source)-[relationship:RELATES_TO {
						id: $id,
						sourceId: $sourceId,
						targetId: $targetId,
						relation: $relation,
						information: $information,
						description: $description,
						metadata: $metadata,
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
						metadata: compactString(relation.metadata),
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
