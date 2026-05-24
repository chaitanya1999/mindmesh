import crypto from "node:crypto";

export function toSnakeCase(value) {
	return String(value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function normalizeNodeName(value) {
	return toSnakeCase(String(value ?? "").trim().replace(/^node:/i, ""));
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

function relationIdFor(sourceId, relation, targetId) {
	return `rel:${stableHash(`${sourceId}:${relation}:${targetId}`)}`;
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

function preferText(existingValue, nextValue) {
	const existingText = String(existingValue ?? "");
	const nextText = String(nextValue ?? "");

	if (!existingText) {
		return nextText;
	}

	if (!nextText || existingText === nextText) {
		return existingText;
	}

	return nextText.length > existingText.length ? nextText : existingText;
}

function mergeRelation(existingRelation, nextRelation) {
	if (!existingRelation) {
		return nextRelation;
	}

	return {
		...existingRelation,
		information: preferText(existingRelation.information, nextRelation.information),
		description: preferText(existingRelation.description, nextRelation.description),
		metadata: preferText(existingRelation.metadata, nextRelation.metadata),
	};
}

function mergeNode(existingNode, nextNode, schemaRules) {
	if (!existingNode) {
		return nextNode;
	}

	const shouldUpgradeFallbackType = existingNode.type === schemaRules.fallbackNodeType
		&& nextNode.type
		&& nextNode.type !== schemaRules.fallbackNodeType;

	return {
		...existingNode,
		label: existingNode.label || nextNode.label,
		type: shouldUpgradeFallbackType ? nextNode.type : existingNode.type,
		description: preferText(existingNode.description, nextNode.description),
		metadata: preferText(existingNode.metadata, nextNode.metadata),
	};
}

export function normalizeGraphPayload(payload, { schema = null, autoApplySuggestions = false } = {}) {
	const nodeMap = new Map();
	const warnings = [...(payload.warnings ?? [])];
	const schemaSuggestions = normalizeSuggestions(payload.schemaSuggestions);
	if (schema && autoApplySuggestions) {
		addImplicitSuggestionsFromPayload(payload, schema, schemaSuggestions);
	}
	const schemaRules = buildSchemaRules(schema, schemaSuggestions, autoApplySuggestions);

	for (const rawNode of payload.nodes ?? []) {
		const name = normalizeNodeName(rawNode.name || rawNode.label);
		if (!name) {
			continue;
		}

		const normalizedNode = {
			id: rawNode.id || `node:${name}`,
			label: rawNode.label || labelFromName(name),
			name,
			type: normalizeNodeType(rawNode.type, schemaRules, warnings),
			description: rawNode.description || "",
			metadata: rawNode.metadata || "",
			operation: rawNode.operation || "upsert",
		};
		nodeMap.set(name, mergeNode(nodeMap.get(name), normalizedNode, schemaRules));
	}

	const relationMap = new Map();

	for (const rawRelation of payload.relations ?? []) {
		const sourceName = normalizeNodeName(rawRelation.sourceName || rawRelation.source || rawRelation.sourceId);
		const targetName = normalizeNodeName(rawRelation.targetName || rawRelation.target || rawRelation.targetId);
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
				metadata: "",
				operation: "upsert",
			});
		}

		if (!nodeMap.has(targetName)) {
			nodeMap.set(targetName, {
				id: `node:${targetName}`,
				label: labelFromName(targetName),
				name: targetName,
				type: schemaRules.fallbackNodeType,
				description: "",
				metadata: "",
				operation: "upsert",
			});
		}

		const sourceId = nodeMap.get(sourceName).id;
		const targetId = nodeMap.get(targetName).id;
		const relationId = rawRelation.id || relationIdFor(sourceId, relation, targetId);

		const normalizedRelation = {
			id: relationId,
			sourceId,
			targetId,
			relation,
			information: rawRelation.information ?? "",
			description: rawRelation.description ?? "",
			metadata: rawRelation.metadata ?? "",
			operation: rawRelation.operation || "upsert",
		};
		relationMap.set(relationId, mergeRelation(relationMap.get(relationId), normalizedRelation));
	}

	const nodeDeleteMap = new Map();
	for (const rawNodeDelete of payload.nodeDeletes ?? []) {
		const name = normalizeNodeName(rawNodeDelete.name || rawNodeDelete.id);
		if (!name) {
			continue;
		}

		const id = rawNodeDelete.id || `node:${name}`;
		const existingNodeDelete = nodeDeleteMap.get(id);
		nodeDeleteMap.set(id, {
			id,
			name,
			metadata: preferText(existingNodeDelete?.metadata, rawNodeDelete.metadata),
			operation: "delete",
		});
	}

	const relationDeleteMap = new Map();
	for (const rawRelationDelete of payload.relationDeletes ?? []) {
		const sourceName = normalizeNodeName(rawRelationDelete.sourceName || rawRelationDelete.source || rawRelationDelete.sourceId);
		const targetName = normalizeNodeName(rawRelationDelete.targetName || rawRelationDelete.target || rawRelationDelete.targetId);
		const relation = toSnakeCase(rawRelationDelete.relation);

		if (!sourceName || !targetName || !relation) {
			continue;
		}

		const sourceId = `node:${sourceName}`;
		const targetId = `node:${targetName}`;
		const id = rawRelationDelete.id || relationIdFor(sourceId, relation, targetId);
		const existingRelationDelete = relationDeleteMap.get(id);
		relationDeleteMap.set(id, {
			id,
			sourceId,
			targetId,
			relation,
			metadata: preferText(existingRelationDelete?.metadata, rawRelationDelete.metadata),
			operation: "delete",
		});
	}

	return {
		nodes: [...nodeMap.values()],
		relations: [...relationMap.values()],
		nodeDeletes: [...nodeDeleteMap.values()],
		relationDeletes: [...relationDeleteMap.values()],
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

function isCustomGraphStartTag(line) {
	return ["<start#$#$>", "start#$#$"].includes(String(line ?? "").trim().toLowerCase());
}

function isCustomGraphEndTag(line) {
	return ["</end#$#$>", "<end#$#$>", "end#$#$"].includes(String(line ?? "").trim().toLowerCase());
}

function extractCustomGraphBody(text) {
	const raw = stripFence(text);
	const lines = raw.split(/\r?\n/);
	const startIndex = lines.findIndex(isCustomGraphStartTag);

	if (startIndex === -1) {
		return raw;
	}

	const endIndex = lines.findIndex((line, index) => index > startIndex && isCustomGraphEndTag(line));
	const bodyLines = endIndex === -1
		? lines.slice(startIndex + 1)
		: lines.slice(startIndex + 1, endIndex);

	return bodyLines.join("\n").trim();
}

function cleanField(value) {
	return String(value ?? "").trim();
}

export function extractCustomGraph(text) {
	const raw = extractCustomGraphBody(text);
	const payload = {
		nodes: [],
		relations: [],
		nodeDeletes: [],
		relationDeletes: [],
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

		if (recordType === "NODE" || recordType === "NODE_CREATE" || recordType === "NODE_UPDATE") {
			const [, name, label, type = "concept", description = "", metadata = ""] = parts;

			if (!name || !label) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.nodes.push({
				name,
				label,
				type,
				description,
				metadata,
				operation: recordType === "NODE" ? "upsert" : recordType.replace("NODE_", "").toLowerCase(),
			});
			continue;
		}

		if (recordType === "NODE_DELETE") {
			const [, name, metadata = ""] = parts;

			if (!name) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.nodeDeletes.push({ name, metadata, operation: "delete" });
			continue;
		}

		if (recordType === "RELATION" || recordType === "EDGE" || recordType === "RELATION_CREATE" || recordType === "RELATION_UPDATE") {
			const [, sourceName, targetName, relation = "relates_to", information = "", description = "", metadata = ""] = parts;

			if (!sourceName || !targetName) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.relations.push({
				sourceName,
				targetName,
				relation,
				information,
				description,
				metadata,
				operation: recordType === "RELATION" || recordType === "EDGE" ? "upsert" : recordType.replace("RELATION_", "").toLowerCase(),
			});
			continue;
		}

		if (recordType === "RELATION_DELETE") {
			const [, sourceName, targetName, relation = "", metadata = ""] = parts;

			if (!sourceName || !targetName || !relation) {
				skippedLines.push(index + 1);
				continue;
			}

			payload.relationDeletes.push({ sourceName, targetName, relation, metadata, operation: "delete" });
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

	if (
		payload.nodes.length === 0
		&& payload.relations.length === 0
		&& payload.nodeDeletes.length === 0
		&& payload.relationDeletes.length === 0
	) {
		payload.warnings = [
			...(payload.warnings ?? []),
			"LLM response did not contain graph mutation records.",
		];
	}

	if (skippedLines.length > 0) {
		payload.warnings = [
			...(payload.warnings ?? []),
			`Skipped malformed graph lines: ${skippedLines.join(", ")}`,
		];
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
