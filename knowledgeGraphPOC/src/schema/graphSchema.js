import fs from "node:fs";

import { toSnakeCase } from "../ingestion/graphPayload.js";

function readJson(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		throw new Error(`Graph schema file not found: ${filePath}`);
	}

	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeEntry(entry) {
	return {
		...entry,
		name: toSnakeCase(entry.name),
		description: String(entry.description ?? "").trim(),
		reason: String(entry.reason ?? "").trim(),
	};
}

export function loadGraphSchema(config) {
	const schema = readJson(config.schema.path);

	return {
		...schema,
		path: config.schema.path,
		fallbacks: {
			nodeType: toSnakeCase(schema.fallbacks?.nodeType || "concept") || "concept",
			relationshipType: toSnakeCase(schema.fallbacks?.relationshipType || "relates_to") || "relates_to",
		},
		nodeTypes: (schema.nodeTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
		relationshipTypes: (schema.relationshipTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
		suggestions: {
			nodeTypes: (schema.suggestions?.nodeTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
			relationshipTypes: (schema.suggestions?.relationshipTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
		},
	};
}

function formatTypeList(title, entries) {
	const lines = entries.length > 0
		? entries.map((entry) => `- ${entry.name}: ${entry.description || "No description."}${entry.reason ? ` Reason: ${entry.reason}` : ""}`)
		: ["- None."];
	return [title, ...lines].join("\n");
}

export function formatSchemaCatalog(schema) {
	return [
		formatTypeList("Approved node types:", schema.nodeTypes),
		"",
		formatTypeList("Not-yet-approved node types:", schema.suggestions?.nodeTypes ?? []),
		"",
		formatTypeList("Approved relationship types:", schema.relationshipTypes),
		"",
		formatTypeList("Not-yet-approved relationship types:", schema.suggestions?.relationshipTypes ?? []),
		"",
		// `Fallback node type when suggestions are not accepted by runtime: ${schema.fallbacks.nodeType}`,
		// `Fallback relationship type when suggestions are not accepted by runtime: ${schema.fallbacks.relationshipType}`,
	].join("\n");
}

function entryMap(entries) {
	return new Map(entries.map((entry) => [toSnakeCase(entry.name), entry]));
}

function mergeSuggestions({ approvedEntries, existingSuggestions, incomingSuggestions }) {
	const approvedNames = new Set(approvedEntries.map((entry) => toSnakeCase(entry.name)));
	const merged = entryMap(existingSuggestions);

	for (const suggestion of incomingSuggestions) {
		const normalized = normalizeEntry(suggestion);

		if (!normalized.name || approvedNames.has(normalized.name)) {
			continue;
		}

		const existing = merged.get(normalized.name);
		merged.set(normalized.name, {
			name: normalized.name,
			description: normalized.description || existing?.description || "",
			reason: normalized.reason || existing?.reason || "",
		});
	}

	return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function persistGraphSchemaSuggestions(schema, schemaSuggestions = {}) {
	const incomingNodeTypes = schemaSuggestions.nodeTypes ?? [];
	const incomingRelationshipTypes = schemaSuggestions.relationshipTypes ?? [];

	if (incomingNodeTypes.length === 0 && incomingRelationshipTypes.length === 0) {
		return {
			nodeTypesAdded: 0,
			relationshipTypesAdded: 0,
		};
	}

	const rawSchema = readJson(schema.path);
	const existingNodeSuggestions = rawSchema.suggestions?.nodeTypes ?? [];
	const existingRelationshipSuggestions = rawSchema.suggestions?.relationshipTypes ?? [];
	const nextNodeSuggestions = mergeSuggestions({
		approvedEntries: rawSchema.nodeTypes ?? [],
		existingSuggestions: existingNodeSuggestions,
		incomingSuggestions: incomingNodeTypes,
	});
	const nextRelationshipSuggestions = mergeSuggestions({
		approvedEntries: rawSchema.relationshipTypes ?? [],
		existingSuggestions: existingRelationshipSuggestions,
		incomingSuggestions: incomingRelationshipTypes,
	});

	const nextSchema = {
		...rawSchema,
		suggestions: {
			nodeTypes: nextNodeSuggestions,
			relationshipTypes: nextRelationshipSuggestions,
		},
	};

	fs.writeFileSync(schema.path, `${JSON.stringify(nextSchema, null, "\t")}\n`);

	return {
		nodeTypesAdded: nextNodeSuggestions.length - existingNodeSuggestions.length,
		relationshipTypesAdded: nextRelationshipSuggestions.length - existingRelationshipSuggestions.length,
	};
}

function mergeApprovedTypes({ approvedEntries, incomingSuggestions }) {
	const merged = entryMap(approvedEntries);
	let added = 0;

	for (const suggestion of incomingSuggestions) {
		const normalized = normalizeEntry(suggestion);

		if (!normalized.name || merged.has(normalized.name)) {
			continue;
		}

		merged.set(normalized.name, {
			name: normalized.name,
			description: normalized.description,
		});
		added += 1;
	}

	return {
		entries: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
		added,
	};
}

export function promoteGraphSchemaSuggestions(schema, schemaSuggestions = {}) {
	const incomingNodeTypes = schemaSuggestions.nodeTypes ?? [];
	const incomingRelationshipTypes = schemaSuggestions.relationshipTypes ?? [];

	if (incomingNodeTypes.length === 0 && incomingRelationshipTypes.length === 0) {
		return {
			nodeTypesAdded: 0,
			relationshipTypesAdded: 0,
		};
	}

	const rawSchema = readJson(schema.path);
	const nextNodeTypes = mergeApprovedTypes({
		approvedEntries: rawSchema.nodeTypes ?? [],
		incomingSuggestions: incomingNodeTypes,
	});
	const nextRelationshipTypes = mergeApprovedTypes({
		approvedEntries: rawSchema.relationshipTypes ?? [],
		incomingSuggestions: incomingRelationshipTypes,
	});

	const nextSchema = {
		...rawSchema,
		nodeTypes: nextNodeTypes.entries,
		relationshipTypes: nextRelationshipTypes.entries,
		suggestions: {
			nodeTypes: mergeSuggestions({
				approvedEntries: nextNodeTypes.entries,
				existingSuggestions: rawSchema.suggestions?.nodeTypes ?? [],
				incomingSuggestions: [],
			}),
			relationshipTypes: mergeSuggestions({
				approvedEntries: nextRelationshipTypes.entries,
				existingSuggestions: rawSchema.suggestions?.relationshipTypes ?? [],
				incomingSuggestions: [],
			}),
		},
	};

	fs.writeFileSync(schema.path, `${JSON.stringify(nextSchema, null, "\t")}\n`);

	return {
		nodeTypesAdded: nextNodeTypes.added,
		relationshipTypesAdded: nextRelationshipTypes.added,
	};
}
