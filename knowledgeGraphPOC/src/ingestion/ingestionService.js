import { normalizeGraphPayload } from "./graphPayload.js";

export class IngestionService {
  constructor({ llmProvider, graphStore, vectorStore, prompts }) {
    this.llmProvider = llmProvider;
    this.graphStore = graphStore;
    this.vectorStore = vectorStore;
    this.prompts = prompts;
  }

  async ingestText({ text, source }) {
    const extractedGraph = await this.llmProvider.extractGraph({
      text,
      systemPrompt: this.prompts.extractionSystem,
    });
    const graphPayload = normalizeGraphPayload(extractedGraph);
    const storedGraph = await this.graphStore.upsertGraph(graphPayload, { source });
    await this.vectorStore.upsertGraphIndex(storedGraph);

    return storedGraph;
  }
}
