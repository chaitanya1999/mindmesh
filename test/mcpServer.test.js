// Characterization tests for the MCP tools, over the SDK's in-memory transport.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp/server.js";
import { createTestServices, node, records, relation } from "./helpers/testServices.js";

const services = createTestServices({ mode: "auto" });
const client = new Client({ name: "mindmesh-test", version: "0.0.0" });

async function connectClient(serverServices) {
	const connected = new Client({ name: "mindmesh-test", version: "0.0.0" });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await createMcpServer({ ...serverServices, llmProvider: null }).connect(serverTransport);
	await connected.connect(clientTransport);
	return connected;
}

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

const READ_TOOLS = [
	"search_context", "search_nodes", "search_relations", "get_node", "explore_graph", "find_paths", "query_cypher",
	"get_schema", "search_proposals", "list_proposals", "get_proposal", "get_ingest_prompt", "get_regenerate_prompt",
];
const PROPOSE_TOOLS = ["submit_ingest", "submit_regeneration", "save_reviewer_notes"];
const DECISION_TOOLS = ["approve_proposal", "reject_proposal"];

async function callTool(name, args, onClient = client) {
	const result = await onClient.callTool({ name, arguments: args });
	assert.notEqual(result.isError, true, result.content?.[0]?.text);
	return JSON.parse(result.content[0].text);
}

async function callToolError(name, args, onClient = client) {
	const result = await onClient.callTool({ name, arguments: args });
	assert.equal(result.isError, true, `expected ${name} to fail`);
	return result.content[0].text;
}

// Seeds approved nodes and relations in the graph and indexes their vectors, as an approval would.
async function seedGraph({ nodes = [], relations = [] }) {
	services.graphStore.seed({ nodes, relations });
	await services.vectorStore.upsertGraphIndex({ nodes, relations });
}

// Stores a proposal through submit_ingest in hitl mode and returns its tool result.
async function propose(...lines) {
	services.ingestionService.ingestion.mode = "hitl";
	return callTool("submit_ingest", { records: records(...lines), text: `input: ${lines[0]}`, author: "author" });
}

describe("MCP tools", () => {
	it("lists the tools with hints; review decisions are off by default", async () => {
		const { tools } = await client.listTools();
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [...READ_TOOLS, ...PROPOSE_TOOLS].sort());
		for (const name of READ_TOOLS) {
			assert.equal(tools.find((tool) => tool.name === name).annotations?.readOnlyHint, true, `${name} should be read-only`);
		}
		for (const name of PROPOSE_TOOLS) {
			assert.equal(tools.find((tool) => tool.name === name).annotations?.readOnlyHint, false, `${name} writes`);
		}
		assert.equal(tools.find((tool) => tool.name === "submit_regeneration").annotations.destructiveHint, true);
	});

	it("get_ingest_prompt returns the prompt, retrieved nodes, pending nodes, and a retrieval quality note", async () => {
		await seedGraph({ nodes: [node("ekyc_screen", "screen", "EKYC Screen")] });
		await propose("NODE_CREATE|pan_api|PAN API|api||");
		services.ingestionService.ingestion.mode = "auto";

		const result = await callTool("get_ingest_prompt", { text: "EKYC screen calls PAN." });

		assert.match(result.extractionSystemPrompt, /EKYC screen calls PAN\./);
		assert.match(result.extractionSystemPrompt, /node:ekyc_screen/);
		assert.deepEqual(result.retrievedNodes, [{ id: "node:ekyc_screen", label: "EKYC Screen", type: "screen" }]);
		assert.equal(result.pendingNodes[0].id, "node:pan_api");
		assert.equal(result.pendingNodes[0].verified, false);
		assert.equal(result.retrievalQuality.entryNodeCount, 1);
		assert.match(result.retrievalQuality.note, /look up every entity/);
		assert.match(result.instructions, /submit_ingest/);
		assert.equal(result.ingestionMode, "auto");
	});

	it("get_ingest_prompt tells the agent to look everything up when nothing was retrieved", async () => {
		const result = await callTool("get_ingest_prompt", { text: "Brand new things." });

		assert.equal(result.retrievalQuality.entryNodeCount, 0);
		assert.match(result.retrievalQuality.note, /retrieved no existing nodes/);
	});

	it("submit_ingest applies clean creates in auto mode", async () => {
		const result = await callTool("submit_ingest", {
			records: records("NODE_CREATE|a_screen|A|screen||", "NODE_CREATE|b_api|B|api||", "RELATION_CREATE|a_screen|b_api|uses|||"),
			text: "A uses B.",
		});

		assert.equal(result.status, "applied");
		assert.equal(result.applied, true);
		assert.deepEqual(result.nodeIds.sort(), ["node:a_screen", "node:b_api"]);
		assert.equal(result.counts.relations, 1);
		assert.equal(services.graphStore.nodes.size, 2);
		assert.equal(services.vectorStore.ids("test_relations").length, 1);
	});

	it("submit_ingest stores a proposal for a delete and returns the reasons", async () => {
		services.graphStore.seed({ nodes: [node("a_screen", "screen")] });

		const result = await callTool("submit_ingest", { records: records("NODE_DELETE|a_screen|"), text: "Remove A.", author: "agent" });

		assert.equal(result.status, "pending_hitl");
		assert.match(result.ref, /^#[0-9a-f]{6}$/);
		assert.match(result.id, /^hitl:/);
		assert.ok(result.reviewReasons.some((reason) => reason.includes("node delete")));
		assert.ok(await services.graphStore.getNode("node:a_screen"));
	});

	it("submit_ingest reconciles with pending proposals like web ingest", async () => {
		await propose("NODE_CREATE|sales_flow|Sales Flow|screen||");

		const second = await propose("NODE_CREATE|sales_flow|Sales Flow|screen|More detail.|");

		const note = await services.hitlService.getProposal(second.id);
		assert.match(note.llmResponse, /NODE_UPDATE\|sales_flow/, "a create for a node that is already pending becomes an update");
	});

	it("regenerates a proposal by short ref: prompt with the notes, then the overwrite", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A|screen||");

		const prompt = await callTool("get_regenerate_prompt", { ref: stored.ref, notes: "A is an API." });

		assert.equal(prompt.id, stored.id);
		assert.equal(prompt.ref, stored.ref);
		assert.equal(prompt.notesSource, "chat");
		assert.match(prompt.extractionSystemPrompt, /A is an API\./);
		assert.match(prompt.previousProposal, /NODE_CREATE\|a_screen/);
		assert.match(prompt.instructions, /submit_regeneration/);

		const regenerated = await callTool("submit_regeneration", { ref: stored.ref, records: records("NODE_CREATE|a_api|A|api||"), notes: "A is an API." });

		assert.equal(regenerated.status, "pending_hitl");
		assert.equal(regenerated.counts.nodes, 1);
		const note = await services.hitlService.getProposal(stored.id);
		assert.match(note.llmResponse, /NODE_CREATE\|a_api/);
		assert.equal(note.reviewerNotes, "A is an API.");
		assert.equal(note.regenerationOrigin, "agent");
	});

	it("get_regenerate_prompt uses saved notes, and requires notes when none are saved", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A|screen||");

		assert.match(await callToolError("get_regenerate_prompt", { ref: stored.ref }), /has no saved reviewer notes/);

		const saved = await callTool("save_reviewer_notes", { ref: stored.ref, notes: "Use the api type." });
		assert.equal(saved.reviewerNotes, "Use the api type.");
		const prompt = await callTool("get_regenerate_prompt", { ref: stored.ref });
		assert.equal(prompt.notesSource, "saved");
		assert.equal(prompt.reviewerNotes, "Use the api type.");
	});

	it("submit_regeneration leaves the proposal unchanged when the records are empty", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A|screen||");

		assert.match(await callToolError("submit_regeneration", { ref: stored.ref, records: "nothing", notes: "x" }), /no graph records/);
		assert.match((await services.hitlService.getProposal(stored.id)).llmResponse, /NODE_CREATE\|a_screen/);
	});
});

describe("MCP review decisions (config.mcp.allowReviewDecisions)", () => {
	let decisionClient;
	before(async () => {
		decisionClient = await connectClient({ ...services, config: { ...services.config, mcp: { allowReviewDecisions: true } } });
	});
	after(async () => {
		await decisionClient.close();
	});

	it("registers approve_proposal and reject_proposal as destructive when enabled", async () => {
		const { tools } = await decisionClient.listTools();
		for (const name of DECISION_TOOLS) {
			assert.equal(tools.find((tool) => tool.name === name)?.annotations?.destructiveHint, true, `${name} should be registered and destructive`);
		}
	});

	it("approve_proposal applies the proposal and removes it", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A Screen|screen||");

		const result = await callTool("approve_proposal", { ref: stored.ref, reviewer: "owner" }, decisionClient);

		assert.equal(result.status, "approved");
		assert.deepEqual(result.nodeIds, ["node:a_screen"]);
		assert.ok(await services.graphStore.getNode("node:a_screen"));
		assert.equal((await services.hitlService.listProposals({ limit: 10 })).total, 0);
	});

	it("approve_proposal can approve edited records", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A Screen|screen||");

		await callTool("approve_proposal", { ref: stored.ref, reviewer: "owner", records: records("NODE_CREATE|edited_screen|Edited|screen||") }, decisionClient);

		assert.ok(await services.graphStore.getNode("node:edited_screen"));
		assert.equal(await services.graphStore.getNode("node:a_screen"), null);
	});

	it("approve_proposal refuses a proposal that breaks the schema, keeping it pending", async () => {
		const stored = await propose("NODE_CREATE|w|Widget|gadget||");

		assert.match(await callToolError("approve_proposal", { ref: stored.ref, reviewer: "owner" }, decisionClient), /Schema validation failed/);
		assert.equal((await services.hitlService.listProposals({ limit: 10 })).total, 1);
	});

	it("reject_proposal deletes the proposal without touching the graph, and needs a reason", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A|screen||");

		const missingReason = await decisionClient.callTool({ name: "reject_proposal", arguments: { ref: stored.ref, reviewer: "owner", reason: "" } });
		assert.equal(missingReason.isError, true);

		const result = await callTool("reject_proposal", { ref: stored.ref, reviewer: "owner", reason: "Duplicate of an existing screen." }, decisionClient);
		assert.equal(result.status, "rejected");
		assert.equal((await services.hitlService.listProposals({ limit: 10 })).total, 0);
		assert.equal(services.graphStore.nodes.size, 0);
	});

	it("the default server cannot approve or reject", async () => {
		const stored = await propose("NODE_CREATE|a_screen|A|screen||");

		const result = await client.callTool({ name: "approve_proposal", arguments: { ref: stored.ref, reviewer: "owner" } });

		assert.equal(result.isError, true);
		assert.equal((await services.hitlService.listProposals({ limit: 10 })).total, 1);
	});
});

// The fake Chroma ignores the query text and returns matching records in insertion order, so these tests
// check filters, shapes, and that records come from the graph store, not ranking quality.
describe("MCP read tools", () => {
	it("search_context returns MindMesh's context, entry nodes, and optional pending knowledge", async () => {
		await seedGraph({
			nodes: [node("a_screen", "screen", "A Screen"), node("b_api", "api", "B API")],
			relations: [relation("a_screen", "uses", "b_api")],
		});
		await propose("NODE_CREATE|c_screen|C Screen|screen||");

		const plain = await callTool("search_context", { query: "A screen" });
		assert.match(plain.context, /node:a_screen/);
		assert.ok(plain.entryNodes.some((entry) => entry.id === "node:a_screen" && entry.type === "screen"));
		assert.equal(plain.pending, undefined);

		const withPending = await callTool("search_context", { query: "A screen", includePending: true, depth: 0 });
		assert.equal(withPending.depth, 0);
		assert.equal(withPending.pending.verified, false);
		assert.equal(withPending.pending.proposals.length, 1);
		assert.match(withPending.pending.proposals[0].ref, /^#/);
	});

	it("search_nodes semantic returns graph records, filters by type, and skips stale vectors", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen", "A Screen", "From Neo4j."), node("b_api", "api", "B API")] });
		await services.vectorStore.upsertNode({ ...node("ghost_screen", "screen", "Ghost"), description: "" });

		const all = await callTool("search_nodes", { query: "anything" });
		assert.equal(all.match, "semantic");
		assert.deepEqual(all.results.map((item) => item.id).sort(), ["node:a_screen", "node:b_api"]);
		assert.equal(all.results.find((item) => item.id === "node:a_screen").description, "From Neo4j.");

		const screens = await callTool("search_nodes", { query: "anything", type: "screen" });
		assert.deepEqual(screens.results.map((item) => item.id), ["node:a_screen"]);
	});

	it("search_nodes text finds exact names in the graph", async () => {
		await seedGraph({ nodes: [node("pan_api", "api", "PAN API"), node("pan_screen", "screen", "PAN Screen")] });

		const result = await callTool("search_nodes", { query: "pan api", match: "text" });

		assert.equal(result.match, "text");
		assert.equal(result.results[0].id, "node:pan_api");
		assert.deepEqual((await callTool("search_nodes", { query: "pan", match: "text", type: "screen" })).results.map((item) => item.id), ["node:pan_screen"]);
	});

	it("search_relations returns relations with both endpoints", async () => {
		await seedGraph({
			nodes: [node("a_screen", "screen", "A Screen"), node("b_api", "api", "B API")],
			relations: [relation("a_screen", "uses", "b_api", "during onboarding")],
		});

		const { results } = await callTool("search_relations", { query: "uses", relationType: "uses" });

		assert.equal(results.length, 1);
		assert.equal(results[0].relation, "uses");
		assert.equal(results[0].information, "during onboarding");
		assert.deepEqual(results[0].source, { id: "node:a_screen", label: "A Screen", type: "screen" });
		assert.equal(results[0].target.label, "B API");
	});

	it("get_node groups relations by direction and type and lists pending changes", async () => {
		await seedGraph({
			nodes: [node("a_screen", "screen", "A Screen"), node("b_api", "api", "B API"), node("c_flow", "screen", "C Flow")],
			relations: [relation("a_screen", "uses", "b_api"), relation("c_flow", "uses", "a_screen")],
		});
		await propose("NODE_UPDATE|a_screen|A Screen|screen|New detail.|");

		const result = await callTool("get_node", { node: "a_screen" });

		assert.equal(result.node.id, "node:a_screen");
		assert.equal(result.relationCount, 2);
		assert.equal(result.outgoing.uses[0].target.id, "node:b_api");
		assert.equal(result.incoming.uses[0].source.id, "node:c_flow");
		assert.equal(result.pendingChanges.length, 1);
		assert.equal(result.pendingChanges[0].verified, false);
		assert.equal(result.pendingChanges[0].changes[0].proposed.description, "New detail.");
		assert.equal((await callTool("get_node", { node: "node:a_screen", includePending: false })).pendingChanges, undefined);
	});

	it("get_node points to search_nodes when the node does not exist", async () => {
		const result = await client.callTool({ name: "get_node", arguments: { node: "missing_thing" } });

		assert.equal(result.isError, true);
		assert.match(result.content[0].text, /search_nodes/);
	});

	it("get_schema reports types with counts, totals, and types no longer approved", async () => {
		await seedGraph({
			nodes: [node("a_screen", "screen"), node("b_screen", "screen"), node("w", "gadget")],
			relations: [relation("a_screen", "uses", "b_screen")],
		});

		const schema = await callTool("get_schema", {});

		assert.equal(schema.nodeTypes.find((type) => type.name === "screen").nodeCount, 2);
		assert.equal(schema.nodeTypes.find((type) => type.name === "api").nodeCount, 0);
		assert.equal(schema.relationTypes.find((type) => type.name === "uses").relationCount, 1);
		assert.deepEqual(schema.unapprovedTypesInGraph.nodeTypes, [{ type: "gadget", count: 1 }]);
		assert.deepEqual(schema.totals, { nodes: 3, relations: 1 });
		assert.match(schema.fieldGuidance, /\S/);
	});

	it("search_proposals returns unverified summaries with refs", async () => {
		await propose("NODE_CREATE|a_screen|A|screen||");

		const { results } = await callTool("search_proposals", { query: "A screen" });

		assert.equal(results.length, 1);
		assert.equal(results[0].verified, false);
		assert.match(results[0].ref, /^#[0-9a-f]{6}$/);
		assert.equal(results[0].counts.nodes, 1);
	});

	it("list_proposals filters every pending proposal before the limit", async () => {
		await propose("NODE_CREATE|a_screen|A|screen||");
		await propose("NODE_CREATE|rajat|Rajat|person||AMBIGUITY:two users match");
		await propose("NODE_DELETE|old_screen|");

		assert.equal((await callTool("list_proposals", {})).total, 3);
		const ambiguous = await callTool("list_proposals", { signal: "ambiguity" });
		assert.equal(ambiguous.total, 1);
		assert.equal(ambiguous.results[0].signals.ambiguity, 1);
		const deletes = await callTool("list_proposals", { operation: "delete", limit: 1 });
		assert.equal(deletes.total, 1);
		assert.equal(deletes.results[0].counts.nodeDeletes, 1);
		assert.equal((await callTool("list_proposals", { operation: "create", limit: 1 })).total, 2);
	});

	it("get_proposal shows every record next to its current graph value", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen", "A Screen", "Old.")] });
		const stored = await propose("NODE_UPDATE|a_screen|A Screen|screen|New.|", "NODE_CREATE|b_api|B API|api||");

		const review = await callTool("get_proposal", { ref: stored.ref });

		assert.equal(review.ref, stored.ref);
		assert.equal(review.verified, false);
		assert.match(review.proposal.llmResponse, /NODE_UPDATE\|a_screen/);
		const update = review.changes.find((change) => change.id === "node:a_screen");
		assert.equal(update.operation, "update");
		assert.equal(update.current.description, "Old.");
		assert.equal(update.proposed.description, "New.");
		assert.equal(review.changes.find((change) => change.id === "node:b_api").current, null);
	});
});

// A small dependency graph: two screens use an API that calls a bureau; a flow contains one screen.
const exploreGraphFixture = () => seedGraph({
	nodes: [
		node("ekyc_screen", "screen", "EKYC Screen"),
		node("kyc_screen", "screen", "KYC Screen"),
		node("pan_api", "api", "PAN API"),
		node("bureau_api", "api", "Bureau API"),
		node("onboarding_flow", "screen", "Onboarding Flow"),
	],
	relations: [
		relation("ekyc_screen", "uses", "pan_api"),
		relation("kyc_screen", "uses", "pan_api"),
		relation("pan_api", "invokes", "bureau_api"),
		relation("onboarding_flow", "owned_by", "ekyc_screen"),
	],
});

describe("MCP graph exploration", () => {
	it("explore_graph walks out from a node with hop distances", async () => {
		await exploreGraphFixture();

		const result = await callTool("explore_graph", { from: "pan_api", depth: 2 });

		const distance = Object.fromEntries(result.nodes.map((item) => [item.id, item.distance]));
		assert.deepEqual(distance, {
			"node:pan_api": 0,
			"node:ekyc_screen": 1,
			"node:kyc_screen": 1,
			"node:bureau_api": 1,
			"node:onboarding_flow": 2,
		});
		assert.equal(result.relations.length, 4);
		assert.equal(result.truncated, false);
	});

	it("explore_graph direction in finds what uses a node; out finds what it uses", async () => {
		await exploreGraphFixture();

		const users = await callTool("explore_graph", { from: "node:pan_api", direction: "in" });
		assert.deepEqual(users.nodes.filter((item) => item.distance === 1).map((item) => item.id).sort(), ["node:ekyc_screen", "node:kyc_screen"]);

		const uses = await callTool("explore_graph", { from: "pan_api", direction: "out" });
		assert.deepEqual(uses.nodes.filter((item) => item.distance === 1).map((item) => item.id), ["node:bureau_api"]);
	});

	it("explore_graph filters relation and node types, and reports truncation", async () => {
		await exploreGraphFixture();

		const onlyUses = await callTool("explore_graph", { from: "pan_api", depth: 3, relationTypes: ["uses"] });
		assert.deepEqual(onlyUses.nodes.map((item) => item.id).sort(), ["node:ekyc_screen", "node:kyc_screen", "node:pan_api"]);

		const onlyApis = await callTool("explore_graph", { from: "pan_api", depth: 2, nodeTypes: ["api"] });
		assert.deepEqual(onlyApis.nodes.map((item) => item.id).sort(), ["node:bureau_api", "node:pan_api"]);

		const cut = await callTool("explore_graph", { from: "pan_api", depth: 2, limit: 2 });
		assert.equal(cut.nodes.length, 2);
		assert.equal(cut.truncated, true);
	});

	it("explore_graph points to search_nodes for an unknown start node", async () => {
		assert.match(await callToolError("explore_graph", { from: "nothing_here" }), /search_nodes/);
	});

	it("find_paths returns the shortest connection with a readable summary", async () => {
		await exploreGraphFixture();

		const result = await callTool("find_paths", { from: "kyc_screen", to: "onboarding_flow" });

		assert.equal(result.paths.length, 1);
		assert.equal(result.paths[0].length, 3);
		assert.equal(result.paths[0].summary, "KYC Screen -[uses]-> PAN API <-[uses]- EKYC Screen <-[owned_by]- Onboarding Flow");
		assert.deepEqual(result.paths[0].nodes.map((item) => item.id), ["node:kyc_screen", "node:pan_api", "node:ekyc_screen", "node:onboarding_flow"]);
	});

	it("find_paths respects maxDepth and relation filters, and rejects the same node twice", async () => {
		await exploreGraphFixture();

		assert.deepEqual((await callTool("find_paths", { from: "kyc_screen", to: "onboarding_flow", maxDepth: 2 })).paths, []);
		assert.deepEqual((await callTool("find_paths", { from: "kyc_screen", to: "bureau_api", relationTypes: ["uses"] })).paths, []);
		assert.match(await callToolError("find_paths", { from: "pan_api", to: "node:pan_api" }), /same node/);
	});

	it("query_cypher passes the query, params, and limit to the store and returns its rows", async () => {
		const calls = [];
		services.graphStore.readQueryHandler = async (cypher, params, options) => {
			calls.push({ cypher, params, options });
			return { columns: ["label"], rows: [{ label: "EKYC Screen" }], truncated: false };
		};

		const result = await callTool("query_cypher", { cypher: "MATCH (n:KnowledgeNode {type: $type}) RETURN n.label AS label", params: { type: "screen" }, limit: 5 });

		assert.deepEqual(result.rows, [{ label: "EKYC Screen" }]);
		assert.equal(calls[0].params.type, "screen");
		assert.equal(calls[0].options.limit, 5);
		assert.equal(calls[0].options.timeoutMs, 10000);
	});

	it("query_cypher reports the store's refusal as an invalid request", async () => {
		services.graphStore.readQueryHandler = async () => {
			const error = new Error("query_cypher runs read-only queries only");
			error.status = 400;
			throw error;
		};

		assert.match(await callToolError("query_cypher", { cypher: "CREATE (n) RETURN n" }), /read-only queries only/);
	});
});
