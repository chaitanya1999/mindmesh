import { getConfig, describeRuntime } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";

async function runCheck(name, check) {
	try {
		await check();
		console.log(`[PASS] ${name}`);
		return true;
	} catch (error) {
		console.log(`[FAIL] ${name}`);
		console.log(`       ${error.message}`);
		return false;
	}
}

async function main() {
	const config = getConfig();
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);

	console.log("Knowledge Graph POC database connection test");
	console.log(JSON.stringify(describeRuntime(config), null, 2));
	console.log("");

	try {
		const results = [];
		results.push(await runCheck("Neo4j connectivity", () => graphStore.verifyConnectivity()));
		results.push(await runCheck("Neo4j write/read/delete smoke test", () => graphStore.smokeTest()));
		results.push(await runCheck("Chroma connectivity", () => vectorStore.verifyConnectivity()));
		results.push(await runCheck("Chroma collection add/query smoke test", () => vectorStore.smokeTest()));

		if (results.some((result) => !result)) {
			process.exitCode = 1;
		}
	} finally {
		await graphStore.close();
	}
}

main().catch((error) => {
	console.error("Knowledge Graph POC database test failed.");
	console.error(error.message);
	process.exit(1);
});
