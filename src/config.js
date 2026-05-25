import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const DEFAULT_REPLACEMENTS_PATH = path.join(PROJECT_ROOT, "config.replacements.json");

function applyPlaceholders(text, replacements = {}, strict = false) {
	return text.replace(/{{\s*([A-Z0-9_]+)\s*}}/g, (match, key) => {
		if (Object.prototype.hasOwnProperty.call(replacements, key)) {
			return String(replacements[key]);
		}

		if (strict) {
			throw new Error(`Unresolved placeholder: ${key}`);
		}

		return match;
	});
}

/**
 * Minimal config loader.
 * - Reads `config.json` from project root
 * - Applies optional `{{KEY}}` replacements from a provided map or replacements file
 * - Returns parsed object
 *
 * Usage: `getConfig(replacements = {}, { replacementsPath, strict })`
 */
export function getConfig(replacements = {}, options = {}) {
	const { replacementsPath, strict = false } = options || {};
	let map = Object.assign({}, replacements || {});

	// If a replacementsPath is provided use it, otherwise look for a default
	// `config.replacements.json` in the project root. This lets callers omit
	// the path and still provide replacements by creating that file.
	const rpCandidate = replacementsPath
		? (path.isAbsolute(replacementsPath) ? replacementsPath : path.join(PROJECT_ROOT, replacementsPath))
		: DEFAULT_REPLACEMENTS_PATH;

	if (rpCandidate && fs.existsSync(rpCandidate)) {
		try {
			const json = JSON.parse(fs.readFileSync(rpCandidate, "utf8"));
			if (json && typeof json === "object") Object.assign(map, json);
		} catch (e) {
			// ignore parse errors; map remains as provided
		}
	}

	const raw = fs.readFileSync(CONFIG_PATH, "utf8");
	const applied = applyPlaceholders(raw, map, strict);
	return JSON.parse(applied);
}

export function describeRuntime(config) {
	return {
		llmProvider: config.llm?.provider,
		embeddingProvider: config.embedding?.provider,
		embeddingModel: config.embedding?.provider === "gemini"
			? config.embedding?.gemini?.model
			: config.embedding?.provider === "hub"
				? config.embedding?.hub?.model
				: "chroma-default",
		graphProvider: config.graph?.provider,
		vectorProvider: config.vector?.provider,
		neo4jDatabase: config.graph?.neo4j?.database,
		chromaUrl: config.vector?.chroma?.path,
		chromaTenant: config.vector?.chroma?.tenant,
		chromaDatabase: config.vector?.chroma?.database,
		chromaHitlCollection: config.vector?.chroma?.hitlCollection,
		ingestMode: config.ingestion?.mode,
		ingestContextEnabled: config.ingestion?.contextEnabled,
		ingestContextTopK: config.ingestion?.contextTopK,
		ingestContextDepth: config.ingestion?.contextDepth,
		ragMemoryEnabled: config.rag?.memory?.enabled,
		ragMemoryMaxMessages: config.rag?.memory?.maxMessages,
		ragMemoryRewriteQueryEnabled: config.rag?.memory?.rewriteQueryEnabled,
		schemaPath: config.schema?.path,
		schemaAutoApplySuggestions: config.schema?.autoApplySuggestions,
		debugLog: config.logging?.enabled,
		debugLogDir: config.logging?.directory,
		debugLogScopes: config.logging?.scopes,
	};
}
