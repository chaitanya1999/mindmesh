// Node scopes on, relation scopes off (the LOS setting in config.example.json): relation scopes are dropped from
// records, left out of the prompt, the MCP tools and the UI settings, and kept on direct edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createApp } from "../src/server/server.js";
import { TEST_SCHEMA, createTestServices, node, records, relation, startHttp } from "./helpers/testServices.js";

const SCOPE_FIELD = { name: "scope", description: "Business units.", constraints: { allowedValues: ["uc", "nc", "common"] } };
const SCOPED_SCHEMA = {
	...TEST_SCHEMA,
	nodeProperties: { fields: [{ ...SCOPE_FIELD, description: "Node business units." }] },
	relationshipProperties: { fields: [{ ...SCOPE_FIELD, description: "Relation business units." }] },
};

const services = createTestServices({ mode: "auto", scope: { nodes: true, relations: false } });
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

describe("Relation scopes switched off", () => {
	it("tells the UI which scopes are in use", async () => {
		const response = await http.get("/api/graph");

		assert.deepEqual(response.body.scopeSettings, { nodes: true, relations: false });
	});

	it("drops relation scopes from records with a warning and keeps node scopes", async () => {
		services.graphStore.seed({ nodes: [node("b_api", "api")] });
		services.llmProvider.nextResponse = records("NODE_CREATE|uc_a_screen|A|screen||uc|", "RELATION_CREATE|uc_a_screen|b_api|uses|||uc|");

		const response = await http.post("/api/ingest", { text: "A uses B.", userName: "tester", scope: "uc" });

		assert.equal(response.body.status, "applied");
		assert.deepEqual(response.body.relations[0].scope, []);
		assert.deepEqual((await services.graphStore.getNode("node:uc_a_screen")).scope, ["uc"]);
	});

	it("warns about a dropped relation scope and stores the proposal without it", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		services.graphStore.seed({ nodes: [node("b_api", "api")] });
		services.llmProvider.nextResponse = records("NODE_CREATE|uc_a_screen|A|screen||uc|", "RELATION_CREATE|uc_a_screen|b_api|uses|||uc|");

		const response = await http.post("/api/ingest", { text: "A uses B.", userName: "tester", scope: "uc" });

		assert.ok(response.body.schemaWarnings.some((warning) => /relation scopes are switched off/.test(warning)), response.body.schemaWarnings.join("; "));
		const { note } = (await http.get(`/api/hitl/notes/${encodeURIComponent(response.body.hitlNote.id)}`)).body;
		assert.match(note.llmResponse, /^RELATION_CREATE\|uc_a_screen\|b_api\|uses\|\|\|\|$/m, "the stored text drops the relation scope");
		assert.match(note.llmResponse, /NODE_CREATE\|uc_a_screen\|A\|screen\|\|uc\|/);
	});

	it("leaves relation scope out of the prompt and tells the model to leave it empty", async () => {
		await http.post("/api/ingest", { text: "Something.", userName: "tester", scope: "uc" });

		const prompt = services.llmProvider.requests[0].systemPrompt;
		assert.match(prompt, /Always leave the scope field of relation records empty\./);
		assert.match(prompt, /gets the unit as a name prefix/, "node scope rules are present");
		assert.match(prompt, /Node business units\./);
		assert.doesNotMatch(prompt, /Relation business units\./);
		assert.doesNotMatch(prompt, /Relation scope is empty in almost every record/);
		assert.doesNotMatch(prompt, /\{\{[#^/]SCOPE_/, "no section markers are left");
	});

	it("keeps a stored relation scope on a direct edit", async () => {
		services.graphStore.seed({
			nodes: [node("a_screen", "screen"), node("b_api", "api")],
			relations: [{ ...relation("a_screen", "uses", "b_api"), scope: ["nc"] }],
		});
		const id = relation("a_screen", "uses", "b_api").id;

		const response = await http.put(`/api/hitl/relations/${encodeURIComponent(id)}`, { sourceId: "a_screen", targetId: "b_api", relation: "uses", information: "now", scope: ["uc"], reviewedBy: "owner" });

		assert.equal(response.status, 200);
		const stored = await services.graphStore.getRelation(id);
		assert.deepEqual(stored.scope, ["nc"]);
		assert.equal(stored.information, "now");
	});

	it("offers no scope argument on search_relations but keeps it on node tools", async () => {
		const tools = (await client.listTools()).tools;
		const argumentsOf = (name) => Object.keys(tools.find((tool) => tool.name === name).inputSchema.properties);

		assert.ok(!argumentsOf("search_relations").includes("scope"));
		assert.ok(argumentsOf("search_nodes").includes("scope"));
		assert.ok(tools.find((tool) => tool.name === "get_ingest_prompt").inputSchema.required.includes("scope"));
	});
});
