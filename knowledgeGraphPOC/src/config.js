import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const POC_CONFIG_PATH = path.join(PROJECT_ROOT, "knowledgeGraphPOC", "config.json");
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, "knowledgeGraphPOC", "schema", "graphSchema.json");
const DEFAULT_LOG_DIR = path.join(PROJECT_ROOT, "knowledgeGraphPOC", "logs");

function readJsonIfExists(filePath) {
	if (!fs.existsSync(filePath)) {
		return {};
	}

	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function firstDefined(...values) {
	return values.find((value) => value !== undefined && value !== null && value !== "");
}

function booleanFrom(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	if (typeof value === "boolean") {
		return value;
	}

	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function resolveFromProjectRoot(filePath) {
	if (!filePath || path.isAbsolute(filePath)) {
		return filePath;
	}

	return path.join(PROJECT_ROOT, filePath);
}

function parseScopes(value) {
	if (Array.isArray(value)) {
		return value.map((scope) => String(scope).trim()).filter(Boolean);
	}

	if (typeof value === "string") {
		return value.split(",").map((scope) => scope.trim()).filter(Boolean);
	}

	return [];
}

export function getConfig() {
	const rootConfig = readJsonIfExists(ROOT_CONFIG_PATH);
	const pocConfig = readJsonIfExists(POC_CONFIG_PATH);
	const extractionFormat = String(firstDefined(process.env.KG_EXTRACTION_FORMAT, pocConfig.llm?.extractionFormat, "json")).toLowerCase();

	return {
		llm: {
			provider: firstDefined(process.env.KG_LLM_PROVIDER, pocConfig.llm?.provider, "gemini"),
			extractionFormat,
			gemini: {
				apiKey: firstDefined(process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY, pocConfig.llm?.gemini?.apiKey, rootConfig.apiKey),
				model: firstDefined(process.env.GEMINI_MODEL, pocConfig.llm?.gemini?.model, rootConfig.model, "gemini-2.5-flash"),
				extractionFormat,
			},
			ollama: {
				baseUrl: firstDefined(process.env.OLLAMA_BASE_URL, pocConfig.llm?.ollama?.baseUrl, "http://localhost:11434"),
				model: firstDefined(process.env.OLLAMA_MODEL, pocConfig.llm?.ollama?.model, "mistral"),
				extractionFormat,
			},
			custom: {
				endpoint: firstDefined(process.env.KG_CUSTOM_LLM_ENDPOINT, pocConfig.llm?.custom?.endpoint, "http://localhost:3001/llm"),
				extractionFormat,
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
				tenant: firstDefined(process.env.CHROMA_TENANT, pocConfig.vector?.chroma?.tenant, "default_tenant"),
				database: firstDefined(process.env.CHROMA_DATABASE, pocConfig.vector?.chroma?.database, "default_database"),
				nodeCollection: firstDefined(process.env.CHROMA_NODE_COLLECTION, pocConfig.vector?.chroma?.nodeCollection, "kg_nodes"),
				relationCollection: firstDefined(process.env.CHROMA_RELATION_COLLECTION, pocConfig.vector?.chroma?.relationCollection, "kg_relationships"),
			},
		},
		embedding: {
			provider: firstDefined(process.env.KG_EMBEDDING_PROVIDER, pocConfig.embedding?.provider, "gemini"),
			gemini: {
				apiKey: firstDefined(
					process.env.GEMINI_API_KEY,
					process.env.GOOGLE_API_KEY,
					pocConfig.embedding?.gemini?.apiKey,
					pocConfig.llm?.gemini?.apiKey,
					rootConfig.apiKey,
				),
				model: firstDefined(process.env.GEMINI_EMBEDDING_MODEL, pocConfig.embedding?.gemini?.model, "gemini-embedding-001"),
				outputDimensionality: Number(firstDefined(process.env.GEMINI_EMBEDDING_DIMENSIONS, pocConfig.embedding?.gemini?.outputDimensionality, 768)),
			},
		},
		rag: {
			topK: Number(firstDefined(process.env.KG_RAG_TOP_K, pocConfig.rag?.topK, 5)),
			depth: Number(firstDefined(process.env.KG_RAG_DEPTH, pocConfig.rag?.depth, 4)),
		},
		schema: {
			path: resolveFromProjectRoot(firstDefined(
				process.env.KG_SCHEMA_PATH,
				pocConfig.schema?.path,
				DEFAULT_SCHEMA_PATH,
			)),
			autoApplySuggestions: booleanFrom(
				firstDefined(process.env.KG_SCHEMA_AUTO_APPLY_SUGGESTIONS, pocConfig.schema?.autoApplySuggestions),
				false,
			),
		},
		logging: {
			enabled: booleanFrom(
				firstDefined(process.env.KG_DEBUG_LOG, pocConfig.logging?.enabled),
				false,
			),
			directory: resolveFromProjectRoot(firstDefined(
				process.env.KG_DEBUG_LOG_DIR,
				pocConfig.logging?.directory,
				DEFAULT_LOG_DIR,
			)),
			scopes: parseScopes(firstDefined(
				process.env.KG_DEBUG_LOG_SCOPES,
				pocConfig.logging?.scopes,
			)),
		},
		prompts: {
			extractionFormat,
			extractionSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_EXTRACTION_PROMPT_PATH,
				pocConfig.prompts?.extractionSystemPath,
				path.join(PROJECT_ROOT, "knowledgeGraphPOC", "prompts", "extraction-system.md"),
			)),
			extractionCustomSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_CUSTOM_EXTRACTION_PROMPT_PATH,
				pocConfig.prompts?.extractionCustomSystemPath,
				path.join(PROJECT_ROOT, "knowledgeGraphPOC", "prompts", "extraction-system-custom.md"),
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
		extractionFormat: config.llm.extractionFormat,
		embeddingProvider: config.embedding.provider,
		embeddingModel: config.embedding.provider === "gemini" ? config.embedding.gemini.model : "chroma-default",
		graphProvider: config.graph.provider,
		vectorProvider: config.vector.provider,
		neo4jDatabase: config.graph.neo4j.database,
		chromaUrl: config.vector.chroma.path,
		chromaTenant: config.vector.chroma.tenant,
		chromaDatabase: config.vector.chroma.database,
		schemaPath: config.schema.path,
		schemaAutoApplySuggestions: config.schema.autoApplySuggestions,
		debugLog: config.logging.enabled,
		debugLogDir: config.logging.directory,
		debugLogScopes: config.logging.scopes,
	};
}
