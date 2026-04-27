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

export class Neo4jGraphStore {
  constructor(config) {
    this.config = config;
    this.driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
  }

  async verifyConnectivity() {
    await this.driver.verifyConnectivity();
  }

  async upsertGraph(graphPayload) {
    const session = this.driver.session({ database: this.config.database });
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
                n.description = $description,
                n.updatedAt = $now
            `,
            { ...node, now },
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
                r.information = $information,
                r.description = $description,
                r.updatedAt = $now
            `,
            { ...relation, now },
          );
        }
      });

      return graphPayload;
    } finally {
      await session.close();
    }
  }

  async expandFromNodes(nodeIds, depth) {
    const session = this.driver.session({ database: this.config.database });
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

  async smokeTest() {
    const session = this.driver.session({ database: this.config.database });
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
