// Characterization tests for the MCP tools, over the SDK's in-memory transport.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createTestServices, node, records } from "./helpers/testServices.js";

const services = createTestServices({ mode: "auto" });
const client = new Client({ name: "mindmesh-test", version: "0.0.0" });

before(async () => {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await createMcpServer({ ...services, llmProvider: null }).connect(serverTransport);
	await client.connect(clientTransport);
});
after(async () => {
	await client.close();
	services.cleanUp();
});
beforeEach(() => services.reset());

async function callTool(name, args) {
	const result = await client.callTool({ name, arguments: args });
	return JSON.parse(result.content[0].text);
}

describe("MCP tools", () => {
	it("lists the five tools", async () => {
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name).sort(), ["apply-ingestion", "apply-regeneration", "ask", "ingest-context", "regenerate-context"]);
	});

	it("ingest-context returns the rendered extraction prompt with the text and graph context", async () => {
		services.graphStore.seed({ nodes: [node("ekyc_screen", "screen", "EKYC Screen")] });
		await services.vectorStore.upsertGraphIndex({ nodes: [node("ekyc_screen", "screen", "EKYC Screen")], relations: [] });

		const result = await callTool("ingest-context", { text: "EKYC screen calls PAN." });

		assert.match(result.extractionSystemPrompt, /EKYC screen calls PAN\./);
		assert.match(result.context, /node:ekyc_screen/);
		assert.equal(result.ingestionMode, "auto");
	});

	it("apply-ingestion applies clean creates in auto mode", async () => {
		const result = await callTool("apply-ingestion", {
			graphRecords: records("NODE_CREATE|a_screen|A|screen||", "NODE_CREATE|b_api|B|api||", "RELATION_CREATE|a_screen|b_api|uses|||"),
			text: "A uses B.",
		});

		assert.equal(result.status, "applied");
		assert.equal(services.graphStore.nodes.size, 2);
		assert.equal(services.vectorStore.ids("test_relations").length, 1);
	});

	it("apply-ingestion stores a proposal for a delete and returns the reasons", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen")] });

		const result = await callTool("apply-ingestion", { graphRecords: records("NODE_DELETE|a_screen|"), text: "Remove A.", userName: "agent" });

		assert.equal(result.status, "pending_hitl");
		assert.match(result.hitlNoteRef, /^#[0-9a-f]{6}$/);
		assert.ok(result.reviewReasons.some((reason) => reason.includes("node delete")));
		assert.ok(await services.graphStore.getNode("node:a_screen"));
	});

	it("regenerates a proposal by short ref: context with the notes, then the overwrite", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		const stored = await callTool("apply-ingestion", { graphRecords: records("NODE_CREATE|a_screen|A|screen||"), text: "A exists." });

		const context = await callTool("regenerate-context", { proposal: stored.hitlNoteRef, notes: "A is an API." });

		assert.equal(context.noteId, stored.hitlNoteId);
		assert.equal(context.notesSource, "chat");
		assert.match(context.extractionSystemPrompt, /A is an API\./);
		assert.match(context.previousProposal, /NODE_CREATE\|a_screen/);

		const regenerated = await callTool("apply-regeneration", {
			proposal: stored.hitlNoteRef,
			graphRecords: records("NODE_CREATE|a_api|A|api||"),
			notes: "A is an API.",
		});

		assert.equal(regenerated.status, "pending_hitl");
		const note = await services.ingestionService.getHitlNote(stored.hitlNoteId);
		assert.match(note.llmResponse, /NODE_CREATE\|a_api/);
		assert.equal(note.reviewerNotes, "A is an API.");
		assert.equal(note.regenerationOrigin, "agent");
	});

	it("regenerate-context requires notes when none are saved", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		const stored = await callTool("apply-ingestion", { graphRecords: records("NODE_CREATE|a_screen|A|screen||"), text: "A exists." });

		const result = await client.callTool({ name: "regenerate-context", arguments: { proposal: stored.hitlNoteRef } });

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /has no saved reviewer notes/);
	});
});
