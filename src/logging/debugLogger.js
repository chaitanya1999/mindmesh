import fs from "node:fs";
import path from "node:path";

function timestampForFile(date = new Date()) {
	return date.toISOString().replace(/[:.]/g, "-");
}

function asText(value) {
	if (typeof value === "string") {
		return value;
	}

	return JSON.stringify(value, null, 2);
}

function scopeEnabled(scopes, name) {
	return scopes.length === 0 || scopes.includes(name) || scopes.includes("*");
}

export function createDebugLogger({ enabled = false, directory, scopes = [], name = "debug" } = {}) {
	if (!enabled || !scopeEnabled(scopes, name)) {
		return {
			enabled: false,
			path: null,
			log() {},
			section() {},
			json() {},
		};
	}

	fs.mkdirSync(directory, { recursive: true });
	const filePath = path.join(directory, `${name}-${timestampForFile()}.log`);

	function append(content) {
		fs.appendFileSync(filePath, content, "utf8");
	}

	append([
		`# MindMesh ${name} Debug Log`,
		`createdAt: ${new Date().toISOString()}`,
		"",
	].join("\n"));

	return {
		enabled: true,
		path: filePath,
		log(value) {
			append(`${asText(value)}\n`);
		},
		section(title, value) {
			append([
				"",
				`## ${title}`,
				"",
				asText(value),
				"",
			].join("\n"));
		},
		json(title, value) {
			this.section(title, JSON.stringify(value, null, 2));
		},
	};
}
