// Both scope switches off (the default when config has no `scope`): MindMesh behaves as if scope did not
// exist, but stored scopes are kept.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createApp } from "../src/server/server.js";
import { TEST_SCHEMA, createTestServices, node, records, startHttp } from "./helpers/testServices.js";

const SCOPE_FIELD = { name: "scope", description: "Node business units.", constraints: { allowedValues: ["uc", "nc", "common"] } };
const SCOPED_SCHEMA = { ...TEST_SCHEMA, nodeProperties: { fields: [SCOPE_FIELD] } };

// No `scope` option: the defaults apply.
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

const scoped = (name, scope) => ({ ...node(name, "screen"), scope });

describe("All scopes switched off", () => {
	it("drops node scopes and adds no scope signals", async () => {
		services.graphStore.seed({ nodes: [scoped("uc_a_screen", ["uc"])] });
		services.llmProvider.nextResponse = records("NODE_UPDATE|uc_a_screen|A|screen|More.|nc|", "NODE_CREATE|b_screen|B|screen||xx|");

		const response = await http.post("/api/ingest", { text: "A and B.", userName: "tester", scope: "nc" });

		assert.equal(response.body.status, "applied", response.body.reviewReasons?.join("; "));
		assert.deepEqual((await services.graphStore.getNode("node:uc_a_screen")).scope, ["uc"], "stored scope is kept");
		assert.deepEqual((await services.graphStore.getNode("node:b_screen")).scope, []);
	});

	it("leaves every scope rule out of the prompt", async () => {
		await http.post("/api/ingest", { text: "Something.", userName: "tester", scope: "uc" });

		const prompt = services.llmProvider.requests[0].systemPrompt;
		assert.match(prompt, /Always leave the scope field of node records empty\./);
		assert.match(prompt, /Always leave the scope field of relation records empty\./);
		assert.doesNotMatch(prompt, /Selected scope for this input/);
		assert.doesNotMatch(prompt, /name prefix/);
		assert.doesNotMatch(prompt, /Node business units\./);
		assert.doesNotMatch(prompt, /\{\{[#^/]?(SCOPE_|INGEST_SCOPE)/);
	});

	it("ignores scope filters", async () => {
		services.graphStore.seed({ nodes: [scoped("uc_a_screen", ["uc"]), scoped("nc_a_screen", ["nc"])] });

		const result = await services.graphReadService.searchNodes({ query: "a_screen", match: "text", scope: "uc" });

		assert.equal(result.results.length, 2);
	});

	it("keeps the stored node scope on a direct edit", async () => {
		services.graphStore.seed({ nodes: [scoped("uc_a_screen", ["uc"])] });

		await http.put("/api/hitl/nodes/node%3Auc_a_screen", { label: "A2", type: "screen", scope: [], reviewedBy: "owner" });

		const stored = await services.graphStore.getNode("node:uc_a_screen");
		assert.equal(stored.label, "A2");
		assert.deepEqual(stored.scope, ["uc"]);
	});

	it("registers no scope arguments on the MCP tools", async () => {
		const tools = (await client.listTools()).tools;

		for (const tool of tools) {
			assert.ok(!Object.keys(tool.inputSchema.properties ?? {}).includes("scope"), tool.name);
		}
		assert.deepEqual(tools.find((tool) => tool.name === "get_ingest_prompt").inputSchema.required, ["text"]);
		const result = JSON.parse((await client.callTool({ name: "get_ingest_prompt", arguments: { text: "x" } })).content[0].text);
		assert.equal(result.scope, "");
	});

	it("tells the UI that no scopes are in use", async () => {
		assert.deepEqual((await http.get("/api/graph")).body.scopeSettings, { nodes: false, relations: false });
	});
});
