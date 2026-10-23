import { getConfig, describeRuntime } from "../config.js";
import { readInput } from "../input/readInput.js";
import { createMindMesh } from "../mindmesh.js";

const FALLBACK_QUESTION = "What does the EKYC screen use?";

async function main() {
	const input = await readInput({
		argv: process.argv.slice(2),
		fallback: FALLBACK_QUESTION,
		prompt: "Question: ",
	});
	const config = getConfig();
	const services = createMindMesh(config, { llmProviderName: input.options.provider });

	try {
		const result = await services.ragService.answer({ query: input.text, source: input.source, scope: input.options.scope || "" });

		console.log("MindMesh answer complete.");
		console.log(JSON.stringify({
			...describeRuntime(config),
			llmProvider: input.options.provider || config.llm.provider,
			inputSource: input.source,
			topK: config.rag.topK,
			depth: result.depth,
			entryNodes: result.entryNodes.map((node) => ({
				id: node.id,
				label: node.metadata.label,
				name: node.metadata.name,
				distance: node.distance,
			})),
			expandedNodes: result.graph.nodes.length,
			expandedRelations: result.graph.relations.length,
		}, null, 2));

		console.log("\nAnswer:");
		console.log(result.answer);
	} finally {
		await services.close();
	}
}

main().catch((error) => {
	console.error("MindMesh ask failed.");
	console.error(error.message);
	process.exit(1);
});
