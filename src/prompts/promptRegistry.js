import fs from "node:fs";
import { formatSchemaCatalog, loadGraphSchema } from "../schema/graphSchema.js";

const GRAPH_SCHEMA_PLACEHOLDER = "{{GRAPH_SCHEMA}}";
const EXISTING_GRAPH_CONTEXT_PLACEHOLDER = "{{EXISTING_GRAPH_CONTEXT}}";
const USER_INPUT_PLACEHOLDER = "{{USER_INPUT}}";

function readPrompt(filePath, fallback) {
	if (!filePath || !fs.existsSync(filePath)) {
		return fallback;
	}

	return fs.readFileSync(filePath, "utf8").trim();
}

export function loadPrompts(config) {
	const graphSchema = loadGraphSchema(config);
	const schemaCatalog = formatSchemaCatalog(graphSchema);
	const extractionSystemPath = config.prompts.extractionCustomSystemPath;
	const extractionSystemFallback = "Extract graph nodes and relations using the custom line syntax.";
	const extractionSystemTemplate = readPrompt(
		extractionSystemPath,
		extractionSystemFallback,
	);

	return {
		extractionSystem: extractionSystemTemplate
			.replaceAll(GRAPH_SCHEMA_PLACEHOLDER, schemaCatalog)
			.replaceAll(EXISTING_GRAPH_CONTEXT_PLACEHOLDER, "No existing graph context was retrieved.")
			.replaceAll(USER_INPUT_PLACEHOLDER, ""),
		extractionSystemTemplate,
		answerSystem: readPrompt(
			config.prompts.answerSystemPath,
			"Answer using only the supplied graph context.",
		),
		contextFormat: readPrompt(
			config.prompts.contextFormatPath,
			"Format graph context compactly.",
		),
		jobScannerSystem: readPrompt(
			config.prompts.jobScannerSystemPath,
			"Inspect the graph neighborhood for quality issues and cite node or relation IDs.",
		),
		jobNuggetSystem: readPrompt(
			config.prompts.jobNuggetSystemPath,
			"Write one concise knowledge nugget from the graph neighborhood.",
		),
		graphSchema,
		schemaAutoApplySuggestions: config.schema.autoApplySuggestions,
	};
}

function renderTemplate(template, values) {
	return Object.entries(values).reduce(
		(rendered, [placeholder, value]) => rendered.replaceAll(placeholder, String(value ?? "")),
		template,
	);
}

export function buildExtractionPrompt(template, {
	graphSchema,
	existingGraphContext = "No existing graph context was retrieved.",
	userInput = "",
} = {}) {
	return renderTemplate(template, {
		[GRAPH_SCHEMA_PLACEHOLDER]: formatSchemaCatalog(graphSchema),
		[EXISTING_GRAPH_CONTEXT_PLACEHOLDER]: existingGraphContext,
		[USER_INPUT_PLACEHOLDER]: userInput,
	});
}

export function buildExtractionSystemPrompt(template, graphSchema) {
	return buildExtractionPrompt(template, { graphSchema });
}
