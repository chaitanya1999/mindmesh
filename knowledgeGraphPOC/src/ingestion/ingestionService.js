import { normalizeGraphPayload } from "./graphPayload.js";
import { createDebugLogger } from "../logging/debugLogger.js";
import { buildExtractionSystemPrompt } from "../prompts/promptRegistry.js";
import { loadGraphSchema, persistGraphSchemaSuggestions, promoteGraphSchemaSuggestions } from "../schema/graphSchema.js";

export class IngestionService {
	constructor({ llmProvider, graphStore, vectorStore, prompts, logging = null }) {
		this.llmProvider = llmProvider;
		this.graphStore = graphStore;
		this.vectorStore = vectorStore;
		this.prompts = prompts;
		this.logging = logging;
	}

	async ingestText({ text, source }) {
		const debugLogger = createDebugLogger({
			...this.logging,
			name: "ingest",
		});
		const graphSchema = loadGraphSchema({ schema: this.prompts.graphSchema });
		const systemPrompt = buildExtractionSystemPrompt(this.prompts.extractionSystemTemplate, graphSchema);
		const extractionPrompt = `Extract graph data from this text:\n\n${text}`;

		debugLogger.section("Runtime", {
			source,
			extractionFormat: this.prompts.extractionFormat,
			schemaAutoApplySuggestions: this.prompts.schemaAutoApplySuggestions,
			schemaPath: graphSchema.path,
		});
		debugLogger.section("Extraction System Prompt", systemPrompt);
		debugLogger.section("Extraction User Prompt", extractionPrompt);

		const extractedGraph = await this.llmProvider.extractGraph({
			text,
			systemPrompt,
			prompt: extractionPrompt,
			debugLogger,
		});
		debugLogger.json("Parsed Extraction Payload", extractedGraph);
		const graphPayload = normalizeGraphPayload(extractedGraph, {
			schema: graphSchema,
			autoApplySuggestions: this.prompts.schemaAutoApplySuggestions,
		});
		debugLogger.json("Normalized Graph Payload", graphPayload);
		graphPayload.persistedSchemaSuggestions = this.prompts.schemaAutoApplySuggestions
			? promoteGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions)
			: persistGraphSchemaSuggestions(graphSchema, graphPayload.schemaSuggestions);
		debugLogger.json("Persisted Schema Suggestions", graphPayload.persistedSchemaSuggestions);
		const storedGraph = await this.graphStore.upsertGraph(graphPayload, { source });
		await this.vectorStore.upsertGraphIndex(storedGraph);

		if (debugLogger.enabled) {
			console.log(`Ingest debug log written to ${debugLogger.path}`);
		}

		return storedGraph;
	}
}
