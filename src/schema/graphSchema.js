import fs from "node:fs";

import { toSnakeCase } from "../ingestion/graphPayload.js";

function readJson(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		throw new Error(`Graph schema file not found: ${filePath}`);
	}

	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function schemaPathFromConfig(config) {
	return config?.schema?.path || config?.path;
}

function readRawJson(filePath) {
	if (!filePath || !fs.existsSync(filePath)) {
		throw new Error(`Graph schema file not found: ${filePath}`);
	}

	return fs.readFileSync(filePath, "utf8");
}

function normalizeEntry(entry) {
	return {
		...entry,
		name: toSnakeCase(entry.name),
		description: String(entry.description ?? "").trim(),
		reason: String(entry.reason ?? "").trim(),
	};
}

function assertPlainObject(value, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
}

function normalizeTypeEntries(entries) {
	if (entries === undefined) {
		return [];
	}
	if (!Array.isArray(entries)) {
		throw new Error("Schema type lists must be arrays.");
	}

	const merged = new Map();
	for (const entry of entries) {
		assertPlainObject(entry, "Schema type entry");
		const name = toSnakeCase(entry.name);
		if (!name) {
			continue;
		}

		const existing = merged.get(name);
		merged.set(name, {
			name,
			description: String(entry.description ?? existing?.description ?? "").trim(),
		});
	}

	return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeEditableGraphSchema(schema) {
	assertPlainObject(schema, "Graph schema");

	const normalized = {
		...schema,
		nodeTypes: normalizeTypeEntries(schema.nodeTypes),
		relationshipTypes: normalizeTypeEntries(schema.relationshipTypes),
	};

	delete normalized.path;
	delete normalized.fallbacks;
	delete normalized.suggestions;
	return normalized;
}

export function readEditableGraphSchema(config) {
	const filePath = schemaPathFromConfig(config);
	const rawJson = readRawJson(filePath);
	const schema = normalizeEditableGraphSchema(JSON.parse(rawJson));

	return {
		path: filePath,
		pathLabel: filePath,
		schema,
		rawJson,
		formattedJson: `${JSON.stringify(schema, null, "\t")}\n`,
	};
}

export function saveEditableGraphSchema(config, { rawJson, schema } = {}) {
	const filePath = schemaPathFromConfig(config);
	const candidate = rawJson !== undefined
		? JSON.parse(String(rawJson))
		: schema;
	const normalized = normalizeEditableGraphSchema(candidate);
	const formattedJson = `${JSON.stringify(normalized, null, "\t")}\n`;

	fs.writeFileSync(filePath, formattedJson);

	return {
		path: filePath,
		pathLabel: filePath,
		schema: normalized,
		rawJson: formattedJson,
		formattedJson,
	};
}

export function loadGraphSchema(config) {
	const raw = readJson(schemaPathFromConfig(config));

	return {
		...raw,
		path: schemaPathFromConfig(config),
		fallbacks: {
			nodeType: toSnakeCase(raw.fallbacks?.nodeType || "concept") || "concept",
			relationshipType: toSnakeCase(raw.fallbacks?.relationshipType || "relates_to") || "relates_to",
		},
		nodeTypes: (raw.nodeTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
		relationshipTypes: (raw.relationshipTypes ?? []).map(normalizeEntry).filter((entry) => entry.name),
	};
}

function formatTypeList(title, entries) {
	const lines = entries.length > 0
		? entries.map((entry) => `- ${entry.name}: ${entry.description || "No description."}${entry.reason ? ` Reason: ${entry.reason}` : ""}`)
		: ["- None."];
	return [title, ...lines].join("\n");
}

function formatConstraintText(constraints = {}) {
	const parts = [];
	if (constraints.pattern) {
		parts.push(`pattern: ${constraints.pattern}`);
	}
	if (constraints.immutable) {
		parts.push("immutable");
	}
	if (constraints.maxLength !== undefined && constraints.maxLength !== null) {
		parts.push(`max length: ${constraints.maxLength}`);
	}
	if (constraints.allowedValues && Array.isArray(constraints.allowedValues) && constraints.allowedValues.length > 0) {
		parts.push(`allowed values: ${constraints.allowedValues.join(", ")}`);
	}
	return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatPropertyGuidance(title, propertyFields = []) {
	if (!propertyFields || propertyFields.length === 0) {
		return [title, "- No property descriptors defined."].join("\n");
	}

	const lines = propertyFields.map((field) => {
		const description = field.description || "No description.";
		const constraints = formatConstraintText(field.constraints);
		return `- ${field.name}: ${description}${constraints}`;
	});

	return [title, ...lines].join("\n");
}

export function formatSchemaCatalog(schema) {
	return [
		formatTypeList("Approved node types:", schema.nodeTypes),
		"",
		formatTypeList("Approved relationship types:", schema.relationshipTypes),
	].join("\n");
}

/**
 * Format property field guidance for injection into {{FIELD_GUIDANCE}} placeholder.
 * This renders per-property descriptions and constraints for both node and relationship fields.
 * Used by promptRegistry.js to inject field-level guidance after the OUTPUT SYNTAX section.
 */
export function formatFieldGuidance(schema) {
	const parts = [];

	if (schema.nodeProperties?.fields && schema.nodeProperties.fields.length > 0) {
		parts.push(formatPropertyGuidance("Node fields:", schema.nodeProperties.fields));
	}

	if (schema.relationshipProperties?.fields && schema.relationshipProperties.fields.length > 0) {
		parts.push(formatPropertyGuidance("Relationship fields:", schema.relationshipProperties.fields));
	}

	if (parts.length === 0) {
		return "No field descriptions defined in schema.";
	}

	return parts.join("\n\n");
}

/**
 * Merge proposal type suggestions into the approved schema file types.
 * Called when a HITL proposal is approved. Reads the raw schema file,
 * adds any new types from the proposal to the approved lists, and writes back.
 * Never writes to a `suggestions` section — suggestions live only in HITL records.
 */
export function mergeSchemaTypes(schema, schemaSuggestions = {}) {
	const incomingNodeTypes = schemaSuggestions.nodeTypes ?? [];
	const incomingRelationshipTypes = schemaSuggestions.relationshipTypes ?? [];

	if (incomingNodeTypes.length === 0 && incomingRelationshipTypes.length === 0) {
		return { nodeTypesAdded: 0, relationshipTypesAdded: 0 };
	}

	const rawSchema = readJson(schema.path);
	const existingNodeNames = new Set((rawSchema.nodeTypes ?? []).map((e) => toSnakeCase(e.name)));
	const existingRelationNames = new Set((rawSchema.relationshipTypes ?? []).map((e) => toSnakeCase(e.name)));
	let nodeTypesAdded = 0;
	let relationshipTypesAdded = 0;

	const nextNodeTypes = [...(rawSchema.nodeTypes ?? [])];
	for (const suggestion of incomingNodeTypes) {
		const name = toSnakeCase(suggestion.name);
		if (name && !existingNodeNames.has(name)) {
			nextNodeTypes.push({ name, description: String(suggestion.description ?? "").trim() });
			existingNodeNames.add(name);
			nodeTypesAdded += 1;
		}
	}

	const nextRelationshipTypes = [...(rawSchema.relationshipTypes ?? [])];
	for (const suggestion of incomingRelationshipTypes) {
		const name = toSnakeCase(suggestion.name);
		if (name && !existingRelationNames.has(name)) {
			nextRelationshipTypes.push({ name, description: String(suggestion.description ?? "").trim() });
			existingRelationNames.add(name);
			relationshipTypesAdded += 1;
		}
	}

	if (nodeTypesAdded === 0 && relationshipTypesAdded === 0) {
		return { nodeTypesAdded: 0, relationshipTypesAdded: 0 };
	}

	const nextSchema = {
		...rawSchema,
		nodeTypes: nextNodeTypes,
		relationshipTypes: nextRelationshipTypes,
	};

	fs.writeFileSync(schema.path, `${JSON.stringify(nextSchema, null, "\t")}\n`);

	return { nodeTypesAdded, relationshipTypesAdded };
}

export function buildApprovalSchema(baseSchema, schemaSuggestions = {}) {
    const approvalNodeTypes = new Map(baseSchema.nodeTypes.map(e => [e.name, e]));
    const approvalRelationTypes = new Map(baseSchema.relationshipTypes.map(e => [e.name, e]));
    
    for (const suggestion of (schemaSuggestions.nodeTypes ?? [])) {
        const name = toSnakeCase(suggestion.name);
        if (name && !approvalNodeTypes.has(name)) {
            approvalNodeTypes.set(name, { name, description: suggestion.description || '' });
        }
    }
    
    for (const suggestion of (schemaSuggestions.relationshipTypes ?? [])) {
        const name = toSnakeCase(suggestion.name);
        if (name && !approvalRelationTypes.has(name)) {
            approvalRelationTypes.set(name, { name, description: suggestion.description || '' });
        }
    }
    
    return {
        ...baseSchema,
        nodeTypes: [...approvalNodeTypes.values()],
        relationshipTypes: [...approvalRelationTypes.values()],
    };
}
