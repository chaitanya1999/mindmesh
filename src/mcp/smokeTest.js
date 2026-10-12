import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getConfig } from "../config.js";
import { createGraphStore } from "../graph/providerFactory.js";
import { createVectorStore } from "../vector/providerFactory.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.js");
const SMOKE_SOURCE_NAME = "mcp_smoke_test_node";
const SMOKE_TARGET_NAME = "mcp_smoke_test_target";
let createdHitlNoteId = null;
// stdout must carry only MCP protocol messages; anything else breaks strict clients.
const nonJsonLines = [];

const child = spawn(process.execPath, [serverPath], {
	stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
	const id = nextId++;
	const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
	child.stdin.write(`${message}\n`);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject, method });
		setTimeout(() => {
			if (pending.has(id)) {
				pending.delete(id);
				reject(new Error(`Timeout waiting for response to ${method}`));
			}
		}, 30000);
	});
}

child.stdout.on("data", (chunk) => {
	buffer += chunk.toString();
	let newlineIndex;
	while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, newlineIndex).trim();
		buffer = buffer.slice(newlineIndex + 1);
		if (!line) continue;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			console.error("Non-JSON output from server:", line);
			nonJsonLines.push(line);
			continue;
		}
		if (message.id && pending.has(message.id)) {
			const { resolve, reject, method } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) {
				reject(new Error(`${method} failed: ${JSON.stringify(message.error)}`));
			} else {
				resolve(message.result);
			}
		}
	}
});

child.stderr.on("data", (chunk) => {
	console.error("[server stderr]", chunk.toString().trim());
});

child.on("exit", (code) => {
	console.error(`[server exited with code ${code}]`);
});

async function main() {
	try {
		const init = await send("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "mindmesh-smoke-test", version: "0.1.0" },
		});
		console.log("initialize OK:", init.serverInfo.name, init.serverInfo.version);
		console.log("capabilities:", JSON.stringify(init.capabilities));
		
		const tools = await send("tools/list");
		console.log("tools/list OK:", tools.tools.map((t) => t.name).join(", "));
		
		const resources = await send("resources/list");
		console.log("resources/list OK:", resources.resources.map((r) => r.uri).join(", "));
		
		async function callTool(name, args) {
			const result = await send("tools/call", { name, arguments: args });
			if (result.isError) {
				throw new Error(`${name} returned error: ${result.content?.[0]?.text ?? "no message"}`);
			}
			return JSON.parse(result.content?.[0]?.text ?? "{}");
		}

		const contextParsed = await callTool("search_context", { query: "What does the EKYC screen use?" });
		console.log("search_context OK: context length =", contextParsed.context?.length ?? 0, "entryNodes =", contextParsed.entryNodes?.length ?? 0);

		const schemaParsed = await callTool("get_schema", {});
		console.log("get_schema OK: node types =", schemaParsed.nodeTypes?.length ?? 0, "totals =", JSON.stringify(schemaParsed.totals));

		const ingestParsed = await callTool("get_ingest_prompt", { text: "EKYC Screen uses PAN Verification API." });
		console.log("get_ingest_prompt OK: extractionSystemPrompt length =", ingestParsed.extractionSystemPrompt?.length ?? 0);
		console.log("get_ingest_prompt OK: retrievedNodes =", ingestParsed.retrievedNodes?.length ?? 0, "ingestionMode =", ingestParsed.ingestionMode);

		const schemaResult = await send("resources/read", { uri: "mindmesh://schema" });
		console.log("resources/read schema OK: text length =", schemaResult.contents?.[0]?.text?.length ?? 0);
		
		// submit_ingest uses throwaway nodes only; cleanUp() removes whatever it created
		// (graph data in auto mode, a pending HITL proposal in hitl mode).
		const applyResult = await send("tools/call", {
			name: "submit_ingest",
			arguments: {
				records: [
					"<start#$#$>",
					`NODE_CREATE|${SMOKE_SOURCE_NAME}|MCP Smoke Test Node|screen|A node created by the MCP smoke test.|`,
					`NODE_CREATE|${SMOKE_TARGET_NAME}|MCP Smoke Test Target|screen|A node created by the MCP smoke test.|`,
					`RELATION_CREATE|${SMOKE_SOURCE_NAME}|${SMOKE_TARGET_NAME}|uses|created for smoke test|`,
					"</end#$#$>",
				].join("\n"),
				text: "MCP smoke test node uses the MCP smoke test target.",
				author: "mcp-smoke-test",
				source: "mcp-smoke-test",
			},
		});
		if (applyResult.isError) {
			throw new Error(`submit_ingest returned error: ${applyResult.content?.[0]?.text ?? "no message"}`);
		}
		const applyParsed = JSON.parse(applyResult.content?.[0]?.text ?? "{}");
		createdHitlNoteId = applyParsed.id ?? null;
		console.log("submit_ingest OK: status =", applyParsed.status, "applied =", applyParsed.applied, "ref =", applyParsed.ref);
		console.log("submit_ingest OK: counts =", JSON.stringify(applyParsed.counts));

		if (applyParsed.applied) {
			const nodeResult = await send("resources/read", { uri: `mindmesh://nodes/node:${SMOKE_SOURCE_NAME}` });
			console.log("resources/read node OK: text length =", nodeResult.contents?.[0]?.text?.length ?? 0);
		} else {
			console.log("resources/read node skipped: records were stored as a HITL proposal, not applied.");
		}

		if (nonJsonLines.length > 0) {
			throw new Error(`the server wrote ${nonJsonLines.length} non-protocol line(s) to stdout`);
		}
		console.log("stdout OK: only MCP protocol messages");
		console.log("\nALL SMOKE TESTS PASSED");
	} catch (error) {
		console.error("\nSMOKE TEST FAILED:", error.message);
		process.exitCode = 1;
	} finally {
		child.kill();
		try {
			await cleanUp();
		} catch (error) {
			console.error("Smoke test cleanup failed:", error.message);
			process.exitCode = 1;
		}
		setTimeout(() => process.exit(process.exitCode ?? 0), 200);
	}
}

async function cleanUp() {
	const config = getConfig();
	const graphStore = createGraphStore(config);
	const vectorStore = createVectorStore(config);

	try {
		if (createdHitlNoteId) {
			await vectorStore.deleteHitlNotes([createdHitlNoteId]);
		}

		const nodeIds = [`node:${SMOKE_SOURCE_NAME}`, `node:${SMOKE_TARGET_NAME}`];
		const relationIds = [];
		for (const nodeId of nodeIds) {
			const result = await graphStore.deleteNode(nodeId);
			relationIds.push(...(result.relationIds ?? []));
		}
		await vectorStore.deleteNodes(nodeIds);
		if (relationIds.length > 0) {
			await vectorStore.deleteRelations(relationIds);
		}
		console.log(`cleanup OK: removed smoke test nodes${createdHitlNoteId ? " and HITL proposal" : ""}.`);
	} finally {
		await graphStore.close();
	}
}

main();