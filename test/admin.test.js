// Admin panel: authentication, password re-entry for destructive actions, and each admin feature, over the
// real web app with in-memory stores.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { AdminSessions, hashPassword, verifyPassword } from "../src/admin/adminAuth.js";
import { createApp } from "../src/server/server.js";
import { createTestServices, node, records, relation } from "./helpers/testServices.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PASSWORD = "correct horse battery";
const services = createTestServices({ mode: "hitl", adminPassword: PASSWORD });
const auditFile = path.join(services.directory, "admin-audit.log");

// An HTTP client that keeps the admin session cookie, like a browser.
async function startAdminHttp(app) {
	const server = await new Promise((resolve) => {
		const listening = app.listen(0, () => resolve(listening));
	});
	const baseUrl = `http://127.0.0.1:${server.address().port}`;
	let cookie = "";
	async function request(method, url, body) {
		const response = await fetch(baseUrl + url, {
			method,
			headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const setCookie = response.headers.get("set-cookie");
		if (setCookie) {
			cookie = setCookie.split(";")[0];
		}
		return { status: response.status, headers: response.headers, setCookie, body: await response.json().catch(() => null) };
	}
	return {
		get: (url) => request("GET", url),
		post: (url, body) => request("POST", url, body ?? {}),
		login: (password = PASSWORD) => request("POST", "/api/admin/login", { password }),
		forgetCookie: () => {
			cookie = "";
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

async function seedGraph({ nodes = [], relations = [] }) {
	services.graphStore.seed({ nodes, relations });
	await services.vectorStore.upsertGraphIndex({ nodes, relations });
}

async function propose(text, ...lines) {
	return services.hitlService.submitRecords({ graphRecords: records(...lines), text, userName: "author", source: "mcp" });
}

let http;
before(async () => {
	http = await startAdminHttp(createApp(services));
});
after(async () => {
	await http.close();
	services.cleanUp();
});
beforeEach(async () => {
	services.reset();
	await http.login();
});

describe("admin password hashing", () => {
	it("stores a salted scrypt hash and verifies only the right password", () => {
		const first = hashPassword(PASSWORD);
		const second = hashPassword(PASSWORD);
		assert.match(first, /^scrypt\$16384\$8\$1\$/);
		assert.notEqual(first, second, "salted");
		assert.equal(verifyPassword(PASSWORD, first), true);
		assert.equal(verifyPassword("wrong password!", first), false);
		assert.equal(verifyPassword(PASSWORD, "not-a-hash"), false);
		assert.throws(() => hashPassword("short"), /at least 10 characters/);
	});

	it("kg:admin:password writes only the hash into config.json, keeping placeholders and CRLF", () => {
		const configPath = path.join(services.directory, "config.cli.json");
		fs.writeFileSync(configPath, "{\r\n\t\"llm\": {\r\n\t\t\"apiKey\": \"{{API_KEY}}\"\r\n\t}\r\n}\r\n");

		const run = spawnSync(process.execPath, [path.join(ROOT, "src/cli/adminPassword.js"), "--stdin", "--config", configPath], { input: `${PASSWORD}\n`, encoding: "utf8" });

		assert.equal(run.status, 0, run.stderr);
		const raw = fs.readFileSync(configPath, "utf8");
		assert.ok(!raw.includes(PASSWORD), "the plain password is not stored");
		assert.ok(raw.includes("\"{{API_KEY}}\"") && raw.includes("\r\n"), "placeholders and line endings kept");
		assert.equal(verifyPassword(PASSWORD, JSON.parse(raw).admin.passwordHash), true);

		const tooShort = spawnSync(process.execPath, [path.join(ROOT, "src/cli/adminPassword.js"), "--stdin", "--config", configPath], { input: "short\n", encoding: "utf8" });
		assert.notEqual(tooShort.status, 0);
		assert.equal(verifyPassword(PASSWORD, JSON.parse(fs.readFileSync(configPath, "utf8")).admin.passwordHash), true, "a rejected password leaves the old hash");
	});

	it("kg:admin:password keeps spaces in the password and the file's indentation", () => {
		const configPath = path.join(services.directory, "config.spaces.json");
		fs.writeFileSync(configPath, "{\n  \"llm\": {\n    \"provider\": \"hub\"\n  }\n}\n");
		const spaced = `  ${PASSWORD}  `;

		const run = spawnSync(process.execPath, [path.join(ROOT, "src/cli/adminPassword.js"), "--stdin", "--config", configPath], { input: `${spaced}\r\n`, encoding: "utf8" });

		assert.equal(run.status, 0, run.stderr);
		const raw = fs.readFileSync(configPath, "utf8");
		assert.ok(raw.startsWith("{\n  \"llm\": {\n    \"provider\""), "two-space indentation kept");
		const hash = JSON.parse(raw).admin.passwordHash;
		assert.equal(verifyPassword(spaced, hash), true, "the password is stored exactly as typed");
		assert.equal(verifyPassword(PASSWORD, hash), false);
	});
});

describe("admin access", () => {
	it("needs a session for everything but status and login", async () => {
		http.forgetCookie();
		assert.deepEqual((await http.get("/api/admin/status")).body, { configured: true, authenticated: false });
		assert.equal((await http.get("/api/admin/overview")).status, 401);
		assert.equal((await http.post("/api/admin/query/cypher", { cypher: "RETURN 1" })).status, 401);
		assert.equal((await http.post("/api/admin/reindex", {})).status, 401);
		assert.equal((await http.post("/api/admin/consistency/repair", {})).status, 401);
	});

	it("logs in with the password and sets an HttpOnly, SameSite=Strict cookie scoped to the admin API", async () => {
		http.forgetCookie();
		assert.equal((await http.login("wrong password!!")).status, 401);

		const login = await http.login();
		assert.equal(login.status, 200);
		assert.match(login.setCookie, /HttpOnly/);
		assert.match(login.setCookie, /SameSite=Strict/);
		assert.match(login.setCookie, /Path=\/api\/admin/);
		assert.equal((await http.get("/api/admin/status")).body.authenticated, true);
		assert.equal((await http.get("/api/admin/overview")).status, 200);
	});

	it("logout ends the session", async () => {
		await http.post("/api/admin/logout");
		assert.equal((await http.get("/api/admin/overview")).status, 401);
	});

	it("locks an address out after repeated wrong passwords", async () => {
		const lockedApp = await startAdminHttp(createApp({ ...services, adminRouteOptions: { sessions: new AdminSessions({ maxFailures: 3 }) } }));
		try {
			for (let attempt = 0; attempt < 3; attempt += 1) {
				assert.equal((await lockedApp.login("wrong password!!")).status, 401);
			}
			const blocked = await lockedApp.login();
			assert.equal(blocked.status, 429, "even the right password is refused during the lockout");
			assert.match(blocked.body.error, /Too many wrong passwords/);
		} finally {
			await lockedApp.close();
		}
	});

	it("expires sessions", async () => {
		let now = 0;
		const sessions = new AdminSessions({ sessionMinutes: 30, now: () => now });
		const { token } = sessions.create();
		assert.equal(sessions.isValid(token), true);
		now += 31 * 60 * 1000;
		assert.equal(sessions.isValid(token), false);
	});

	it("is disabled until a password is set", async () => {
		const unconfigured = createTestServices({ mode: "hitl" });
		const plain = await startAdminHttp(createApp(unconfigured));
		try {
			assert.deepEqual((await plain.get("/api/admin/status")).body, { configured: false, authenticated: false });
			const login = await plain.login();
			assert.equal(login.status, 503);
			assert.match(login.body.error, /kg:admin:password/);
		} finally {
			await plain.close();
			unconfigured.cleanUp();
		}
	});
});

describe("admin overview", () => {
	it("reports Neo4j counts, Chroma collections with roles, pending proposals, and schema health", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen"), node("b_api", "api"), node("w", "gadget")], relations: [relation("a_screen", "uses", "b_api")] });
		await propose("something new", "NODE_CREATE|c_screen|C|screen|||");
		await (await services.vectorStore.client.getOrCreateCollection({ name: "old_smoke_leftover" })).upsert({ ids: ["x"], documents: ["x"] });

		const { body } = await http.get("/api/admin/overview");

		assert.deepEqual(body.neo4j.totals, { nodes: 3, relations: 1 });
		assert.ok(body.neo4j.nodeTypes.some((row) => row.type === "screen" && row.count === 1));
		const roles = Object.fromEntries(body.chroma.collections.map((collection) => [collection.name, collection.role]));
		assert.equal(roles.test_nodes, "nodes");
		assert.equal(roles.test_hitl, "proposals");
		assert.equal(roles.old_smoke_leftover, "other");
		assert.equal(body.proposals.pending, 1);
		assert.deepEqual(body.schemaHealth.unapprovedTypesInGraph.nodeTypes, [{ type: "gadget", count: 1 }]);
		assert.ok(body.schemaHealth.unusedNodeTypes.includes("person"));
		assert.equal(body.runtime.ingestMode, "hitl");
	});
});

describe("admin destructive actions", () => {
	beforeEach(async () => {
		await seedGraph({ nodes: [node("a_screen", "screen"), node("b_api", "api")], relations: [relation("a_screen", "uses", "b_api")] });
		await propose("keep me", "NODE_CREATE|c_screen|C|screen|||");
	});

	it("refuse without the password, with a wrong password, or without the confirmation word", async () => {
		assert.equal((await http.post("/api/admin/wipe", { target: "graph", confirm: "DELETE" })).status, 401);
		assert.equal((await http.post("/api/admin/wipe", { target: "graph", confirm: "DELETE", password: "wrong password!!" })).status, 401);
		const noWord = await http.post("/api/admin/wipe", { target: "graph", password: PASSWORD, confirm: "delete" });
		assert.equal(noWord.status, 400);
		assert.match(noWord.body.error, /Type DELETE/);
		assert.equal(services.graphStore.nodes.size, 2, "nothing was deleted");
	});

	it("wipe graph deletes graph data and its vectors, keeping proposals", async () => {
		const result = await http.post("/api/admin/wipe", { target: "graph", password: PASSWORD, confirm: "DELETE" });

		assert.equal(result.status, 200);
		assert.equal(result.body.graph.deletedNodes, 2);
		assert.equal(services.graphStore.nodes.size, 0);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), []);
		assert.equal((await services.hitlService.listProposals({ limit: 5 })).total, 1);
	});

	it("wipe proposals deletes only the proposal collection", async () => {
		await http.post("/api/admin/wipe", { target: "proposals", password: PASSWORD, confirm: "DELETE" });

		assert.equal((await services.hitlService.listProposals({ limit: 5 })).total, 0);
		assert.equal(services.graphStore.nodes.size, 2);
	});

	it("wipe vectors keeps the graph; reindex rebuilds the vectors from it", async () => {
		await http.post("/api/admin/wipe", { target: "vectors", password: PASSWORD, confirm: "DELETE" });
		assert.equal(services.graphStore.nodes.size, 2);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), []);

		// Reindex only rebuilds derived vectors: the session is enough, and it is still audited.
		const reindex = await http.post("/api/admin/reindex", {});

		assert.equal(reindex.body.nodes, 2);
		assert.deepEqual(services.vectorStore.ids("test_nodes").sort(), ["node:a_screen", "node:b_api"]);
		assert.equal(services.vectorStore.ids("test_relations").length, 1);
		const entries = (await http.get("/api/admin/audit")).body.entries;
		assert.ok(entries.some((entry) => entry.action === "reindex_vectors" && entry.ok === true));
	});

	it("wipe all deletes graph, vectors, and proposals; unknown targets are refused", async () => {
		assert.equal((await http.post("/api/admin/wipe", { target: "everything", password: PASSWORD, confirm: "DELETE" })).status, 400);

		await http.post("/api/admin/wipe", { target: "all", password: PASSWORD, confirm: "DELETE" });

		assert.equal(services.graphStore.nodes.size, 0);
		assert.deepEqual(services.vectorStore.ids("test_nodes"), []);
		assert.equal((await services.hitlService.listProposals({ limit: 5 })).total, 0);
	});
});

describe("admin maintenance", () => {
	it("consistency finds records without vectors and vectors without records; repair fixes both", async () => {
		services.graphStore.seed({ nodes: [node("no_vector", "screen")] });
		await services.vectorStore.upsertGraphIndex({ nodes: [node("ghost", "screen")], relations: [] });

		const report = (await http.get("/api/admin/consistency")).body;
		assert.equal(report.inSync, false);
		assert.deepEqual(report.nodesWithoutVector.sample, ["node:no_vector"]);
		assert.deepEqual(report.vectorsWithoutNode.sample, ["node:ghost"]);

		const repaired = await http.post("/api/admin/consistency/repair", {});

		assert.equal(repaired.body.indexedNodes, 1);
		assert.equal(repaired.body.deletedNodeVectors, 1);
		assert.equal(repaired.body.inSync, true);
		assert.equal((await http.get("/api/admin/consistency")).body.inSync, true);
	});

	it("backup downloads the graph and every pending proposal", async () => {
		await seedGraph({ nodes: [node("a_screen", "screen")] });
		await propose("pending input", "NODE_CREATE|c_screen|C|screen|||");

		const backup = await http.get("/api/admin/backup");

		assert.match(backup.headers.get("content-disposition"), /attachment; filename="mindmesh-backup-.*\.json"/);
		assert.equal(backup.body.format, "mindmesh-backup");
		assert.deepEqual(backup.body.graph.nodes.map((item) => item.id), ["node:a_screen"]);
		assert.equal(backup.body.proposals.length, 1);
		assert.equal(backup.body.proposals[0].userInput, "pending input");
		assert.match(backup.body.proposals[0].llmResponse, /NODE_CREATE\|c_screen/);
	});

	it("query console runs read-only Cypher and vector matches across selected collections", async () => {
		services.graphStore.readQueryHandler = async (cypher) => ({ columns: ["n"], rows: [{ n: cypher.length }], truncated: false });
		await seedGraph({ nodes: [node("a_screen", "screen", "A Screen")] });
		await propose("pending text", "NODE_CREATE|c_screen|C|screen|||");

		const cypher = await http.post("/api/admin/query/cypher", { cypher: "MATCH (n) RETURN count(n)" });
		assert.equal(cypher.body.rows[0].n, "MATCH (n) RETURN count(n)".length);

		const vector = await http.post("/api/admin/query/vector", { query: "screen", collections: ["test_nodes", "test_hitl", "missing_collection"], topK: 3 });
		const byName = Object.fromEntries(vector.body.results.map((result) => [result.collection, result]));
		assert.equal(byName.test_nodes.matches[0].id, "node:a_screen");
		assert.equal(byName.test_nodes.role, "nodes");
		assert.equal(byName.test_hitl.matches.length, 1);
		assert.match(byName.missing_collection.error, /not found/);
		assert.equal((await http.post("/api/admin/query/vector", { query: "screen", collections: [] })).status, 400);
	});

	it("writes an audit log without passwords", async () => {
		await http.login("wrong password!!");
		await http.login();
		await http.post("/api/admin/wipe", { target: "vectors", password: PASSWORD, confirm: "DELETE" });

		const entries = (await http.get("/api/admin/audit")).body.entries;
		assert.ok(entries.some((entry) => entry.action === "wipe" && entry.ok === true && entry.details.target === "vectors"));
		assert.ok(entries.some((entry) => entry.action === "password_rejected"));
		assert.ok(entries.some((entry) => entry.action === "login"));
		assert.ok(!fs.readFileSync(auditFile, "utf8").includes(PASSWORD), "no password in the audit log");
	});
});
