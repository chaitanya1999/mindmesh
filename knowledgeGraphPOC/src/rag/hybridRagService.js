function formatGraphContext(graph, prompts) {
  const nodeLines = graph.nodes.map((node) =>
    `- ${node.id} | label: ${node.label} | name: ${node.name} | type: ${node.type} | description: ${node.description || ""}`,
  );
  const relationLines = graph.relations.map((relation) =>
    `- ${relation.id} | ${relation.sourceId} -[${relation.relation}]-> ${relation.targetId} | information: ${relation.information || ""} | description: ${relation.description || ""}`,
  );

  return [
    prompts.contextFormat,
    "",
    "Nodes:",
    nodeLines.length > 0 ? nodeLines.join("\n") : "- No nodes found.",
    "",
    "Relations:",
    relationLines.length > 0 ? relationLines.join("\n") : "- No relations found.",
  ].join("\n");
}

export class HybridRagService {
  constructor({ llmProvider, graphStore, vectorStore, prompts, topK, depth }) {
    this.llmProvider = llmProvider;
    this.graphStore = graphStore;
    this.vectorStore = vectorStore;
    this.prompts = prompts;
    this.topK = topK;
    this.depth = depth;
  }

  async answer({ query }) {
    const entryNodes = await this.vectorStore.queryNodes(query, this.topK);
    const nodeIds = entryNodes.map((node) => node.id);
    const graph = nodeIds.length > 0
      ? await this.graphStore.expandFromNodes(nodeIds, this.depth)
      : { nodes: [], relations: [] };
    const context = formatGraphContext(graph, this.prompts);
    const answer = await this.llmProvider.generateAnswer({
      systemPrompt: this.prompts.answerSystem,
      context,
      query,
    });

    return {
      answer,
      entryNodes,
      graph,
      context,
      depth: this.depth,
    };
  }
}
