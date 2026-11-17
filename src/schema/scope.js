// Scope: which parts of the organisation a node or relation belongs to, in named dimensions declared by the
// schema (for the LOS project `bu`: uc, nc, tw, cv, tr, and `module`: sbd, hzt, mandate, pai). A scope is a
// sorted list of "dimension:value" entries (["bu:nc", "bu:uc", "module:sbd"]); its record form is
// "bu:nc,uc;module:sbd". A dimension without entries is not stated: it matches every filter on that dimension.
// Dimensions are independent; the engine knows no rules between them.

// Which kinds of scope are in use (config `scope.nodes`, `scope.relations`; set once by createMindMesh()).
// A switched-off kind keeps its record column, but values are dropped, prompts and forms leave it out, and
// filters ignore it. Stored values are kept.
// Both off unless config switches them on.
const DEFAULT_SCOPE_SETTINGS = { nodes: false, relations: false };
let scopeSettings = { ...DEFAULT_SCOPE_SETTINGS };

// Names of the dimensions declared by the last schema loaded (loadGraphSchema()). The vector store writes a
// "not stated" flag for each, because a Chroma filter cannot match a missing metadata key.
let knownDimensions = [];

export function setScopeSettings(settings = {}) {
	scopeSettings = {
		nodes: settings.nodes ?? DEFAULT_SCOPE_SETTINGS.nodes,
		relations: settings.relations ?? DEFAULT_SCOPE_SETTINGS.relations,
	};
	return getScopeSettings();
}

export function getScopeSettings() {
	return { ...scopeSettings };
}

// kind: "node" | "relation"
export function scopeEnabled(kind = "node") {
	return kind === "relation" ? scopeSettings.relations : scopeSettings.nodes;
}

function scopeName(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

// The dimension of an entry ("bu" for "bu:uc"); "" for a value written without one.
export function scopeDimension(entry) {
	const index = String(entry).indexOf(":");
	return index < 0 ? "" : String(entry).slice(0, index);
}

function scopeEntryValue(entry) {
	const index = String(entry).indexOf(":");
	return index < 0 ? String(entry) : String(entry).slice(index + 1);
}

// Entries of one text: groups separated by ";", values by "," or spaces; a value takes the dimension written
// before it in its group ("bu:uc,nc"). A value with no dimension stays bare, and scopeProblems() reports it.
function parseScopeText(text) {
	const entries = [];
	for (const group of String(text ?? "").split(";")) {
		let dimension = "";
		for (const token of group.split(/[,\s]+/)) {
			if (token.includes(":")) {
				dimension = scopeName(scopeDimension(token));
			}
			const value = scopeName(scopeEntryValue(token));
			if (value) {
				entries.push(dimension ? `${dimension}:${value}` : value);
			}
		}
	}
	return entries;
}

// "bu:uc,NC; module:sbd", ["bu:uc", "bu:nc"], or { bu: "uc", module: ["sbd"] } -> ["bu:nc", "bu:uc", "module:sbd"].
export function parseScope(value) {
	let entries;
	if (Array.isArray(value)) {
		entries = value.flatMap(parseScopeText);
	} else if (value && typeof value === "object") {
		entries = Object.entries(value).flatMap(([dimension, values]) => (
			(Array.isArray(values) ? values : [values]).flatMap((item) => parseScopeText(`${dimension}:${String(item ?? "").replace(/;/g, ",")}`))
		));
	} else {
		entries = parseScopeText(value);
	}
	return [...new Set(entries)].sort();
}

// Entries grouped by dimension, in sorted order: Map { "bu" => ["nc", "uc"], "module" => ["sbd"] }.
export function scopeByDimension(scope) {
	const groups = new Map();
	for (const entry of parseScope(scope)) {
		const dimension = scopeDimension(entry);
		groups.set(dimension, [...(groups.get(dimension) ?? []), scopeEntryValue(entry)]);
	}
	return groups;
}

// The pipe-record form: "bu:nc,uc;module:sbd".
export function formatScope(scope) {
	return [...scopeByDimension(scope)]
		.map(([dimension, values]) => (dimension ? `${dimension}:${values.join(",")}` : values.join(",")))
		.join(";");
}

// The scope dimensions declared for nodes ("node") or relations ("relation", falling back to the node
// dimensions): [{ name, label, description, allowedValues }], or null when the schema declares none (then any
// dimension and value is accepted). From the `dimensions` of the `scope` field descriptor.
export function scopeDimensions(schema, kind = "node") {
	const fields = kind === "relation" ? schema?.relationshipProperties?.fields : schema?.nodeProperties?.fields;
	const declared = (fields ?? []).find((field) => field?.name === "scope")?.dimensions;
	if (!Array.isArray(declared) || declared.length === 0) {
		return kind === "relation" ? scopeDimensions(schema, "node") : null;
	}
	return declared
		.map((dimension) => ({
			name: scopeName(dimension?.name),
			label: String(dimension?.label || dimension?.name || ""),
			description: String(dimension?.description ?? ""),
			allowedValues: Array.isArray(dimension?.allowedValues) ? dimension.allowedValues.map(scopeName).filter(Boolean) : null,
		}))
		.filter((dimension) => dimension.name);
}

// Called by loadGraphSchema() so the vector store knows every declared dimension.
export function rememberScopeDimensions(schema) {
	const names = new Set([...(scopeDimensions(schema, "node") ?? []), ...(scopeDimensions(schema, "relation") ?? [])].map((dimension) => dimension.name));
	knownDimensions = [...names].sort();
}

export function knownScopeDimensions() {
	return [...knownDimensions];
}

// Messages for values without a dimension, unknown dimensions, and values a dimension does not allow.
export function scopeProblems(scope, dimensions) {
	const problems = [];
	for (const [dimension, values] of scopeByDimension(scope)) {
		if (!dimension) {
			const example = dimensions?.[0]?.name ?? "dimension";
			problems.push(`scope value${values.length > 1 ? "s" : ""} ${values.map((value) => `"${value}"`).join(", ")} without a dimension (write ${example}:${values[0]})`);
			continue;
		}
		if (!dimensions) {
			continue;
		}
		const declared = dimensions.find((item) => item.name === dimension);
		if (!declared) {
			problems.push(`unknown scope dimension "${dimension}" (declared: ${dimensions.map((item) => item.name).join(", ")})`);
			continue;
		}
		const unknown = declared.allowedValues ? values.filter((value) => !declared.allowedValues.includes(value)) : [];
		if (unknown.length > 0) {
			problems.push(`unknown ${dimension} value${unknown.length > 1 ? "s" : ""} ${unknown.map((value) => `"${value}"`).join(", ")} (allowed: ${declared.allowedValues.join(", ")})`);
		}
	}
	return problems;
}

// `next` applied over `existing`: each dimension `next` states replaces that dimension; the others are kept.
export function mergeScope(existing, next) {
	const replaced = new Set(scopeByDimension(next).keys());
	return parseScope([...parseScope(existing).filter((entry) => !replaced.has(scopeDimension(entry))), ...parseScope(next)]);
}

// The filter entries for one kind, or [] when the filter is blank or that kind of scope is switched off.
export function scopeFilterEntries(filter, kind = "node") {
	return scopeEnabled(kind) ? parseScope(filter) : [];
}

// An item matches a filter when, for each filtered dimension, it states no value for that dimension or one
// of the filtered values.
export function matchesScope(itemScope, filter, kind = "node") {
	const item = scopeByDimension(itemScope);
	return [...scopeByDimension(scopeFilterEntries(filter, kind))].every(([dimension, values]) => {
		const stated = item.get(dimension) ?? [];
		return stated.length === 0 || stated.some((value) => values.includes(value));
	});
}

// A filter or ingest scope from a request (text "bu:uc;module:sbd", a list, or { bu: "uc", module: "" }) in
// its record form, at most one value per dimension; "" for none (always "" when every kind of scope is off).
// Problems are a 400 error.
export function normalizeScopeFilter(value, schema) {
	const entries = parseScope(value);
	if (entries.length === 0 || (!scopeEnabled("node") && !scopeEnabled("relation"))) {
		return "";
	}
	const dimensions = scopeDimensions(schema, "node");
	const problems = scopeProblems(entries, dimensions);
	for (const [dimension, values] of scopeByDimension(entries)) {
		if (dimension && values.length > 1) {
			problems.push(`one ${dimension} value at most`);
		}
	}
	if (problems.length > 0) {
		const choices = dimensions ? ` Dimensions: ${dimensions.map((dimension) => `${dimension.name} (${(dimension.allowedValues ?? ["any value"]).join(", ")})`).join("; ")}.` : "";
		const error = new Error(`Invalid scope: ${problems.join("; ")}.${choices} Leave it empty for no scope.`);
		error.status = 400;
		throw error;
	}
	return formatScope(entries);
}
