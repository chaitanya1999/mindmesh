import { ChromaClient } from "chromadb";

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

	async verifyConnectivity() {
		if (typeof this.client.heartbeat === "function") {
			await this.client.heartbeat();
			return;
		}

		await this.client.listCollections();
	}

	async upsertGraphIndex(graphPayload) {
		const nodeCollection = await this.getNodeCollection();
		const relationCollection = await this.getRelationCollection();

		if (graphPayload.nodes.length > 0) {
			const documents = graphPayload.nodes.map(nodeDocument);
			await nodeCollection.upsert({
				ids: graphPayload.nodes.map((node) => node.id),
				documents,
				embeddings: this.embeddingProvider ? await this.embeddingProvider.embedDocuments(documents) : undefined,
				metadatas: graphPayload.nodes.map((node) => ({
					kind: "node",
					label: node.label,
					name: node.name,
					type: node.type,
				})),
			});
		}

		if (graphPayload.relations.length > 0) {
			const documents = graphPayload.relations.map(relationDocument);
			await relationCollection.upsert({
				ids: graphPayload.relations.map((relation) => relation.id),
				documents,
				embeddings: this.embeddingProvider ? await this.embeddingProvider.embedDocuments(documents) : undefined,
				metadatas: graphPayload.relations.map((relation) => ({
					kind: "relation",
					sourceId: relation.sourceId,
					targetId: relation.targetId,
					relation: relation.relation,
				})),
			});
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
				documents: ["knowledge graph poc smoke test"],
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
