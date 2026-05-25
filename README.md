# MindMesh

Prototype personal knowledge management system that extracts graph facts from text, stores them in Neo4j, indexes them in ChromaDB, and answers questions with a hybrid vector + graph RAG flow.

This README is written for humans and AI agents that need to understand or extend the codebase quickly.

## High-Level Architecture

```text
User text
  -> src/cli/ingest.js
  -> IngestionService
  -> ChromaVectorStore.queryNodes() for existing context
  -> Neo4jGraphStore.expandFromNodes() for identity/disambiguation context
  -> LLM provider extracts graph records as JSON or custom syntax
  -> normalizeGraphPayload()
  -> Neo4jGraphStore.upsertGraph()
  -> ChromaVectorStore.upsertGraphIndex()

Question
  -> src/cli/ask.js
  -> HybridRagService
  -> ChromaVectorStore.queryNodes()
  -> Neo4jGraphStore.expandFromNodes()
  -> formatGraphContext()
  -> LLM provider generates final answer

Web UI
  -> src/server/server.js
  -> Express JSON APIs + static files
  -> same IngestionService and HybridRagService used by the CLIs
  -> graph preview from Neo4jGraphStore.getGraphPreview()
```

## Runtime Stack

- Node.js ES modules; package root is the repository root.
- LLM providers:
  - Gemini via `@google/genai`, default model `gemini-2.5-flash`.
  - Ollama via local HTTP API, default model `mistral`.
  - Custom HTTP endpoint via `POST { "text": "prompt" }`, returning a plain string.
  - Hackathon hub chat-completions proxy, default model `gpt-4.1-nano`.
- Graph database: Neo4j using the official `neo4j-driver`.
- Vector database: ChromaDB using `chromadb`.
- Embeddings: Gemini `gemini-embedding-001` by default; Chroma's default embedder can still be enabled with `KG_EMBEDDING_PROVIDER=chroma`.
- Web server: Express serving JSON APIs and the bundled Preact/CSS frontend.
- Graph UI: Preact for UI state, Graphology for the browser graph model, Graphology force layout for positioning, and Sigma for canvas rendering.
- Prompt files live under `/prompts`.

## Important Files

- `src/config.js`: central config loader. Reads environment variables first, then `/config.json`, then selected legacy fields from repo-root `config.json`, then hardcoded defaults.
- `src/input/readInput.js`: shared CLI argument parser for `--file`, `--interactive`, `--provider`, and positional text.
- `src/cli/ingest.js`: ingestion entry point with a large fallback sample graph text.
- `src/cli/ask.js`: question-answering entry point.
- `src/cli/testConnections.js`: Neo4j and Chroma connectivity plus write/query smoke tests.
- `src/cli/testLlm.js`: provider reachability and graph extraction smoke test.
- `src/cli/testParser.js`: local JSON/custom extraction and graph normalization smoke test.
- `src/ingestion/ingestionService.js`: orchestrates extraction, normalization, graph persistence, and vector indexing.
- `src/ingestion/graphPayload.js`: parses and normalizes LLM graph output into stable node and relationship payloads.
- `schema/graphSchema.json`: schema registry for allowed node types, relationship types, required properties, fallbacks, and LLM-facing descriptions.
- `src/schema/graphSchema.js`: loads the schema registry and formats the schema catalog injected into extraction prompts.
- `src/graph/neo4jGraphStore.js`: Neo4j persistence, graph expansion, and smoke test implementation.
- `src/vector/chromaVectorStore.js`: Chroma collections, node/relation documents, vector query, and smoke test implementation.
- `src/embedding/geminiEmbeddingProvider.js`: Gemini embedding adapter used to precompute Chroma vectors without downloading Hugging Face models.
- `src/rag/hybridRagService.js`: vector entry-point retrieval, Neo4j expansion, context formatting, and final answer generation.
- `src/llm/geminiProvider.js`, `src/llm/ollamaProvider.js`, `src/llm/customHttpProvider.js`, and `src/llm/hubChatProvider.js`: LLM provider adapters with the same small interface.
- `src/server/server.js`: Express web entry point for ask, ingest, and graph preview APIs.
- `src/server/public`: Preact split-screen KG preview, simulated chat UI, graph search, detail editing, and manual CRUD.

## Setup

Install dependencies from the repo root:

```powershell
npm install
```

Run Neo4j and ChromaDB locally. Defaults are:

```text
Neo4j bolt: bolt://localhost:7687
Neo4j database: neo4j
Chroma: http://localhost:8000
```

Create a local POC config if needed:

```powershell
Copy-Item .\config.example.json .\config.json
```

Do not commit real API keys or local passwords. Prefer environment variables for secrets:

```powershell
$env:GEMINI_API_KEY="your-key"
$env:KG_LLM_PROVIDER="gemini"
```

## Configuration

`getConfig()` resolves values in this order:

1. Environment variable.
2. `/config.json`.
3. Repo-root `config.json` for legacy Gemini `apiKey` and `model` only.
4. Hardcoded default.

Supported environment variables:

| Area | Variables |
| --- | --- |
| LLM | `KG_LLM_PROVIDER`, `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GEMINI_MODEL`, `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `KG_CUSTOM_LLM_ENDPOINT`, `KG_HUB_LLM_BASE_URL`, `KG_HUB_LLM_API_KEY`, `KG_HUB_LLM_MODEL`, `KG_HUB_LLM_TEMPERATURE` |
| Embedding | `KG_EMBEDDING_PROVIDER`, `GEMINI_EMBEDDING_MODEL`, `GEMINI_EMBEDDING_DIMENSIONS` |
| Graph | `KG_GRAPH_PROVIDER`, `NEO4J_INSTANCE`, `NEO4J_URI`, `NEO4J_DATABASE`, `NEO4J_USERNAME`, `NEO4J_PASSWORD` |
| Vector | `KG_VECTOR_PROVIDER`, `CHROMA_URL`, `CHROMA_TENANT`, `CHROMA_DATABASE`, `CHROMA_NODE_COLLECTION`, `CHROMA_RELATION_COLLECTION` |
| RAG | `KG_RAG_TOP_K`, `KG_RAG_DEPTH` |
| Ingestion context | `KG_INGEST_CONTEXT_ENABLED`, `KG_INGEST_CONTEXT_TOP_K`, `KG_INGEST_CONTEXT_DEPTH` |
| Schema | `KG_SCHEMA_PATH`, `KG_SCHEMA_AUTO_APPLY_SUGGESTIONS` |
| Logging | `KG_DEBUG_LOG`, `KG_DEBUG_LOG_DIR`, `KG_DEBUG_LOG_SCOPES` |
| Prompts | `KG_CUSTOM_EXTRACTION_PROMPT_PATH`, `KG_ANSWER_PROMPT_PATH`, `KG_CONTEXT_PROMPT_PATH` |

Only the LLM provider names `gemini`, `ollama`, `custom`, and `hub`; graph/vector provider names `neo4j`/`chroma`; and embedding provider names `gemini`/`chroma` are currently implemented.

## Graph Schema

Ingestion is schema-aware. The schema registry lives at `/schema/graphSchema.json` and defines:

- allowed node types
- allowed relationship types
- suggested node and relationship types pending human approval
- required and optional node/relationship properties
- fallback node and relationship types
- short descriptions that are injected into the extraction prompt

The custom extraction syntax supports schema suggestions without requiring JSON:

```text
NODE_TYPE_SUGGESTION|type_name|description|reason
RELATION_TYPE_SUGGESTION|relation_name|description|reason
```

By default, suggestions are captured for visibility but the graph payload falls back to `concept` and `relates_to` for unknown types. Set `KG_SCHEMA_AUTO_APPLY_SUGGESTIONS=true` or `"autoApplySuggestions": true` in config to accept suggested types in the current ingest and add them to the approved schema arrays.

When auto-apply is off, suggested types are persisted back into `schema/graphSchema.json` under:

```json
{
  "suggestions": {
    "nodeTypes": [],
    "relationshipTypes": []
  }
}
```

Approved schema terms belong in the top-level `nodeTypes` and `relationshipTypes` arrays. When auto-apply is on, current LLM suggestions are added there automatically; when auto-apply is off, future human-in-the-loop approval can promote entries from `suggestions` into those approved arrays.

## Debug Logging

Ingestion and ask debug logging are opt-in because logs can contain full user text, prompts, graph context, and raw LLM output.

Enable it in `/config.json`:

```json
{
  "logging": {
    "enabled": true,
    "directory": ".//logs",
    "scopes": ["ingest", "ask"]
  }
}
```

Or enable it for one shell session:

```powershell
$env:KG_DEBUG_LOG="true"
$env:KG_DEBUG_LOG_SCOPES="ingest,ask"
npm run kg:ingest -- "EKYC Screen uses PAN Verification API."
```

Each ingest run writes a timestamped `ingest-*.log` file containing:

- console progress lines from the ingestion flow
- runtime/schema settings
- retrieved ingestion context summary
- existing graph context used for identity resolution
- rendered extraction prompt sent to the LLM
- raw LLM extraction response
- parsed extraction payload
- normalized graph payload
- persisted schema suggestion summary
- exception details when the ingest flow fails

Each ask run writes a timestamped `ask-*.log` file containing:

- console progress lines from the ask flow
- runtime retrieval settings
- user query
- Chroma vector entry nodes
- expanded Neo4j graph summary
- formatted graph context
- rendered answer prompt sent to the LLM
- raw LLM answer response
- exception details when the ask flow fails

## Commands

Test both databases:

```powershell
npm run kg:test-db
```

Test the selected LLM provider:

```powershell
npm run kg:test-llm
```

Run parser and normalizer smoke tests without external services:

```powershell
npm run kg:test-parser
```

Clear Chroma data:

```powershell
npm run kg:clear-chroma -- --yes
```

By default this deletes only the configured app collections, `kg_nodes` and `kg_relationships`, and does not require Chroma reset/admin permissions.

If your Chroma server allows reset, you can reset the whole server:

```powershell
npm run kg:clear-chroma -- --yes --reset
```

If reset is disabled and you need an admin-level tenant/database cleanup, use:

```powershell
npm run kg:clear-chroma -- --yes --delete-databases
```

Reindex Neo4j graph descriptions into Chroma vectors:

```powershell
npm run kg:reindex-vectors
```

Ingest with the hardcoded fallback sample:

```powershell
npm run kg:ingest
```

Ingest CLI text:

```powershell
npm run kg:ingest -- "EKYC Screen uses PAN Verification API."
```

Ingest from a file:

```powershell
npm run kg:ingest -- --file .\notes\input.txt
```

Ingest via runtime input:

```powershell
npm run kg:ingest -- --interactive
```

Ask with the hardcoded fallback question:

```powershell
npm run kg:ask
```

Ask a CLI question:

```powershell
npm run kg:ask -- "What does the EKYC screen use?"
```

Build and start the web UI:

```powershell
npm run kg:web
```

The web server defaults to:

```text
http://localhost:3000
```

Override the port with `KG_WEB_PORT` or `PORT`.

To rebuild only the browser bundle:

```powershell
npm run kg:web:build
```

Use a provider override for a single CLI run:

```powershell
npm run kg:ask -- --provider ollama "What does the EKYC screen use?"
```

Use the custom HTTP provider:

```powershell
$env:KG_CUSTOM_LLM_ENDPOINT="http://localhost:3001/llm"
npm run kg:test-llm -- --provider custom
```

The custom endpoint receives a JSON body with a single `text` field containing the full prompt and should return the model output as a plain string.

Use the hackathon hub provider:

```powershell
$env:KG_LLM_PROVIDER="hub"
$env:KG_HUB_LLM_API_KEY="your-hackathon-hub-key"
$env:KG_HUB_LLM_MODEL="gpt-4.1-nano"
npm run kg:test-llm
```

The hub provider calls an OpenAI-compatible `/v1/chat/completions` endpoint and always converts the response to plain text before ASK or INGEST consumes it.

Use Gemini embeddings, the default, with the same Gemini API key:

```powershell
$env:GEMINI_API_KEY="your-key"
$env:KG_EMBEDDING_PROVIDER="gemini"
```

Use Chroma's default embedding behavior instead:

```powershell
$env:KG_EMBEDDING_PROVIDER="chroma"
```

## Input Handling

`readInput()` returns `{ text, options, source }`.

Priority order:

1. `--file` or `-f`: reads and trims the file contents.
2. Positional CLI text: joins all remaining args with spaces.
3. `--interactive` or `-i`: prompts on stdin.
4. Fallback text/question supplied by the caller.

`--provider <name>` is parsed by the shared input helper and passed only to the LLM provider factory.

## Graph Extraction Contract

The ingestion pipeline now uses a single, custom line-oriented extraction format. Extraction prompt files are templates. Ingestion renders `{{GRAPH_SCHEMA}}`, `{{EXISTING_GRAPH_CONTEXT}}`, and `{{USER_INPUT}}` into the custom extraction prompt before calling the LLM. Existing graph context is retrieved from Chroma and expanded through Neo4j; it is intended for identity resolution, node-name reuse, disambiguation, and avoiding duplicate facts. New graph facts should still come from `{{USER_INPUT}}`.

Records are one-per-line using `|` as an unescaped field separator. To include special characters inside a field you must use backslash escapes: `\\n` for newline, `\\r` for carriage return, `\\t` for tab, `\\|` for a literal pipe, and `\\\\` for a literal backslash. The parser decodes these escapes into their runtime characters.

The custom extraction prompt asks the model to wrap records in explicit demarcators. The parser consumes only the text inside the first delimited block when present, so extra model commentary outside the block is ignored:

```text
<start#$#$>
NODE|name|label|type|description
RELATION|source_name|target_name|relation|information|description
NODE_TYPE_SUGGESTION|type_name|description|reason
RELATION_TYPE_SUGGESTION|relation_name|description|reason
</end#$#$>
```

Example:

```text
<start#$#$>
NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity verification details.
NODE|pan_api|PAN API|api|API used to verify PAN details.
RELATION|ekyc_screen|pan_api|uses|during identity verification|Triggered during identity verification.
</end#$#$>
```

For relationships, `sourceName`, `relation`, and `targetName` already express the core fact. `information` should contain only extra qualifiers such as conditions, timing, scope, state, or reason; leave it empty when it would merely repeat the relation. `description` is reserved for longer source-backed explanation. Node descriptions should add useful context or disambiguation, not restate the label/type.

`extractCustomGraph()` accepts raw, fenced, or demarcated custom graph records. When demarcators are present, text outside them is ignored; otherwise it falls back to parsing the full response. It ignores blank/header lines, captures schema suggestion records, and throws if no valid records can be parsed.

`normalizeGraphPayload()` then:

- Converts node names, node types, and relation names to lowercase snake case.
- Enforces the loaded graph schema when one is supplied.
- Replaces unknown node or relationship types with configured fallbacks when suggestions are not auto-applied.
- Persists new schema suggestions into `schema/graphSchema.json` under the `suggestions` section when auto-apply is off.
- Promotes current-response schema suggestions into approved `nodeTypes` / `relationshipTypes` when auto-apply is on.
- Allows current-response suggestions during normalization only when `KG_SCHEMA_AUTO_APPLY_SUGGESTIONS=true`.
- Creates node IDs as `node:<name>` when no ID is provided.
- Creates missing endpoint nodes for relations.
- Creates relationship IDs as `rel:<12-char-sha1>` when no ID is provided.
- Defaults missing descriptions to empty strings.
- Preserves empty relation `information` instead of generating redundant relation text.
- Returns `schemaSuggestions`, `schemaWarnings`, and `persistedSchemaSuggestions` for CLI/API visibility and future human-in-the-loop schema approval.

## Neo4j Schema

Nodes use label `KnowledgeNode`.

Node properties:

- `id`
- `label`
- `name`
- `type`
- `description`
- `createdAt`
- `updatedAt`

Relationships use type `RELATES_TO`.

Relationship properties:

- `id`
- `sourceId`
- `targetId`
- `relation`
- `information`
- `description`
- `createdAt`
- `updatedAt`

`upsertGraph()` uses `MERGE` by node `id` and relationship `id`. Re-ingesting the same normalized fact updates properties and preserves `createdAt`.

`expandFromNodes(nodeIds, depth)` expands undirected `RELATES_TO` paths from entry nodes. Depth is clamped to `0..8` to avoid runaway traversals. The default configured depth is `4`.

`getGraphPreview(limit)` returns the newest capped full graph for the web UI. The default UI limit is `150`; the server clamps API limits to `1..500`. Relationships are included only when both endpoints are in the selected node set.

## Chroma Schema

Default collections:

- `kg_nodes`
- `kg_relationships`

Node documents concatenate:

```text
label
name
type
description
```

Node metadata:

- `kind: "node"`
- `label`
- `name`
- `type`

Relationship documents concatenate:

```text
relation
information
description
source:<sourceId>
target:<targetId>
```

Relationship metadata:

- `kind: "relation"`
- `sourceId`
- `targetId`
- `relation`

When `KG_EMBEDDING_PROVIDER=gemini`, the app sends document/query text to Gemini, stores explicit embeddings in Chroma, and queries with explicit query embeddings. This avoids Chroma's JavaScript default embedding function and its Hugging Face model download.

The current RAG flow queries only `kg_nodes`; relationship vectors are indexed for future retrieval paths.

## Ingestion Context Flow

`IngestionService.ingestText({ text })` performs retrieval-augmented extraction:

1. Query Chroma node collection with `ingestion.contextTopK`.
2. Expand Neo4j graph from returned node IDs with `ingestion.contextDepth`.
3. Format that existing graph as human-readable node/fact lists while preserving exact `node:*` IDs.
4. Render the extraction prompt template with schema, existing graph context, and new user input.
5. Ask the selected LLM to extract graph records from the new input while using existing context for identity resolution only.
6. Normalize, upsert to Neo4j, and sync Chroma vectors.

If ingestion context config is omitted, `contextTopK` and `contextDepth` fall back to the configured RAG `topK` and `depth`. For the hackathon POC, `contextDepth: 1` is recommended to keep extraction grounded and avoid context noise.

## RAG Flow

`HybridRagService.answer({ query, source })` performs:

1. Query Chroma node collection with `topK` from config.
2. Use returned node IDs as entry points.
3. Expand Neo4j graph from those entry points to configured `depth`.
4. Format graph context as compact node and relation lists.
5. Ask the selected LLM to answer using only that graph context.

The result object includes:

- `answer`
- `entryNodes`
- `graph`
- `context`
- `depth`

## Web UI

The web UI is a dependency-light Preact app. It is bundled to static assets and served by Express from `src/server/public`.

Layout:

- Desktop: graph preview uses roughly two thirds of the screen; simulated chat uses one third.
- Mobile: graph preview stacks above the chat panel.
- The graph preview uses Graphology + Sigma with force-layout positioning, draggable nodes, pan/zoom, hover focus, click-to-select focus, and compact relationship labels.
- The graph panel includes instant client-side search over the loaded preview and full Neo4j search on submit. Search results focus a loaded node or fetch its neighborhood.
- The workspace has tabs for `chat`, `details`, and `manage`.
- The details tab edits or deletes the selected node/relation.
- The manage tab manually creates nodes and relationships.
- Node and relationship mutations update Neo4j first and then sync the corresponding Chroma vector documents.
- Node vector documents include label, name, type, and description. Relationship vector documents include relation, information, description, source ID, and target ID.
- The chat tab has one text area and two buttons: `Ask` and `Ingest`.
- Chat messages are local UI state only. There is no persisted session and no conversational memory passed to the LLM.
- `src/server/public/app.js` is the Preact source file. `npm run kg:web:build` bundles it to `app.bundle.js`, which is intentionally ignored by git.

API endpoints:

- `GET /api/graph?limit=150`: returns `{ nodes, relations, limit }`.
- `GET /api/nodes/search?q=pan&limit=12`: searches all Neo4j nodes by id, label, name, type, or description.
- `GET /api/nodes/:id/neighborhood?depth=1`: returns a focused graph around a node.
- `GET /api/nodes/:id/relations`: returns relationships attached to a node.
- `POST /api/nodes`: manually creates a node and syncs its vector document.
- `PUT /api/nodes/:id`: updates a node and syncs its vector document.
- `DELETE /api/nodes/:id`: deletes a node, attached relationships, and matching vector documents.
- `POST /api/relations`: manually creates a relation and syncs its vector document.
- `PUT /api/relations/:id`: updates a relation and syncs its vector document.
- `DELETE /api/relations/:id`: deletes a relation and matching vector document.
- `POST /api/ask`: accepts `{ "text": "question" }` and returns `{ answer, entryNodes, graph, depth }`.
- `POST /api/ingest`: accepts `{ "text": "source text" }` and returns `{ nodes, relations, triplets, schemaSuggestions, schemaWarnings, persistedSchemaSuggestions, graph }`.
- Errors return `{ error: "message" }`.

Ingest responses include `triplets` formatted as:

```json
{
  "sourceId": "node:source",
  "sourceLabel": "Source",
  "relation": "uses",
  "targetId": "node:target",
  "targetLabel": "Target",
  "information": "Source uses Target."
}
```

## Provider Interfaces

LLM providers should implement:

- `generateText({ systemPrompt, prompt })`
- `extractGraph({ text, systemPrompt })`
- `generateAnswer({ systemPrompt, context, query })`

Graph stores should implement the methods currently used by CLIs and services:

- `verifyConnectivity()`
- `upsertGraph(graphPayload)`
- `expandFromNodes(nodeIds, depth)`
- `getGraphPreview(limit)`
- `smokeTest()`
- `close()`

Vector stores should implement:

- `verifyConnectivity()`
- `upsertGraphIndex(graphPayload)`
- `queryNodes(query, topK)`
- `smokeTest()`

To add a provider, create the adapter and update the relevant `providerFactory.js`.

## Agent Notes

- This is a POC, not a hardened service. There is no migration system, no delete/update reconciliation for removed facts, and no automated unit test framework beyond smoke-test scripts.
- `config.json` may contain local secrets. Inspect `config.example.json` for shape, not private values.
- Prompt behavior is part of the application contract. Update prompt files and README together when changing extraction or answer semantics.
- Chroma retrieval depends on its configured embedding implementation. If you switch embedding providers or dimensions, clear/recreate Chroma collections before ingesting again.
- Neo4j relationship type is always `RELATES_TO`; the semantic relation is stored in the `relation` property.
- `source` is passed into `upsertGraph()` today but is not persisted by `Neo4jGraphStore`.
- The fallback ingestion text in `src/cli/ingest.js` is intentionally large and domain-specific. It is sample data, not a schema definition.
