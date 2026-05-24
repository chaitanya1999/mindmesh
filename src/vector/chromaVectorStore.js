import { ChromaClient } from "chromadb";

function nodeDocument(node) {
	return [
		node.label,
		node.name,
		node.type,
		node.description,
		node.metadata,
	].filter(Boolean).join("\n");
}

function relationDocument(relation) {
	return [
		relation.relation,
		relation.information,
		relation.description,
		relation.metadata,
		`source:${relation.sourceId}`,
		`target:${relation.targetId}`,
	].filter(Boolean).join("\n");
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
		metadata,
	};
}

function sortHitlNotes(notes) {
	function timestamp(note) {
		const value = Date.parse(note.createdAt || "");
		return Number.isFinite(value) ? value : 0;
	}

	return [...notes].sort((left, right) => (
		timestamp(left) - timestamp(right)
		|| String(left.id).localeCompare(String(right.id))
	));
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

	async listHitlNotes({ status = "pending", limit = 100, offset = 0 } = {}) {
		const collection = await this.getHitlCollection();
		const result = await collection.get({
			where: status ? { status } : undefined,
			limit,
			offset,
		});

		const notes = (result.ids ?? []).map((id, index) => hitlNoteFromRecord(
			id,
			result.documents?.[index] ?? "",
			result.metadatas?.[index] ?? {},
		));

		return sortHitlNotes(notes);
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

	async queryHitlNotes(query, topK) {
		const collection = await this.getHitlCollection();
		const results = await collection.query({
			queryTexts: this.embeddingProvider ? undefined : [query],
			queryEmbeddings: this.embeddingProvider ? [await this.embeddingProvider.embedQuery(query)] : undefined,
			nResults: topK,
			where: { status: "pending" },
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
					metadata: node.metadata ?? "",
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
					metadata: relation.metadata ?? "",
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

	async queryNodes(query, topK) {
		const collection = await this.getNodeCollection();
		const results = await collection.query({
			queryTexts: this.embeddingProvider ? undefined : [query],
			queryEmbeddings: this.embeddingProvider ? [await this.embeddingProvider.embedQuery(query)] : undefined,
			nResults: topK,
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
