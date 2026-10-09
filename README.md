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
- required and optional node/relationship properties
- short descriptions that are injected into the extraction prompt

Suggested types are not stored in the schema file; they live only in HITL proposals (see below).

The custom extraction syntax supports schema suggestions without requiring JSON:

```text
NODE_TYPE_SUGGESTION|type_name|description|reason
RELATION_TYPE_SUGGESTION|relation_name|description|reason
```

Unknown node or relationship types are preserved in the proposed payload, recorded as schema violations, and forced into HITL review instead of being applied to the graph. This happens even when ingestion mode is `auto`; the reviewer must update the schema or edit the proposal to approved types before approval can apply mutations.

The default ingestion mode in `config.example.json` is `auto`. Set `ingestion.mode` to `hitl` to store normal ingestions as pending Chroma HITL proposals instead of immediately mutating Neo4j, or keep `auto` to apply schema-valid ingestions directly.

### Property Descriptors (Schema-Driven Field Guidance)

`schema/graphSchema.json` supports per-property descriptor objects in `nodeProperties.fields` and `relationshipProperties.fields`. Each descriptor includes:

- `name`: property key (e.g., `name`, `label`, `description`, `information`, `metadata`)
- `description`: brief human-facing guidance for the property
- `constraints` (optional): machine-readable guidance such as `pattern` (regex), `immutable` flag, `maxLength`, and `allowedValues`

Example node property descriptor:

```json
{
  "name": "name",
  "description": "Unique node identifier used for identity and lookup.",
  "constraints": {
    "pattern": "^[a-z0-9_]+$",
    "immutable": true
  }
}
```

These descriptors are rendered by `formatFieldGuidance()` in `src/schema/graphSchema.js` and injected through the dedicated `{{FIELD_GUIDANCE}}` placeholder in `prompts/extraction-system-custom.md`, separate from the type catalog in `{{GRAPH_SCHEMA}}` (rendered by `formatSchemaCatalog()`).

How to add or modify property descriptors:

1. Edit `schema/graphSchema.json` and add/update entries in `nodeProperties.fields` or `relationshipProperties.fields`.
2. Each entry requires at minimum a `name` and `description`. The `constraints` object is optional.
3. The next ingestion run automatically includes the updated guidance in the extraction prompt.
4. To change enforcement policy, modify the call to `validatePropertyConstraints()` in the ingestion pipeline.

#### Constraint Validation (Optional)

`validatePropertyConstraints()` in `src/ingestion/graphPayload.js` provides optional runtime validation of payload fields against schema-defined constraints. It supports:

- `pattern`: regex validation against field values
- `maxLength`: maximum string length check
- `allowedValues`: whitelist of acceptable values
- `immutable`: documented as a constraint (immutability enforcement requires DB state comparison and is not implemented in the stateless validator)

Validation is modular and toggleable. Callers pass `{ strict: true }` to get both violation objects and error strings, or use the default mode for warning-only violations. This allows teams to choose between document-only guidance (prompt-based) and strict enforcement (ingestion-time) without code changes.

Approved schema terms live only in the top-level `nodeTypes` and `relationshipTypes` arrays. Type suggestions (explicit `*_TYPE_SUGGESTION` records, or unknown types used in records) stay inside the HITL proposal. When the reviewer approves the proposal, `mergeSchemaTypes()` adds the suggested types directly to the approved arrays. Types are never promoted automatically.

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
- stored HITL proposal details when HITL mode is active
- exception details when the ingest flow fails

Each HITL regeneration from the web UI writes a timestamped `ingest-regenerate-*.log` file (enabled by the `ingest` scope) containing the reviewer notes, the rendered regeneration prompt, the raw LLM response, and exception details on failure. Agent regenerations through MCP run no LLM on the server and write no log.

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

## MCP Server (Ask & Ingest)

MindMesh exposes an MCP (Model Context Protocol) server over stdio so that any LLM or coding agent can perform the ask and ingest features without invoking MindMesh's own LLM providers. The calling agent performs all reasoning; the MCP server only retrieves context, formats prompts, and applies/stores graph mutations.

Start the MCP server:

```powershell
npm run kg:mcp
```

### Tools

- `ask` — `{ query, includeUnverifiedKnowledge? }`. Returns verified graph context, the answer system prompt, and instructions so the calling agent can answer the user's question. No LLM is invoked.
- `ingest-context` — `{ text }`. Returns retrieval-augmented extraction context (existing graph + pending HITL), the fully rendered extraction system prompt, schema catalog, field guidance, and instructions so the calling agent can extract graph records.
- `apply-ingestion` — `{ graphRecords, text, userName?, source? }`. Parses, normalizes, and applies the pipe-delimited graph records an agent extracted. Applies mutations directly when ingestion mode is `auto` and no schema violations exist; otherwise stores a pending HITL proposal and returns its `hitlNoteId` and short `hitlNoteRef` (e.g. `#d964db`).
- `regenerate-context` — `{ proposal, notes? }`. `proposal` is a HITL note id or short ref. Returns the extraction prompt for regenerating that proposal: the normal ingestion prompt plus a `REVIEWER REVISION` section with the reviewer notes and the previous proposal as baseline. `notes` from chat take precedence over notes saved in the HITL UI; one of them is required. The proposal itself is excluded from pending HITL context.
- `apply-regeneration` — `{ proposal, graphRecords, notes?, regeneratedBy? }`. Overwrites the pending proposal with the regenerated records, saves the notes, and flags it `regenerated` with origin `agent`. A block with no parseable records is rejected and the proposal is left unchanged.

### Resources

- `mindmesh://schema` — the editable graph schema.
- `mindmesh://graph` — graph preview.
- `mindmesh://hitl/notes` — pending HITL proposals.
- `mindmesh://nodes/{nodeId}` — a single graph node.
- `mindmesh://relations/{relationId}` — a single graph relation.

### Recommended ingestion flow

1. Call `ingest-context` with the user's text.
2. Reason over the returned context and extract pipe-delimited graph records following the `extractionSystemPrompt`.
3. Call `apply-ingestion` with the extracted records.

### Recommended regeneration flow

The user names a pending HITL proposal by its full id or the short ref shown in the HITL UI (e.g. `#d964db`), with instructions in chat or saved as reviewer notes in the UI.

1. Call `regenerate-context` with the proposal reference and any chat instructions as `notes`.
2. Produce the complete revised graph records following the returned `extractionSystemPrompt`.
3. Call `apply-regeneration` with the same proposal reference, the records, and the notes. The proposal stays pending for approval in the HITL UI.

The MCP server reuses the existing `HybridRagService`, `IngestionService`, graph/vector stores, prompt registry, and schema modules. It never creates an LLM provider. A smoke test is available at `src/mcp/smokeTest.js` (requires Neo4j and ChromaDB running). Note that it calls `apply-ingestion`, so in `hitl` mode it leaves a pending proposal in the queue.

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

By default this deletes the three configured app collections, `kg_nodes`, `kg_relationships` and `fleeting_notes_hitl` (pending HITL proposals are lost), and does not require Chroma reset/admin permissions. To rebuild only the graph vectors, use `npm run kg:reindex-vectors` instead.

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

Neo4j is the source of truth; Chroma node and relation vectors are derived from it and share the same ids (`node:<name>`, `rel:<hash>`). The npm script runs `src/cli/reindexVectors.js` with `--fresh`: it empties `kg_nodes` and `kg_relationships` and rebuilds them exactly from Neo4j, so vectors of items deleted or re-identified directly in Neo4j disappear too. HITL proposals in `fleeting_notes_hitl` are not touched.

`--fresh` refuses to run when the graph has at least `--limit` nodes (default 5000), since vectors beyond the limit would be dropped. To only upsert without emptying the collections first, run the script directly without the flag:

```powershell
node src/cli/reindexVectors.js
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

The ingestion pipeline now uses a single, custom line-oriented extraction format. Extraction prompt files are templates. Ingestion renders `{{GRAPH_SCHEMA}}`, `{{FIELD_GUIDANCE}}`, `{{EXISTING_GRAPH_CONTEXT}}`, `{{USER_INPUT}}`, and `{{REVIEWER_REVISION}}` into the custom extraction prompt before calling the LLM. `{{REVIEWER_REVISION}}` is empty for normal ingestion; when a HITL proposal is regenerated it holds the reviewer notes and the previous proposal (see HITL Regeneration). Existing graph context is retrieved from Chroma and expanded through Neo4j; pending HITL context is also retrieved from the Chroma HITL collection. Both context sources are intended for identity resolution, node-name reuse, disambiguation, and avoiding duplicate facts. New graph facts should still come from `{{USER_INPUT}}`.

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

The trailing `metadata` field only carries HITL review signals (`AMBIGUITY:<reason>` or `CONTRADICTION:<reason>`). It exists only inside proposals, where it drives review-signal counts, filters and badges, and is never persisted to Neo4j or Chroma when a proposal is applied.

For relationships, `sourceName`, `relation`, and `targetName` already express the core fact. `information` should contain only extra qualifiers such as conditions, timing, scope, state, or reason; leave it empty when it would merely repeat the relation. `description` is reserved for longer source-backed explanation. Node descriptions should add useful context or disambiguation, not restate the label/type.

`extractCustomGraph()` accepts raw, fenced, or demarcated custom graph records. When demarcators are present, text outside them is ignored; otherwise it falls back to parsing the full response. It ignores blank/header lines, captures schema suggestion records, and supports create/update/delete operation records. Unparseable text yields an empty graph rather than an error, so callers that overwrite data (HITL regeneration) check for zero records themselves.

`normalizeGraphPayload()` then:

- Converts node names, node types, and relation names to lowercase snake case.
- Enforces the loaded graph schema when one is supplied.
- Preserves unknown node or relationship types as schema violations so HITL can review the exact model output, and records them as implicit type suggestions in the payload (not in the schema file).
- Blocks graph application while schema violations are present.
- Creates node IDs as `node:<name>` when no ID is provided.
- Creates missing endpoint nodes for relations.
- Creates relationship IDs as `rel:<12-char-sha1>` when no ID is provided.
- Defaults missing descriptions to empty strings.
- Preserves empty relation `information` instead of generating redundant relation text.
- Carries node/relation create, update, and delete operations into HITL or graph application.
- Returns `schemaSuggestions`, `schemaWarnings`, and `schemaViolations` for CLI/API visibility and HITL schema approval.

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

The `type` and `relation` properties carry the semantic type; Neo4j labels and relationship types are fixed (`KnowledgeNode`, `RELATES_TO`) so schema types can change without database migrations. The configured database is `graph.neo4j.database` (the default database is used when it is `neo4j`).

### Identity and uniqueness

MindMesh uses its own `id` property, never Neo4j's internal element id. The same `id` is the record id in Chroma, so no cross-reference field is needed.

- Node ids are `node:<name>`, derived from the snake_case name.
- Relationship ids are `rel:<12-char-sha1>` of `sourceId:relation:targetId`.
- Uniqueness is enforced by Neo4j constraints that the graph store creates once per process before its first write: `knowledge_node_id` (unique `KnowledgeNode.id`) and, on Neo4j 5.7 and later, `relates_to_id` (unique `RELATES_TO.id`). The syntax adapts to the Neo4j version (3.5, 4.x, or 5+/calendar versions). On older versions relationship uniqueness relies on the deterministic ids.
- The name of a node that already exists is permanent, because it is part of the id. The web/HITL update routes reject a different name and the UI shows the Name field read-only; the label can always be changed. Nodes that exist only in a pending proposal can still be renamed.
- Editing a relation directly in the HITL workspace recomputes its id from the new source, relation, and target; if the id changes, the old relation and its vector are deleted. Relation updates submitted as proposals become a delete of the old relation plus a create of the new one.

### Write behavior

`upsertGraph()` uses `MERGE` by node `id` and relationship `id`. Re-ingesting the same normalized fact updates properties and preserves `createdAt`. In this path an empty `description` (and empty relation `information`) keeps the stored value instead of clearing it, so passing mentions do not wipe existing text. `label`, `name`, and `type` are always overwritten. Direct HITL edits (`upsertNode()`, `upsertRelation()`) set fields exactly as submitted, so clearing a description is done through the edit form.

`upsertGraph()` returns the nodes and relationships as Neo4j stored them, and the vector index is built from that result. Ingestion and `kg:reindex-vectors` therefore produce identical vector documents. Relationships whose endpoint node does not exist are not stored and not indexed.

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
- `description`

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
- `information`
- `description`

Node and relationship vectors share their ids with Neo4j and are derived from it; `npm run kg:reindex-vectors` rebuilds them (see Commands).

HITL note documents contain the pending proposal status, user/source metadata, original input, and LLM proposed graph mutations. Their metadata includes:

- counts for proposed node/relation upserts, deletions, schema suggestions, ambiguity signals, and contradiction signals
- `reviewerNotes`: the latest reviewer notes, saved from the HITL UI or by an agent
- `regenerated`, `regeneratedBy`, `regeneratedAt`, `regenerationOrigin` (`ui` or `agent`): set when the proposal was regenerated. The proposal is overwritten and no history is kept.

HITL note ids look like `hitl:<base36-time>:<12 hex>`. The HITL UI also shows a short reference made of `#` plus the first 6 hex characters (e.g. `#d964db`), and the MCP tools accept it in place of the full id when it matches exactly one pending note.

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

## HITL Regeneration

A reviewer can regenerate a pending proposal with instructions instead of editing it row by row. Both entry points share `IngestionService.buildHitlRegenerationPrompt()` and `storeHitlRegeneration()`:

- Web UI: reviewer notes + **Regenerate** call `POST /api/hitl/notes/:id/regenerate`, which runs the server's configured LLM (`regenerateHitlProposal()`).
- MCP: `regenerate-context` and `apply-regeneration`, where the calling agent does the reasoning.

Behavior:

1. The original user input is extracted again with the normal extraction prompt plus the `{{REVIEWER_REVISION}}` section (`formatReviewerRevision()` in `src/prompts/promptRegistry.js`). That section contains the reviewer notes as top-priority instructions and the previous proposal as the baseline to keep unless the notes ask for a change. The web UI sends the current draft, including unsaved manual edits, as that baseline.
2. Graph context is retrieved again, with this note excluded from the pending HITL context. Otherwise its own previous creates would be reconciled into updates.
3. The response must contain at least one record. The parser returns an empty graph for unparseable text, so an empty result is rejected and the proposal is left unchanged.
4. The proposal is overwritten (no history), counts are recomputed, the notes are saved, and the regeneration fields are set. The original submitter and creation time are kept, and the proposal stays pending for approval.

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
- The graph preview has two renderers, toggled in the graph header: NeoVis (default) and Graphology + Sigma with force-layout positioning. Both support pan/zoom, hover focus, click-to-select focus, and compact relationship labels.
- The graph panel includes instant client-side search over the loaded preview and full Neo4j search on submit. Search results focus a loaded node or fetch its neighborhood.
- The main workspace has tabs for chat, details, manage, and related task surfaces.
- The details tab edits or deletes the selected node/relation. The Name field is read-only for nodes that already exist in the graph, because the name is part of the node id; change the label instead.
- The manage tab manually creates nodes and relationships.
- Main-workspace manual node and relationship mutations create HITL proposals.
- The HITL workspace previews pending proposals over the approved graph, allows reviewer edits, and applies approved graph/schema mutations.
  - Submission cards show per-operation counts, e.g. `12N (8C 3U 1D) 5R (5C) 2NT 1RT` (N nodes, R relations, NT/RT node/relation type suggestions; C/U/D create/update/delete, zero counts omitted). They are parsed client-side with the same parser as the detail view. Cards also show the short `#ref` and Regenerated/Notes tags.
  - The proposal detail is a collapsible tree: Nodes and Relations each split into Create, Update, and Delete; Schema suggestions split into Node types and Relation types; then Review signals.
  - Update and delete rows compare Current against the approved DB version: preview graph items carry an `approved` snapshot because the preview merges the proposal over the DB item.
  - The detail shows the full proposal id with a copy button, a Reviewer notes box with **Save notes** and **Regenerate** (see HITL Regeneration), and a copy button on the raw piped response for backups before regenerating.
- Direct HITL reviewer graph edits update Neo4j first and then sync the corresponding Chroma vector documents.
- Node vector documents include label, name, type, and description. Relationship vector documents include relation, information, description, source ID, and target ID.
- The chat tab supports asking, ingesting text, and ingesting uploaded PDF/DOCX/DOC files.
- Browser chat messages are local UI state. Recent messages can be sent as request memory for follow-up resolution, but they are not persisted server-side.
- Frontend source lives in `src/server/public`: `app.js` holds the `App` component (state, handlers, routes) and the entry point; components are one per file under `components/` (`common`, `graph`, `chat`, `entity`, `hitl`, `schema`, `jobs`); shared helpers are in `lib/`. `npm run kg:web:build` bundles everything from `app.js` into `app.bundle.js`. The bundle is tracked in git, so rebuild before committing UI changes.

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
- `GET /api/hitl/notes`: lists pending HITL notes, each with its counts, review-signal counts, reviewer notes, regeneration fields, and `llmResponse` (used for per-operation card counts).
- `GET /api/hitl/notes/:id`: returns one HITL proposal.
- `GET /api/hitl/notes/:id/graph`: previews one HITL proposal over graph context.
- `POST /api/hitl/notes/:id/graph`: previews edited HITL proposal text.
- `GET /api/hitl/graph`: returns approved graph overlaid with pending HITL proposals. In both preview endpoints, pending items carry `pendingHitl`, `pendingOperation`, `hitlNoteId`, and `approved` (the DB version before the proposal, absent for items not yet in the graph).
- `POST /api/hitl/nodes`, `PUT /api/hitl/nodes/:id`, `DELETE /api/hitl/nodes/:id`: direct reviewer node mutations, or pending proposals when schema validation fails.
- `POST /api/hitl/relations`, `PUT /api/hitl/relations/:id`, `DELETE /api/hitl/relations/:id`: direct reviewer relation mutations, or pending proposals when schema validation fails.
- `PUT /api/hitl/notes/:id/reviewer-notes`: saves reviewer notes on a pending proposal.
- `POST /api/hitl/notes/:id/regenerate`: accepts `{ reviewerNotes, llmResponse, reviewedBy }`, re-runs extraction on the original input with the notes and the current draft as baseline, and overwrites the proposal. Fails without changing the note if the LLM output has no records.
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
