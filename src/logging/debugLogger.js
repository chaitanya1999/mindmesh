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

// Prints a pipeline step to the console and, when enabled, to the debug log.
export function logStep(debugLogger, message) {
	console.log(message);
	debugLogger?.log(message);
}

// Plain-object form of an error (including its cause chain) for debug logs.
export function errorDetails(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			status: error.status,
			code: error.code,
			cause: error.cause ? errorDetails(error.cause) : undefined,
		};
	}

	return {
		name: typeof error,
		message: String(error),
		value: error,
	};
}

// `name` sets the log file prefix; `scope` (defaults to name) is matched against `logging.scopes`.
export function createDebugLogger({ enabled = false, directory, scopes = [], name = "debug", scope = name } = {}) {
	if (!enabled || !scopeEnabled(scopes, scope)) {
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
