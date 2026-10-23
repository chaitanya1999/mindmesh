import { ChromaClient } from "chromadb";
import { formatScope, parseScope, scopeMatchValues } from "../schema/scope.js";

function nodeDocument(node) {
	return [
		node.label,
		node.name,
		node.type,
		node.description,
	].filter(Boolean).join("\n");
}

function relationDocument(relation) {
	return [
		relation.relation,
		relation.information,
		relation.description,
		`source:${relation.sourceId}`,
		`target:${relation.targetId}`,
	].filter(Boolean).join("\n");
}

// Chroma metadata holds no lists, so a scope is stored as one flag per value (scope_uc: true), plus
// `scoped` (false for unscoped items, which match every filter) and `scope` as text for display.
function scopeMetadata(scope) {
	const values = parseScope(scope);
	return {
		scope: formatScope(values),
		scoped: values.length > 0,
		...Object.fromEntries(values.map((value) => [`scope_${value}`, true])),
	};
}

function scopeWhere(scope) {
	const values = scopeMatchValues(scope);
	if (values.length === 0) {
		return null;
	}
	return { $or: [...values.map((value) => ({ [`scope_${value}`]: true })), { scoped: false }] };
}

// Chroma needs $and for more than one condition.
function combineWhere(...conditions) {
	const parts = conditions.filter(Boolean);
	if (parts.length === 0) {
		return undefined;
	}
	return parts.length === 1 ? parts[0] : { $and: parts };
}

function previewText(value, maxLength = 240) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function hitlNoteDocument(note) {
	return [
		"Pending HITL ingestion proposal",
		`Status: ${note.status || "pending"}`,
		`User: ${note.userName || "unknown"}`,
		`Source: ${note.source || "unknown"}`,
		`Scope: ${note.scope || "none"}`,
		`Created at: ${note.createdAt || ""}`,
		"",
		"Human input:",
		String(note.userInput ?? "").trim(),
		"",
		"LLM proposed graph mutations:",
		String(note.llmResponse ?? "").trim(),
	].join("\n").trim();
}

function firstMatch(text, pattern, fallback = "") {
	const match = String(text ?? "").match(pattern);
	return match?.[1]?.trim() || fallback;
}

function sectionBetween(text, startMarker, endMarker = "") {
	const raw = String(text ?? "");
	const startIndex = raw.indexOf(startMarker);
	if (startIndex === -1) {
		return "";
	}

	const contentStart = startIndex + startMarker.length;
	const endIndex = endMarker ? raw.indexOf(endMarker, contentStart) : -1;
	return raw.slice(contentStart, endIndex === -1 ? undefined : endIndex).trim();
}

function hitlNoteFromRecord(id, document, metadata = {}) {
	const userInput = sectionBetween(document, "Human input:", "LLM proposed graph mutations:");
	const llmResponse = sectionBetween(document, "LLM proposed graph mutations:");
	const userName = metadata.userName || firstMatch(document, /^User:\s*(.+)$/m, "unknown");
	const createdAt = metadata.createdAt || firstMatch(document, /^Created at:\s*(.+)$/m, "");
	const status = metadata.status || firstMatch(document, /^Status:\s*(.+)$/m, "pending");
	const source = metadata.source || firstMatch(document, /^Source:\s*(.+)$/m, "unknown");

	return {
		id,
		status,
		userName,
		source,
		scope: metadata.scope || "",
		createdAt,
		userInput,
		llmResponse,
		document,
		inputPreview: metadata.inputPreview || previewText(userInput),
		llmPreview: metadata.llmPreview || previewText(llmResponse),
		nodeCount: Number(metadata.nodeCount ?? 0),
		relationCount: Number(metadata.relationCount ?? 0),
		nodeDeleteCount: Number(metadata.nodeDeleteCount ?? 0),
		relationDeleteCount: Number(metadata.relationDeleteCount ?? 0),
		schemaSuggestionCount: Number(metadata.schemaSuggestionCount ?? 0),
		ambiguityCount: Number(metadata.ambiguityCount ?? 0),
		contradictionCount: Number(metadata.contradictionCount ?? 0),
		reviewerNotes: metadata.reviewerNotes || "",
		regenerated: metadata.regenerated === true,
		regeneratedBy: metadata.regeneratedBy || "",
		regeneratedAt: metadata.regeneratedAt || "",
		regenerationOrigin: metadata.regenerationOrigin || "",
		metadata,
	};
}

// Oldest first; ties (or missing createdAt) fall back to the id, which starts with a base36 timestamp.
function compareHitlEntries(left, right) {
	function timestamp(entry) {
		const value = Date.parse(entry.createdAt || "");
		return Number.isFinite(value) ? value : 0;
	}

	return timestamp(left) - timestamp(right)
		|| String(left.id).localeCompare(String(right.id));
}

function uniqueById(records = []) {
	const byId = new Map();

	for (const record of records) {
		if (!record?.id) {
			continue;
		}

		byId.set(record.id, record);
	}

	return [...byId.values()];
}

export class ChromaVectorStore {
	constructor(config, { embeddingProvider = null } = {}) {
		this.config = config;
		this.embeddingProvider = embeddingProvider;
		const url = new URL(config.path);
		this.client = new ChromaClient({
			host: url.hostname,
			port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
			ssl: url.protocol === "https:",
			tenant: config.tenant,
			database: config.database,
		});
	}

	async getNodeCollection() {
		return this.client.getOrCreateCollection({
			name: this.config.nodeCollection,
			embeddingFunction: this.embeddingProvider ? null : undefined,
		});
	}

	async getRelationCollection() {
		return this.client.getOrCreateCollection({
			name: this.config.relationCollection,
			embeddingFunction: this.embeddingProvider ? null : undefined,
		});
	}

	// Deletes the named collections; ones that do not exist are skipped. Returns the names actually deleted.
	async deleteCollections(names) {
		const deleted = [];
		for (const name of names) {
			try {
				await this.client.deleteCollection({ name });
				deleted.push(name);
			} catch (error) {
				const message = String(error?.message ?? "").toLowerCase();
				if (error?.name !== "ChromaNotFoundError" && !message.includes("does not exist") && !message.includes("not found")) {
					throw error;
				}
			}
		}

		return deleted;
	}

	// Drops only the graph index collections (nodes, relations). HITL notes are never touched.
	async clearGraphIndex() {
		return this.deleteCollections([this.config.nodeCollection, this.config.relationCollection]);
	}

	// Drops the HITL proposal collection. Proposals cannot be rebuilt from Neo4j; admin wipe only.
	async clearHitlCollection() {
		return this.deleteCollections([this.config.hitlCollection || "fleeting_notes_hitl"]);
	}

	// What each configured collection is used for, by name.
	collectionRole(name) {
		if (name === this.config.nodeCollection) {
			return "nodes";
		}
		if (name === this.config.relationCollection) {
			return "relations";
		}
		if (name === (this.config.hitlCollection || "fleeting_notes_hitl")) {
			return "proposals";
		}
		return "other";
	}

	// Every collection in the configured tenant and database, with its record count and role.
	async listCollectionsWithCounts() {
		const collections = await this.client.listCollections();
		const rows = [];
		for (const collection of collections) {
			rows.push({ name: collection.name, count: await collection.count(), role: this.collectionRole(collection.name) });
		}
		return rows.sort((left, right) => left.name.localeCompare(right.name));
	}

	// Every id in the node and relation collections (for the admin consistency check).
	async listIndexIds() {
		const nodes = await (await this.getNodeCollection()).get({ include: [] });
		const relations = await (await this.getRelationCollection()).get({ include: [] });
		return { nodeIds: nodes.ids ?? [], relationIds: relations.ids ?? [] };
	}

	// Admin vector match: one query text against several collections. A collection that cannot be queried
	// (missing, or built with a different embedding) reports its error instead of failing the whole match.
	async queryCollections(names, query, topK = 5) {
		const existing = new Set((await this.client.listCollections()).map((collection) => collection.name));
		const queryEmbedding = this.embeddingProvider ? await this.embeddingProvider.embedQuery(query) : null;
		const results = [];
		for (const name of names) {
			if (!existing.has(name)) {
				results.push({ collection: name, error: "Collection not found." });
				continue;
			}
			try {
				const collection = await this.client.getCollection({ name, embeddingFunction: this.embeddingProvider ? null : undefined });
				const response = await collection.query({
					queryTexts: queryEmbedding ? undefined : [query],
					queryEmbeddings: queryEmbedding ? [queryEmbedding] : undefined,
					nResults: topK,
				});
				const ids = response.ids?.[0] ?? [];
				results.push({
					collection: name,
					role: this.collectionRole(name),
					matches: ids.map((id, index) => ({
						id,
						distance: response.distances?.[0]?.[index],
						document: previewText(response.documents?.[0]?.[index] ?? "", 400),
						metadata: response.metadatas?.[0]?.[index] ?? {},
					})),
				});
			} catch (error) {
				results.push({ collection: name, error: error?.message ?? String(error) });
			}
		}
		return results;
	}

	async getHitlCollection() {
		return this.client.getOrCreateCollection({
			name: this.config.hitlCollection || "fleeting_notes_hitl",
			embeddingFunction: this.embeddingProvider ? null : undefined,
		});
	}

	async verifyConnectivity() {
		if (typeof this.client.heartbeat === "function") {
			await this.client.heartbeat();
			return;
		}

		await this.client.listCollections();
	}

	async upsertHitlNote(note) {
		if (!note?.id) {
			throw new Error("HITL note id is required.");
		}

		const collection = await this.getHitlCollection();
		const createdAt = note.createdAt || new Date().toISOString();
		const document = hitlNoteDocument({ ...note, createdAt });
		await collection.upsert({
			ids: [note.id],
			documents: [document],
			embeddings: this.embeddingProvider ? await this.embeddingProvider.embedDocuments([document]) : undefined,
			metadatas: [{
				kind: "hitl_ingestion",
				status: note.status || "pending",
				userName: note.userName || "unknown",
				source: note.source || "unknown",
				scope: String(note.scope ?? ""),
				createdAt,
				inputPreview: previewText(note.userInput),
				llmPreview: previewText(note.llmResponse),
				nodeCount: Number(note.nodeCount ?? 0),
				relationCount: Number(note.relationCount ?? 0),
				nodeDeleteCount: Number(note.nodeDeleteCount ?? 0),
				relationDeleteCount: Number(note.relationDeleteCount ?? 0),
				schemaSuggestionCount: Number(note.schemaSuggestionCount ?? 0),
				ambiguityCount: Number(note.ambiguityCount ?? 0),
				contradictionCount: Number(note.contradictionCount ?? 0),
				reviewerNotes: String(note.reviewerNotes ?? ""),
				regenerated: Boolean(note.regenerated),
				regeneratedBy: String(note.regeneratedBy ?? ""),
				regeneratedAt: String(note.regeneratedAt ?? ""),
				regenerationOrigin: String(note.regenerationOrigin ?? ""),
			}],
		});

		return {
			id: note.id,
			collection: this.config.hitlCollection || "fleeting_notes_hitl",
			document,
			metadata: {
				status: note.status || "pending",
				userName: note.userName || "unknown",
				source: note.source || "unknown",
				createdAt,
				ambiguityCount: Number(note.ambiguityCount ?? 0),
				contradictionCount: Number(note.contradictionCount ?? 0),
			},
		};
	}

	// Chroma returns records in no fixed order, so sorting after a `limit` would show an arbitrary subset.
	// Instead: read ids + metadata of every matching note (no documents, so this stays cheap), sort by
	// createdAt, cut the page, then fetch full documents for that page only.
	// `order` is "oldest" (default) or "newest"; `limit` of 0/null returns every matching note.
	async listHitlNotePage({ status = "pending", limit = 100, offset = 0, order = "oldest" } = {}) {
		const collection = await this.getHitlCollection();
		const where = status ? { status } : undefined;
		const index = await collection.get({ where, include: ["metadatas"] });
		const entries = (index.ids ?? []).map((id, position) => ({
			id,
			createdAt: index.metadatas?.[position]?.createdAt || "",
		}));
		entries.sort((left, right) => compareHitlEntries(left, right));
		if (order === "newest") {
			entries.reverse();
		}

		const start = Math.max(0, Number(offset) || 0);
		const pageIds = entries
			.slice(start, limit ? start + Number(limit) : undefined)
			.map((entry) => entry.id);
		if (pageIds.length === 0) {
			return { notes: [], total: entries.length };
		}

		const result = await collection.get({ ids: pageIds });
		const noteById = new Map((result.ids ?? []).map((id, position) => [id, hitlNoteFromRecord(
			id,
			result.documents?.[position] ?? "",
			result.metadatas?.[position] ?? {},
		)]));

		return {
			notes: pageIds.map((id) => noteById.get(id)).filter(Boolean),
			total: entries.length,
		};
	}

	async listHitlNotes(options = {}) {
		return (await this.listHitlNotePage(options)).notes;
	}

	async getHitlNote(id) {
		if (!id) {
			return null;
		}

		const collection = await this.getHitlCollection();
		const result = await collection.get({ ids: [id] });
		const noteId = result.ids?.[0];
		if (!noteId) {
			return null;
		}

		return hitlNoteFromRecord(
			noteId,
			result.documents?.[0] ?? "",
			result.metadatas?.[0] ?? {},
		);
	}

	async deleteHitlNotes(ids) {
		const safeIds = (ids ?? []).filter(Boolean);
		if (safeIds.length === 0) {
			return;
		}

		const collection = await this.getHitlCollection();
		if (typeof collection.delete === "function") {
			await collection.delete({ ids: safeIds });
		}
	}

	// `scope` keeps proposals ingested for that scope, for "common", and without a scope.
	async queryHitlNotes(query, topK, { scope = "" } = {}) {
		const collection = await this.getHitlCollection();
		const scopeValues = scopeMatchValues(scope);
		const results = await collection.query({
			queryTexts: this.embeddingProvider ? undefined : [query],
			queryEmbeddings: this.embeddingProvider ? [await this.embeddingProvider.embedQuery(query)] : undefined,
			nResults: topK,
			where: combineWhere({ status: "pending" }, scopeValues.length > 0 ? { scope: { $in: [...scopeValues, ""] } } : null),
		});

		const ids = results.ids?.[0] ?? [];
		const documents = results.documents?.[0] ?? [];
		const metadatas = results.metadatas?.[0] ?? [];
		const distances = results.distances?.[0] ?? [];

		return ids.map((id, index) => ({
			...hitlNoteFromRecord(
				id,
				documents[index] ?? "",
				metadatas[index] ?? {},
			),
			distance: distances[index],
		}));
	}

	async upsertGraphIndex(graphPayload) {
		const nodeCollection = await this.getNodeCollection();
		const relationCollection = await this.getRelationCollection();
		const nodes = uniqueById(graphPayload.nodes);
		const relations = uniqueById(graphPayload.relations);

		if (nodes.length > 0) {
			const documents = nodes.map(nodeDocument);
			await nodeCollection.upsert({
				ids: nodes.map((node) => node.id),
				documents,
				embeddings: this.embeddingProvider ? await this.embeddingProvider.embedDocuments(documents) : undefined,
				metadatas: nodes.map((node) => ({
					kind: "node",
					label: node.label,
					name: node.name,
					type: node.type,
					description: node.description ?? "",
					...scopeMetadata(node.scope),
				})),
			});
		}

		if (relations.length > 0) {
			const documents = relations.map(relationDocument);
			await relationCollection.upsert({
				ids: relations.map((relation) => relation.id),
				documents,
				embeddings: this.embeddingProvider ? await this.embeddingProvider.embedDocuments(documents) : undefined,
				metadatas: relations.map((relation) => ({
					kind: "relation",
					sourceId: relation.sourceId,
					targetId: relation.targetId,
					relation: relation.relation,
					information: relation.information ?? "",
					description: relation.description ?? "",
					...scopeMetadata(relation.scope),
				})),
			});
		}
	}

	async upsertNode(node) {
		await this.upsertGraphIndex({ nodes: [node], relations: [] });
	}

	async upsertRelation(relation) {
		await this.upsertGraphIndex({ nodes: [], relations: [relation] });
	}

	async deleteNodes(ids) {
		const safeIds = (ids ?? []).filter(Boolean);
		if (safeIds.length === 0) {
			return;
		}

		const collection = await this.getNodeCollection();
		if (typeof collection.delete === "function") {
			await collection.delete({ ids: safeIds });
		}
	}

	async deleteRelations(ids) {
		const safeIds = (ids ?? []).filter(Boolean);
		if (safeIds.length === 0) {
			return;
		}

		const collection = await this.getRelationCollection();
		if (typeof collection.delete === "function") {
			await collection.delete({ ids: safeIds });
		}
	}

	// Removes every relation vector attached to the given nodes, found by the stored sourceId/targetId
	// metadata. Unlike the relation ids Neo4j returns when it deletes a node, this also works on a retry,
	// after the node is already gone from the graph.
	async deleteRelationsForNodes(nodeIds) {
		const safeIds = [...new Set((nodeIds ?? []).filter(Boolean))];
		if (safeIds.length === 0) {
			return;
		}

		const collection = await this.getRelationCollection();
		await collection.delete({
			where: {
				$or: [
					{ sourceId: { $in: safeIds } },
					{ targetId: { $in: safeIds } },
				],
			},
		});
	}

	// `type` limits results to one node type, `scope` to nodes matching a scope filter (vector metadata).
	async queryNodes(query, topK, { type = "", scope = "" } = {}) {
		const collection = await this.getNodeCollection();
		const results = await collection.query({
			queryTexts: this.embeddingProvider ? undefined : [query],
			queryEmbeddings: this.embeddingProvider ? [await this.embeddingProvider.embedQuery(query)] : undefined,
			nResults: topK,
			where: combineWhere(type ? { type } : null, scopeWhere(scope)),
		});

		const ids = results.ids?.[0] ?? [];
		const documents = results.documents?.[0] ?? [];
		const metadatas = results.metadatas?.[0] ?? [];
		const distances = results.distances?.[0] ?? [];

		return ids.map((id, index) => ({
			id,
			document: documents[index],
			metadata: metadatas[index] ?? {},
			distance: distances[index],
		}));
	}

	// `relation` limits results to one relation type, `scope` to relations matching a scope filter.
	async queryRelations(query, topK, { relation = "", scope = "" } = {}) {
		const collection = await this.getRelationCollection();
		const results = await collection.query({
			queryTexts: this.embeddingProvider ? undefined : [query],
			queryEmbeddings: this.embeddingProvider ? [await this.embeddingProvider.embedQuery(query)] : undefined,
			nResults: topK,
			where: combineWhere(relation ? { relation } : null, scopeWhere(scope)),
		});

		const ids = results.ids?.[0] ?? [];
		const metadatas = results.metadatas?.[0] ?? [];
		const distances = results.distances?.[0] ?? [];

		return ids.map((id, index) => ({
			id,
			metadata: metadatas[index] ?? {},
			distance: distances[index],
		}));
	}

	async smokeTest() {
		const collectionName = `kg_poc_smoke_${Date.now()}`;
		const collection = await this.client.getOrCreateCollection({
			name: collectionName,
			embeddingFunction: null,
		});
		const id = `smoke-${Date.now()}`;
		const embedding = [1, 0, 0];

		try {
			await collection.add({
				ids: [id],
				documents: ["MindMesh smoke test"],
				embeddings: [embedding],
				metadatas: [{ kind: "smoke" }],
			});

			const result = await collection.query({
				queryEmbeddings: [embedding],
				nResults: 1,
			});

			if (!result.ids?.[0]?.includes(id)) {
				throw new Error("Chroma smoke document was not returned by query.");
			}

			if (typeof collection.delete === "function") {
				await collection.delete({ ids: [id] });
			}
		} finally {
			if (typeof this.client.deleteCollection === "function") {
				await this.client.deleteCollection({ name: collectionName });
			}
		}
	}
}
