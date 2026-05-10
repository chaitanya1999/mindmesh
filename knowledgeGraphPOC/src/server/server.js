import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig, describeRuntime } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { IngestionService } from "../ingestion/ingestionService.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { HybridRagService } from "../rag/hybridRagService.js";
import { createVectorStore } from "../vector/providerFactory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const DEFAULT_GRAPH_LIMIT = 150;

function parseLimit(value) {
	return Math.max(1, Math.min(Number(value) || DEFAULT_GRAPH_LIMIT, 500));
}

function requireText(body) {
	const text = String(body?.text ?? "").trim();
	if (!text) {
		const error = new Error("Text is required.");
		error.status = 400;
		throw error;
	}

	return text;
}

function buildTriplets(graph) {
	const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

	return graph.relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);

		return {
			sourceId: relation.sourceId,
			sourceLabel: source?.label ?? relation.sourceId,
			relation: relation.relation,
			targetId: relation.targetId,
			targetLabel: target?.label ?? relation.targetId,
			information: relation.information ?? "",
		};
	});
}

function asyncRoute(handler) {
	return async (req, res, next) => {
		try {
			await handler(req, res);
		} catch (error) {
			next(error);
		}
	};
}

const config = getConfig();
const prompts = loadPrompts(config);
const llmProvider = createLlmProvider(config);
const graphStore = createGraphStore(config);
const vectorStore = createVectorStore(config);
const ingestionService = new IngestionService({
	llmProvider,
	graphStore,
	vectorStore,
	prompts,
	logging: config.logging,
});
const ragService = new HybridRagService({
	llmProvider,
	graphStore,
	vectorStore,
	prompts,
	topK: config.rag.topK,
	depth: config.rag.depth,
});

const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

app.get("/api/graph", asyncRoute(async (req, res) => {
	const limit = parseLimit(req.query.limit);
	const graph = await graphStore.getGraphPreview(limit);

	res.json({
		...graph,
		limit,
	});
}));

app.post("/api/ask", asyncRoute(async (req, res) => {
	const text = requireText(req.body);
	const result = await ragService.answer({ query: text });

	res.json({
		answer: result.answer,
		entryNodes: result.entryNodes,
		graph: result.graph,
		depth: result.depth,
	});
}));

app.post("/api/ingest", asyncRoute(async (req, res) => {
	const text = requireText(req.body);
	const storedGraph = await ingestionService.ingestText({ text, source: "web" });
	const graph = await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT);

	res.json({
		nodes: storedGraph.nodes,
		relations: storedGraph.relations,
		triplets: buildTriplets(storedGraph),
		schemaSuggestions: storedGraph.schemaSuggestions,
		schemaWarnings: storedGraph.schemaWarnings,
		persistedSchemaSuggestions: storedGraph.persistedSchemaSuggestions,
		graph,
	});
}));

app.use((req, res) => {
	res.status(404).json({ error: "Not found." });
});

app.use((error, req, res, _next) => {
	const status = Number(error.status) || 500;
	const message = status >= 500 ? "Server error. Check the terminal for details." : error.message;

	if (status >= 500) {
		console.error(error);
	}

	res.status(status).json({ error: message });
});

const port = Number(process.env.KG_WEB_PORT || process.env.PORT || 3000);
const server = app.listen(port, () => {
	console.log("Knowledge Graph POC web server started.");
	console.log(JSON.stringify({
		...describeRuntime(config),
		port,
		url: `http://localhost:${port}`,
	}, null, 2));
});

async function shutdown(signal) {
	console.log(`\nReceived ${signal}. Closing Knowledge Graph POC web server.`);
	server.close(async () => {
		try {
			await graphStore.close();
			process.exit(0);
		} catch (error) {
			console.error(error);
			process.exit(1);
		}
	});
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
