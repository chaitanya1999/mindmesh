// Hard rule: every graph write goes through GraphWriteService, so Neo4j and Chroma stay in step and every
// write passes the same checks. This test fails if any other source file calls a store write method.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// Stores are always referenced as `...Store` (graphStore, vectorStore, this.graphStore, ...); GraphWriteService
// has methods with the same names, so only calls on a store object count.
const WRITE_CALL = /[sS]tore\.(applyGraph|upsertNode|deleteNode|upsertRelation|deleteRelation|upsertGraphIndex|deleteNodes|deleteRelations|deleteRelationsForNodes|clearGraphIndex|deleteAllKnowledge|deleteCollections)\(/g;

// Files allowed to write directly, each with the reason.
const ALLOWED = new Map([
	["src/graph/graphWriteService.js", "the gate itself"],
	["src/graph/neo4jGraphStore.js", "the Neo4j store implementation"],
	["src/vector/chromaVectorStore.js", "the Chroma store implementation"],
	["src/cli/clearChroma.js", "maintenance command that wipes Chroma collections"],
	["src/mcp/smokeTest.js", "removes its own throwaway smoke-test nodes"],
	["src/cli/testParser.js", "unit tests that call fake stores"],
]);

function sourceFiles(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			return entry.name === "public" ? [] : sourceFiles(fullPath);
		}
		return entry.name.endsWith(".js") ? [fullPath] : [];
	});
}

describe("graph write gate", () => {
	it("only GraphWriteService (and the listed exceptions) call store write methods", () => {
		const offenders = [];
		for (const file of sourceFiles(SRC)) {
			const relative = path.relative(ROOT, file).split(path.sep).join("/");
			if (ALLOWED.has(relative)) {
				continue;
			}
			const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
			lines.forEach((line, index) => {
				for (const match of line.matchAll(WRITE_CALL)) {
					offenders.push(`${relative}:${index + 1} calls .${match[1]}()`);
				}
			});
		}

		assert.deepEqual(offenders, [], `Graph writes must go through GraphWriteService:\n${offenders.join("\n")}`);
	});
});
