// Scope: the record column, validation, storage (blank keeps, filled replaces), the review signal for scope
// changes, and scope filtering in ingest context, Ask, and the MCP read tools.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extractCustomGraph, formatGraphRecords, normalizeGraphPayload } from "../src/ingestion/graphPayload.js";
import { createMcpServer } from "../src/mcp/server.js";
import { matchesScope, parseScope, scopeMatchValues } from "../src/schema/scope.js";
import { createApp } from "../src/server/server.js";
import { TEST_SCHEMA, createTestServices, node, records, relation, startHttp } from "./helpers/testServices.js";

const SCOPE_VALUES = ["uc", "nc", "tw", "cv", "tr", "common"];
const SCOPED_SCHEMA = {
	...TEST_SCHEMA,
	nodeProperties: { fields: [{ name: "scope", description: "Business units.", constraints: { allowedValues: SCOPE_VALUES } }] },
	relationshipProperties: { fields: [{ name: "scope", description: "Business units.", constraints: { allowedValues: SCOPE_VALUES } }] },
};

const services = createTestServices({ mode: "auto" });
const writeScopedSchema = () => fs.writeFileSync(services.schemaPath, `${JSON.stringify(SCOPED_SCHEMA, null, "\t")}\n`);
writeScopedSchema();
const client = new Client({ name: "mindmesh-test", version: "0.0.0" });
let http;

before(async () => {
	http = await startHttp(createApp(services));
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await createMcpServer({ ...services, llmProvider: null }).connect(serverTransport);
	await client.connect(clientTransport);
});
after(async () => {
	await client.close();
	await http.close();
	services.cleanUp();
});
beforeEach(() => {
	services.reset();
	writeScopedSchema();
});

const scoped = (name, type, scope, label = name) => ({ ...node(name, type, label), scope });

async function seedGraph({ nodes = [], relations = [] }) {
	services.graphStore.seed({ nodes, relations });
	await services.vectorStore.upsertGraphIndex({ nodes, relations });
}

async function callTool(name, args) {
	const result = await client.callTool({ name, arguments: args });
	assert.notEqual(result.isError, true, result.content?.[0]?.text);
	return JSON.parse(result.content[0].text);
}

const ingest = (text, scope = "") => http.post("/api/ingest", { text, userName: "tester", scope });

describe("Scope rules", () => {
	it("parses, sorts, and matches scopes", () => {
		assert.deepEqual(parseScope("UC, nc;uc"), ["nc", "uc"]);
		assert.deepEqual(scopeMatchValues("uc"), ["uc", "common"]);
		assert.deepEqual(scopeMatchValues("common"), ["common"]);
		assert.deepEqual(scopeMatchValues(""), []);
		assert.equal(matchesScope(["uc", "nc"], "uc"), true);
		assert.equal(matchesScope(["common"], "tw"), true);
		assert.equal(matchesScope([], "tw"), true);
		assert.equal(matchesScope(["nc"], "uc"), false);
		assert.equal(matchesScope(["nc"], "common"), false);
		assert.equal(matchesScope(["nc"], ""), true);
	});

	it("reads and writes the scope column before metadata", () => {
		const text = records(
			"NODE_CREATE|uc_qde_screen|QDE Screen|screen||uc|AMBIGUITY:check",
			"RELATION_CREATE|uc_qde_screen|pan_api|uses|||nc,uc|",
		);
		const payload = normalizeGraphPayload(extractCustomGraph(text), { schema: SCOPED_SCHEMA });

		assert.deepEqual(payload.nodes[0].scope, ["uc"]);
		assert.equal(payload.nodes[0].metadata, "AMBIGUITY:check");
		assert.deepEqual(payload.relations[0].scope, ["nc", "uc"]);
		assert.match(formatGraphRecords(payload), /NODE_CREATE\|uc_qde_screen\|QDE Screen\|screen\|\|uc\|AMBIGUITY:check/);
		assert.match(formatGraphRecords(payload), /RELATION_CREATE\|uc_qde_screen\|pan_api\|uses\|\|\|nc,uc\|/);
	});

	it("treats unknown values and common with other values as schema violations", () => {
		const payload = normalizeGraphPayload(extractCustomGraph(records(
			"NODE_CREATE|a_screen|A|screen||xx|",
			"NODE_CREATE|b_screen|B|screen||common,uc|",
		)), { schema: SCOPED_SCHEMA });

		assert.deepEqual(payload.schemaViolations.map((violation) => violation.kind), ["scope", "scope"]);
		assert.match(payload.schemaViolations[0].message, /unknown scope value "xx"/);
		assert.match(payload.schemaViolations[1].message, /"common" cannot be combined/);
	});
});

describe("Scope in ingest and storage", () => {
	it("stores scope in the graph and as vector metadata flags", async () => {
		services.llmProvider.nextResponse = records("NODE_CREATE|uc_qde_screen|QDE Screen|screen||uc|", "NODE_CREATE|pan_api|PAN API|api|||");

		const response = await ingest("UC QDE screen.", "uc");

		assert.equal(response.body.status, "applied");
		assert.deepEqual((await services.graphStore.getNode("node:uc_qde_screen")).scope, ["uc"]);
		const vectors = await (await services.vectorStore.getNodeCollection()).get({ ids: ["node:uc_qde_screen", "node:pan_api"] });
		assert.equal(vectors.metadatas[0].scope_uc, true);
		assert.equal(vectors.metadatas[0].scoped, true);
		assert.equal(vectors.metadatas[1].scoped, false);
	});

	it("keeps the stored scope when an update leaves it blank", async () => {
		await seedGraph({ nodes: [scoped("uc_qde_screen", "screen", ["uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|uc_qde_screen|QDE Screen|screen|New detail.||");

		const response = await ingest("More about the UC QDE screen.", "uc");

		assert.equal(response.body.status, "applied");
		const stored = await services.graphStore.getNode("node:uc_qde_screen");
		assert.deepEqual(stored.scope, ["uc"]);
		assert.equal(stored.description, "New detail.");
	});

	it("sends a scope change of an existing node to review", async () => {
		await seedGraph({ nodes: [scoped("apex_util", "api", ["uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|apex_util|Apex Util|api||nc|");

		const response = await ingest("NC uses the util.", "nc");

		assert.equal(response.body.status, "pending_hitl");
		assert.ok(response.body.reviewReasons.some((reason) => reason.includes("ambiguity")), response.body.reviewReasons.join("; "));
		assert.match(response.body.hitlNote.document, /scope of "apex_util" changes from uc to nc/);
		assert.deepEqual((await services.graphStore.getNode("node:apex_util")).scope, ["uc"]);
	});

	it("filters the ingest context by scope and names the scope in the prompt", async () => {
		await seedGraph({
			nodes: [
				scoped("uc_qde_screen", "screen", ["uc"], "UC QDE"),
				scoped("nc_qde_screen", "screen", ["nc"], "NC QDE"),
				scoped("shared_api", "api", [], "Shared API"),
				scoped("org_api", "api", ["common"], "Org API"),
			],
		});

		await ingest("The QDE screen.", "uc");

		const prompt = services.llmProvider.requests[0].systemPrompt;
		assert.match(prompt, /Selected scope for this input: uc\./);
		assert.match(prompt, /node:uc_qde_screen/);
		assert.match(prompt, /node:shared_api/);
		assert.match(prompt, /node:org_api/);
		assert.doesNotMatch(prompt, /node:nc_qde_screen/);
	});

	it("stores the ingest scope on a proposal and regenerates with it", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		services.llmProvider.nextResponse = records("NODE_CREATE|tw_home_screen|Home|screen||tw|");
		const response = await ingest("TW home screen.", "tw");
		const noteId = response.body.hitlNote.id;

		const { note } = (await http.get(`/api/hitl/notes/${encodeURIComponent(noteId)}`)).body;
		assert.equal(note.scope, "tw");
		assert.equal((await http.get("/api/hitl/notes")).body.notes[0].scope, "tw");

		services.llmProvider.nextResponse = records("NODE_CREATE|tw_home_screen|Home Screen|screen||tw|");
		await http.post(`/api/hitl/notes/${encodeURIComponent(noteId)}/regenerate`, { reviewerNotes: "Rename.", reviewedBy: "owner" });
		assert.match(services.llmProvider.requests.at(-1).systemPrompt, /Selected scope for this input: tw\./);
	});

	it("rejects an unknown ingest scope", async () => {
		const response = await ingest("Text.", "xx");

		assert.equal(response.status, 400);
		assert.match(response.body.error, /Scope must be one of/);
	});
});

describe("Scope in direct edits", () => {
	it("writes scope exactly as submitted, including clearing it", async () => {
		await seedGraph({ nodes: [scoped("a_screen", "screen", ["uc"])] });

		const cleared = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: [], reviewedBy: "owner" });

		assert.equal(cleared.status, 200);
		assert.deepEqual((await services.graphStore.getNode("node:a_screen")).scope, []);
		const set = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: ["nc", "uc"], reviewedBy: "owner" });
		assert.equal(set.status, 200);
		assert.deepEqual((await services.graphStore.getNode("node:a_screen")).scope, ["nc", "uc"]);
	});

	it("rejects an invalid scope in a form edit", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen")] });

		const response = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: ["common", "uc"], reviewedBy: "owner" });

		assert.equal(response.status, 400);
		assert.match(response.body.error, /cannot be combined/);
	});
});

describe("Scope filters for reads", () => {
	beforeEach(async () => {
		await seedGraph({
			nodes: [
				scoped("uc_qde_screen", "screen", ["uc"]),
				scoped("nc_qde_screen", "screen", ["nc"]),
				scoped("shared_api", "api", []),
				scoped("org_api", "api", ["common"]),
			],
			relations: [
				relation("uc_qde_screen", "uses", "shared_api"),
				relation("nc_qde_screen", "uses", "shared_api"),
				{ ...relation("shared_api", "invokes", "org_api"), scope: ["nc"] },
			],
		});
	});

	it("search_nodes keeps the scope, common, and unscoped nodes", async () => {
		for (const match of ["semantic", "text"]) {
			const result = await callTool("search_nodes", { query: "_", match, scope: "uc" });
			assert.deepEqual(result.results.map((item) => item.id).sort(), ["node:org_api", "node:shared_api", "node:uc_qde_screen"], match);
		}
	});

	it("explore_graph does not follow nodes or relations scoped to other values", async () => {
		const result = await callTool("explore_graph", { from: "shared_api", depth: 1, scope: "uc" });

		assert.deepEqual(result.nodes.map((item) => item.id).sort(), ["node:shared_api", "node:uc_qde_screen"]);
	});

	it("search_context and Ask use the scope filter", async () => {
		const context = await callTool("search_context", { query: "QDE", depth: 0, scope: "nc" });
		assert.ok(context.entryNodes.every((entry) => entry.id !== "node:uc_qde_screen"));
		assert.equal(context.scope, "nc");

		const answer = await http.post("/api/ask", { text: "QDE?", scope: "nc" });
		assert.equal(answer.status, 200);
		assert.ok(answer.body.entryNodes.every((entry) => entry.id !== "node:uc_qde_screen"));
	});

	it("get_ingest_prompt requires a scope and passes it on", async () => {
		const missing = await client.callTool({ name: "get_ingest_prompt", arguments: { text: "QDE." } });
		assert.equal(missing.isError, true);

		const result = await callTool("get_ingest_prompt", { text: "The QDE screen.", scope: "uc" });
		assert.equal(result.scope, "uc");
		assert.match(result.extractionSystemPrompt, /Selected scope for this input: uc\./);
		assert.ok(result.retrievedNodes.every((item) => item.id !== "node:nc_qde_screen"));
	});

	it("submit_ingest stores the scope on the proposal", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		const result = await callTool("submit_ingest", { records: records("NODE_CREATE|cv_x_screen|X|screen||cv|"), text: "CV X.", scope: "cv" });

		const proposals = await callTool("list_proposals", { scope: "cv" });
		assert.equal(proposals.total, 1);
		assert.equal(proposals.results[0].ref, result.ref);
		assert.equal(proposals.results[0].scope, "cv");
	});
});
