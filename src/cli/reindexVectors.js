#!/usr/bin/env node

import { getConfig, describeRuntime } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";

function parseLimit(argv) {
	const limitIndex = argv.findIndex((arg) => arg === "--limit" || arg === "-l");
	if (limitIndex === -1) {
		return 5000;
	}

	return Math.max(1, Math.min(Number(argv[limitIndex + 1]) || 5000, 10000));
}

async function main() {
	const config = getConfig();
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);
	const argv = process.argv.slice(2);
	const limit = parseLimit(argv);
	// --fresh empties the node and relation collections first, so vectors of items deleted in Neo4j disappear too.
	const fresh = argv.includes("--fresh");

	try {
		// Read the graph before deleting anything, so a Neo4j failure leaves the vector index intact.
		const graph = await graphStore.getGraphSnapshot(limit);
		if (fresh && graph.nodes.length >= limit) {
			throw new Error(`The graph has at least ${limit} nodes, so --fresh would drop vectors beyond the limit. Re-run with a higher --limit.`);
		}
		const clearedCollections = fresh ? await vectorStore.clearGraphIndex() : [];
		await vectorStore.upsertGraphIndex(graph);

		console.log(fresh ? "Cleared and reindexed graph vectors." : "Reindexed graph vectors.");
		console.log(JSON.stringify({
			...describeRuntime(config),
			fresh,
			clearedCollections,
			nodes: graph.nodes.length,
			relations: graph.relations.length,
			limit,
		}, null, 2));
	} finally {
		await graphStore.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
