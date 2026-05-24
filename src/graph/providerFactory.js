import { Neo4jGraphStore } from "./neo4jGraphStore.js";

export function createGraphStore(config) {
  if (config.graph.provider === "neo4j") {
    return new Neo4jGraphStore(config.graph.neo4j);
  }

  throw new Error(`Unsupported graph provider: ${config.graph.provider}`);
}
