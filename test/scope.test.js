// Scope dimensions: the record column, validation, storage (dimensions a record leaves out are kept), the review
// signals for scope changes and out-of-scope nodes, and per-dimension filtering in Ask and the MCP read tools.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extractCustomGraph, formatGraphRecords, normalizeGraphPayload } from "../src/ingestion/graphPayload.js";
import { createMcpServer } from "../src/mcp/server.js";
import { formatScope, matchesScope, mergeScope, parseScope } from "../src/schema/scope.js";
import { createApp } from "../src/server/server.js";
import { TEST_SCHEMA, createTestServices, node, records, relation, startHttp } from "./helpers/testServices.js";

const SCOPE_FIELD = {
	name: "scope",
	description: "Where the item belongs.",
	guidance: ["A unit concept gets the unit as a name prefix, for example uc_qde_screen."],
	dimensions: [
		{ name: "bu", label: "Business unit", description: "Business units.", allowedValues: ["uc", "nc", "tw", "cv", "tr"] },
		{ name: "module", label: "Module", description: "Horizontal module teams.", allowedValues: ["sbd", "pai"] },
	],
};
const SCOPED_SCHEMA = {
	...TEST_SCHEMA,
	nodeProperties: { fields: [SCOPE_FIELD] },
	relationshipProperties: { fields: [SCOPE_FIELD] },
};

const services = createTestServices({ mode: "auto", scope: { nodes: true, relations: true } });
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
	it("parses, formats, and merges dimension entries", () => {
		assert.deepEqual(parseScope("bu:UC,nc; module:sbd"), ["bu:nc", "bu:uc", "module:sbd"]);
		assert.deepEqual(parseScope({ bu: "uc", module: "" }), ["bu:uc"]);
		assert.deepEqual(parseScope(["module:sbd", "bu:uc"]), ["bu:uc", "module:sbd"]);
		assert.equal(formatScope(["module:sbd", "bu:uc", "bu:nc"]), "bu:nc,uc;module:sbd");
		assert.deepEqual(mergeScope(["bu:uc", "module:sbd"], "bu:nc"), ["bu:nc", "module:sbd"], "a stated dimension replaces, the others are kept");
		assert.deepEqual(mergeScope(["bu:uc"], ""), ["bu:uc"]);
	});

	it("matches each filtered dimension: the value, or no value stated", () => {
		assert.equal(matchesScope(["bu:nc", "bu:uc"], "bu:uc"), true);
		assert.equal(matchesScope([], "bu:uc"), true);
		assert.equal(matchesScope(["module:sbd"], "bu:uc"), true, "no bu stated");
		assert.equal(matchesScope(["bu:nc", "module:sbd"], "bu:uc"), false);
		assert.equal(matchesScope(["bu:uc"], "bu:uc;module:pai"), true, "no module stated");
		assert.equal(matchesScope(["bu:uc", "module:sbd"], "bu:uc;module:pai"), false);
		assert.equal(matchesScope(["bu:nc"], ""), true);
	});

	it("reads and writes the scope column before metadata", () => {
		const text = records(
			"NODE_CREATE|uc_qde_screen|QDE Screen|screen||bu:uc;module:sbd|AMBIGUITY:check",
			"RELATION_CREATE|uc_qde_screen|pan_api|uses|||bu:nc,uc|",
		);
		const payload = normalizeGraphPayload(extractCustomGraph(text), { schema: SCOPED_SCHEMA });

		assert.deepEqual(payload.nodes[0].scope, ["bu:uc", "module:sbd"]);
		assert.equal(payload.nodes[0].metadata, "AMBIGUITY:check");
		assert.deepEqual(payload.relations[0].scope, ["bu:nc", "bu:uc"]);
		assert.match(formatGraphRecords(payload), /NODE_CREATE\|uc_qde_screen\|QDE Screen\|screen\|\|bu:uc;module:sbd\|AMBIGUITY:check/);
		assert.match(formatGraphRecords(payload), /RELATION_CREATE\|uc_qde_screen\|pan_api\|uses\|\|\|bu:nc,uc\|/);
	});

	it("treats values without a dimension, unknown dimensions, and unknown values as schema violations", () => {
		const payload = normalizeGraphPayload(extractCustomGraph(records(
			"NODE_CREATE|a_screen|A|screen||uc|",
			"NODE_CREATE|b_screen|B|screen||team:x|",
			"NODE_CREATE|c_screen|C|screen||bu:xx|",
			"NODE_CREATE|d_screen|D|screen||bu:common|",
		)), { schema: SCOPED_SCHEMA });

		assert.deepEqual(payload.schemaViolations.map((violation) => violation.kind), ["scope", "scope", "scope", "scope"]);
		assert.match(payload.schemaViolations[0].message, /"uc" without a dimension \(write bu:uc\)/);
		assert.match(payload.schemaViolations[1].message, /unknown scope dimension "team"/);
		assert.match(payload.schemaViolations[2].message, /unknown bu value "xx"/);
		assert.match(payload.schemaViolations[3].message, /unknown bu value "common"/, "there is no common value");
	});
});

describe("Scope in ingest and storage", () => {
	it("stores scope in the graph and as vector metadata flags for every declared dimension", async () => {
		services.llmProvider.nextResponse = records("NODE_CREATE|uc_qde_screen|QDE Screen|screen||bu:uc|", "NODE_CREATE|pan_api|PAN API|api|||");

		const response = await ingest("UC QDE screen.", "bu:uc");

		assert.equal(response.body.status, "applied");
		assert.deepEqual((await services.graphStore.getNode("node:uc_qde_screen")).scope, ["bu:uc"]);
		const vectors = await (await services.vectorStore.getNodeCollection()).get({ ids: ["node:uc_qde_screen", "node:pan_api"] });
		assert.equal(vectors.metadatas[0]["scope:bu:uc"], true);
		assert.equal(vectors.metadatas[0]["scoped:bu"], true);
		assert.equal(vectors.metadatas[0]["scoped:module"], false);
		assert.equal(vectors.metadatas[1]["scoped:bu"], false);
		assert.equal(vectors.metadatas[0].scope, "bu:uc");
	});

	it("keeps the stored scope when an update leaves it blank", async () => {
		await seedGraph({ nodes: [scoped("uc_qde_screen", "screen", ["bu:uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|uc_qde_screen|QDE Screen|screen|New detail.||");

		const response = await ingest("More about the UC QDE screen.", "bu:uc");

		assert.equal(response.body.status, "applied");
		const stored = await services.graphStore.getNode("node:uc_qde_screen");
		assert.deepEqual(stored.scope, ["bu:uc"]);
		assert.equal(stored.description, "New detail.");
	});

	it("adds a dimension without touching the others and without review", async () => {
		await seedGraph({ nodes: [scoped("dedupe_rule", "api", ["bu:nc", "bu:uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|dedupe_rule|Dedupe Rule|api||module:sbd|");

		const response = await ingest("The dedupe rule is owned by SBD.", "module:sbd");

		assert.equal(response.body.status, "applied", response.body.reviewReasons?.join("; "));
		assert.deepEqual((await services.graphStore.getNode("node:dedupe_rule")).scope, ["bu:nc", "bu:uc", "module:sbd"]);
	});

	it("sends a change of a stated dimension to review", async () => {
		await seedGraph({ nodes: [scoped("apex_util", "api", ["bu:uc", "module:sbd"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|apex_util|Apex Util|api||bu:nc|");

		const response = await ingest("NC uses the util.", "");

		assert.equal(response.body.status, "pending_hitl");
		assert.ok(response.body.reviewReasons.some((reason) => reason.includes("ambiguity")), response.body.reviewReasons.join("; "));
		assert.match(response.body.hitlNote.document, /bu of "apex_util" changes from uc to nc/);
		assert.doesNotMatch(response.body.hitlNote.document, /module of/);
		assert.deepEqual((await services.graphStore.getNode("node:apex_util")).scope, ["bu:uc", "module:sbd"]);
	});

	it("names the ingest scope in the prompt but does not filter the context by it", async () => {
		await seedGraph({
			nodes: [
				scoped("uc_qde_screen", "screen", ["bu:uc"], "UC QDE"),
				scoped("nc_qde_screen", "screen", ["bu:nc"], "NC QDE"),
				scoped("shared_api", "api", [], "Shared API"),
			],
		});

		await ingest("The QDE screen.", { bu: "uc", module: "sbd" });

		const prompt = services.llmProvider.requests[0].systemPrompt;
		assert.match(prompt, /Selected scope for this input: bu:uc;module:sbd\. Read the input as knowledge of that scope/);
		assert.match(prompt, /\[node:uc_qde_screen\] UC QDE \(type: screen, name: uc_qde_screen, scope: bu:uc\)/);
		assert.match(prompt, /\[node:nc_qde_screen\] NC QDE \(type: screen, name: nc_qde_screen, scope: bu:nc\)/);
		assert.match(prompt, /node:shared_api/);
		assert.match(prompt, /- bu: Business units\. \(allowed values: uc, nc, tw, cv, tr\)/, "dimensions are in the field guidance");
		assert.match(prompt, /SCOPE RULES:[\s\S]*^- A unit concept gets the unit as a name prefix, for example uc_qde_screen\.$/m, "scope guidance from the schema follows the generic scope rules");
		assert.equal(prompt.match(/A unit concept gets the unit as a name prefix/g).length, 2, "node and relation guidance (both switched on)");
		assert.doesNotMatch(prompt, /\{\{SCOPE_GUIDANCE\}\}/);
		assert.doesNotMatch(prompt, /common/);
	});

	it("flags records that touch existing nodes scoped outside the ingest scope", async () => {
		await seedGraph({
			nodes: [
				scoped("uc_qde_screen", "screen", ["bu:uc"]),
				scoped("nc_qde_screen", "screen", ["bu:nc"]),
				scoped("sbd_rule", "api", ["module:sbd"]),
				scoped("otp_cmp", "api", []),
			],
		});
		services.llmProvider.nextResponse = records(
			"NODE_UPDATE|uc_qde_screen|QDE|screen|Edited from NC.||",
			"RELATION_CREATE|uc_qde_screen|otp_cmp|uses||||",
			"RELATION_CREATE|nc_qde_screen|sbd_rule|uses||||",
		);

		const response = await ingest("NC text that mentions UC.", "bu:nc");

		assert.equal(response.body.status, "pending_hitl");
		const text = response.body.hitlNote.document;
		assert.match(text, /NODE_UPDATE\|uc_qde_screen.*AMBIGUITY: "uc_qde_screen" is scoped bu:uc, outside this input's scope bu:nc/);
		assert.match(text, /RELATION_CREATE\|uc_qde_screen\|otp_cmp.*AMBIGUITY: this relation uses "uc_qde_screen" \(scoped bu:uc\), outside this input's scope bu:nc/);
		assert.match(text, /^RELATION_CREATE\|nc_qde_screen\|sbd_rule\|uses\|\|\|\|$/m, "own-unit nodes and nodes stating no bu are not flagged");
	});

	it("does not flag out-of-scope nodes when the ingest has no scope", async () => {
		await seedGraph({ nodes: [scoped("uc_qde_screen", "screen", ["bu:uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|uc_qde_screen|QDE|screen|More.||");

		const response = await ingest("Text.", "");

		assert.equal(response.body.status, "applied");
	});

	it("stores the ingest scope on a proposal and regenerates with it", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		services.llmProvider.nextResponse = records("NODE_CREATE|tw_home_screen|Home|screen||bu:tw|");
		const response = await ingest("TW home screen.", "bu:tw");
		const noteId = response.body.hitlNote.id;

		const { note } = (await http.get(`/api/hitl/notes/${encodeURIComponent(noteId)}`)).body;
		assert.equal(note.scope, "bu:tw");
		assert.equal((await http.get("/api/hitl/notes")).body.notes[0].scope, "bu:tw");

		services.llmProvider.nextResponse = records("NODE_CREATE|tw_home_screen|Home Screen|screen||bu:tw|");
		await http.post(`/api/hitl/notes/${encodeURIComponent(noteId)}/regenerate`, { reviewerNotes: "Rename.", reviewedBy: "owner" });
		assert.match(services.llmProvider.requests.at(-1).systemPrompt, /Selected scope for this input: bu:tw\./);
	});

	it("rejects an invalid ingest scope", async () => {
		for (const [scope, message] of [["bu:xx", /unknown bu value "xx"/], ["uc", /without a dimension/], ["bu:uc,nc", /one bu value at most/]]) {
			const response = await ingest("Text.", scope);

			assert.equal(response.status, 400, scope);
			assert.match(response.body.error, message);
		}
	});
});

describe("Scope in direct edits", () => {
	it("writes scope exactly as submitted, including clearing it", async () => {
		await seedGraph({ nodes: [scoped("a_screen", "screen", ["bu:uc", "module:sbd"])] });

		const cleared = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: [], reviewedBy: "owner" });

		assert.equal(cleared.status, 200);
		assert.deepEqual((await services.graphStore.getNode("node:a_screen")).scope, []);
		const set = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: ["bu:nc", "bu:uc"], reviewedBy: "owner" });
		assert.equal(set.status, 200);
		assert.deepEqual((await services.graphStore.getNode("node:a_screen")).scope, ["bu:nc", "bu:uc"]);
	});

	it("drops the vector flags of removed scope values and dimensions", async () => {
		await seedGraph({ nodes: [scoped("a_screen", "screen", ["bu:uc", "module:sbd"])] });

		await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: ["bu:nc"], reviewedBy: "owner" });

		const search = async (scope) => (await client.callTool({ name: "search_nodes", arguments: { query: "A", scope } })).content[0].text;
		assert.doesNotMatch(await search({ bu: "uc" }), /node:a_screen/);
		assert.match(await search({ bu: "nc" }), /node:a_screen/);
		assert.match(await search({ module: "pai" }), /node:a_screen/, "module is no longer stated");
	});

	it("rejects an invalid scope in a form edit", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen")] });

		const response = await http.put("/api/hitl/nodes/node%3Aa_screen", { label: "A", type: "screen", scope: ["uc"], reviewedBy: "owner" });

		assert.equal(response.status, 400);
		assert.match(response.body.error, /without a dimension/);
	});
});

describe("Scope filters for reads", () => {
	beforeEach(async () => {
		await seedGraph({
			nodes: [
				scoped("uc_qde_screen", "screen", ["bu:uc"]),
				scoped("nc_qde_screen", "screen", ["bu:nc"]),
				scoped("shared_api", "api", []),
				scoped("sbd_rule", "api", ["module:sbd"]),
				scoped("sbd_nc_rule", "api", ["bu:nc", "module:sbd"]),
			],
			relations: [
				relation("uc_qde_screen", "uses", "shared_api"),
				relation("nc_qde_screen", "uses", "shared_api"),
				{ ...relation("shared_api", "invokes", "sbd_rule"), scope: ["bu:nc"] },
			],
		});
	});

	it("search_nodes keeps nodes stating the value or no value in each filtered dimension", async () => {
		for (const match of ["semantic", "text"]) {
			const byUnit = await callTool("search_nodes", { query: "_", match, scope: { bu: "uc" } });
			assert.deepEqual(byUnit.results.map((item) => item.id).sort(), ["node:sbd_rule", "node:shared_api", "node:uc_qde_screen"], match);

			const byBoth = await callTool("search_nodes", { query: "_", match, scope: { bu: "nc", module: "pai" } });
			assert.deepEqual(byBoth.results.map((item) => item.id).sort(), ["node:nc_qde_screen", "node:shared_api"], match);
		}
	});

	it("explore_graph does not follow nodes or relations that fail the filter", async () => {
		const result = await callTool("explore_graph", { from: "shared_api", depth: 1, scope: { bu: "uc" } });

		assert.deepEqual(result.nodes.map((item) => item.id).sort(), ["node:shared_api", "node:uc_qde_screen"]);
	});

	it("search_context and Ask use the scope filter", async () => {
		const context = await callTool("search_context", { query: "QDE", depth: 0, scope: { bu: "nc" } });
		assert.ok(context.entryNodes.every((entry) => entry.id !== "node:uc_qde_screen"));
		assert.equal(context.scope, "bu:nc");

		const answer = await http.post("/api/ask", { text: "QDE?", scope: "bu:nc" });
		assert.equal(answer.status, 200);
		assert.ok(answer.body.entryNodes.every((entry) => entry.id !== "node:uc_qde_screen"));
	});

	it("keeps pending proposals of other units out of filtered context", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		await callTool("submit_ingest", { records: records("NODE_CREATE|uc_pending_screen|Pending|screen||bu:uc|"), text: "UC pending.", scope: { bu: "uc", module: "" } });
		await callTool("submit_ingest", { records: records("NODE_CREATE|nc_pending_screen|Pending|screen||bu:nc|"), text: "NC pending.", scope: { bu: "nc", module: "" } });

		const context = await callTool("search_context", { query: "Pending", includePending: true, scope: { bu: "uc" } });

		assert.deepEqual(context.pending.proposals.map((proposal) => proposal.author), ["mcp-agent"]);
		assert.match(context.pending.context, /uc_pending_screen/);
		assert.doesNotMatch(context.pending.context, /nc_pending_screen/);
	});

	it("get_ingest_prompt requires a value for every dimension and passes the scope on", async () => {
		const missing = await client.callTool({ name: "get_ingest_prompt", arguments: { text: "QDE.", scope: { bu: "uc" } } });
		assert.equal(missing.isError, true);

		const result = await callTool("get_ingest_prompt", { text: "The QDE screen.", scope: { bu: "uc", module: "" } });
		assert.equal(result.scope, "bu:uc");
		assert.match(result.extractionSystemPrompt, /Selected scope for this input: bu:uc\./);
		assert.ok(result.retrievedNodes.some((item) => item.id === "node:nc_qde_screen"), "other units are in the context");
	});

	it("submit_ingest stores the scope on the proposal, and list_proposals filters by it", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		const result = await callTool("submit_ingest", { records: records("NODE_CREATE|cv_x_screen|X|screen||bu:cv|"), text: "CV X.", scope: { bu: "cv", module: "" } });
		await callTool("submit_ingest", { records: records("NODE_CREATE|uc_y_screen|Y|screen||bu:uc|"), text: "UC Y.", scope: { bu: "uc", module: "" } });

		const proposals = await callTool("list_proposals", { scope: { bu: "cv" } });
		assert.equal(proposals.total, 1);
		assert.equal(proposals.results[0].ref, result.ref);
		assert.equal(proposals.results[0].scope, "bu:cv");
	});
});
