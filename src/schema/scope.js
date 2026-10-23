// Scope: which parts of the organisation a node or relation belongs to (for the LOS project, the business
// units uc, nc, tw, cv, tr, plus "common"). A scope is a list of values; an empty list means the scope is not
// curated (or not needed), and such items match every filter. The allowed values come from the schema's
// `scope` field descriptor (`constraints.allowedValues`); without one, any value is accepted.

export const COMMON_SCOPE = "common";

// Which kinds of scope are in use (config `scope.nodes`, `scope.relations`; set once by createMindMesh()).
// A switched-off kind keeps its record column, but values are dropped, prompts and forms leave it out, and
// filters ignore it. Stored values are kept.
// Both off unless config switches them on.
const DEFAULT_SCOPE_SETTINGS = { nodes: false, relations: false };
let scopeSettings = { ...DEFAULT_SCOPE_SETTINGS };

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

function scopeValue(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

// "uc, NC" or ["uc", "nc"] -> ["nc", "uc"]: lower snake case, no duplicates, sorted.
export function parseScope(value) {
	const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
	return [...new Set(parts.map(scopeValue).filter(Boolean))].sort();
}

// The pipe-record form of a scope: "nc,uc".
export function formatScope(scope) {
	return parseScope(scope).join(",");
}

// Allowed scope values for nodes ("node") or relations ("relation"), or null when the schema does not restrict them.
export function scopeAllowedValues(schema, kind = "node") {
	const fields = kind === "relation" ? schema?.relationshipProperties?.fields : schema?.nodeProperties?.fields;
	const allowed = (fields ?? []).find((field) => field?.name === "scope")?.constraints?.allowedValues;
	return Array.isArray(allowed) && allowed.length > 0 ? allowed.map(scopeValue).filter(Boolean) : null;
}

// Messages for values that are not allowed, and for "common" combined with other values.
export function scopeProblems(scope, allowedValues) {
	const values = parseScope(scope);
	const problems = [];
	const unknown = allowedValues ? values.filter((value) => !allowedValues.includes(value)) : [];
	if (unknown.length > 0) {
		problems.push(`unknown scope value${unknown.length > 1 ? "s" : ""} ${unknown.map((value) => `"${value}"`).join(", ")} (allowed: ${allowedValues.join(", ")})`);
	}
	if (values.includes(COMMON_SCOPE) && values.length > 1) {
		problems.push(`"${COMMON_SCOPE}" cannot be combined with other scope values`);
	}
	return problems;
}

// The scope values an item may carry to match a filter; empty means no filtering (also when that kind of
// scope is switched off). Unscoped items always match.
export function scopeMatchValues(filter, kind = "node") {
	const value = scopeValue(filter);
	if (!value || !scopeEnabled(kind)) {
		return [];
	}
	return value === COMMON_SCOPE ? [COMMON_SCOPE] : [value, COMMON_SCOPE];
}

export function matchesScope(itemScope, filter, kind = "node") {
	const matchValues = scopeMatchValues(filter, kind);
	const scope = parseScope(itemScope);
	return matchValues.length === 0 || scope.length === 0 || scope.some((value) => matchValues.includes(value));
}

// A filter or ingest scope from a request: one value, or "" for none (always "" when every kind of scope is off).
// Unknown values are a 400 error.
export function normalizeScopeFilter(value, schema) {
	const values = parseScope(value);
	if (values.length === 0 || (!scopeEnabled("node") && !scopeEnabled("relation"))) {
		return "";
	}
	const allowed = scopeAllowedValues(schema, "node");
	if (values.length > 1 || (allowed && !allowed.includes(values[0]))) {
		const error = new Error(`Scope must be one of: ${(allowed ?? ["a single value"]).join(", ")}, or empty for no scope.`);
		error.status = 400;
		throw error;
	}
	return values[0];
}
