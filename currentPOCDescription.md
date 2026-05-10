## Before: Current KnowledgeGraphPOC State

The existing `knowledgeGraphPOC` is a working proof-of-concept for a personal knowledge graph + GraphRAG system.

### Current Architecture

- **Neo4j** is used as the graph database for storing extracted knowledge graph nodes and relationships.
- **ChromaDB** is used as the vector database for indexing graph nodes and relationships for semantic retrieval.
- **Node.js / Express** powers the backend, with both CLI scripts and a web server.
- **LLM providers** are abstracted behind adapters:
  - Gemini
  - Ollama
  - Custom HTTP endpoint
- **Embedding providers** are also abstracted:
  - Gemini embeddings by default
  - Chroma default embedding support is still available

### Current Web UI

The POC has a split-screen browser UI:

- **Left/main pane:** interactive Neo4j graph preview rendered with Graphology, Sigma, and force layout.
- **Right pane:** chat-style interface with a text box and two explicit action buttons:
  - **ASK**
  - **INGEST**

### Current ASK Flow

The **ASK** button triggers the current hybrid GraphRAG pipeline:

1. User enters a question.
2. ChromaDB vector search identifies relevant entry-point graph nodes.
3. Neo4j expands from those nodes using a hardcoded/configured traversal depth.
4. The expanded graph context is formatted into text.
5. The selected LLM provider generates an answer from that context.
6. The UI displays the answer and highlights the retrieved entry nodes in the graph.

Each ASK message is treated as an independent prompt. There is currently no conversational memory or multi-turn chat state.

### Current INGEST Flow

The **INGEST** button triggers the ingestion pipeline:

1. User enters raw text.
2. The selected LLM provider extracts graph facts from the text.
3. The extracted payload is normalized into nodes and relationships.
4. Nodes and relationships are upserted into Neo4j.
5. Graph records are indexed into ChromaDB.
6. The UI updates the graph preview and displays extracted triplets.

### Current CLI Support

The same core services are available through CLI scripts:

- Ingest text
- Ask questions
- Test Neo4j and ChromaDB connections
- Test LLM provider behavior
- Test graph payload parsing
- Clear Chroma collections

### Current Limitations

- Chat messages are stateless; there is no conversation/session memory.
- ASK and INGEST are separate manual actions chosen by the user.
- Graph traversal depth and retrieval behavior are mostly static/config-driven.
- The system does not yet maintain synthesized long-term memory, fleeting notes, or richer notebook-like context.
- The UI is a functional POC, not yet a polished product workflow.
