export const HITL_CHIP_DENSITY_KEY = "mindmesh.hitlChipDensity";

const START_MARKERS = new Set(["<start#$#$>", "start#$#$"]);
const END_MARKERS = new Set(["</end#$#$>", "<end#$#$>", "end#$#$"]);

function decodePipelineField(value) {
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

export function displayPipelineText(value) {
	return decodePipelineField(value);
}

function encodePipelineField(value) {
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

export function truncateText(value, length = 34) {
	const text = String(value ?? "");
	return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

export function toSnakeCase(value) {
	return String(value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

export function relationLabel(relation) {
	return String(relation ?? "relates_to").replaceAll("_", " ");
}

export function graphNameFromId(id) {
	return String(id ?? "").replace(/^node:/i, "");
}

export function displayNameFromIdentifier(value) {
	const text = graphNameFromId(value).trim();
	if (!text) {
		return "Unknown";
	}

	return text
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function isPipelineStart(line) {
	return START_MARKERS.has(String(line ?? "").trim().toLowerCase());
}

function isPipelineEnd(line) {
	return END_MARKERS.has(String(line ?? "").trim().toLowerCase());
}

export function pipelineLines(text) {
	const rawLines = String(text ?? "").split(/\r?\n/);
	const startIndex = rawLines.findIndex(isPipelineStart);
	const endIndex = rawLines.findIndex((line, index) => index > startIndex && isPipelineEnd(line));
	const bodyLines = startIndex === -1
		? rawLines
		: rawLines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex);

	return bodyLines.map((line) => line.trim()).filter(Boolean);
}

export function pipelineEditorText(text) {
	return pipelineLines(text).join("\n");
}

function pipelineParts(line) {
	// split respecting escaped pipes and decode escape sequences
	const raw = String(line ?? "");
	const parts = [];
	let cur = "";
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (ch === "\\" && i + 1 < raw.length) {
			cur += ch + raw[i + 1];
			i += 1;
			continue;
		}
		if (ch === "|") {
			parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	parts.push(cur.trim());
	return parts.map((p) => decodePipelineField(p));
}

function safePipelineField(value) {
	return encodePipelineField(value);
}

function pipelineRecordLine(recordType, fields) {
	return [recordType, ...fields].map(safePipelineField).join("|");
}

function withPipelineLines(lines) {
	return lines.filter(Boolean).join("\n");
}

function nodeIdFromName(name) {
	return `node:${toSnakeCase(graphNameFromId(name))}`;
}

function normalizedOperation(recordType) {
	if (recordType.endsWith("_DELETE")) {
		return "delete";
	}
	if (recordType.endsWith("_UPDATE")) {
		return "update";
	}
	return "create";
}

function reviewSignalEntries(record) {
	const text = [
		record.metadata,
		record.description,
		record.information,
		record.reason,
	].filter(Boolean).join("\n");
	const signals = [];
	if (/CONTRADICTION\s*:/i.test(text)) {
		signals.push({ kind: "contradiction", text });
	}
	if (/AMBIGUITY\s*:/i.test(text)) {
		signals.push({ kind: "ambiguity", text });
	}
	return signals;
}

function parseNodeRecord(parts, line, index, errors) {
	const recordType = parts[0].toUpperCase();
	const name = toSnakeCase(parts[1]);
	if (!name) {
		errors.push(`Line ${index + 1}: ${recordType} requires a node name.`);
	}

	const operation = normalizedOperation(recordType);
	const record = {
		key: `${recordType}:${name}:${index}`,
		entity: "node",
		recordType,
		operation,
		name,
		id: nodeIdFromName(name),
		label: parts[2] || displayNameFromIdentifier(name),
		type: toSnakeCase(parts[3] || "concept") || "concept",
		description: parts[4] || "",
		metadata: parts[5] || "",
		line,
		lineNumber: index + 1,
	};
	record.signals = reviewSignalEntries(record);
	return record;
}

function parseNodeDeleteRecord(parts, line, index, errors) {
	const recordType = parts[0].toUpperCase();
	const name = toSnakeCase(parts[1]);
	if (!name) {
		errors.push(`Line ${index + 1}: NODE_DELETE requires a node name.`);
	}

	const record = {
		key: `${recordType}:${name}:${index}`,
		entity: "nodeDelete",
		recordType,
		operation: "delete",
		name,
		id: nodeIdFromName(name),
		label: displayNameFromIdentifier(name),
		metadata: parts[2] || "",
		line,
		lineNumber: index + 1,
	};
	record.signals = reviewSignalEntries(record);
	return record;
}

function parseRelationRecord(parts, line, index, errors) {
	const recordType = parts[0].toUpperCase();
	const sourceName = toSnakeCase(parts[1]);
	const targetName = toSnakeCase(parts[2]);
	const relation = toSnakeCase(parts[3] || "relates_to") || "relates_to";
	if (!sourceName || !targetName) {
		errors.push(`Line ${index + 1}: ${recordType} requires source and target node names.`);
	}

	const operation = normalizedOperation(recordType);
	const record = {
		key: `${recordType}:${sourceName}:${relation}:${targetName}:${index}`,
		entity: "relation",
		recordType,
		operation,
		sourceName,
		targetName,
		sourceId: nodeIdFromName(sourceName),
		targetId: nodeIdFromName(targetName),
		relation,
		information: parts[4] || "",
		description: parts[5] || "",
		metadata: parts[6] || "",
		line,
		lineNumber: index + 1,
	};
	record.signals = reviewSignalEntries(record);
	return record;
}

function parseRelationDeleteRecord(parts, line, index, errors) {
	const recordType = parts[0].toUpperCase();
	const sourceName = toSnakeCase(parts[1]);
	const targetName = toSnakeCase(parts[2]);
	const relation = toSnakeCase(parts[3] || "relates_to") || "relates_to";
	if (!sourceName || !targetName) {
		errors.push(`Line ${index + 1}: RELATION_DELETE requires source and target node names.`);
	}

	const record = {
		key: `${recordType}:${sourceName}:${relation}:${targetName}:${index}`,
		entity: "relationDelete",
		recordType,
		operation: "delete",
		sourceName,
		targetName,
		sourceId: nodeIdFromName(sourceName),
		targetId: nodeIdFromName(targetName),
		relation,
		metadata: parts[4] || "",
		line,
		lineNumber: index + 1,
	};
	record.signals = reviewSignalEntries(record);
	return record;
}

function parseSchemaSuggestion(parts, line, index, errors) {
	const recordType = parts[0].toUpperCase();
	const name = toSnakeCase(parts[1]);
	if (!name) {
		errors.push(`Line ${index + 1}: ${recordType} requires a type name.`);
	}

	return {
		key: `${recordType}:${name}:${index}`,
		entity: recordType === "NODE_TYPE_SUGGESTION" ? "nodeTypeSuggestion" : "relationTypeSuggestion",
		recordType,
		operation: "suggest",
		name,
		description: parts[2] || "",
		reason: parts[3] || "",
		line,
		lineNumber: index + 1,
	};
}

function schemaSuggestionRecordType(entity) {
	return entity === "relationTypeSuggestion" ? "RELATION_TYPE_SUGGESTION" : "NODE_TYPE_SUGGESTION";
}

function schemaSuggestionLine(entity, suggestion) {
	return pipelineRecordLine(schemaSuggestionRecordType(entity), [
		toSnakeCase(suggestion?.name),
		suggestion?.description ?? "",
		suggestion?.reason ?? "",
	]);
}

function nextSchemaSuggestionName(lines, baseName) {
	const existingNames = new Set(lines.map((line) => toSnakeCase(pipelineParts(line)[1])));
	let nextName = baseName;
	let index = 2;
	while (existingNames.has(nextName)) {
		nextName = `${baseName}_${index}`;
		index += 1;
	}
	return nextName;
}

export function appendSchemaSuggestion(text, entity) {
	const lines = pipelineLines(text);
	const isRelation = entity === "relationTypeSuggestion";
	const name = nextSchemaSuggestionName(lines, isRelation ? "new_relationship_type" : "new_node_type");
	const description = isRelation ? "Describe this relationship type." : "Describe this node type.";
	lines.push(schemaSuggestionLine(entity, { name, description, reason: "Added during HITL review." }));
	return withPipelineLines(lines);
}

export function updateSchemaSuggestion(text, record, draft) {
	const lineIndex = Number(record?.lineNumber ?? 0) - 1;
	const lines = pipelineLines(text);
	if (lineIndex < 0 || lineIndex >= lines.length) {
		return text;
	}

	lines[lineIndex] = schemaSuggestionLine(record.entity, {
		name: draft?.name ?? record.name,
		description: draft?.description ?? record.description,
		reason: draft?.reason ?? record.reason,
	});
	return withPipelineLines(lines);
}

export function deleteSchemaSuggestion(text, record) {
	const lineIndex = Number(record?.lineNumber ?? 0) - 1;
	const lines = pipelineLines(text);
	if (lineIndex < 0 || lineIndex >= lines.length) {
		return text;
	}

	lines.splice(lineIndex, 1);
	return withPipelineLines(lines);
}

export function parseHitlProposal(text) {
	const errors = [];
	const records = [];
	const lines = pipelineLines(text);

	for (const [index, line] of lines.entries()) {
		const parts = pipelineParts(line);
		const recordType = parts[0]?.toUpperCase();

		if (["NODE", "NODE_CREATE", "NODE_UPDATE"].includes(recordType)) {
			records.push(parseNodeRecord(parts, line, index, errors));
		} else if (recordType === "NODE_DELETE") {
			records.push(parseNodeDeleteRecord(parts, line, index, errors));
		} else if (["RELATION", "EDGE", "RELATION_CREATE", "RELATION_UPDATE"].includes(recordType)) {
			records.push(parseRelationRecord(parts, line, index, errors));
		} else if (recordType === "RELATION_DELETE") {
			records.push(parseRelationDeleteRecord(parts, line, index, errors));
		} else if (recordType === "NODE_TYPE_SUGGESTION" || recordType === "RELATION_TYPE_SUGGESTION") {
			records.push(parseSchemaSuggestion(parts, line, index, errors));
		} else {
			errors.push(`Line ${index + 1}: unsupported record type "${parts[0] || "empty"}".`);
		}
	}

	const nodes = records.filter((record) => record.entity === "node");
	const relations = records.filter((record) => record.entity === "relation");
	const nodeDeletes = records.filter((record) => record.entity === "nodeDelete");
	const relationDeletes = records.filter((record) => record.entity === "relationDelete");
	const schemaSuggestions = records.filter((record) => (
		record.entity === "nodeTypeSuggestion" || record.entity === "relationTypeSuggestion"
	));
	const signals = records.flatMap((record) => record.signals?.map((signal) => ({
		...signal,
		record,
	})) ?? []);

	return {
		lines,
		records,
		nodes,
		relations,
		nodeDeletes,
		relationDeletes,
		schemaSuggestions,
		signals,
		errors,
	};
}

export function formatHitlDate(value) {
	if (!value) {
		return "Unknown time";
	}

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleString([], {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

export function hitlSignalCounts(note) {
	return {
		ambiguityCount: Number(note?.ambiguityCount ?? 0),
		contradictionCount: Number(note?.contradictionCount ?? 0),
	};
}

export function deleteCount(note) {
	return Number(note?.nodeDeleteCount ?? 0) + Number(note?.relationDeleteCount ?? 0);
}

export function needsAttention(note) {
	const signals = hitlSignalCounts(note);
	return signals.ambiguityCount > 0
		|| signals.contradictionCount > 0
		|| deleteCount(note) > 0
		|| Number(note?.schemaSuggestionCount ?? 0) > 0;
}

export function noteMatchesFilter(note, filter) {
	const signals = hitlSignalCounts(note);
	if (filter === "attention") {
		return needsAttention(note);
	}
	if (filter === "contradictions") {
		return signals.contradictionCount > 0;
	}
	if (filter === "ambiguities") {
		return signals.ambiguityCount > 0;
	}
	if (filter === "deletes") {
		return deleteCount(note) > 0;
	}
	if (filter === "schema") {
		return Number(note?.schemaSuggestionCount ?? 0) > 0;
	}
	return true;
}

function attentionScore(note) {
	const signals = hitlSignalCounts(note);
	return (signals.contradictionCount * 100)
		+ (signals.ambiguityCount * 70)
		+ (deleteCount(note) * 35)
		+ (Number(note?.schemaSuggestionCount ?? 0) * 20);
}

export function sortHitlNotes(notes) {
	return [...(notes ?? [])].sort((left, right) => {
		const scoreDelta = attentionScore(right) - attentionScore(left);
		if (scoreDelta !== 0) {
			return scoreDelta;
		}

		return new Date(right.createdAt ?? 0).getTime() - new Date(left.createdAt ?? 0).getTime();
	});
}

export function hitlCountLabel(note) {
	const nodeParts = [
		`${note.nodeCount ?? 0}N`,
		note.nodeDeleteCount ? `${note.nodeDeleteCount}ND` : "",
	].filter(Boolean);
	const relationParts = [
		`${note.relationCount ?? 0}R`,
		note.relationDeleteCount ? `${note.relationDeleteCount}RD` : "",
	].filter(Boolean);
	return [...nodeParts, ...relationParts].join(" / ");
}

export function strongNoteChips(note) {
	const signals = hitlSignalCounts(note);
	return [
		{ kind: "neutral", label: "Nodes", value: Number(note?.nodeCount ?? 0) },
		{ kind: "neutral", label: "Relations", value: Number(note?.relationCount ?? 0) },
		{ kind: "delete", label: "Delete", value: deleteCount(note) },
		{ kind: "schema", label: "Schema", value: Number(note?.schemaSuggestionCount ?? 0) },
		{ kind: "contradiction", label: "Contradiction", value: signals.contradictionCount },
		{ kind: "ambiguity", label: "Ambiguity", value: signals.ambiguityCount },
	].filter((chip) => chip.value > 0);
}
