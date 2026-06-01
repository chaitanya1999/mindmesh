import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const POC_CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const DEFAULT_SCHEMA_PATH = path.join(PROJECT_ROOT, "schema", "graphSchema.json");
const DEFAULT_LOG_DIR = path.join(PROJECT_ROOT, "logs");
const DEFAULT_JOB_SCANNER_PROMPT_PATH = path.join(PROJECT_ROOT, "prompts", "job-scanner-system.md");
const DEFAULT_JOB_NUGGET_PROMPT_PATH = path.join(PROJECT_ROOT, "prompts", "job-nugget-system.md");

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

function ingestionModeFrom(value) {
	const mode = String(value || "auto").trim().toLowerCase();
	return mode === "hitl" ? "hitl" : "auto";
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
	const ragTopK = Number(firstDefined(process.env.KG_RAG_TOP_K, pocConfig.rag?.topK, 5));
	const ragDepth = Number(firstDefined(process.env.KG_RAG_DEPTH, pocConfig.rag?.depth, 4));
	const ragMemory = pocConfig.rag?.memory ?? {};

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
				think: firstDefined(process.env.OLLAMA_THINK, pocConfig.llm?.ollama?.think, false),
				temperature: firstDefined(process.env.OLLAMA_TEMPERATURE, pocConfig.llm?.ollama?.temperature),
			},
			custom: {
				subProvider: firstDefined(process.env.KG_CUSTOM_LLM_SUB_PROVIDER, pocConfig.llm?.custom?.subProvider, "gemini"),
				openai: {
					endpoint: firstDefined(process.env.KG_CUSTOM_OPENAI_ENDPOINT, pocConfig.llm?.custom?.openai?.endpoint),
					bridgedEndpoint: firstDefined(process.env.KG_CUSTOM_OPENAI_BRIDGED_ENDPOINT, pocConfig.llm?.custom?.openai?.bridgedEndpoint),
					apiKey: firstDefined(process.env.KG_CUSTOM_OPENAI_API_KEY, pocConfig.llm?.custom?.openai?.apiKey),
					model: firstDefined(process.env.KG_CUSTOM_OPENAI_MODEL, pocConfig.llm?.custom?.openai?.model, "gpt-5-mini"),
				},
				gemini: {
					endpoint: firstDefined(process.env.KG_CUSTOM_GEMINI_ENDPOINT, pocConfig.llm?.custom?.gemini?.endpoint, "http://localhost:3001/llm"),
					bridgedEndpoint: firstDefined(process.env.KG_CUSTOM_OPENAI_BRIDGED_ENDPOINT, pocConfig.llm?.custom?.gemini?.bridgedEndpoint),
					apiKey: firstDefined(process.env.KG_CUSTOM_OPENAI_API_KEY, pocConfig.llm?.custom?.gemini?.apiKey),
				},
                
			},
			hub: {
				baseUrl: firstDefined(process.env.KG_HUB_LLM_BASE_URL, pocConfig.llm?.hub?.baseUrl, "https://hub-proxy-service.thankfulfield-16b4d5d6.eastus.azurecontainerapps.io"),
				apiKey: firstDefined(process.env.KG_HUB_LLM_API_KEY, pocConfig.llm?.hub?.apiKey),
				model: firstDefined(process.env.KG_HUB_LLM_MODEL, pocConfig.llm?.hub?.model, "gpt-4.1-nano"),
				temperature: firstDefined(process.env.KG_HUB_LLM_TEMPERATURE, pocConfig.llm?.hub?.temperature),
                
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
				hitlCollection: firstDefined(process.env.CHROMA_HITL_COLLECTION, pocConfig.vector?.chroma?.hitlCollection, "fleeting_notes_hitl"),
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
			hub: {
				baseUrl: firstDefined(
					process.env.KG_HUB_EMBEDDING_BASE_URL,
					pocConfig.embedding?.hub?.baseUrl,
					process.env.KG_HUB_LLM_BASE_URL,
					pocConfig.llm?.hub?.baseUrl,
					"https://hub-proxy-service.thankfulfield-16b4d5d6.eastus.azurecontainerapps.io",
				),
				apiKey: firstDefined(
					process.env.KG_HUB_EMBEDDING_API_KEY,
					pocConfig.embedding?.hub?.apiKey,
					process.env.KG_HUB_LLM_API_KEY,
					pocConfig.llm?.hub?.apiKey,
				),
				model: firstDefined(process.env.KG_HUB_EMBEDDING_MODEL, pocConfig.embedding?.hub?.model, "embeddings"),
				encodingFormat: firstDefined(process.env.KG_HUB_EMBEDDING_ENCODING_FORMAT, pocConfig.embedding?.hub?.encodingFormat, "float"),
				dimensions: Number(firstDefined(process.env.KG_HUB_EMBEDDING_DIMENSIONS, pocConfig.embedding?.hub?.dimensions, 512)),
				batchSize: Number(firstDefined(process.env.KG_HUB_EMBEDDING_BATCH_SIZE, pocConfig.embedding?.hub?.batchSize, 64)),
			},
		},
		rag: {
			topK: ragTopK,
			depth: ragDepth,
			memory: {
				enabled: booleanFrom(
					firstDefined(process.env.KG_RAG_MEMORY_ENABLED, ragMemory.enabled),
					true,
				),
				maxMessages: Number(firstDefined(process.env.KG_RAG_MEMORY_MAX_MESSAGES, ragMemory.maxMessages, 12)),
				maxMessageChars: Number(firstDefined(process.env.KG_RAG_MEMORY_MAX_MESSAGE_CHARS, ragMemory.maxMessageChars, 2000)),
				rewriteQueryEnabled: booleanFrom(
					firstDefined(process.env.KG_RAG_MEMORY_REWRITE_QUERY_ENABLED, ragMemory.rewriteQueryEnabled),
					true,
				),
			},
		},
		ingestion: {
			mode: ingestionModeFrom(firstDefined(process.env.KG_INGEST_MODE, pocConfig.ingestion?.mode, "Hitl")),
			hitlDefaultUserName: firstDefined(process.env.KG_HITL_DEFAULT_USER_NAME, pocConfig.ingestion?.hitlDefaultUserName, "web-user"),
			contextEnabled: booleanFrom(
				firstDefined(process.env.KG_INGEST_CONTEXT_ENABLED, pocConfig.ingestion?.contextEnabled),
				true,
			),
			contextTopK: Number(firstDefined(process.env.KG_INGEST_CONTEXT_TOP_K, pocConfig.ingestion?.contextTopK, ragTopK)),
			contextDepth: Number(firstDefined(process.env.KG_INGEST_CONTEXT_DEPTH, pocConfig.ingestion?.contextDepth, ragDepth)),
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
			extractionCustomSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_CUSTOM_EXTRACTION_PROMPT_PATH,
				pocConfig.prompts?.extractionCustomSystemPath,
				path.join(PROJECT_ROOT, "prompts", "extraction-system-custom.md"),
			)),
			answerSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_ANSWER_PROMPT_PATH,
				pocConfig.prompts?.answerSystemPath,
				path.join(PROJECT_ROOT, "prompts", "answer-system.md"),
			)),
			contextFormatPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_CONTEXT_PROMPT_PATH,
				pocConfig.prompts?.contextFormatPath,
				path.join(PROJECT_ROOT, "prompts", "context-format.md"),
			)),
			jobScannerSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_JOB_SCANNER_PROMPT_PATH,
				pocConfig.prompts?.jobScannerSystemPath,
				DEFAULT_JOB_SCANNER_PROMPT_PATH,
			)),
			jobNuggetSystemPath: resolveFromProjectRoot(firstDefined(
				process.env.KG_JOB_NUGGET_PROMPT_PATH,
				pocConfig.prompts?.jobNuggetSystemPath,
				DEFAULT_JOB_NUGGET_PROMPT_PATH,
			)),
		},
	};
}

export function describeRuntime(config) {
	return {
		llmProvider: config.llm.provider,
		embeddingProvider: config.embedding.provider,
		embeddingModel: config.embedding.provider === "gemini"
			? config.embedding.gemini.model
			: config.embedding.provider === "hub"
				? config.embedding.hub.model
				: "chroma-default",
		graphProvider: config.graph.provider,
		vectorProvider: config.vector.provider,
		neo4jDatabase: config.graph.neo4j.database,
		chromaUrl: config.vector.chroma.path,
		chromaTenant: config.vector.chroma.tenant,
		chromaDatabase: config.vector.chroma.database,
		chromaHitlCollection: config.vector.chroma.hitlCollection,
		ingestMode: config.ingestion.mode,
		ingestContextEnabled: config.ingestion.contextEnabled,
		ingestContextTopK: config.ingestion.contextTopK,
		ingestContextDepth: config.ingestion.contextDepth,
		ragMemoryEnabled: config.rag.memory.enabled,
		ragMemoryMaxMessages: config.rag.memory.maxMessages,
		ragMemoryRewriteQueryEnabled: config.rag.memory.rewriteQueryEnabled,
		schemaPath: config.schema.path,
		schemaAutoApplySuggestions: config.schema.autoApplySuggestions,
		debugLog: config.logging.enabled,
		debugLogDir: config.logging.directory,
		debugLogScopes: config.logging.scopes,
	};
}
