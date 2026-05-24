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
	const limit = parseLimit(process.argv.slice(2));

	try {
		const graph = await graphStore.getGraphSnapshot(limit);
		await vectorStore.upsertGraphIndex(graph);

		console.log("Reindexed graph vectors.");
		console.log(JSON.stringify({
			...describeRuntime(config),
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
