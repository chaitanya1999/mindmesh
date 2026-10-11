import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(PROJECT_ROOT, "config.json");
const DEFAULT_REPLACEMENTS_PATH = path.join(PROJECT_ROOT, "config.replacements.json");

const PLACEHOLDER_PATTERN = /{{\s*([A-Z0-9_]+)\s*}}/g;
const WHOLE_PLACEHOLDER_PATTERN = /^{{\s*([A-Z0-9_]+)\s*}}$/;

function hasKey(map, key) {
	return Object.prototype.hasOwnProperty.call(map, key);
}

// Replaces `{{KEY}}` inside the string values of an already-parsed config. Values never pass through
// JSON syntax, so quotes, backslashes and Windows paths are kept exactly. A string that is only a
// placeholder takes the replacement's own type (number, boolean, ...). Unknown keys are left as is
// and added to `unresolved`.
export function applyPlaceholders(value, replacements = {}, unresolved = new Set()) {
	if (typeof value === "string") {
		const whole = value.match(WHOLE_PLACEHOLDER_PATTERN);
		if (whole) {
			if (hasKey(replacements, whole[1])) {
				return replacements[whole[1]];
			}
			unresolved.add(whole[1]);
			return value;
		}

		return value.replace(PLACEHOLDER_PATTERN, (match, key) => {
			if (hasKey(replacements, key)) {
				return String(replacements[key]);
			}
			unresolved.add(key);
			return match;
		});
	}

	if (Array.isArray(value)) {
		return value.map((item) => applyPlaceholders(item, replacements, unresolved));
	}

	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyPlaceholders(item, replacements, unresolved)]));
	}

	return value;
}

function readJsonFile(filePath, label) {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"));
	} catch (error) {
		throw new Error(`Could not read ${label} (${filePath}): ${error.message}`);
	}
}

// A missing replacements file is fine; a broken one is an error, never silently ignored.
export function readReplacementsFile(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		return {};
	}

	const replacements = readJsonFile(filePath, "the replacements file");
	if (!replacements || typeof replacements !== "object" || Array.isArray(replacements)) {
		throw new Error(`The replacements file (${filePath}) must contain a JSON object of "KEY": value pairs.`);
	}

	return replacements;
}

/**
 * Config loader.
 * - Reads `config.json` from the project root and parses it.
 * - Replaces `{{KEY}}` placeholders in its string values from `config.replacements.json` (or
 *   `replacementsPath`) and the `replacements` argument; values in the file win over the argument.
 * - Unresolved placeholders print one warning listing the keys, or throw with `strict: true`.
 *
 * Usage: `getConfig(replacements = {}, { replacementsPath, strict })`
 */
export function getConfig(replacements = {}, options = {}) {
	const { replacementsPath, strict = false } = options || {};
	const filePath = replacementsPath
		? (path.isAbsolute(replacementsPath) ? replacementsPath : path.join(PROJECT_ROOT, replacementsPath))
		: DEFAULT_REPLACEMENTS_PATH;
	const map = { ...(replacements || {}), ...readReplacementsFile(filePath) };

	const unresolved = new Set();
	const config = applyPlaceholders(readJsonFile(CONFIG_PATH, "config.json"), map, unresolved);
	if (unresolved.size > 0) {
		const message = `Unresolved config placeholder(s): ${[...unresolved].join(", ")}. Add them to ${path.basename(filePath)} if the settings that use them are needed.`;
		if (strict) {
			throw new Error(message);
		}
		// stderr, so the MCP server's stdout protocol stream is not affected.
		console.warn(`[config] ${message}`);
	}

	return config;
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
		schemaPath: config.schema?.path,
		debugLog: config.logging?.enabled,
		debugLogDir: config.logging?.directory,
		debugLogScopes: config.logging?.scopes,
	};
}
