import fs from "node:fs";
import { formatFieldGuidance, formatSchemaCatalog, loadGraphSchema } from "../schema/graphSchema.js";
import { scopeEnabled } from "../schema/scope.js";

const GRAPH_SCHEMA_PLACEHOLDER = "{{GRAPH_SCHEMA}}";
const EXISTING_GRAPH_CONTEXT_PLACEHOLDER = "{{EXISTING_GRAPH_CONTEXT}}";
const USER_INPUT_PLACEHOLDER = "{{USER_INPUT}}";
const FIELD_GUIDANCE_PLACEHOLDER = "{{FIELD_GUIDANCE}}";
const REVIEWER_REVISION_PLACEHOLDER = "{{REVIEWER_REVISION}}";
const INGEST_SCOPE_PLACEHOLDER = "{{INGEST_SCOPE}}";

// Conditional blocks for the scope switches: {{#SCOPE_NODES}}...{{/SCOPE_NODES}} is kept when node scopes are
// on, {{^SCOPE_NODES}}...{{/SCOPE_NODES}} when they are off; the same for SCOPE_RELATIONS.
const SCOPE_SECTIONS = { SCOPE_NODES: "node", SCOPE_RELATIONS: "relation" };
const SCOPE_SECTION_PATTERN = /\{\{([#^])(SCOPE_NODES|SCOPE_RELATIONS)\}\}\r?\n?([\s\S]*?)\{\{\/\2\}\}\r?\n?/g;

export function renderScopeSections(template) {
	return String(template).replace(SCOPE_SECTION_PATTERN, (match, mode, name, body) => (
		(mode === "#") === scopeEnabled(SCOPE_SECTIONS[name]) ? body : ""
	));
}

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
		extractionSystem: renderScopeSections(extractionSystemTemplate)
			.replaceAll(GRAPH_SCHEMA_PLACEHOLDER, schemaCatalog)
			.replaceAll(FIELD_GUIDANCE_PLACEHOLDER, fieldGuidance)
			.replaceAll(EXISTING_GRAPH_CONTEXT_PLACEHOLDER, "No existing graph context was retrieved.")
			.replaceAll(USER_INPUT_PLACEHOLDER, "")
			.replaceAll(INGEST_SCOPE_PLACEHOLDER, formatIngestScope(""))
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
	scope = "",
	reviewerRevision = null,
} = {}) {
	return renderTemplate(renderScopeSections(template), {
		[GRAPH_SCHEMA_PLACEHOLDER]: formatSchemaCatalog(graphSchema),
		[FIELD_GUIDANCE_PLACEHOLDER]: formatFieldGuidance(graphSchema),
		[EXISTING_GRAPH_CONTEXT_PLACEHOLDER]: existingGraphContext,
		[INGEST_SCOPE_PLACEHOLDER]: formatIngestScope(scope),
		[USER_INPUT_PLACEHOLDER]: userInput,
		[REVIEWER_REVISION_PLACEHOLDER]: formatReviewerRevision(reviewerRevision),
	});
}

// The scope chosen for this input (ingest picker, MCP `scope`, or the proposal's stored scope on regeneration).
// It frames the reasoning only; the retrieved context is not filtered by it. Empty when node scopes are off.
export function formatIngestScope(scope) {
	if (!scopeEnabled("node")) {
		return "";
	}
	if (!scope) {
		return "Selected scope for this input: none. Set a scope only where the input itself states it.";
	}
	return `Selected scope for this input: ${scope}. Read the input as ${scope} knowledge. Existing graph context covers every scope; each node shows its own.`;
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
