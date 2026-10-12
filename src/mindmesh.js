import path from "node:path";
import { fileURLToPath } from "node:url";
import { GraphReadService } from "./graph/graphReadService.js";
import { GraphWriteService } from "./graph/graphWriteService.js";
import { createGraphStore } from "./graph/providerFactory.js";
import { HitlService } from "./hitl/hitlService.js";
import { IngestionService } from "./ingestion/ingestionService.js";
import { KgJobsService } from "./jobs/kgJobsService.js";
import { createLlmProvider } from "./llm/providerFactory.js";
import { loadPrompts } from "./prompts/promptRegistry.js";
import { HybridRagService } from "./rag/hybridRagService.js";
import { createVectorStore } from "./vector/providerFactory.js";

// Composition root: builds the stores and services once, for the web server, the MCP server, and the CLIs.
// `overrides` replaces individual parts (tests pass in-memory stores and a fake LLM).
// `withLlm: false` creates no LLM provider; the MCP server uses it, because the calling agent does the reasoning.
export function createMindMesh(config, overrides = {}) {
	const { withLlm = true, llmProviderName } = overrides;
	const prompts = overrides.prompts ?? loadPrompts(config);
	const llmProvider = overrides.llmProvider !== undefined
		? overrides.llmProvider
		: (withLlm ? createLlmProvider(config, llmProviderName) : null);
	const graphStore = overrides.graphStore ?? createGraphStore(config);
	const vectorStore = overrides.vectorStore ?? createVectorStore(config);
	const graphWriteService = new GraphWriteService({ graphStore, vectorStore });
	const graphReadService = new GraphReadService({ graphStore, vectorStore, schemaConfig: config });

	const ingestionService = new IngestionService({
		llmProvider,
		graphStore,
		vectorStore,
		prompts,
		logging: config.logging,
		ingestion: config.ingestion,
	});
	const hitlService = new HitlService({
		ingestionService,
		graphStore,
		vectorStore,
		graphWriter: graphWriteService,
		schemaConfig: config,
		logging: config.logging,
	});
	const ragService = new HybridRagService({
		llmProvider,
		graphStore,
		vectorStore,
		prompts,
		topK: config.rag?.topK,
		depth: config.rag?.depth,
		logging: config.logging,
		memoryEnabled: config.rag?.memory?.enabled,
		memoryMaxMessages: config.rag?.memory?.maxMessages,
		memoryMaxMessageChars: config.rag?.memory?.maxMessageChars,
	});
	const jobsService = new KgJobsService({
		llmProvider,
		graphStore,
		prompts,
	});

	return {
		config,
		prompts,
		llmProvider,
		graphStore,
		vectorStore,
		graphReadService,
		graphWriteService,
		ingestionService,
		hitlService,
		ragService,
		jobsService,
		async close() {
			await graphStore.close?.();
			await vectorStore.close?.();
		},
	};
}

// True when the given module (pass `import.meta.url`) is the script Node was started with, so a module can
// export factories for tests and still start itself when run directly.
export function isMainModule(moduleUrl) {
	if (!process.argv[1]) {
		return false;
	}

	const normalize = (filePath) => {
		const resolved = path.resolve(filePath);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	return normalize(fileURLToPath(moduleUrl)) === normalize(process.argv[1]);
}
