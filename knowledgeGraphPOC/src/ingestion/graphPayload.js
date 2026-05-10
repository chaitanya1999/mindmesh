import crypto from "node:crypto";

export function toSnakeCase(value) {
	return String(value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function labelFromName(name) {
	return name
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function stableHash(value) {
	return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function normalizeSuggestions(rawSuggestions = {}) {
	const nodeTypes = (rawSuggestions.nodeTypes ?? []).map((suggestion) => ({
		name: toSnakeCase(suggestion.name),
		description: suggestion.description || "",
		reason: suggestion.reason || "",
	})).filter((suggestion) => suggestion.name);

	const relationshipTypes = (rawSuggestions.relationshipTypes ?? []).map((suggestion) => ({
		name: toSnakeCase(suggestion.name),
		description: suggestion.description || "",
		reason: suggestion.reason || "",
	})).filter((suggestion) => suggestion.name);

	return { nodeTypes, relationshipTypes };
}

function addImplicitSuggestionsFromPayload(payload, schema, schemaSuggestions) {
	const approvedNodeTypes = new Set((schema?.nodeTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));
	const approvedRelationshipTypes = new Set((schema?.relationshipTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));
	const suggestedNodeTypes = new Set(schemaSuggestions.nodeTypes.map((entry) => entry.name));
	const suggestedRelationshipTypes = new Set(schemaSuggestions.relationshipTypes.map((entry) => entry.name));
	const fallbackNodeType = toSnakeCase(schema?.fallbacks?.nodeType || "concept") || "concept";
	const fallbackRelationshipType = toSnakeCase(schema?.fallbacks?.relationshipType || "relates_to") || "relates_to";

	for (const rawNode of payload.nodes ?? []) {
		const type = toSnakeCase(rawNode.type);

		if (!type || type === fallbackNodeType || approvedNodeTypes.has(type) || suggestedNodeTypes.has(type)) {
			continue;
		}

		schemaSuggestions.nodeTypes.push({
			name: type,
			description: `Node type inferred from extracted NODE records.`,
			reason: `The LLM used "${type}" as a node type without an explicit NODE_TYPE_SUGGESTION record.`,
		});
		suggestedNodeTypes.add(type);
	}

	for (const rawRelation of payload.relations ?? []) {
		const relation = toSnakeCase(rawRelation.relation);

		if (!relation || relation === fallbackRelationshipType || approvedRelationshipTypes.has(relation) || suggestedRelationshipTypes.has(relation)) {
			continue;
		}

		schemaSuggestions.relationshipTypes.push({
			name: relation,
			description: `Relationship type inferred from extracted RELATION records.`,
			reason: `The LLM used "${relation}" as a relationship type without an explicit RELATION_TYPE_SUGGESTION record.`,
		});
		suggestedRelationshipTypes.add(relation);
	}
}

function buildSchemaRules(schema, suggestions, autoApplySuggestions) {
	const fallbackNodeType = toSnakeCase(schema?.fallbacks?.nodeType || "concept") || "concept";
	const fallbackRelationshipType = toSnakeCase(schema?.fallbacks?.relationshipType || "relates_to") || "relates_to";
	const enforceSchema = Boolean(schema);
	const allowedNodeTypes = new Set((schema?.nodeTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));
	const allowedRelationshipTypes = new Set((schema?.relationshipTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));

	allowedNodeTypes.add(fallbackNodeType);
	allowedRelationshipTypes.add(fallbackRelationshipType);

	if (autoApplySuggestions) {
		for (const suggestion of suggestions.nodeTypes) {
			allowedNodeTypes.add(suggestion.name);
		}

		for (const suggestion of suggestions.relationshipTypes) {
			allowedRelationshipTypes.add(suggestion.name);
		}
	}

	return {
		enforceSchema,
		fallbackNodeType,
		fallbackRelationshipType,
		allowedNodeTypes,
		allowedRelationshipTypes,
	};
}

function normalizeNodeType(rawType, schemaRules, warnings) {
	const type = toSnakeCase(rawType || schemaRules.fallbackNodeType) || schemaRules.fallbackNodeType;

	if (!schemaRules.enforceSchema) {
		return type;
	}

	if (schemaRules.allowedNodeTypes.has(type)) {
		return type;
	}

	warnings.push(`Unknown node type "${type}" was replaced with "${schemaRules.fallbackNodeType}".`);
	return schemaRules.fallbackNodeType;
}

function normalizeRelationshipType(rawRelation, schemaRules, warnings) {
	const relation = toSnakeCase(rawRelation || schemaRules.fallbackRelationshipType) || schemaRules.fallbackRelationshipType;

	if (!schemaRules.enforceSchema) {
		return relation;
	}

	if (schemaRules.allowedRelationshipTypes.has(relation)) {
		return relation;
	}

	warnings.push(`Unknown relationship type "${relation}" was replaced with "${schemaRules.fallbackRelationshipType}".`);
	return schemaRules.fallbackRelationshipType;
}

export function normalizeGraphPayload(payload, { schema = null, autoApplySuggestions = false } = {}) {
	const nodeMap = new Map();
	const warnings = [];
	const schemaSuggestions = normalizeSuggestions(payload.schemaSuggestions);
	if (schema && autoApplySuggestions) {
		addImplicitSuggestionsFromPayload(payload, schema, schemaSuggestions);
	}
	const schemaRules = buildSchemaRules(schema, schemaSuggestions, autoApplySuggestions);

	for (const rawNode of payload.nodes ?? []) {
		const name = toSnakeCase(rawNode.name || rawNode.label);
		if (!name) {
			continue;
		}

		nodeMap.set(name, {
			id: rawNode.id || `node:${name}`,
			label: rawNode.label || labelFromName(name),
			name,
			type: normalizeNodeType(rawNode.type, schemaRules, warnings),
			description: rawNode.description || "",
		});
	}

	const relations = [];

	for (const rawRelation of payload.relations ?? []) {
		const sourceName = toSnakeCase(rawRelation.sourceName || rawRelation.source || rawRelation.sourceId);
		const targetName = toSnakeCase(rawRelation.targetName || rawRelation.target || rawRelation.targetId);
		const relation = normalizeRelationshipType(rawRelation.relation, schemaRules, warnings);

		if (!sourceName || !targetName) {
			continue;
		}

		if (!nodeMap.has(sourceName)) {
			nodeMap.set(sourceName, {
				id: `node:${sourceName}`,
				label: labelFromName(sourceName),
				name: sourceName,
				type: schemaRules.fallbackNodeType,
				description: "",
			});
		}

		if (!nodeMap.has(targetName)) {
			nodeMap.set(targetName, {
				id: `node:${targetName}`,
				label: labelFromName(targetName),
				name: targetName,
				type: schemaRules.fallbackNodeType,
				description: "",
			});
		}

		const sourceId = nodeMap.get(sourceName).id;
		const targetId = nodeMap.get(targetName).id;
		const relationId = rawRelation.id || `rel:${stableHash(`${sourceId}:${relation}:${targetId}`)}`;

		relations.push({
			id: relationId,
			sourceId,
			targetId,
			relation,
			information: rawRelation.information || `${nodeMap.get(sourceName).label} ${relation.replaceAll("_", " ")} ${nodeMap.get(targetName).label}.`,
			description: rawRelation.description || "",
		});
	}

	return {
		nodes: [...nodeMap.values()],
		relations,
		schemaSuggestions,
		schemaWarnings: [...new Set(warnings)],
	};
}

export function extractJsonObject(text) {
	const raw = String(text ?? "").trim();
	const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidate = fencedMatch ? fencedMatch[1].trim() : raw;

	try {
		return JSON.parse(candidate);
	} catch {
		const start = candidate.indexOf("{");
		const end = candidate.lastIndexOf("}");

		if (start >= 0 && end > start) {
			return JSON.parse(candidate.slice(start, end + 1));
		}

		throw new Error("LLM response did not contain valid graph JSON.");
	}
}

function stripFence(text) {
	const raw = String(text ?? "").trim();
	const fencedMatch = raw.match(/```(?:graph|text)?\s*([\s\S]*?)```/i);
	return fencedMatch ? fencedMatch[1].trim() : raw;
}

function cleanField(value) {
	return String(value ?? "").trim();
}

export function extractCustomGraph(text) {
	const raw = stripFence(text);
	const payload = {
		nodes: [],
		relations: [],
		schemaSuggestions: {
			nodeTypes: [],
			relationshipTypes: [],
		},
	};
	const skippedLines = [];

	for (const [index, line] of raw.split(/\r?\n/).entries()) {
		const trimmed = line.trim().replace(/^[-*]\s+/, "");

		if (!trimmed || trimmed.startsWith("#") || trimmed === "GRAPH" || trimmed === "NODES" || trimmed === "RELATIONS") {
			continue;
		}

		const parts = trimmed.split("|").map(cleanField);
		const recordType = parts[0]?.toUpperCase();

		if (recordType === "NODE") {
			const [, name, label, type = "concept", description = ""] = parts;

			if (!name || !label) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.nodes.push({ name, label, type, description });
			continue;
		}

		if (recordType === "RELATION" || recordType === "EDGE") {
			const [, sourceName, targetName, relation = "relates_to", information = "", description = ""] = parts;

			if (!sourceName || !targetName) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.relations.push({ sourceName, targetName, relation, information, description });
			continue;
		}

		if (recordType === "NODE_TYPE_SUGGESTION") {
			const [, name, description = "", reason = ""] = parts;

			if (!name || !description) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.schemaSuggestions.nodeTypes.push({ name, description, reason });
			continue;
		}

		if (recordType === "RELATION_TYPE_SUGGESTION") {
			const [, name, description = "", reason = ""] = parts;

			if (!name || !description) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.schemaSuggestions.relationshipTypes.push({ name, description, reason });
			continue;
		}

		skippedLines.push(index + 1);
	}

	if (payload.nodes.length === 0 && payload.relations.length === 0) {
		throw new Error("LLM response did not contain valid custom graph records.");
	}

	if (skippedLines.length > 0) {
		payload.warnings = [`Skipped malformed graph lines: ${skippedLines.join(", ")}`];
	}

	return payload;
}

export function parseGraphExtraction(text, { format = "json" } = {}) {
	if (format === "json") {
		if (text && typeof text === "object") {
			return text;
		}

		return extractJsonObject(text);
	}

	if (format === "custom") {
		return extractCustomGraph(text);
	}

	throw new Error(`Unsupported graph extraction format: ${format}`);
}
