// In-memory stand-ins for Neo4j and the Chroma client, so tests run without databases.
// MemoryGraphStore follows Neo4jGraphStore's rules; FakeChromaClient sits under the real ChromaVectorStore,
// so its document format, HITL listing and metadata deletes are tested as they are.
import { ChromaVectorStore } from "../../src/vector/chromaVectorStore.js";

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function clone(value) {
	return structuredClone(value);
}

export class MemoryGraphStore {
	constructor() {
		this.reset();
	}

	reset() {
		this.nodes = new Map();
		this.relations = new Map();
		this.clock = 0;
	}

	now() {
		this.clock += 1;
		return new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock)).toISOString();
	}

	// Test setup helper: write nodes and relations directly, bypassing every check.
	seed({ nodes = [], relations = [] } = {}) {
		for (const node of nodes) {
			const now = this.now();
			this.nodes.set(node.id, { description: "", createdAt: now, updatedAt: now, ...node });
		}
		for (const relation of relations) {
			const now = this.now();
			this.relations.set(relation.id, { information: "", description: "", createdAt: now, updatedAt: now, ...relation });
		}
	}

	async getExistingNodeIds(nodeIds) {
		return [...new Set(nodeIds)].filter((id) => this.nodes.has(id));
	}

	// One "transaction": work on copies and swap them in only if everything succeeds.
	async applyGraph(payload) {
		const nodes = new Map(this.nodes);
		const relations = new Map(this.relations);
		const storedNodes = [];
		const storedRelations = [];
		const deletedNodeIds = new Set();
		const deletedRelationIds = new Set();
		const now = this.now();

		for (const relationDelete of payload.relationDeletes ?? []) {
			relations.delete(relationDelete.id);
			deletedRelationIds.add(relationDelete.id);
		}
		for (const nodeDelete of payload.nodeDeletes ?? []) {
			nodes.delete(nodeDelete.id);
			deletedNodeIds.add(nodeDelete.id);
			for (const [id, relation] of relations) {
				if (relation.sourceId === nodeDelete.id || relation.targetId === nodeDelete.id) {
					relations.delete(id);
					deletedRelationIds.add(id);
				}
			}
		}
		for (const node of payload.nodes ?? []) {
			const existing = nodes.get(node.id);
			const description = String(node.description ?? "").trim();
			const stored = {
				id: node.id,
				label: node.label,
				name: node.name,
				type: node.type,
				description: description || existing?.description || "",
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			nodes.set(node.id, stored);
			storedNodes.push(clone(stored));
		}
		for (const relation of payload.relations ?? []) {
			if (!nodes.has(relation.sourceId) || !nodes.has(relation.targetId)) {
				throw httpError(`Relation ${relation.sourceId} -> ${relation.targetId} was not stored: an endpoint node does not exist.`, 409);
			}
			const existing = relations.get(relation.id);
			const information = String(relation.information ?? "").trim();
			const description = String(relation.description ?? "").trim();
			const stored = {
				id: relation.id,
				sourceId: relation.sourceId,
				targetId: relation.targetId,
				relation: relation.relation,
				information: information || existing?.information || "",
				description: description || existing?.description || "",
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};
			relations.set(relation.id, stored);
			storedRelations.push(clone(stored));
		}

		this.nodes = nodes;
		this.relations = relations;
		return {
			nodes: storedNodes,
			relations: storedRelations,
			deletedNodeIds: [...deletedNodeIds],
			deletedRelationIds: [...deletedRelationIds],
		};
	}

	async expandFromNodes(nodeIds, depth) {
		const found = new Set(nodeIds.filter((id) => this.nodes.has(id)));
		let frontier = [...found];
		const relationIds = new Set();
		for (let level = 0; level < depth; level += 1) {
			const next = [];
			for (const relation of this.relations.values()) {
				for (const [from, to] of [[relation.sourceId, relation.targetId], [relation.targetId, relation.sourceId]]) {
					if (frontier.includes(from)) {
						relationIds.add(relation.id);
						if (!found.has(to)) {
							found.add(to);
							next.push(to);
						}
					}
				}
			}
			frontier = next;
		}

		return {
			nodes: [...found].map((id) => clone(this.nodes.get(id))),
			relations: [...relationIds].map((id) => clone(this.relations.get(id))),
		};
	}

	async getGraphPreview(limit = 150) {
		const nodes = [...this.nodes.values()].slice(0, limit);
		const ids = new Set(nodes.map((node) => node.id));
		return {
			nodes: clone(nodes),
			relations: clone([...this.relations.values()].filter((relation) => ids.has(relation.sourceId) && ids.has(relation.targetId))),
		};
	}

	async getGraphSnapshot(limit = 5000) {
		return this.getGraphPreview(limit);
	}

	async getRandomNode() {
		return clone([...this.nodes.values()][0] ?? null);
	}

	async searchNodes(query, limit = 20) {
		const text = String(query ?? "").toLowerCase();
		return clone([...this.nodes.values()]
			.filter((node) => [node.id, node.label, node.name, node.type, node.description].some((value) => String(value ?? "").toLowerCase().includes(text)))
			.slice(0, limit));
	}

	async getNode(nodeId) {
		return clone(this.nodes.get(nodeId) ?? null);
	}

	async getNodeNeighborhood(nodeId, depth = 1) {
		return this.expandFromNodes([nodeId], depth);
	}

	async getRelationsForNode(nodeId) {
		return clone([...this.relations.values()].filter((relation) => relation.sourceId === nodeId || relation.targetId === nodeId));
	}

	async getRelation(relationId) {
		return clone(this.relations.get(relationId) ?? null);
	}

	async upsertNode(node) {
		const existing = this.nodes.get(node.id);
		const now = this.now();
		const stored = {
			id: node.id,
			label: String(node.label ?? "").trim(),
			name: String(node.name ?? "").trim(),
			type: String(node.type ?? "").trim(),
			description: String(node.description ?? "").trim(),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.nodes.set(node.id, stored);
		return clone(stored);
	}

	async deleteNode(nodeId) {
		const relationIds = [];
		for (const [id, relation] of this.relations) {
			if (relation.sourceId === nodeId || relation.targetId === nodeId) {
				this.relations.delete(id);
				relationIds.push(id);
			}
		}
		this.nodes.delete(nodeId);
		return { nodeId, relationIds };
	}

	async upsertRelation(relation, { replaceId = "" } = {}) {
		if (!this.nodes.has(relation.sourceId) || !this.nodes.has(relation.targetId)) {
			throw httpError("Source or target node was not found.", 404);
		}
		const replaced = [relation.id, replaceId].filter(Boolean).map((id) => this.relations.get(id)).filter(Boolean);
		const createdAt = replaced.map((item) => item.createdAt).sort()[0] ?? this.now();
		for (const item of replaced) {
			this.relations.delete(item.id);
		}
		const stored = {
			id: relation.id,
			sourceId: relation.sourceId,
			targetId: relation.targetId,
			relation: String(relation.relation ?? "").trim(),
			information: String(relation.information ?? "").trim(),
			description: String(relation.description ?? "").trim(),
			createdAt,
			updatedAt: this.now(),
		};
		this.relations.set(relation.id, stored);
		return clone(stored);
	}

	async deleteRelation(relationId) {
		if (!this.relations.has(relationId)) {
			throw httpError("Relation was not found.", 404);
		}
		this.relations.delete(relationId);
		return { relationId };
	}

	async close() {}
}

function matchesWhere(metadata, where) {
	if (!where) {
		return true;
	}
	return Object.entries(where).every(([key, condition]) => {
		if (key === "$or") {
			return condition.some((part) => matchesWhere(metadata, part));
		}
		if (key === "$and") {
			return condition.every((part) => matchesWhere(metadata, part));
		}
		if (condition && typeof condition === "object" && "$in" in condition) {
			return condition.$in.includes(metadata?.[key]);
		}
		return metadata?.[key] === condition;
	});
}

class FakeChromaCollection {
	constructor(name, client) {
		this.name = name;
		this.client = client;
		this.records = new Map();
	}

	failIfAsked(operation) {
		const failure = this.client.failures[`${this.name}:${operation}`];
		if (failure) {
			throw new Error(failure);
		}
	}

	async upsert({ ids, documents = [], metadatas = [] }) {
		this.failIfAsked("upsert");
		ids.forEach((id, index) => {
			this.records.set(id, { id, document: documents[index] ?? "", metadata: clone(metadatas[index] ?? {}) });
		});
	}

	async add(args) {
		await this.upsert(args);
	}

	async get({ ids, where, limit, offset = 0, include } = {}) {
		let records = [...this.records.values()];
		if (ids) {
			records = ids.map((id) => this.records.get(id)).filter(Boolean);
		}
		records = records.filter((record) => matchesWhere(record.metadata, where)).slice(offset, limit ? offset + limit : undefined);
		const wants = (field) => !include || include.includes(field);
		return {
			ids: records.map((record) => record.id),
			documents: wants("documents") ? records.map((record) => record.document) : undefined,
			metadatas: wants("metadatas") ? records.map((record) => clone(record.metadata)) : undefined,
		};
	}

	async delete({ ids, where } = {}) {
		this.failIfAsked("delete");
		for (const record of [...this.records.values()]) {
			if ((ids && ids.includes(record.id)) || (!ids && matchesWhere(record.metadata, where))) {
				this.records.delete(record.id);
			}
		}
	}

	// Similarity is not modelled: matching records come back in insertion order.
	async query({ nResults = 10, where } = {}) {
		const records = [...this.records.values()].filter((record) => matchesWhere(record.metadata, where)).slice(0, nResults);
		return {
			ids: [records.map((record) => record.id)],
			documents: [records.map((record) => record.document)],
			metadatas: [records.map((record) => clone(record.metadata))],
			distances: [records.map(() => 0)],
		};
	}

	async count() {
		return this.records.size;
	}
}

class FakeChromaClient {
	constructor() {
		this.collections = new Map();
		this.failures = {};
	}

	async getOrCreateCollection({ name }) {
		if (!this.collections.has(name)) {
			this.collections.set(name, new FakeChromaCollection(name, this));
		}
		return this.collections.get(name);
	}

	async deleteCollection({ name }) {
		this.collections.delete(name);
	}

	async heartbeat() {}

	async listCollections() {
		return [...this.collections.keys()];
	}
}

export const TEST_CHROMA_CONFIG = {
	path: "http://localhost:1",
	nodeCollection: "test_nodes",
	relationCollection: "test_relations",
	hitlCollection: "test_hitl",
};

// The real ChromaVectorStore over the fake client. `failNext(collection, operation, message)` makes that
// operation throw until `clearFailures()`; `ids(collection)` lists stored record ids.
export function createMemoryVectorStore() {
	const store = new ChromaVectorStore(TEST_CHROMA_CONFIG);
	const client = new FakeChromaClient();
	store.client = client;
	store.reset = () => {
		client.collections.clear();
		client.failures = {};
	};
	store.failNext = (collection, operation, message) => {
		client.failures[`${collection}:${operation}`] = message;
	};
	store.clearFailures = () => {
		client.failures = {};
	};
	store.ids = (collection) => [...(client.collections.get(collection)?.records.keys() ?? [])];
	return store;
}
