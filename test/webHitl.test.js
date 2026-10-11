// Characterization tests for the HITL web API: proposals (list, approve, reject, regenerate, preview),
// manual proposals from the main page, and direct reviewer edits.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/server/server.js";
import { createTestServices, node, records, relation, relationId, startHttp } from "./helpers/testServices.js";

const services = createTestServices({ mode: "hitl" });
let http;

before(async () => {
	http = await startHttp(createApp(services));
});
after(async () => {
	await http.close();
	services.cleanUp();
});
beforeEach(() => services.reset());

const noteUrl = (id, suffix = "") => `/api/hitl/notes/${encodeURIComponent(id)}${suffix}`;

// Stores a proposal through the ingest route (hitl mode) and returns its id.
async function propose(...lines) {
	services.llmProvider.nextResponse = records(...lines);
	const response = await http.post("/api/ingest", { text: `input for ${lines[0]}`, userName: "author" });
	assert.equal(response.body.status, "pending_hitl");
	return response.body.hitlNote.id;
}

const approve = (id, body = {}) => http.post(noteUrl(id, "/approve"), { reviewedBy: "reviewer", ...body });

describe("GET /api/hitl/notes", () => {
	it("lists pending proposals oldest first with counts and the total", async () => {
		const first = await propose("NODE_CREATE|a_screen|A|screen||");
		const second = await propose("NODE_CREATE|b_screen|B|screen||", "NODE_DELETE|old_screen|");

		const { body } = await http.get("/api/hitl/notes");

		assert.equal(body.total, 2);
		assert.deepEqual(body.notes.map((note) => note.id), [first, second]);
		assert.equal(body.notes[1].nodeCount, 1);
		assert.equal(body.notes[1].nodeDeleteCount, 1);
		assert.match(body.notes[0].llmResponse, /NODE_CREATE\|a_screen/);
	});

	it("returns the parsed records next to the proposal text", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||", "NODE_DELETE|old_screen|");

		const list = (await http.get("/api/hitl/notes")).body;
		const detail = (await http.get(noteUrl(id))).body.note;

		for (const records of [list.notes[0].records, detail.records]) {
			assert.equal(records.nodes[0].id, "node:a_screen");
			assert.equal(records.nodes[0].type, "screen");
			assert.equal(records.nodeDeletes[0].id, "node:old_screen");
			assert.deepEqual(records.schemaViolations, []);
		}
		assert.match(detail.llmResponse, /NODE_CREATE\|a_screen/);
	});
});

describe("POST /api/hitl/notes/:id/approve", () => {
	it("applies the proposal, indexes vectors, and removes the note", async () => {
		const id = await propose("NODE_CREATE|a_screen|A Screen|screen||", "NODE_CREATE|b_api|B API|api||", "RELATION_CREATE|a_screen|b_api|uses|||");

		const response = await approve(id);

		assert.equal(response.status, 200);
		assert.equal(response.body.status, "approved");
		assert.equal(services.graphStore.nodes.size, 2);
		assert.equal(services.vectorStore.ids("test_relations").length, 1);
		assert.equal((await http.get(noteUrl(id))).status, 404);
	});

	it("applies the reviewer's edited records instead of the stored ones", async () => {
		const id = await propose("NODE_CREATE|a_screen|A Screen|screen||");

		await approve(id, { llmResponse: records("NODE_CREATE|edited_screen|Edited|screen||") });

		assert.ok(await services.graphStore.getNode("node:edited_screen"));
		assert.equal(await services.graphStore.getNode("node:a_screen"), null);
	});

	it("merges the proposal's type suggestions into the schema", async () => {
		const id = await propose("NODE_CREATE|flow_x|Flow X|flow||", "NODE_TYPE_SUGGESTION|flow|A business flow.|No type fits.");

		const response = await approve(id);

		assert.equal(response.status, 200);
		assert.ok(services.readSchema().nodeTypes.some((type) => type.name === "flow"));
	});

	it("applies deletes, including the relations of a deleted node", async () => {
		services.graphStore.seed({
			nodes: [node("a_screen", "screen"), node("b_api", "api")],
			relations: [relation("a_screen", "uses", "b_api")],
		});
		await services.vectorStore.upsertGraphIndex({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });
		const id = await propose("NODE_DELETE|b_api|");

		await approve(id);

		assert.equal(await services.graphStore.getNode("node:b_api"), null);
		assert.equal(services.graphStore.relations.size, 0);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), ["node:a_screen"]);
		assert.deepEqual(services.vectorStore.ids("test_relations"), []);
	});

	it("refuses a relation to a missing node and keeps the note and schema unchanged", async () => {
		const id = await propose("RELATION_CREATE|a_screen|ghost|uses|||", "NODE_TYPE_SUGGESTION|flow|A flow.|reason");

		const response = await approve(id);

		assert.equal(response.status, 400);
		assert.match(response.body.error, /does not exist/);
		assert.equal((await http.get(noteUrl(id))).status, 200);
		assert.equal(services.graphStore.nodes.size, 0);
		assert.ok(!services.readSchema().nodeTypes.some((type) => type.name === "flow"));
	});

	it("refuses unknown types without a suggestion", async () => {
		const id = await propose("NODE_CREATE|w|Widget|gadget||");

		const response = await approve(id);

		assert.equal(response.status, 400);
		assert.match(response.body.error, /Schema validation failed/);
	});

	it("reports a vector sync failure as saved-but-unsynced, and an approve retry repairs it", async () => {
		const id = await propose("NODE_CREATE|a_screen|A Screen|screen||");
		services.vectorStore.failNext("test_nodes", "upsert", "chroma down");

		const failed = await approve(id);

		assert.equal(failed.status, 503);
		assert.match(failed.body.error, /Graph changes were saved/);
		assert.match(failed.body.error, /chroma down/);
		assert.ok(await services.graphStore.getNode("node:a_screen"));
		assert.equal((await http.get(noteUrl(id))).status, 200, "the note stays pending");

		services.vectorStore.clearFailures();
		const retried = await approve(id);

		assert.equal(retried.status, 200);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), ["node:a_screen"]);
		assert.equal((await http.get(noteUrl(id))).status, 404);
	});

	it("requires a reviewer name", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||");
		const response = await http.post(noteUrl(id, "/approve"), {});
		assert.equal(response.status, 400);
	});
});

describe("DELETE /api/hitl/notes/:id", () => {
	it("rejects the proposal without touching the graph", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||");

		const response = await http.del(noteUrl(id));

		assert.equal(response.body.status, "rejected");
		assert.equal((await http.get(noteUrl(id))).status, 404);
		assert.equal(services.graphStore.nodes.size, 0);
	});
});

describe("Reviewer notes and regeneration", () => {
	it("saves reviewer notes on the proposal", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||");

		const response = await http.put(noteUrl(id, "/reviewer-notes"), { reviewerNotes: "Use the api type." });

		assert.equal(response.body.note.reviewerNotes, "Use the api type.");
		assert.equal((await http.get(noteUrl(id))).body.note.reviewerNotes, "Use the api type.");
	});

	it("regenerates the proposal from the original input with the reviewer notes", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||");
		services.llmProvider.nextResponse = records("NODE_CREATE|a_api|A|api||");

		const response = await http.post(noteUrl(id, "/regenerate"), { reviewedBy: "reviewer", reviewerNotes: "It is an API." });

		assert.equal(response.status, 200);
		assert.match(response.body.note.llmResponse, /NODE_CREATE\|a_api/);
		assert.equal(response.body.note.regenerated, true);
		assert.equal(response.body.note.regeneratedBy, "reviewer");
		const prompt = services.llmProvider.requests.at(-1).systemPrompt;
		assert.match(prompt, /It is an API\./);
		assert.match(prompt, /input for NODE_CREATE\|a_screen/);
	});

	it("keeps the proposal when the regenerated output has no records", async () => {
		const id = await propose("NODE_CREATE|a_screen|A|screen||");
		services.llmProvider.nextResponse = "no records here";

		const response = await http.post(noteUrl(id, "/regenerate"), { reviewedBy: "reviewer", reviewerNotes: "x" });

		assert.equal(response.status, 400);
		assert.match((await http.get(noteUrl(id))).body.note.llmResponse, /NODE_CREATE\|a_screen/);
	});
});

describe("HITL previews", () => {
	it("marks pending items and keeps the approved version for comparison", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen", "A", "Old.")] });
		const id = await propose("NODE_UPDATE|a_screen|A|screen|New.|", "NODE_CREATE|b_api|B|api||", "RELATION_CREATE|a_screen|b_api|uses|||");

		const { body } = await http.get(noteUrl(id, "/graph"));

		const updated = body.nodes.find((item) => item.id === "node:a_screen");
		assert.equal(updated.pendingHitl, true);
		assert.equal(updated.pendingOperation, "update");
		assert.equal(updated.description, "New.");
		assert.equal(updated.approved.description, "Old.");
		assert.equal(body.nodes.find((item) => item.id === "node:b_api").approved, undefined);
		assert.equal(body.relations[0].pendingOperation, "create");
	});

	it("overlays every pending proposal on the approved graph", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen")] });
		await propose("NODE_CREATE|b_api|B|api||");

		const { body } = await http.get("/api/hitl/graph");

		assert.deepEqual(body.nodes.map((item) => item.id).sort(), ["node:a_screen", "node:b_api"]);
		assert.equal(body.pendingNotes.length, 1);
	});
});

describe("Manual proposals from the main page", () => {
	it("stores a node create as a proposal", async () => {
		const response = await http.post("/api/nodes", { label: "New Screen", type: "screen", userName: "author" });

		assert.equal(response.status, 202);
		assert.match(response.body.hitlNote.document, /NODE_CREATE\|new_screen\|New Screen\|screen/);
		assert.equal(services.graphStore.nodes.size, 0);
	});

	it("stores a create for an existing node as a flagged update", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen", "A")] });

		const response = await http.post("/api/nodes", { name: "a_screen", label: "A", type: "screen", userName: "author" });

		assert.match(response.body.hitlNote.document, /NODE_UPDATE\|a_screen\|A\|screen\|\|AMBIGUITY:/);
	});

	it("requires a node type", async () => {
		const response = await http.post("/api/nodes", { label: "Untyped", userName: "author" });
		assert.equal(response.status, 400);
		assert.match(response.body.error, /Node type is required/);
	});

	it("rejects a relation whose endpoint does not exist", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen")] });

		const response = await http.post("/api/relations", { sourceId: "node:a_screen", targetId: "b_typo", relation: "uses", userName: "author" });

		assert.equal(response.status, 400);
		assert.match(response.body.error, /Not found: node:b_typo/);
	});

	it("stores a relation edit as a delete of the old relation plus a create", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });

		const response = await http.put(`/api/relations/${relationId("a_screen", "uses", "b_api")}`, {
			sourceId: "node:a_screen", targetId: "node:b_api", relation: "invokes", userName: "author",
		});

		assert.equal(response.status, 202);
		assert.match(response.body.hitlNote.document, /RELATION_DELETE\|a_screen\|b_api\|uses/);
		assert.match(response.body.hitlNote.document, /RELATION_CREATE\|a_screen\|b_api\|invokes/);
	});
});

describe("Direct reviewer edits on /hitl", () => {
	it("creates a schema-valid node directly, with its vector", async () => {
		const response = await http.post("/api/hitl/nodes", { label: "A Screen", type: "screen", reviewedBy: "reviewer" });

		assert.equal(response.body.status, "applied");
		assert.ok(await services.graphStore.getNode("node:a_screen"));
		assert.deepEqual(services.vectorStore.ids("test_nodes"), ["node:a_screen"]);
	});

	it("turns a node with an unknown type into a proposal", async () => {
		const response = await http.post("/api/hitl/nodes", { label: "W", type: "gadget", reviewedBy: "reviewer" });

		assert.equal(response.status, 202);
		assert.equal(response.body.status, "pending_hitl");
		assert.equal(services.graphStore.nodes.size, 0);
	});

	it("refuses to rename an existing node", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen")] });

		const response = await http.put("/api/hitl/nodes/node:a_screen", { name: "b_screen", label: "B", type: "screen", reviewedBy: "reviewer" });

		assert.equal(response.status, 400);
		assert.match(response.body.error, /renaming is not supported/);
	});

	it("replaces a relation whose type changes, keeping vectors in step", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });
		const oldId = relationId("a_screen", "uses", "b_api");
		await services.vectorStore.upsertRelation(relation("a_screen", "uses", "b_api"));

		const response = await http.put(`/api/hitl/relations/${oldId}`, { sourceId: "node:a_screen", targetId: "node:b_api", relation: "invokes", reviewedBy: "reviewer" });

		const newId = relationId("a_screen", "invokes", "b_api");
		assert.equal(response.body.relation.id, newId);
		assert.equal(await services.graphStore.getRelation(oldId), null);
		assert.deepEqual(services.vectorStore.ids("test_relations"), [newId]);
	});

	it("deletes a node with its relations and their vectors", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });
		await services.vectorStore.upsertGraphIndex({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });

		const response = await http.del("/api/hitl/nodes/node:b_api", { reviewedBy: "reviewer" });

		assert.equal(response.body.deletedRelationIds.length, 1);
		assert.equal(services.graphStore.relations.size, 0);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), ["node:a_screen"]);
		assert.deepEqual(services.vectorStore.ids("test_relations"), []);
	});

	it("deletes a relation and its vector", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });
		const id = relationId("a_screen", "uses", "b_api");
		await services.vectorStore.upsertRelation(relation("a_screen", "uses", "b_api"));

		const response = await http.del(`/api/hitl/relations/${id}`, { reviewedBy: "reviewer" });

		assert.equal(response.body.deletedRelationId, id);
		assert.deepEqual(services.vectorStore.ids("test_relations"), []);
	});
});
