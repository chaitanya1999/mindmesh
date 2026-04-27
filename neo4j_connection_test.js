import neo4j from "neo4j-driver";
import crypto from "node:crypto";

const config = {
	instance: process.env.NEO4J_INSTANCE ?? "myGraphDB",
	uri: process.env.NEO4J_URI ?? "bolt://localhost:7687",
	database: process.env.NEO4J_DATABASE ?? "neo4j",
	username: process.env.NEO4J_USERNAME ?? "neo4j",
	password: process.env.NEO4J_PASSWORD ?? "password",
};

function randomId() {
	return crypto.randomUUID();
}

function formatNode(node) {
	return {
		elementId: node.elementId,
		labels: node.labels,
		properties: node.properties,
	};
}

function formatRelationship(relationship) {
	return {
		elementId: relationship.elementId,
		type: relationship.type,
		startNodeElementId: relationship.startNodeElementId,
		endNodeElementId: relationship.endNodeElementId,
		properties: relationship.properties,
	};
}

async function main() {
	const driver = neo4j.driver(config.uri, neo4j.auth.basic(config.username, config.password));
	const session = driver.session({ database: config.database });
	const runId = randomId();

	try {
		await driver.verifyConnectivity();
		console.log(`Connected to Neo4j instance "${config.instance}" at ${config.uri}`);

		const createResult = await session.executeWrite((tx) =>
			tx.run(
				`
        CREATE (source:DemoNode {
          id: $sourceId,
          name: $sourceName,
          createdAt: datetime()
        })
        CREATE (target:DemoNode {
          id: $targetId,
          name: $targetName,
          createdAt: datetime()
        })
        CREATE (source)-[relationship:LINKED_TO {
          id: $relationshipId,
          createdAt: datetime()
        }]->(target)
        RETURN source, relationship, target
        `,
				{
					sourceId: `source-${runId}`,
					sourceName: `Random Source ${runId.slice(0, 8)}`,
					targetId: `target-${runId}`,
					targetName: `Random Target ${runId.slice(0, 8)}`,
					relationshipId: `relationship-${runId}`,
				},
			),
		);

		const created = createResult.records[0];
		console.log("\nCreated:");
		console.log(JSON.stringify(
			{
				source: formatNode(created.get("source")),
				relationship: formatRelationship(created.get("relationship")),
				target: formatNode(created.get("target")),
			},
			null,
			2,
		));

		const retrieveResult = await session.executeRead((tx) =>
			tx.run(
				`
        MATCH (source:DemoNode {id: $sourceId})-[relationship:LINKED_TO]->(target:DemoNode)
        RETURN source, relationship, target
        `,
				{
					sourceId: `source-${runId}`,
				},
			),
		);

		const retrieved = retrieveResult.records[0];
		console.log("\nRetrieved:");
		console.log(JSON.stringify(
			{
				source: formatNode(retrieved.get("source")),
				relationship: formatRelationship(retrieved.get("relationship")),
				target: formatNode(retrieved.get("target")),
			},
			null,
			2,
		));
	} finally {
		await session.close();
		await driver.close();
	}
}

main().catch((error) => {
	console.error("Neo4j connection test failed.");
	console.error(error.message);
	process.exit(1);
});
