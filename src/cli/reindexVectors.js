#!/usr/bin/env node

import { getConfig, describeRuntime } from "../config.js";
import { createMindMesh } from "../mindmesh.js";

function parseLimit(argv) {
	const limitIndex = argv.findIndex((arg) => arg === "--limit" || arg === "-l");
	if (limitIndex === -1) {
		return 5000;
	}

	return Math.max(1, Math.min(Number(argv[limitIndex + 1]) || 5000, 10000));
}

async function main() {
	const config = getConfig();
	const services = createMindMesh(config, { withLlm: false });
	const argv = process.argv.slice(2);
	// --fresh empties the node and relation collections first, so vectors of items deleted in Neo4j disappear too.
	const fresh = argv.includes("--fresh");

	try {
		const result = await services.graphWriteService.reindexVectors({ fresh, limit: parseLimit(argv) });

		console.log(fresh ? "Cleared and reindexed graph vectors." : "Reindexed graph vectors.");
		console.log(JSON.stringify({
			...describeRuntime(config),
			...result,
		}, null, 2));
	} finally {
		await services.close();
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
