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
  constructor(config) {
    this.config = config;
    const url = new URL(config.path);
    this.client = new ChromaClient({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ssl: url.protocol === "https:",
    });
  }

  async getNodeCollection() {
    return this.client.getOrCreateCollection({ name: this.config.nodeCollection });
  }

  async getRelationCollection() {
    return this.client.getOrCreateCollection({ name: this.config.relationCollection });
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
      await nodeCollection.upsert({
        ids: graphPayload.nodes.map((node) => node.id),
        documents: graphPayload.nodes.map(nodeDocument),
        metadatas: graphPayload.nodes.map((node) => ({
          kind: "node",
          label: node.label,
          name: node.name,
          type: node.type,
        })),
      });
    }

    if (graphPayload.relations.length > 0) {
      await relationCollection.upsert({
        ids: graphPayload.relations.map((relation) => relation.id),
        documents: graphPayload.relations.map(relationDocument),
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
      queryTexts: [query],
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
    const collection = await this.client.getOrCreateCollection({ name: "kg_poc_smoke" });
    const id = `smoke-${Date.now()}`;

    await collection.add({
      ids: [id],
      documents: ["knowledge graph poc smoke test"],
      metadatas: [{ kind: "smoke" }],
    });

    const result = await collection.query({
      queryTexts: ["knowledge graph smoke"],
      nResults: 1,
    });

    if (!result.ids?.[0]?.includes(id)) {
      throw new Error("Chroma smoke document was not returned by query.");
    }

    if (typeof collection.delete === "function") {
      await collection.delete({ ids: [id] });
    }
  }
}
