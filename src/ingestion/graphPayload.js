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

	for (const rawNode of payload.nodes ?? []) {
		const type = toSnakeCase(rawNode.type);

		if (!type || approvedNodeTypes.has(type) || suggestedNodeTypes.has(type)) {
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

		if (!relation || approvedRelationshipTypes.has(relation) || suggestedRelationshipTypes.has(relation)) {
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

// There are no fallback types: a blank or unknown type is a schema violation, so it always reaches review.
function buildSchemaRules(schema) {
	const enforceSchema = Boolean(schema);
	const allowedNodeTypes = new Set((schema?.nodeTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));
	const allowedRelationshipTypes = new Set((schema?.relationshipTypes ?? []).map((entry) => toSnakeCase(entry.name)).filter(Boolean));

	return {
		enforceSchema,
		allowedNodeTypes,
		allowedRelationshipTypes,
	};
}

function schemaViolation(kind, value, message, record = {}) {
	return {
		kind,
		value,
		message,
		record,
	};
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

function mergeNode(existingNode, nextNode) {
	if (!existingNode) {
		return nextNode;
	}

	return {
		...existingNode,
		label: existingNode.label || nextNode.label,
		type: existingNode.type || nextNode.type,
		description: nextNode.description
			? nextNode.description
			: existingNode.description,
		metadata: nextNode.metadata
			? nextNode.metadata
			: existingNode.metadata,
	};
}

export function normalizeGraphPayload(payload, { schema = null } = {}) {
	const nodeMap = new Map();
	const warnings = [...(payload.warnings ?? [])];
	const schemaViolations = [];
	const schemaSuggestions = normalizeSuggestions(payload.schemaSuggestions);
	if (schema) {
		addImplicitSuggestionsFromPayload(payload, schema, schemaSuggestions);
	}
	const schemaRules = buildSchemaRules(schema);

	for (const rawNode of payload.nodes ?? []) {
		const name = normalizeNodeName(rawNode.name || rawNode.label);
		if (!name) {
			continue;
		}

		const nodeType = toSnakeCase(rawNode.type);
		if (schemaRules.enforceSchema && !schemaRules.allowedNodeTypes.has(nodeType)) {
			const message = nodeType
				? `Node "${name}" uses unknown node type "${nodeType}".`
				: `Node "${name}" has no node type.`;
			warnings.push(message);
			schemaViolations.push(schemaViolation("nodeType", nodeType, message, { name, label: rawNode.label || labelFromName(name) }));
		}

		const normalizedNode = {
			id: rawNode.id || `node:${name}`,
			label: rawNode.label || labelFromName(name),
			name,
			type: nodeType,
			description: rawNode.description || "",
			metadata: rawNode.metadata || "",
			operation: rawNode.operation || "upsert",
		};
		nodeMap.set(name, mergeNode(nodeMap.get(name), normalizedNode));
	}

	const relationMap = new Map();

	for (const rawRelation of payload.relations ?? []) {
		const sourceName = normalizeNodeName(rawRelation.sourceName || rawRelation.source || rawRelation.sourceId);
		const targetName = normalizeNodeName(rawRelation.targetName || rawRelation.target || rawRelation.targetId);
		const relation = toSnakeCase(rawRelation.relation);

		if (!sourceName || !targetName) {
			continue;
		}

		if (schemaRules.enforceSchema && !schemaRules.allowedRelationshipTypes.has(relation)) {
			const message = relation
				? `Relation "${sourceName}" -> "${targetName}" uses unknown relationship type "${relation}".`
				: `Relation "${sourceName}" -> "${targetName}" has no relationship type.`;
			warnings.push(message);
			schemaViolations.push(schemaViolation("relationshipType", relation, message, { sourceName, targetName, relation }));
		}

		// Relations never create nodes. An endpoint without a node record here is a reference to an
		// existing node; resolveGraphPayload() in graphResolution.js checks that it exists.
		const sourceId = nodeMap.get(sourceName)?.id ?? `node:${sourceName}`;
		const targetId = nodeMap.get(targetName)?.id ?? `node:${targetName}`;
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
		schemaViolations,
		schemaWarnings: [...new Set(warnings)],
	};
}

// Pipeline parsing utilities for custom extraction format.
export function splitPipelineFields(line) {
	const parts = [];
	let current = "";
	for (let i = 0; i < line.length; i += 1) {
		const ch = line[i];

		if (ch === "\\" && i + 1 < line.length) {
			// keep escape sequences intact for decoding later
			current += ch + line[i + 1];
			i += 1;
			continue;
		}

		if (ch === "|") {
			parts.push(current.trim());
			current = "";
			continue;
		}

		current += ch;
	}

	parts.push(current.trim());
	return parts;
}

export function decodePipelineField(value) {
	if (value === undefined || value === null) {
		return "";
	}

	const text = String(value);
	let decoded = "";

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char !== "\\" || index + 1 >= text.length) {
			decoded += char;
			continue;
		}

		const escaped = text[index + 1];
		index += 1;

		if (escaped === "n") {
			decoded += "\n";
		} else if (escaped === "r") {
			decoded += "\r";
		} else if (escaped === "t") {
			decoded += "\t";
		} else if (escaped === "|") {
			decoded += "|";
		} else if (escaped === "\\") {
			decoded += "\\";
		} else {
			decoded += `\\${escaped}`;
		}
	}

	return decoded.trim();
}

export function encodePipelineField(value) {
	if (value === undefined || value === null) {
		return "";
	}

	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.trim();
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
		const trimmedLine = line.trim().replace(/^[-*]\s+/, "");
		const trimmed = String(trimmedLine);

		if (!trimmed || trimmed.startsWith("#") || trimmed === "GRAPH" || trimmed === "NODES" || trimmed === "RELATIONS") {
			continue;
		}

		const rawParts = splitPipelineFields(trimmed);
		const parts = rawParts.map((p) => decodePipelineField(p));
		const recordType = parts[0]?.toUpperCase();

		if (recordType === "NODE" || recordType === "NODE_CREATE" || recordType === "NODE_UPDATE") {
			const [, name, label, type = "", description = "", metadata = ""] = parts;

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
			const [, sourceName, targetName, relation = "", information = "", description = "", metadata = ""] = parts;

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

export function parseGraphExtraction(text) {
	return extractCustomGraph(text);
}

function graphNameFromId(value) {
	return String(value ?? "").replace(/^node:/i, "");
}

function graphRecordLine(recordType, fields) {
	return [recordType, ...fields].map(encodePipelineField).join("|");
}

// Renders a normalized payload back into the pipe-delimited record block stored on HITL proposals.
export function formatGraphRecords(graphPayload) {
	const lines = [];
	for (const node of graphPayload.nodes ?? []) {
		lines.push(graphRecordLine(node.operation === "update" ? "NODE_UPDATE" : "NODE_CREATE", [
			node.name || graphNameFromId(node.id),
			node.label || node.name || graphNameFromId(node.id),
			node.type || "",
			node.description || "",
			node.metadata || "",
		]));
	}
	for (const nodeDelete of graphPayload.nodeDeletes ?? []) {
		lines.push(graphRecordLine("NODE_DELETE", [
			nodeDelete.name || graphNameFromId(nodeDelete.id),
			nodeDelete.metadata || "",
		]));
	}
	for (const relation of graphPayload.relations ?? []) {
		lines.push(graphRecordLine(relation.operation === "update" ? "RELATION_UPDATE" : "RELATION_CREATE", [
			graphNameFromId(relation.sourceId),
			graphNameFromId(relation.targetId),
			relation.relation || "",
			relation.information || "",
			relation.description || "",
			relation.metadata || "",
		]));
	}
	for (const relationDelete of graphPayload.relationDeletes ?? []) {
		lines.push(graphRecordLine("RELATION_DELETE", [
			graphNameFromId(relationDelete.sourceId),
			graphNameFromId(relationDelete.targetId),
			relationDelete.relation || "",
			relationDelete.metadata || "",
		]));
	}
	for (const suggestion of graphPayload.schemaSuggestions?.nodeTypes ?? []) {
		lines.push(graphRecordLine("NODE_TYPE_SUGGESTION", [
			suggestion.name,
			suggestion.description,
			suggestion.reason,
		]));
	}
	for (const suggestion of graphPayload.schemaSuggestions?.relationshipTypes ?? []) {
		lines.push(graphRecordLine("RELATION_TYPE_SUGGESTION", [
			suggestion.name,
			suggestion.description,
			suggestion.reason,
		]));
	}

	return [
		"<start#$#$>",
		...lines,
		"</end#$#$>",
	].join("\n");
}

/**
 * Validate node properties against schema constraint definitions.
 * Returns an array of violation objects with { field, value, constraint, message }.
 * This is optional and configurable; violations can be attached as metadata
 * or used to reject mutations depending on ingestion mode and schema.strict config.
 *
 * @param {object} graphPayload - Normalized graph payload ({ nodes, relations })
 * @param {object} schema - Loaded graph schema with nodeProperties.fields and relationshipProperties.fields
 * @param {object} [options]
 * @param {boolean} [options.strict=false] - If true, violations are returned as errors (strings); otherwise as warnings
 * @returns {{ violations: Array<{field:string, value:*, constraint:string, message:string, record:object}>, errors: string[] }}
 */
export function validatePropertyConstraints(graphPayload, schema, { strict = false } = {}) {
	const violations = [];
	const errors = [];

	const nodeFieldMap = buildFieldMap(schema.nodeProperties?.fields);
	const relationFieldMap = buildFieldMap(schema.relationshipProperties?.fields);

	for (const node of graphPayload.nodes ?? []) {
		for (const [fieldName, constraints] of nodeFieldMap) {
			const value = node[fieldName];
			const result = checkConstraints(fieldName, value, constraints, node);
			if (result) {
				violations.push(result);
				if (strict) {
					errors.push(result.message);
				}
			}
		}
		// Check immutable by comparing against existing node? Not possible without DB lookup here.
	}

	for (const relation of graphPayload.relations ?? []) {
		for (const [fieldName, constraints] of relationFieldMap) {
			const value = relation[fieldName];
			const result = checkConstraints(fieldName, value, constraints, relation);
			if (result) {
				violations.push(result);
				if (strict) {
					errors.push(result.message);
				}
			}
		}
	}

	return { violations, errors };
}

function buildFieldMap(fields = []) {
	const map = new Map();
	for (const field of fields) {
		if (field.constraints && typeof field.constraints === "object" && Object.keys(field.constraints).length > 0) {
			map.set(field.name, field.constraints);
		}
	}
	return map;
}

function checkConstraints(fieldName, value, constraints, record) {
	if (constraints.pattern && value && !new RegExp(constraints.pattern).test(String(value))) {
		return {
			field: fieldName,
			value,
			constraint: `pattern: ${constraints.pattern}`,
			message: `Field "${fieldName}" value "${value}" does not match required pattern ${constraints.pattern}.`,
			record,
		};
	}

	if (constraints.maxLength !== undefined && constraints.maxLength !== null && value && String(value).length > constraints.maxLength) {
		return {
			field: fieldName,
			value,
			constraint: `maxLength: ${constraints.maxLength}`,
			message: `Field "${fieldName}" value exceeds maximum length of ${constraints.maxLength}.`,
			record,
		};
	}

	if (constraints.allowedValues && Array.isArray(constraints.allowedValues) && value && !constraints.allowedValues.includes(String(value))) {
		return {
			field: fieldName,
			value,
			constraint: `allowedValues: [${constraints.allowedValues.join(", ")}]`,
			message: `Field "${fieldName}" value "${value}" is not in allowed values: ${constraints.allowedValues.join(", ")}.`,
			record,
		};
	}

	return null;
}
