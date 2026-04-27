import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const POC_CONFIG_PATH = path.join(PROJECT_ROOT, "knowledgeGraphPOC", "config.json");

function readJsonIfExists(filePath) {
	if (!fs.existsSync(filePath)) {
		return {};
	}

	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function firstDefined(...values) {
	return values.find((value) => value !== undefined && value !== null && value !== "");
}

function resolveFromProjectRoot(filePath) {
	if (!filePath || path.isAbsolute(filePath)) {
		return filePath;
	}

	return path.join(PROJECT_ROOT, filePath);
}

export function getConfig() {
	const rootConfig = readJsonIfExists(ROOT_CONFIG_PATH);
	const pocConfig = readJsonIfExists(POC_CONFIG_PATH);

	return {
		llm: {
			provider: firstDefined(process.env.KG_LLM_PROVIDER, pocConfig.llm?.provider, "gemini"),
			gemini: {
				apiKey: firstDefined(process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, pocConfig.llm?.gemini?.apiKey, rootConfig.apiKey),
				model: firstDefined(process.env.GEMINI_MODEL, pocConfig.llm?.gemini?.model, rootConfig.model, "gemini-2.5-flash"),
			},
			ollama: {
				baseUrl: firstDefined(process.env.OLLAMA_BASE_URL, pocConfig.llm?.ollama?.baseUrl, "http://localhost:11434"),
				model: firstDefined(process.env.OLLAMA_MODEL, pocConfig.llm?.ollama?.model, "mistral"),
			},
		},
		graph: {
			provider: firstDefined(process.env.KG_GRAPH_PROVIDER, pocConfig.graph?.provider, "neo4j"),
			neo4j: {
				instance: firstDefined(process.env.NEO4J_INSTANCE, pocConfig.graph?.neo4j?.instance, "myGraphDB"),
				uri: firstDefined(process.env.NEO4J_URI, pocConfig.graph?.neo4j?.uri, "bolt://localhost:7687"),
				database: firstDefined(process.env.NEO4J_DATABASE, pocConfig.graph?.neo4j?.database, "neo4j"),
				username: firstDefined(process.env.NEO4J_USERNAME, pocConfig.graph?.neo4j?.username, "neo4j"),
				password: firstDefined(process.env.NEO4J_PASSWORD, pocConfig.graph?.neo4j?.password, "password"),
			},
		},
		vector: {
			provider: firstDefined(process.env.KG_VECTOR_PROVIDER, pocConfig.vector?.provider, "chroma"),
			chroma: {
				path: firstDefined(process.env.CHROMA_URL, pocConfig.vector?.chroma?.path, "http://localhost:8000"),
				nodeCollection: firstDefined(process.env.CHROMA_NODE_COLLECTION, pocConfig.vector?.chroma?.nodeCollection, "kg_nodes"),
				relationCollection: firstDefined(process.env.CHROMA_RELATION_COLLECTION, pocConfig.vector?.chroma?.relationCollection, "kg_relationships"),
			},
		},
		rag: {
			topK: Number(firstDefined(process.env.KG_RAG_TOP_K, pocConfig.rag?.topK, 5)),
			depth: Number(firstDefined(process.env.KG_RAG_DEPTH, pocConfig.rag?.depth, 4)),
		},
		prompts: {
			extractionSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_EXTRACTION_PROMPT_PATH,
				pocConfig.prompts?.extractionSystemPath,
				path.join(PROJECT_ROOT, "knowledgeGraphPOC", "prompts", "extraction-system.md"),
			)),
			answerSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_ANSWER_PROMPT_PATH,
				pocConfig.prompts?.answerSystemPath,
				path.join(PROJECT_ROOT, "knowledgeGraphPOC", "prompts", "answer-system.md"),
			)),
			contextFormatPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_CONTEXT_PROMPT_PATH,
				pocConfig.prompts?.contextFormatPath,
				path.join(PROJECT_ROOT, "knowledgeGraphPOC", "prompts", "context-format.md"),
			)),
		},
	};
}

export function describeRuntime(config) {
	return {
		llmProvider: config.llm.provider,
		graphProvider: config.graph.provider,
		vectorProvider: config.vector.provider,
		neo4jDatabase: config.graph.neo4j.database,
		chromaUrl: config.vector.chroma.path,
	};
}
