import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "server.js");

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
		
		const askResult = await send("tools/call", {
			name: "ask",
			arguments: { query: "What does the EKYC screen use?" },
		});
		if (askResult.isError) {
			throw new Error(`ask tool returned error: ${askResult.content?.[0]?.text ?? "no message"}`);
		}
		const askText = askResult.content?.[0]?.text ?? "";
		const askParsed = JSON.parse(askText);
		console.log("ask OK: context length =", askParsed.context?.length ?? 0);
		console.log("ask OK: systemPrompt length =", askParsed.systemPrompt?.length ?? 0);
		console.log("ask OK: instructions length =", askParsed.instructions?.length ?? 0);
		console.log("ask OK: entryNodes =", askParsed.entryNodes?.length ?? 0);
		console.log("ask OK: graph nodes =", askParsed.graph?.nodes?.length ?? 0, "relations =", askParsed.graph?.relations?.length ?? 0);
		
		const ingestResult = await send("tools/call", {
			name: "ingest-context",
			arguments: { text: "EKYC Screen uses PAN Verification API." },
		});
		const ingestText = ingestResult.content?.[0]?.text ?? "";
		const ingestParsed = JSON.parse(ingestText);
		console.log("ingest-context OK: context length =", ingestParsed.context?.length ?? 0);
		console.log("ingest-context OK: extractionSystemPrompt length =", ingestParsed.extractionSystemPrompt?.length ?? 0);
		console.log("ingest-context OK: schemaCatalog length =", ingestParsed.schemaCatalog?.length ?? 0);
		console.log("ingest-context OK: fieldGuidance length =", ingestParsed.fieldGuidance?.length ?? 0);
		console.log("ingest-context OK: ingestionMode =", ingestParsed.ingestionMode);
		
		const schemaResult = await send("resources/read", { uri: "mindmesh://schema" });
		console.log("resources/read schema OK: text length =", schemaResult.contents?.[0]?.text?.length ?? 0);
		
		// Test apply-ingestion with a schema-valid record (auto mode should apply directly).
		const applyResult = await send("tools/call", {
			name: "apply-ingestion",
			arguments: {
				graphRecords: [
					"<start#$#$>",
					"NODE_CREATE|mcp_smoke_test_node|MCP Smoke Test Node|screen|A node created by the MCP smoke test.|",
					"RELATION_CREATE|mcp_smoke_test_node|ckyc_search_screen|uses|created for smoke test|",
					"</end#$#$>",
				].join("\n"),
				text: "MCP smoke test node uses the CKYC search screen.",
				userName: "mcp-smoke-test",
				source: "mcp-smoke-test",
			},
		});
		if (applyResult.isError) {
			throw new Error(`apply-ingestion returned error: ${applyResult.content?.[0]?.text ?? "no message"}`);
		}
		const applyParsed = JSON.parse(applyResult.content?.[0]?.text ?? "{}");
		console.log("apply-ingestion OK: status =", applyParsed.status, "applied =", applyParsed.applied);
		console.log("apply-ingestion OK: nodes =", applyParsed.nodes?.length ?? 0, "relations =", applyParsed.relations?.length ?? 0);
		
		// Test the templated node resource using a node that should exist.
		const nodeResult = await send("resources/read", { uri: "mindmesh://nodes/node:ckyc_search_screen" });
		console.log("resources/read node OK: text length =", nodeResult.contents?.[0]?.text?.length ?? 0);
		
		console.log("\nALL SMOKE TESTS PASSED");
	} catch (error) {
		console.error("\nSMOKE TEST FAILED:", error.message);
		process.exitCode = 1;
	} finally {
		child.kill();
		setTimeout(() => process.exit(process.exitCode ?? 0), 200);
	}
}

main();