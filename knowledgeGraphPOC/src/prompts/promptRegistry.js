import fs from "node:fs";
import { formatSchemaCatalog, loadGraphSchema } from "../schema/graphSchema.js";

const GRAPH_SCHEMA_PLACEHOLDER = "{{GRAPH_SCHEMA}}";

function readPrompt(filePath, fallback) {
	if (!filePath || !fs.existsSync(filePath)) {
		return fallback;
	}

	return fs.readFileSync(filePath, "utf8").trim();
}

export function loadPrompts(config) {
	const extractionFormat = config.prompts.extractionFormat ?? "json";
	const graphSchema = loadGraphSchema(config);
	const schemaCatalog = formatSchemaCatalog(graphSchema);
	const extractionSystemPath = extractionFormat === "custom"
		? config.prompts.extractionCustomSystemPath
		: config.prompts.extractionSystemPath;
	const extractionSystemFallback = extractionFormat === "custom"
		? "Extract graph nodes and relations using the custom line syntax."
		: "Extract graph nodes and relations as strict JSON.";

	return {
		extractionSystem: readPrompt(
			extractionSystemPath,
			extractionSystemFallback,
		).replaceAll(GRAPH_SCHEMA_PLACEHOLDER, schemaCatalog),
		extractionSystemTemplate: readPrompt(
			extractionSystemPath,
			extractionSystemFallback,
		),
		extractionFormat,
		answerSystem: readPrompt(
			config.prompts.answerSystemPath,
			"Answer using only the supplied graph context.",
		),
		contextFormat: readPrompt(
			config.prompts.contextFormatPath,
			"Format graph context compactly.",
		),
		graphSchema,
		schemaAutoApplySuggestions: config.schema.autoApplySuggestions,
	};
}

export function buildExtractionSystemPrompt(template, graphSchema) {
	return template.replaceAll(GRAPH_SCHEMA_PLACEHOLDER, formatSchemaCatalog(graphSchema));
}
