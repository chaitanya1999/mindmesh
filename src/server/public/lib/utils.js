
export function truncate(value, length = 34) {
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

export function displayText(value) {
	return decodePipelineField(value);
}

export function displayNameFromIdentifier(value) {
	const text = String(value ?? "")
		.replace(/^node:/i, "")
		.trim();

	if (!text) {
		return "Unknown";
	}

	return text
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function clampNumber(value, min, max) {
	return Math.min(Math.max(value, min), max);
}
