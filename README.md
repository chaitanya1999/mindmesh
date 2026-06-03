# MindMesh

Prototype personal knowledge management system that extracts graph facts from text/documents, stores approved facts in Neo4j, indexes approved graph records and pending HITL proposals in ChromaDB, and answers questions with a hybrid vector + graph RAG flow.

This README is written for humans and AI agents that need to understand or extend the codebase quickly.

## High-Level Architecture

```text
User text
  -> src/cli/ingest.js
  -> IngestionService
  -> ChromaVectorStore.queryNodes() for existing context
  -> Neo4jGraphStore.expandFromNodes() for identity/disambiguation context
  -> pending HITL notes are retrieved from Chroma for duplicate avoidance
  -> LLM provider extracts custom line-oriented graph records
  -> normalizeGraphPayload()
  -> HITL proposal stored in Chroma when HITL mode or schema violations apply
  -> otherwise Neo4jGraphStore.upsertGraph()
  -> ChromaVectorStore.upsertGraphIndex()

Question
  -> src/cli/ask.js
  -> HybridRagService
  -> optional browser-session memory is folded into retrieval/answer context
  -> ChromaVectorStore.queryNodes()
  -> Neo4jGraphStore.expandFromNodes()
  -> optional pending HITL notes can be included as unverified context
  -> formatGraphContext()
  -> LLM provider generates final answer

Web UI
  -> src/server/server.js
  -> Express JSON APIs + static files
  -> same IngestionService and HybridRagService used by the CLIs
  -> graph, schema, jobs, and HITL review workspaces
  -> graph preview from Neo4jGraphStore plus pending HITL overlays
```

## Runtime Stack

- Node.js ES modules; package root is the repository root.
- LLM providers:
  - Gemini via `@google/genai`, default model `gemini-2.5-flash`.
  - Ollama via local HTTP API, default model `mistral`.
  - Custom HTTP endpoint via Gemini-style or OpenAI-compatible subproviders.
  - Hackathon hub chat-completions proxy, default model `gpt-4.1-nano`.
- Graph database: Neo4j using the official `neo4j-driver`.
- Vector database: ChromaDB using `chromadb`.
- Embeddings: Gemini `gemini-embedding-001` by default; hub embeddings and Chroma's default embedder are also supported.
- Web server: Express serving JSON APIs and the bundled Preact/CSS frontend.
- Graph UI: Preact for UI state, Graphology for the browser graph model, Graphology force layout for positioning, and Sigma for canvas rendering.
- Document ingestion uploads: PDF via `pdf-parse`, DOCX via `mammoth`, and DOC via `word-extractor`.
- Prompt files live under `/prompts`.

## Important Files

- `src/config.js`: central config loader. Reads repo-root `config.json`, applies optional `{{KEY}}` placeholders from `config.replacements.json` or caller-supplied replacements, and returns the parsed runtime config.
- `src/input/readInput.js`: shared CLI argument parser for `--file`, `--interactive`, `--provider`, and positional text.
- `src/cli/ingest.js`: ingestion entry point with a large fallback sample graph text.
- `src/cli/ask.js`: question-answering entry point.
- `src/cli/testConnections.js`: Neo4j and Chroma connectivity plus write/query smoke tests.
- `src/cli/testLlm.js`: provider reachability and graph extraction smoke test.
- `src/cli/testParser.js`: local custom extraction and graph normalization smoke test.
- `src/ingestion/ingestionService.js`: orchestrates extraction, normalization, graph persistence, and vector indexing.
- `src/ingestion/graphPayload.js`: parses and normalizes LLM graph output into stable node and relationship payloads.
- `src/ingestion/reviewSignals.js`: detects ambiguity and contradiction review signals in proposed graph records.
- `schema/graphSchema.json`: schema registry for allowed node types, relationship types, required properties, fallbacks, and LLM-facing descriptions.
- `src/schema/graphSchema.js`: loads the schema registry and formats the schema catalog injected into extraction prompts.
- `src/graph/neo4jGraphStore.js`: Neo4j persistence, search, graph expansion, direct CRUD, and smoke test implementation.
- `src/vector/chromaVectorStore.js`: Chroma node/relation/HITL collections, vector query, and smoke test implementation.
- `src/embedding/geminiEmbeddingProvider.js`: Gemini embedding adapter used to precompute Chroma vectors without downloading Hugging Face models.
- `src/embedding/hubEmbeddingProvider.js`: OpenAI-compatible hub embedding adapter.
- `src/rag/hybridRagService.js`: vector entry-point retrieval, Neo4j expansion, context formatting, and final answer generation.
- `src/jobs/kgJobsService.js`: graph job runner for scanner and nugget prompts.
- `src/llm/geminiProvider.js`, `src/llm/ollamaProvider.js`, `src/llm/customHttpProvider.js`, and `src/llm/hubChatProvider.js`: LLM provider adapters with the same small interface.
- `src/server/server.js`: Express web entry point for ask, ingest, graph, schema, jobs, upload, and HITL APIs.
- `src/server/public`: Preact graph, chat, schema, jobs, and HITL review UI.

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

Use placeholders in `config.json` for secrets or machine-specific values, then put the local replacement values in `config.replacements.json`:

```json
{
  "llm": {
    "provider": "gemini",
    "gemini": {
      "apiKey": "{{GEMINI_API_KEY}}",
      "model": "gemini-2.5-flash"
    }
  },
  "graph": {
    "neo4j": {
      "password": "{{NEO4J_PASSWORD}}"
    }
  }
}
```

```json
{
  "GEMINI_API_KEY": "your-key",
  "NEO4J_PASSWORD": "your-password"
}
```

## Configuration

`getConfig()` reads `config.json` from the repository root, applies optional replacements, and parses the result as JSON. The config loader does not read application settings from environment variables and does not supply hardcoded fallback defaults; required defaults should live in `config.json` or `config.example.json`.

Replacement model:

1. `config.json` is the complete application config.
2. Placeholders use `{{KEY}}` syntax and are matched by uppercase letters, digits, and underscores, for example `{{GEMINI_API_KEY}}`, `{{NEO4J_PASSWORD}}`, or `{{CHROMA_URL}}`.
3. `config.replacements.json` supplies replacement values from the repository root when the file exists.
4. Callers may pass an explicit map with `getConfig(replacements)`. Current merge behavior starts with caller-supplied replacements and then merges `config.replacements.json` over them.
5. Unresolved placeholders remain as literal strings by default. Use `getConfig(replacements, { strict: true })` to fail with `Unresolved placeholder: KEY`.
6. Invalid `config.replacements.json` is ignored by the loader, so malformed replacement JSON can leave placeholders unresolved.

Example:

```json
{
  "vector": {
    "chroma": {
      "path": "{{CHROMA_URL}}"
    }
  }
}
```

```json
{
  "CHROMA_URL": "http://localhost:8000"
}
```

Only the LLM provider names `gemini`, `ollama`, `custom`, and `hub`; graph/vector provider names `neo4j`/`chroma`; and embedding provider names `gemini`/`hub`/`chroma` are currently implemented.

## Graph Schema

Ingestion is schema-aware. The schema registry lives at `/schema/graphSchema.json` and defines:

- allowed node types
- allowed relationship types
- suggested node and relationship types pending human approval
- required and optional node/relationship properties
- short descriptions that are injected into the extraction prompt

The custom extraction syntax supports schema suggestions without requiring JSON:

```text
NODE_TYPE_SUGGESTION|type_name|description|reason
RELATION_TYPE_SUGGESTION|relation_name|description|reason
```

Unknown node or relationship types are preserved in the proposed payload, recorded as schema violations, and forced into HITL review instead of being applied to the graph. This happens even when ingestion mode is `auto`; the reviewer must update the schema or edit the proposal to approved types before approval can apply mutations.

The default ingestion mode in `config.example.json` is `auto`. Set `ingestion.mode` to `hitl` to store normal ingestions as pending Chroma HITL proposals instead of immediately mutating Neo4j, or keep `auto` to apply schema-valid ingestions directly.

Suggested types are persisted back into `schema/graphSchema.json` under:

```json
{
  "suggestions": {
    "nodeTypes": [],
    "relationshipTypes": []
  }
}
```

Approved schema terms belong in the top-level `nodeTypes` and `relationshipTypes` arrays. Suggested entries are review candidates only; they do not become valid graph types until promoted into the approved arrays.

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

Each ingest run writes a timestamped `ingest-*.log` file containing:

- console progress lines from the ingestion flow
- runtime/schema settings
- retrieved ingestion context summary
- existing graph context and pending HITL context used for identity resolution
- rendered extraction prompt sent to the LLM
- raw LLM extraction response
- parsed extraction payload
- normalized graph payload
- persisted schema suggestion summary
- stored HITL proposal details when HITL mode is active
- exception details when the ingest flow fails

Each ask run writes a timestamped `ask-*.log` file containing:

- console progress lines from the ask flow
- runtime retrieval settings
- user query
- Chroma vector entry nodes
- expanded Neo4j graph summary
- formatted graph context
- browser-session memory and unverified HITL context when provided
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

```json
{
  "llm": {
    "provider": "custom",
    "custom": {
      "endpoint": "http://localhost:3001/llm"
    }
  }
}
```

```powershell
npm run kg:test-llm -- --provider custom
```

The custom endpoint receives a JSON body with a single `text` field containing the full prompt and should return the model output as a plain string.

Use the hackathon hub provider:

```json
{
  "llm": {
    "provider": "hub",
    "hub": {
      "baseUrl": "https://hub-proxy-service.thankfulfield-16b4d5d6.eastus.azurecontainerapps.io",
      "apiKey": "{{HUB_LLM_API_KEY}}",
      "model": "gpt-4.1-nano"
    }
  }
}
```

```json
{
  "HUB_LLM_API_KEY": "your-hackathon-hub-key"
}
```

```powershell
npm run kg:test-llm
```

The hub provider calls an OpenAI-compatible `/v1/chat/completions` endpoint and always converts the response to plain text before ASK or INGEST consumes it.

Use Gemini embeddings, the default, with the same Gemini API key:

```json
{
  "embedding": {
    "provider": "gemini",
    "gemini": {
      "apiKey": "{{GEMINI_API_KEY}}",
      "model": "gemini-embedding-001",
      "outputDimensionality": 768
    }
  }
}
```

Use Chroma's default embedding behavior instead:

```json
{
  "embedding": {
    "provider": "chroma"
  }
}
```

Use hub embeddings:

```json
{
  "embedding": {
    "provider": "hub",
    "hub": {
      "baseUrl": "{{HUB_EMBEDDING_BASE_URL}}",
      "apiKey": "{{HUB_EMBEDDING_API_KEY}}",
      "model": "embeddings",
      "encodingFormat": "float",
      "dimensions": 512,
      "batchSize": 64
    }
  }
}
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

The ingestion pipeline now uses a single, custom line-oriented extraction format. Extraction prompt files are templates. Ingestion renders `{{GRAPH_SCHEMA}}`, `{{EXISTING_GRAPH_CONTEXT}}`, and `{{USER_INPUT}}` into the custom extraction prompt before calling the LLM. Existing graph context is retrieved from Chroma and expanded through Neo4j; pending HITL context is also retrieved from the Chroma HITL collection. Both context sources are intended for identity resolution, node-name reuse, disambiguation, and avoiding duplicate facts. New graph facts should still come from `{{USER_INPUT}}`.

Records are one-per-line using `|` as an unescaped field separator. To include special characters inside a field you must use backslash escapes: `\\n` for newline, `\\r` for carriage return, `\\t` for tab, `\\|` for a literal pipe, and `\\\\` for a literal backslash. The parser decodes these escapes into their runtime characters.

The custom extraction prompt asks the model to wrap records in explicit demarcators. The parser consumes only the text inside the first delimited block when present, so extra model commentary outside the block is ignored:

```text
<start#$#$>
NODE|name|label|type|description
RELATION|source_name|target_name|relation|information|description
NODE_CREATE|name|label|type|description|metadata
NODE_UPDATE|name|label|type|description|metadata
NODE_DELETE|name|metadata
RELATION_CREATE|source_name|target_name|relation|information|description|metadata
RELATION_UPDATE|source_name|target_name|relation|information|description|metadata
RELATION_DELETE|source_name|target_name|relation|metadata
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

`extractCustomGraph()` accepts raw, fenced, or demarcated custom graph records. When demarcators are present, text outside them is ignored; otherwise it falls back to parsing the full response. It ignores blank/header lines, captures schema suggestion records, supports create/update/delete operation records, and throws if no valid records can be parsed.

`normalizeGraphPayload()` then:

- Converts node names, node types, and relation names to lowercase snake case.
- Enforces the loaded graph schema when one is supplied.
- Preserves unknown node or relationship types as schema violations so HITL can review the exact model output.
- Persists unknown types into `schema/graphSchema.json` under the `suggestions` section for review.
- Blocks graph application while schema violations are present.
- Creates node IDs as `node:<name>` when no ID is provided.
- Creates missing endpoint nodes for relations.
- Creates relationship IDs as `rel:<12-char-sha1>` when no ID is provided.
- Defaults missing descriptions to empty strings.
- Preserves empty relation `information` instead of generating redundant relation text.
- Carries node/relation create, update, and delete operations into HITL or graph application.
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

Graph deletes are supported by normalized `nodeDeletes` and `relationDeletes`. Direct node/relation CRUD helpers are used by the web and HITL review flows and keep vector documents synchronized through the server layer.

`expandFromNodes(nodeIds, depth)` expands undirected `RELATES_TO` paths from entry nodes. Depth is clamped to `0..8` to avoid runaway traversals. The default configured depth is `4`.

`getGraphPreview(limit)` returns the newest capped full graph for the web UI. The default UI limit is `150`; the server clamps API limits to `1..500`. Relationships are included only when both endpoints are in the selected node set.

## Chroma Schema

Default collections:

- `kg_nodes`
- `kg_relationships`
- `fleeting_notes_hitl`

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

HITL note documents contain the pending proposal status, user/source metadata, original input, and LLM proposed graph mutations. Their metadata includes counts for proposed node/relation upserts, deletions, schema suggestions, ambiguity signals, and contradiction signals.

When `embedding.provider` is `gemini`, the app sends document/query text to Gemini, stores explicit embeddings in Chroma, and queries with explicit query embeddings. This avoids Chroma's JavaScript default embedding function and its Hugging Face model download.

The current RAG flow queries only `kg_nodes`; relationship vectors are indexed for future retrieval paths. HITL notes are queried separately when ingestion needs pending context or ASK opts into unverified knowledge.

## Ingestion Context Flow

`IngestionService.ingestText({ text })` performs retrieval-augmented extraction:

1. Query Chroma node collection with `ingestion.contextTopK`.
2. Expand Neo4j graph from returned node IDs with `ingestion.contextDepth`.
3. Query/list pending HITL notes and parse their proposed mutations as unverified pending context.
4. Format approved graph and pending HITL context as human-readable node/fact lists while preserving exact `node:*` IDs.
5. Render the extraction prompt template with schema, existing graph context, and new user input.
6. Ask the selected LLM to extract graph records from the new input while using existing/pending context for identity resolution only.
7. Normalize the response into upserts, deletes, suggestions, warnings, and violations.
8. Store a pending HITL proposal when `ingestion.mode` is `hitl` or schema violations exist; otherwise apply graph mutations and sync Chroma vectors.

If ingestion context config is omitted, `contextTopK` and `contextDepth` fall back to the configured RAG `topK` and `depth`. For the hackathon POC, `contextDepth: 1` is recommended to keep extraction grounded and avoid context noise.

## RAG Flow

`HybridRagService.answer({ query, source })` performs:

1. Normalize optional browser-session memory messages.
2. Build a retrieval query from the current question plus recent memory. Standalone LLM query rewriting is currently disabled.
3. Query Chroma node collection with `topK` from config.
4. Use returned node IDs as entry points.
5. Expand Neo4j graph from those entry points to configured `depth`.
6. Optionally retrieve pending HITL notes as unverified knowledge.
7. Format graph context as compact node and relation lists.
8. Ask the selected LLM to answer using verified graph context, with chat memory only for follow-up reference resolution.

The result object includes:

- `answer`
- `entryNodes`
- `graph`
- `context`
- `depth`
- `sessionId`
- `retrievalQuery`
- `unverifiedNotes`

## Web UI

The web UI is a dependency-light Preact app. It is bundled to static assets and served by Express from `src/server/public`.

Routes:

- `/`: main graph/chat workspace.
- `/hitl`: human review workspace.
- `/schema`: graph schema editor.
- `/jobs`: graph job workspace.

Layout and behavior:

- Desktop: graph preview uses roughly two thirds of the screen; simulated chat uses one third.
- Mobile: graph preview stacks above the chat panel.
- The graph preview uses Graphology + Sigma with force-layout positioning, draggable nodes, pan/zoom, hover focus, click-to-select focus, and compact relationship labels.
- The graph panel includes instant client-side search over the loaded preview and full Neo4j search on submit. Search results focus a loaded node or fetch its neighborhood.
- The main workspace has tabs for chat, details, manage, and related task surfaces.
- The details tab edits or deletes the selected node/relation.
- The manage tab manually creates nodes and relationships.
- Main-workspace manual node and relationship mutations create HITL proposals.
- The HITL workspace previews pending proposals over the approved graph, allows reviewer edits, and applies approved graph/schema mutations.
- Direct HITL reviewer graph edits update Neo4j first and then sync the corresponding Chroma vector documents.
- Node vector documents include label, name, type, and description. Relationship vector documents include relation, information, description, source ID, and target ID.
- The chat tab supports asking, ingesting text, and ingesting uploaded PDF/DOCX/DOC files.
- Browser chat messages are local UI state. Recent messages can be sent as request memory for follow-up resolution, but they are not persisted server-side.
- `src/server/public/app.js` is the Preact source file. `npm run kg:web:build` bundles it to `app.bundle.js`, which is intentionally ignored by git.

API endpoints:

- `GET /api/graph?limit=150`: returns `{ nodes, relations, limit }`.
- `GET /api/nodes/search?q=pan&limit=12`: searches all Neo4j nodes by id, label, name, type, or description.
- `GET /api/nodes/:id/neighborhood?depth=1`: returns a focused graph around a node.
- `GET /api/nodes/:id/relations`: returns relationships attached to a node.
- `POST /api/nodes`: creates a pending HITL node-create proposal.
- `PUT /api/nodes/:id`: creates a pending HITL node-update proposal.
- `DELETE /api/nodes/:id`: creates a pending HITL node-delete proposal.
- `POST /api/relations`: creates a pending HITL relation-create proposal.
- `PUT /api/relations/:id`: creates a pending HITL relation-update proposal.
- `DELETE /api/relations/:id`: creates a pending HITL relation-delete proposal.
- `POST /api/ask`: accepts `{ "text": "question", "sessionId": "...", "memoryMessages": [], "includeUnverifiedKnowledge": false }` and returns `{ answer, entryNodes, graph, depth, sessionId }`.
- `POST /api/ingest`: accepts multipart `text`, `userName`, and up to 10 `file`/`files` uploads, or JSON/form text; returns applied or pending HITL graph mutation details.
- `POST /api/jobs/scanner`: runs the scanner job over a selected/random graph neighborhood.
- `POST /api/jobs/nugget`: runs the nugget job over a selected/random graph neighborhood.
- `GET /api/schema`: returns the editable graph schema.
- `PUT /api/schema`: saves editable graph schema JSON.
- `GET /api/hitl/notes`: lists pending HITL notes.
- `GET /api/hitl/notes/:id`: returns one HITL proposal.
- `GET /api/hitl/notes/:id/graph`: previews one HITL proposal over graph context.
- `POST /api/hitl/notes/:id/graph`: previews edited HITL proposal text.
- `GET /api/hitl/graph`: returns approved graph overlaid with pending HITL proposals.
- `POST /api/hitl/nodes`, `PUT /api/hitl/nodes/:id`, `DELETE /api/hitl/nodes/:id`: direct reviewer node mutations, or pending proposals when schema validation fails.
- `POST /api/hitl/relations`, `PUT /api/hitl/relations/:id`, `DELETE /api/hitl/relations/:id`: direct reviewer relation mutations, or pending proposals when schema validation fails.
- `POST /api/hitl/notes/:id/approve`: validates and applies an edited HITL proposal, then removes the pending note.
- `DELETE /api/hitl/notes/:id`: rejects and deletes a HITL proposal.
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
- `getGraphSnapshot(limit)`
- `getRandomNode()`
- `searchNodes(query, limit)`
- `getNode(nodeId)`
- `getNodeNeighborhood(nodeId, depth)`
- `getRelationsForNode(nodeId)`
- `getRelation(relationId)`
- `upsertNode(node)`
- `deleteNode(nodeId)`
- `upsertRelation(relation)`
- `deleteRelation(relationId)`
- `smokeTest()`
- `close()`

Vector stores should implement:

- `verifyConnectivity()`
- `upsertGraphIndex(graphPayload)`
- `upsertNode(node)`
- `upsertRelation(relation)`
- `deleteNodes(nodeIds)`
- `deleteRelations(relationIds)`
- `queryNodes(query, topK)`
- `upsertHitlNote(note)`
- `listHitlNotes({ status, limit, offset })`
- `getHitlNote(id)`
- `deleteHitlNotes(ids)`
- `queryHitlNotes(query, topK)`
- `smokeTest()`

To add a provider, create the adapter and update the relevant `providerFactory.js`.

## Agent Notes

- This is a POC, not a hardened service. There is no migration system, no delete/update reconciliation for removed facts, and no automated unit test framework beyond smoke-test scripts.
- `config.json` may contain local placeholders or local secrets. Inspect `config.example.json` for shape, and keep real replacement values in local-only `config.replacements.json` or another private source.
- Prompt behavior is part of the application contract. Update prompt files and README together when changing extraction or answer semantics.
- Chroma retrieval depends on its configured embedding implementation. If you switch embedding providers or dimensions, clear/recreate Chroma collections before ingesting again.
- Neo4j relationship type is always `RELATES_TO`; the semantic relation is stored in the `relation` property.
- `source` is passed into `upsertGraph()` today but is not persisted by `Neo4jGraphStore`.
- The fallback ingestion text in `src/cli/ingest.js` is intentionally large and domain-specific. It is sample data, not a schema definition.
