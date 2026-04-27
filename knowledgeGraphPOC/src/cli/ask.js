import { getConfig, describeRuntime } from "../config.js";
import { readInput } from "../input/readInput.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";
import { HybridRagService } from "../rag/hybridRagService.js";

const FALLBACK_QUESTION = "What does the EKYC screen use?";

async function main() {
	const input = await readInput({
		argv: process.argv.slice(2),
		fallback: FALLBACK_QUESTION,
		prompt: "Question: ",
	});
	const config = getConfig();
	const prompts = loadPrompts(config);
	const llmProvider = createLlmProvider(config, input.options.provider);
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);

	try {
		const service = new HybridRagService({
			llmProvider,
			graphStore,
			vectorStore,
			prompts,
			topK: config.rag.topK,
			depth: config.rag.depth,
		});
		const result = await service.answer({ query: input.text });

		console.log("Knowledge Graph POC answer complete.");
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
		await graphStore.close();
	}
}

main().catch((error) => {
	console.error("Knowledge Graph POC ask failed.");
	console.error(error.message);
	process.exit(1);
});
