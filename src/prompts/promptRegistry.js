import fs from "node:fs";
import { formatFieldGuidance, formatSchemaCatalog, loadGraphSchema } from "../schema/graphSchema.js";

const GRAPH_SCHEMA_PLACEHOLDER = "{{GRAPH_SCHEMA}}";
const EXISTING_GRAPH_CONTEXT_PLACEHOLDER = "{{EXISTING_GRAPH_CONTEXT}}";
const USER_INPUT_PLACEHOLDER = "{{USER_INPUT}}";
const FIELD_GUIDANCE_PLACEHOLDER = "{{FIELD_GUIDANCE}}";
const REVIEWER_REVISION_PLACEHOLDER = "{{REVIEWER_REVISION}}";

function readPrompt(filePath, fallback) {
	if (!filePath || !fs.existsSync(filePath)) {
		return fallback;
	}

	return fs.readFileSync(filePath, "utf8").trim();
}

export function loadPrompts(config) {
	const graphSchema = loadGraphSchema(config);
	const schemaCatalog = formatSchemaCatalog(graphSchema);
	const fieldGuidance = formatFieldGuidance(graphSchema);
	const extractionSystemPath = config.prompts.extractionCustomSystemPath;
	const extractionSystemFallback = "Extract graph nodes and relations using the custom line syntax.";
	const extractionSystemTemplate = readPrompt(
		extractionSystemPath,
		extractionSystemFallback,
	);

	return {
		extractionSystem: extractionSystemTemplate
			.replaceAll(GRAPH_SCHEMA_PLACEHOLDER, schemaCatalog)
			.replaceAll(FIELD_GUIDANCE_PLACEHOLDER, fieldGuidance)
			.replaceAll(EXISTING_GRAPH_CONTEXT_PLACEHOLDER, "No existing graph context was retrieved.")
			.replaceAll(USER_INPUT_PLACEHOLDER, "")
			.replaceAll(REVIEWER_REVISION_PLACEHOLDER, ""),
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
	reviewerRevision = null,
} = {}) {
	return renderTemplate(template, {
		[GRAPH_SCHEMA_PLACEHOLDER]: formatSchemaCatalog(graphSchema),
		[FIELD_GUIDANCE_PLACEHOLDER]: formatFieldGuidance(graphSchema),
		[EXISTING_GRAPH_CONTEXT_PLACEHOLDER]: existingGraphContext,
		[USER_INPUT_PLACEHOLDER]: userInput,
		[REVIEWER_REVISION_PLACEHOLDER]: formatReviewerRevision(reviewerRevision),
	});
}

// Section appended when a HITL reviewer regenerates a proposal; empty for normal ingestion.
export function formatReviewerRevision(reviewerRevision) {
	const reviewerNotes = String(reviewerRevision?.reviewerNotes ?? "").trim();
	const previousProposal = String(reviewerRevision?.previousProposal ?? "").trim();
	if (!reviewerNotes && !previousProposal) {
		return "";
	}

	return [
		"REVIEWER REVISION",
		"A human reviewer checked an earlier proposal for the new user input above and wants it regenerated.",
		"Produce the COMPLETE revised proposal, not a diff, using exactly the same output syntax and demarcators.",
		"Reviewer notes have the highest priority: they override the extraction defaults above, but never the schema or the output syntax.",
		"Treat the previous proposal as the baseline: keep its records unchanged unless the reviewer notes ask for a change.",
		"",
		"Reviewer notes:",
		reviewerNotes || "(none)",
		"",
		"Previous proposal:",
		previousProposal || "(none)",
	].join("\n");
}

export function buildExtractionSystemPrompt(template, graphSchema) {
	return buildExtractionPrompt(template, { graphSchema });
}
