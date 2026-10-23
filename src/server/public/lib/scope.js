// Client copy of the scope rules in src/schema/scope.js (parse and display only; the server validates).

export function parseScope(value) {
	const parts = Array.isArray(value) ? value : String(value ?? "").split(/[,;\s]+/);
	return [...new Set(parts
		.map((part) => String(part ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""))
		.filter(Boolean))].sort();
}

// "nc,uc": the pipe-record form.
export function formatScope(value) {
	return parseScope(value).join(",");
}

// "nc, uc" for display; empty when unscoped.
export function scopeLabel(value) {
	return parseScope(value).join(", ");
}

// Allowed values from the schema's `scope` field descriptor; [] when the schema does not list them.
export function scopeValuesFromSchema(schema, kind = "node") {
	const fields = kind === "relation" ? schema?.relationshipProperties?.fields : schema?.nodeProperties?.fields;
	const allowed = (fields ?? []).find((field) => field?.name === "scope")?.constraints?.allowedValues;
	if (Array.isArray(allowed) && allowed.length > 0) {
		return allowed;
	}
	return kind === "relation" ? scopeValuesFromSchema(schema, "node") : [];
}
