// Characterization tests for POST /api/ingest: when auto mode applies and when it stores a HITL proposal.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/server/server.js";
import { createTestServices, node, records, startHttp } from "./helpers/testServices.js";

const services = createTestServices({ mode: "auto" });
let http;

before(async () => {
	http = await startHttp(createApp(services));
});
after(async () => {
	await http.close();
	services.cleanUp();
});
beforeEach(() => services.reset());

const ingest = (text = "Some input.") => http.post("/api/ingest", { text, userName: "tester" });
const pendingNotes = async () => (await http.get("/api/hitl/notes")).body;

describe("POST /api/ingest in auto mode", () => {
	it("applies clean creates to the graph and the vector index", async () => {
		services.llmProvider.nextResponse = records(
			"NODE_CREATE|ekyc_screen|EKYC Screen|screen|Captures identity details.||",
			"NODE_CREATE|pan_api|PAN API|api|||",
			"RELATION_CREATE|ekyc_screen|pan_api|uses|during onboarding|||",
		);

		const response = await ingest("EKYC screen uses the PAN API.");

		assert.equal(response.status, 200);
		assert.equal(response.body.status, "applied");
		assert.equal(response.body.applied, true);
		assert.equal((await services.graphStore.getNode("node:ekyc_screen")).type, "screen");
		assert.equal((await services.graphStore.getRelationsForNode("node:ekyc_screen")).length, 1);
		assert.deepEqual(services.vectorStore.ids("test_nodes").sort(), ["node:ekyc_screen", "node:pan_api"]);
		assert.equal(services.vectorStore.ids("test_relations").length, 1);
		assert.equal((await pendingNotes()).total, 0);
	});

	it("sends the user input and retrieved context to the LLM", async () => {
		services.graphStore.seed({ nodes: [node("ekyc_screen", "screen", "EKYC Screen")] });
		await services.vectorStore.upsertGraphIndex({ nodes: [node("ekyc_screen", "screen", "EKYC Screen")], relations: [] });

		await ingest("EKYC screen calls PAN.");

		const prompt = services.llmProvider.requests[0].systemPrompt;
		assert.match(prompt, /EKYC screen calls PAN\./);
		assert.match(prompt, /node:ekyc_screen/);
	});

	for (const [label, lines, reason] of [
		["a node delete", ["NODE_DELETE|old_screen|"], "node delete"],
		["a relation delete", ["RELATION_DELETE|a|b|uses|"], "relation delete"],
		["an ambiguity signal", ["NODE_CREATE|rajat|Rajat|person|||AMBIGUITY:two users match"], "ambiguity"],
		["a contradiction signal", ["NODE_CREATE|rajat|Rajat|person|||CONTRADICTION:graph differs"], "contradiction"],
		["an unknown type", ["NODE_CREATE|widget|Widget|gadget|||"], "schema violation"],
	]) {
		it(`stores a HITL proposal instead of applying ${label}`, async () => {
			services.llmProvider.nextResponse = records(...lines);

			const response = await ingest();

			assert.equal(response.status, 200);
			assert.equal(response.body.status, "pending_hitl");
			assert.equal(response.body.applied, false);
			assert.ok(response.body.reviewReasons.some((text) => text.includes(reason)), response.body.reviewReasons.join("; "));
			assert.equal(services.graphStore.nodes.size, 0);
			assert.equal((await pendingNotes()).total, 1);
		});
	}

	it("rejects a relation to a node that does not exist, without creating it", async () => {
		services.llmProvider.nextResponse = records("RELATION_CREATE|ekyc_screen|ghost_api|uses||||");
		services.graphStore.seed({ nodes: [node("ekyc_screen", "screen")] });

		const response = await ingest();

		assert.equal(response.body.status, "pending_hitl");
		assert.ok(response.body.schemaViolations.some((violation) => violation.kind === "relationEndpoint"));
		assert.equal(await services.graphStore.getNode("node:ghost_api"), null);
	});

	it("turns NODE_CREATE for an existing node into a flagged NODE_UPDATE proposal", async () => {
		services.graphStore.seed({ nodes: [node("ekyc_screen", "screen", "EKYC Screen", "Original.")] });
		services.llmProvider.nextResponse = records("NODE_CREATE|ekyc_screen|EKYC Screen|screen|Guessed.||");

		const response = await ingest();

		assert.equal(response.body.status, "pending_hitl");
		const [note] = (await pendingNotes()).notes;
		assert.match(note.llmResponse, /NODE_UPDATE\|ekyc_screen\|EKYC Screen\|screen\|Guessed\.\|\|AMBIGUITY:/);
		assert.equal(note.ambiguityCount, 1);
		assert.equal((await services.graphStore.getNode("node:ekyc_screen")).description, "Original.");
	});

	it("references an existing endpoint without rewriting it", async () => {
		services.graphStore.seed({ nodes: [node("ekyc_screen", "screen", "EKYC Screen"), node("pan_api", "api", "PAN API")] });
		services.llmProvider.nextResponse = records("RELATION_CREATE|ekyc_screen|pan_api|invokes||||");

		const response = await ingest();

		assert.equal(response.body.status, "applied");
		const target = await services.graphStore.getNode("node:pan_api");
		assert.equal(target.type, "api");
		assert.equal(target.label, "PAN API");
	});
});

describe("POST /api/ingest in hitl mode", () => {
	it("stores even a clean extraction as a proposal, keeping the model's exact output", async () => {
		services.ingestionService.ingestion.mode = "hitl";
		const output = records("NODE_CREATE|ekyc_screen|EKYC Screen|screen|||");
		services.llmProvider.nextResponse = output;

		const response = await ingest("EKYC screen exists.");

		assert.equal(response.body.status, "pending_hitl");
		const [note] = (await pendingNotes()).notes;
		assert.equal(note.llmResponse, output);
		assert.equal(note.userName, "tester");
		assert.equal(services.graphStore.nodes.size, 0);
	});
});

describe("POST /api/ingest validation", () => {
	it("requires a user name", async () => {
		const response = await http.post("/api/ingest", { text: "x" });
		assert.equal(response.status, 400);
		assert.match(response.body.error, /User name is required/);
	});

	it("requires text", async () => {
		const response = await http.post("/api/ingest", { text: " ", userName: "tester" });
		assert.equal(response.status, 400);
	});
});
