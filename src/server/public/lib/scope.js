// Client copy of the scope rules in src/schema/scope.js (parse and display only; the server validates).
// A scope is a sorted list of "dimension:value" entries; its record form is "bu:nc,uc;module:sbd".

function scopeName(value) {
	return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function parseScopeText(text) {
	const entries = [];
	for (const group of String(text ?? "").split(";")) {
		let dimension = "";
		for (const token of group.split(/[,\s]+/)) {
			const index = token.indexOf(":");
			if (index >= 0) {
				dimension = scopeName(token.slice(0, index));
			}
			const value = scopeName(index >= 0 ? token.slice(index + 1) : token);
			if (value) {
				entries.push(dimension ? `${dimension}:${value}` : value);
			}
		}
	}
	return entries;
}

export function parseScope(value) {
	const entries = Array.isArray(value) ? value.flatMap(parseScopeText) : parseScopeText(value);
	return [...new Set(entries)].sort();
}

// Map { "bu" => ["nc", "uc"], "module" => ["sbd"] }; bare values sit under "".
export function scopeByDimension(value) {
	const groups = new Map();
	for (const entry of parseScope(value)) {
		const index = entry.indexOf(":");
		const dimension = index < 0 ? "" : entry.slice(0, index);
		groups.set(dimension, [...(groups.get(dimension) ?? []), index < 0 ? entry : entry.slice(index + 1)]);
	}
	return groups;
}

// "bu:nc,uc;module:sbd": the pipe-record form, also sent as the Ask / Ingest scope.
export function formatScope(value) {
	return [...scopeByDimension(value)]
		.map(([dimension, values]) => (dimension ? `${dimension}:${values.join(",")}` : values.join(",")))
		.join(";");
}

// "bu: nc, uc · module: sbd" for display; empty when unscoped.
export function scopeLabel(value) {
	return [...scopeByDimension(value)]
		.map(([dimension, values]) => (dimension ? `${dimension}: ${values.join(", ")}` : values.join(", ")))
		.join(" · ");
}

// The value one dimension has in a scope ("" when not stated); the picker holds one value per dimension.
export function scopeDimensionValue(value, dimension) {
	return (scopeByDimension(value).get(dimension) ?? [])[0] ?? "";
}

// `value` with `dimension` set to `item` ("" removes the dimension), in record form.
export function withScopeDimension(value, dimension, item) {
	const kept = parseScope(value).filter((entry) => !entry.startsWith(`${dimension}:`));
	return formatScope(item ? [...kept, `${dimension}:${item}`] : kept);
}

// Declared dimensions from the schema's `scope` field descriptor: [{ name, label, allowedValues }]; [] when
// the schema declares none (forms then take free text). Relations fall back to the node dimensions.
export function scopeDimensionsFromSchema(schema, kind = "node") {
	const fields = kind === "relation" ? schema?.relationshipProperties?.fields : schema?.nodeProperties?.fields;
	const declared = (fields ?? []).find((field) => field?.name === "scope")?.dimensions;
	if (Array.isArray(declared) && declared.length > 0) {
		return declared
			.map((dimension) => ({
				name: scopeName(dimension?.name),
				label: String(dimension?.label || dimension?.name || ""),
				allowedValues: Array.isArray(dimension?.allowedValues) ? dimension.allowedValues.map(scopeName).filter(Boolean) : [],
			}))
			.filter((dimension) => dimension.name);
	}
	return kind === "relation" ? scopeDimensionsFromSchema(schema, "node") : [];
}
