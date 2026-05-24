import { getConfig, describeRuntime } from "../config.js";
import { readInput } from "../input/readInput.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";
import { IngestionService } from "../ingestion/ingestionService.js";

const FALLBACK_TEXT = "EKYC Screen uses PAN Verification API. PAN Verification API validates customer PAN details for onboarding.";

async function main() {
	const input = await readInput({
		argv: process.argv.slice(2),
		fallback: FALLBACK_TEXT,
		prompt: "Text to ingest: ",
	});
	const config = getConfig();
	const prompts = loadPrompts(config);
	const llmProvider = createLlmProvider(config, input.options.provider);
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);

	try {
		const service = new IngestionService({
			llmProvider,
			graphStore,
			vectorStore,
			prompts,
			logging: config.logging,
			ingestion: config.ingestion,
		});
		const graph = await service.ingestText({
			text: input.text,
			source: input.source,
			userName: config.ingestion.hitlDefaultUserName || "cli-user",
		});

		console.log(graph.status === "pending_hitl"
			? "MindMesh ingestion proposal stored for HITL review."
			: "MindMesh ingestion complete.");
		console.log(JSON.stringify({
			...describeRuntime(config),
			llmProvider: input.options.provider || config.llm.provider,
			inputSource: input.source,
			status: graph.status || "applied",
			applied: graph.applied ?? true,
			hitlNoteId: graph.hitlNote?.id,
			nodes: graph.nodes.length,
			relations: graph.relations.length,
			nodeDeletes: graph.nodeDeletes?.length ?? 0,
			relationDeletes: graph.relationDeletes?.length ?? 0,
			deletedNodeIds: graph.deletedNodeIds ?? [],
			deletedRelationIds: graph.deletedRelationIds ?? [],
			schemaSuggestions: {
				nodeTypes: graph.schemaSuggestions?.nodeTypes?.length ?? 0,
				relationshipTypes: graph.schemaSuggestions?.relationshipTypes?.length ?? 0,
			},
			schemaWarnings: graph.schemaWarnings?.length ?? 0,
			persistedSchemaSuggestions: graph.persistedSchemaSuggestions,
		}, null, 2));

		console.log("\nExtracted nodes:");
		for (const node of graph.nodes) {
			console.log(`- ${node.id} | ${node.label} | ${node.name} | ${node.type}`);
		}

		console.log("\nExtracted relations:");
		for (const relation of graph.relations) {
			console.log(`- ${relation.id} | ${relation.sourceId} -[${relation.relation}]-> ${relation.targetId}`);
		}

		if (graph.schemaWarnings?.length > 0) {
			console.log("\nSchema warnings:");
			for (const warning of graph.schemaWarnings) {
				console.log(`- ${warning}`);
			}
		}

		const suggestedNodeTypes = graph.schemaSuggestions?.nodeTypes ?? [];
		const suggestedRelationshipTypes = graph.schemaSuggestions?.relationshipTypes ?? [];
		if (suggestedNodeTypes.length > 0 || suggestedRelationshipTypes.length > 0) {
			console.log("\nSchema suggestions:");
			for (const suggestion of suggestedNodeTypes) {
				console.log(`- node type ${suggestion.name}: ${suggestion.description}${suggestion.reason ? ` (${suggestion.reason})` : ""}`);
			}
			for (const suggestion of suggestedRelationshipTypes) {
				console.log(`- relationship type ${suggestion.name}: ${suggestion.description}${suggestion.reason ? ` (${suggestion.reason})` : ""}`);
			}
		}
	} finally {
		await graphStore.close();
	}
}

main().catch((error) => {
	console.error("MindMesh ingestion failed.");
	console.error(error.message);
	process.exit(1);
});
