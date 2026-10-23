// Builds MindMesh with in-memory stores, a scripted LLM, and a temp schema file, and starts the web app on a
// random port. One set of services per test file; call reset() in beforeEach.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGraphExtraction } from "../../src/ingestion/graphPayload.js";
import { hashPassword } from "../../src/admin/adminAuth.js";
import { createMindMesh } from "../../src/mindmesh.js";
import { MemoryGraphStore, createMemoryVectorStore } from "./memoryStores.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const TEST_SCHEMA = {
	nodeTypes: [
		{ name: "screen", description: "A UI screen." },
		{ name: "api", description: "An API." },
		{ name: "person", description: "A person." },
	],
	relationshipTypes: [
		{ name: "uses", description: "Source uses target." },
		{ name: "invokes", description: "Source calls target." },
		{ name: "owned_by", description: "Source is owned by target." },
	],
};

// Wraps records in the extraction block markers.
export function records(...lines) {
	return ["<start#$#$>", ...lines, "</end#$#$>"].join("\n");
}

// An LLM provider whose next answer is set by the test. Every request is recorded.
export function createScriptedLlm() {
	return {
		nextResponse: records(),
		requests: [],
		async extractGraphWithRawResponse(request) {
			this.requests.push(request);
			return { rawResponse: this.nextResponse, graph: parseGraphExtraction(this.nextResponse) };
		},
		async generateAnswer() {
			return "scripted answer";
		},
	};
}

// `adminPassword` enables the admin panel (its hash goes into config.admin.passwordHash). `scope` is config.scope
// (which kinds of scope are switched on; process-wide, so one setting per test file).
export function createTestServices({ mode = "auto", adminPassword = "", scope = undefined } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mindmesh-test-"));
	const schemaPath = path.join(directory, "graphSchema.json");
	const prompt = (name) => path.join(ROOT, "prompts", name);
	const config = {
		schema: { path: schemaPath },
		prompts: {
			extractionCustomSystemPath: prompt("extraction-system-custom.md"),
			answerSystemPath: prompt("answer-system.md"),
			contextFormatPath: prompt("context-format.md"),
			jobScannerSystemPath: prompt("job-scanner-system.md"),
			jobNuggetSystemPath: prompt("job-nugget-system.md"),
		},
		ingestion: { mode, hitlDefaultUserName: "test-user", contextEnabled: true, contextTopK: 5, contextDepth: 1 },
		rag: { topK: 5, depth: 1, memory: { enabled: false, maxMessages: 12, maxMessageChars: 2000 } },
		logging: { enabled: false, directory },
		admin: { passwordHash: adminPassword ? hashPassword(adminPassword) : "" },
		scope,
	};
	const writeSchema = (schema = TEST_SCHEMA) => fs.writeFileSync(schemaPath, `${JSON.stringify(schema, null, "\t")}\n`);
	writeSchema();

	const graphStore = new MemoryGraphStore();
	const vectorStore = createMemoryVectorStore();
	const llmProvider = createScriptedLlm();
	const services = createMindMesh(config, { graphStore, vectorStore, llmProvider });

	return {
		...services,
		schemaPath,
		directory,
		readSchema: () => JSON.parse(fs.readFileSync(schemaPath, "utf8")),
		reset() {
			graphStore.reset();
			vectorStore.reset();
			llmProvider.nextResponse = records();
			llmProvider.requests.length = 0;
			services.ingestionService.ingestion.mode = mode;
			writeSchema();
		},
		cleanUp() {
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

// Starts an Express app on a random port and returns a small JSON client for it.
export async function startHttp(app) {
	const server = await new Promise((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	async function request(method, url, body) {
		const response = await fetch(baseUrl + url, {
			method,
			headers: body === undefined ? {} : { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	}
	return {
		request,
		get: (url) => request("GET", url),
		post: (url, body) => request("POST", url, body),
		put: (url, body) => request("PUT", url, body),
		del: (url, body) => request("DELETE", url, body),
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

export const node = (name, type, label = name, description = "") => ({ id: `node:${name}`, name, label, type, description });

// Same id scheme as normalizeGraphPayload(): rel:<12-char sha1 of sourceId:relation:targetId>.
export function relationId(sourceName, relationType, targetName) {
	const hash = crypto.createHash("sha1").update(`node:${sourceName}:${relationType}:node:${targetName}`).digest("hex").slice(0, 12);
	return `rel:${hash}`;
}

export const relation = (sourceName, relationType, targetName, information = "") => ({
	id: relationId(sourceName, relationType, targetName),
	sourceId: `node:${sourceName}`,
	targetId: `node:${targetName}`,
	relation: relationType,
	information,
	description: "",
});
