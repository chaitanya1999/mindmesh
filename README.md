# MindMesh

Prototype personal knowledge management system that extracts graph facts from text/documents, stores approved facts in Neo4j, indexes approved graph records and pending HITL proposals in ChromaDB, and answers questions with a hybrid vector + graph RAG flow.

Its working rule is "LLMs suggest, humans approve, schema enforces": extracted facts become HITL proposals that a reviewer approves, edits, or regenerates with notes before they reach the graph (in `auto` mode, clean creates and updates are applied directly; anything with a schema violation, an ambiguity, a contradiction, or a delete still goes to review). The same pipeline is available three ways: the web UI, the CLIs, and an MCP server that lets any MCP-capable coding agent do the LLM reasoning without MindMesh needing its own LLM key.

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
  -> HITL proposal stored in Chroma in HITL mode or when reviewReasons() finds any
  -> otherwise Neo4jGraphStore.applyGraph() (one transaction)
  -> ChromaVectorStore vector sync

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

HITL review
  -> pending proposal (Chroma HITL collection)
  -> reviewer edits / reviewer notes + regenerate (HitlService.regenerate)
  -> approve: HitlService.approve() -> GraphWriteService.applyPayload()
  -> Neo4jGraphStore.applyGraph() (one transaction) + ChromaVectorStore vector sync
  -> schema types merged, note deleted

MCP agent (no MindMesh LLM)
  -> src/mcp/server.js (stdio)
  -> read tools explore the graph and pending proposals (GraphReadService, HitlService)
  -> get_ingest_prompt / get_regenerate_prompt return context + MindMesh prompts
  -> the agent reasons, then submit_ingest / submit_regeneration go through HitlService
```

## Runtime Stack

- Node.js ES modules; package root is the repository root.
- LLM providers:
  - Gemini via `@google/genai`, default model `gemini-2.5-flash`.
  - Ollama via local HTTP API, default model `mistral`.
  - Custom HTTP endpoint via Gemini-style or OpenAI-compatible subproviders.
  - Hackathon hub chat-completions proxy, default model `gpt-4.1-nano`.
- Graph database: Neo4j using the official `neo4j-driver`. Requires Neo4j 5.23 or later (Community or Enterprise; calendar versions such as 2025.x and 2026.x included). Tested with Community 5.26 and Enterprise 2026.04.
- Vector database: ChromaDB using `chromadb`.
- Embeddings: Gemini `gemini-embedding-001` by default; hub embeddings and Chroma's default embedder are also supported.
- Web server: Express serving JSON APIs and the bundled Preact/CSS frontend.
- Graph UI: Preact for UI state; two graph renderers: NeoVis (`neovis.js`, default) and Graphology + Graphology force layout + Sigma.
- MCP server: `@modelcontextprotocol/sdk` over stdio.
- Document ingestion uploads: PDF via `pdf-parse`, DOCX via `mammoth`, and DOC via `word-extractor`.
- Prompt files live under `/prompts`.

## Important Files

- `src/config.js`: central config loader. Reads repo-root `config.json`, applies optional `{{KEY}}` placeholders from `config.replacements.json` or caller-supplied replacements, and returns the parsed runtime config.
- `src/input/readInput.js`: shared CLI argument parser for `--file`, `--interactive`, `--provider`, `--scope`, and positional text.
- `src/cli/ingest.js`: ingestion entry point with a large fallback sample graph text.
- `src/cli/ask.js`: question-answering entry point.
- `src/cli/testConnections.js`: Neo4j and Chroma connectivity plus write/query smoke tests.
- `src/cli/testLlm.js`: provider reachability and graph extraction smoke test.
- `src/cli/testParser.js`: local custom extraction and graph normalization smoke test.
- `test/`: `npm test` suite (`node:test`): the web API and MCP tools over in-memory stores (`test/helpers/`), plus a check that only `GraphWriteService` calls store write methods.
- `src/mindmesh.js`: composition root. `createMindMesh(config, overrides)` builds the stores and services once for the web server, the MCP server, and the CLIs (tests pass in-memory stores and a scripted LLM as overrides).
- `src/hitl/hitlService.js`: human-in-the-loop decisions. Submit (auto apply or proposal), list, preview, reviewer notes, regenerate, approve, reject, short refs, manual proposals from the main page, and direct reviewer edits.
- `src/graph/graphWriteService.js`: the one gate for graph writes. Graph check, one Neo4j transaction, Chroma vector sync, and the `VECTOR_SYNC_FAILED` error.
- `src/ingestion/ingestionService.js`: retrieval-augmented extraction: graph and pending-proposal context, the extraction prompt, the LLM call, and `prepareExtraction()` (reconcile, normalize, graph check).
- `src/ingestion/graphPayload.js`: parses and normalizes LLM graph output into stable node and relationship payloads.
- `src/ingestion/reviewSignals.js`: detects ambiguity and contradiction review signals in proposed graph records.
- `schema/graphSchema.json`: schema registry for allowed node types, relationship types, required properties, and LLM-facing descriptions.
- `src/schema/graphSchema.js`: loads the schema registry and formats the schema catalog injected into extraction prompts.
- `src/graph/neo4jGraphStore.js`: Neo4j persistence, search, graph expansion, direct CRUD, and smoke test implementation.
- `src/vector/chromaVectorStore.js`: Chroma node/relation/HITL collections, vector query, and smoke test implementation.
- `src/embedding/geminiEmbeddingProvider.js`: Gemini embedding adapter used to precompute Chroma vectors without downloading Hugging Face models.
- `src/embedding/hubEmbeddingProvider.js`: OpenAI-compatible hub embedding adapter.
- `src/rag/hybridRagService.js`: vector entry-point retrieval, Neo4j expansion, context formatting, and final answer generation.
- `src/jobs/kgJobsService.js`: graph job runner for scanner and nugget prompts.
- `src/llm/geminiProvider.js`, `src/llm/ollamaProvider.js`, `src/llm/customHttpProvider.js`, and `src/llm/hubChatProvider.js`: LLM provider adapters with the same small interface.
- `src/server/server.js`: Express web entry point (HTTP only: request parsing, uploads, response shapes) for ask, ingest, graph, schema, jobs, and HITL APIs. `createApp(services)` builds the app without listening; the file starts the server only when run directly.
- `src/server/public`: Preact UI. `app.js` (App state/handlers and routes), `components/` (one component per file: `common`, `graph`, `chat`, `entity`, `hitl`, `schema`, `jobs`), `lib/` (shared helpers, including the client-side HITL proposal parser `lib/hitlProposal.js`), `styles.css`, and the built `app.bundle.js` (gitignored build output).
- `src/mcp/server.js`: MCP server (graph and proposal read tools, ingestion, regeneration, optional review decisions); `createMcpServer(services)` builds it without a transport, and the file connects stdio only when run directly. `src/mcp/smokeTest.js` is its smoke test.
- `src/graph/graphReadService.js`: read-only graph views for agents: node and relation search, `getNode`, traversal, paths, read-only Cypher, and the schema overview.
- `src/prompts/promptRegistry.js`: loads prompt files and renders the extraction prompt placeholders, including the HITL reviewer revision section.
- `src/rag/graphContext.js`: formats graph context for Ask (`formatGraphContext`) and for extraction (`formatExtractionGraphContext`).
- `src/logging/debugLogger.js`: opt-in, scope-filtered debug log files.
- `src/*/providerFactory.js` (`llm`, `embedding`, `graph`, `vector`): pick the configured provider implementation.
- `src/cli/reindexVectors.js`: rebuilds Chroma node/relation vectors from Neo4j; `src/cli/clearChroma.js`: deletes Chroma collections.
- `src/admin/`: admin panel logic. `adminService.js` (overview, consistency, backup, wipe, reindex, query console), `adminAuth.js` (password hashing, sessions, lockout), `auditLog.js`. Routes are in `src/server/adminRoutes.js`; `src/cli/adminPassword.js` sets the password.
- `prompts/`: extraction, answer, context-format, and job prompt templates.
- `MEMORY_BANK/`: compressed context for coding agents: `core.md` (purpose and hard rules), `codeMap.md` (where each pathway lives in the code), `activeContext.md` (the current task), `roadmap.md` (planned work). `CLAUDE.md` tells Claude Code how to use them. This README stays the single source for behavior.

## Setup

Install dependencies from the repo root:

```powershell
npm install
```

Run Neo4j and ChromaDB locally. Defaults are:

```text
Neo4j bolt: bolt://localhost:7687
Neo4j database: neo4j   (set graph.neo4j.database for a named database)
Chroma: http://localhost:8000
```

`npm run chroma:start` starts a local Chroma server with data in `./chroma_data` (requires the Python `chroma` CLI).

Create a local POC config and graph schema if needed (`config.json`, `config.replacements.json`, and `schema/graphSchema.json` are gitignored, so a fresh clone only has the examples):

```powershell
Copy-Item .\config.example.json .\config.json
Copy-Item .\config.replacements.example.json .\config.replacements.json
Copy-Item .\schema\graphSchema.example.json .\schema\graphSchema.json
```

Without `schema/graphSchema.json`, ingestion and the server fail with `Graph schema file not found`.

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

`getConfig()` reads and parses `config.json` from the repository root, then applies optional replacements to its string values. The config loader does not read application settings from environment variables and does not supply hardcoded fallback defaults; required defaults should live in `config.json` or `config.example.json`. The only environment variables used anywhere are `KG_WEB_PORT` / `PORT` for the web server port.

Replacement model:

1. `config.json` is the complete application config.
2. Placeholders use `{{KEY}}` syntax and are matched by uppercase letters, digits, and underscores, for example `{{GEMINI_API_KEY}}`, `{{NEO4J_PASSWORD}}`, or `{{CHROMA_URL}}`.
3. `config.replacements.json` supplies replacement values from the repository root when the file exists (`config.replacements.example.json` shows the keys `config.example.json` uses). Both files are gitignored.
4. Placeholders are replaced inside the parsed string values, never in the raw JSON text, so values with quotes, backslashes, or Windows paths are kept exactly. A placeholder must therefore sit inside a JSON string. A string that is only a placeholder (`"{{TOP_K}}"`) takes the replacement value with its own type, so numbers and booleans stay numbers and booleans.
5. Callers may pass an explicit map with `getConfig(replacements)`; values from `config.replacements.json` win over it.
6. Unresolved placeholders stay as literal strings and print one warning listing the keys (on stderr). Placeholders for unused providers are therefore harmless. Use `getConfig(replacements, { strict: true })` to fail instead.
7. A `config.replacements.json` that is not valid JSON, or not a JSON object, fails with an error naming the file.

`mcp.allowReviewDecisions` (default `false`) registers the MCP tools `approve_proposal` and `reject_proposal`; see MCP Server.

`admin.passwordHash` (written by `npm run kg:admin:password`, empty by default, which disables the admin panel) and `admin.sessionMinutes` (default 30) configure the admin panel; see Admin Panel.

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

The default ingestion mode in `config.example.json` is `auto`. Set `ingestion.mode` to `hitl` to store every ingestion as a pending Chroma HITL proposal instead of mutating Neo4j.

In `auto` mode only clean creates and updates are applied directly. An extraction becomes a HITL proposal instead when `reviewReasons()` (`src/ingestion/reviewSignals.js`) finds any of:

- a schema violation (including a `relationEndpoint` violation from the graph check);
- an `AMBIGUITY:` or `CONTRADICTION:` signal in any record's `metadata`, including the `AMBIGUITY:` the graph check adds when `NODE_CREATE` targets an existing node;
- a `NODE_DELETE` or `RELATION_DELETE` record (a relation re-target is a delete plus a create, so it is reviewed too).

Web/CLI ingest and MCP `submit_ingest` use the same rule and return the reasons as `reviewReasons`. Severity levels per signal (auto-applying only low-severity ones) are planned, not implemented.

### Scope (business units)

Nodes and relations can carry a `scope`: a list of values saying which parts of the organisation they belong to. For the LOS project the values are the business units `uc`, `nc`, `tw`, `cv`, `tr`, plus `common` for things every unit shares. The allowed values are the `constraints.allowedValues` of the `scope` field descriptor in `nodeProperties.fields` (and `relationshipProperties.fields` for relations, which falls back to the node list); without a descriptor any value is accepted. The rules are in `src/schema/scope.js`. An existing local `schema/graphSchema.json` needs the two `scope` descriptors copied from `graphSchema.example.json`; the picker and the validation read the values from there.

- An empty scope means "not curated, or not needed" and is the normal state for shared technical artefacts. `common` cannot be combined with other values. An unknown value or `common` with other values is a `scope` schema violation, so the record goes to review.
- Business-unit specific concepts are named with the unit as a prefix (`uc_qde_screen`, `nc_qde_screen`), because the same concept in two units is two nodes. MindMesh never derives the scope from the name.
- Filtering with one value `f` (ingest context, Ask, MCP reads): a blank filter matches everything; `f = uc` matches items whose scope contains `uc` or `common`, and unscoped items; `f = common` matches `common` and unscoped items. Items scoped only to other values are left out. Graph expansion does not follow a neighbour or a relation that fails the filter.
- Writes: in a payload apply (ingest, approval) a blank scope keeps the stored value and a filled one replaces it, like `description`. Direct reviewer edits set the scope exactly as submitted (an empty selection clears it). A record that replaces the non-empty scope of an existing node gets an `AMBIGUITY:` signal (`scope of "x" changes from uc to nc`), so auto mode sends it to review.
- The ingest scope (web picker, MCP `scope`, CLI `--scope`) filters the retrieved context, is named in the prompt through `{{INGEST_SCOPE}}`, and is stored on the proposal; regeneration reuses it. It does not stamp a scope on records: the model (or reviewer) sets record scopes, following the SCOPE RULES in the extraction prompt.

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

## MCP Server

MindMesh exposes an MCP (Model Context Protocol) server over stdio so that a coding agent (for example Claude in Agentforce or VS Code) can explore the knowledge graph and propose new knowledge without MindMesh calling its own LLM. The agent does all reasoning; the server retrieves context, hands out MindMesh's extraction prompts, and stores the agent's records through the same HITL path as the web UI.

Start the MCP server:

```powershell
npm run kg:mcp
```

stdout carries the MCP protocol, so the server sends all of its console output to stderr.

### Conventions

- Tool names are `verb_noun` in snake_case. Descriptions carry the workflow; the agent needs no extra setup.
- `node`, `from`, and `to` accept a node id (`node:ekyc_screen`) or a bare name (`ekyc_screen`); `ref` accepts a proposal id or a short ref (`#d964db`).
- One node shape (`id`, `name`, `label`, `type`, `description`, `scope`) and one relation shape (`id`, `relation`, `sourceId`, `targetId`, `information`, `description`, `scope`).
- `scope` arguments take one value (allowed values listed in the argument description, from the schema when the server starts). On the read tools it is an optional filter (see Scope). On `get_ingest_prompt` and `submit_ingest` it is required, and the description tells the agent to ask the user for it when they have not said; `""` means no scope. Semantic results come from Chroma, but records are always read from Neo4j; vectors whose node is gone are skipped.
- Pending proposals are unverified: every pending item carries `verified: false` and a `ref`.
- Read tools are marked `readOnlyHint`; `submit_regeneration` and the review decisions are marked `destructiveHint` (and `submit_ingest` too in `auto` mode, where it can apply updates).
- Errors for bad input or unknown ids are `InvalidParams`; an unknown node points the agent to `search_nodes`.

### Approved graph (read-only)

- `search_context` — `{ query, includePending?, depth?, scope? }`. MindMesh's Ask retrieval without an answer prompt: closest nodes by meaning, expanded `depth` hops (0..4, default the server setting), formatted as context, plus the entry nodes with their distance. `includePending` adds pending proposals as unverified knowledge.
- `search_nodes` — `{ query, match?, type?, scope?, limit? }`. `match: "semantic"` (default) ranks by meaning over the node vectors; `match: "text"` is a case-insensitive match on id, label, name, type, and description in Neo4j, exact label/name matches first. `type` filters by node type. `limit` 1..50, default 10.
- `search_relations` — `{ query, relationType?, scope?, limit? }`. Semantic search over the relation vectors; each result also has its `source` and `target` node (`id`, `label`, `type`).
- `get_node` — `{ node, includePending? }`. The node, `relationCount`, and its relations grouped as `outgoing` / `incoming` by relation type. `includePending` (default true) adds `pendingChanges`: pending proposals that would change the node or a relation using it.
- `explore_graph` — `{ from, depth?, direction?, relationTypes?, nodeTypes?, scope?, limit? }`. Breadth-first walk from one node, 1..4 hops (default 1). `direction: "out"` follows relations the node starts (what it uses), `"in"` relations pointing at it (what uses it), `"both"` (default) all. Each node carries its hop `distance`; `truncated` is true when `limit` (default 100, max 500) cut the result.
- `find_paths` — `{ from, to, maxDepth?, relationTypes?, limit? }`. Shortest paths in either direction, up to `maxDepth` relations (1..6, default 4); each path has a readable `summary` (`A -[uses]-> B <-[contains]- C`), its nodes, and its relations.
- `query_cypher` — `{ cypher, params?, limit? }`. One read-only Cypher query for answers the fixed tools would need many calls for. Neo4j's `EXPLAIN` must report the query as read-only (`r`), it runs in a read transaction with a 10 second timeout, and at most `limit` rows (default 100, max 500) are returned, with `truncated`. `LOAD CSV`, `dbms.*`, `apoc.*`, and `SHOW` commands other than `SHOW INDEXES` / `SHOW CONSTRAINTS` are refused. Values come back as plain JSON (integers as numbers, nodes and relationships as their properties).
- `get_schema` — `{}`. Approved node and relation types with descriptions and how many nodes or relations use each, `totals`, `unapprovedTypesInGraph` (types still in the graph but no longer in the schema), `scopeValues` (allowed scope values, or null), and the field guidance.

### Pending proposals (read-only, unverified)

- `search_proposals` — `{ query, limit? }`. Semantic search over pending proposals; short summaries (`ref`, author, source, counts, signals, reviewer notes, distance).
- `list_proposals` — `{ signal?, operation?, author?, source?, scope?, limit? }`. The review queue, oldest first, with `total`. Filters (`signal`: `ambiguity` / `contradiction`; `operation`: `create` / `update` / `delete`; `author`; `source`; `scope`, the proposal's ingest scope) apply to every pending proposal before `limit` (default 20).
- `get_proposal` — `{ ref }`. The proposal detail (input, pipe text, parsed `records`) and `changes`: one entry per record with `proposed` and `current` values (`current` is null for a new record, `proposed` is null for a delete) and its review signal.

### Proposing knowledge

- `get_ingest_prompt` — `{ text, scope }`. Runs MindMesh's default retrieval, filtered by `scope`, and returns `extractionSystemPrompt` (the exact extraction prompt: record format, schema types, field guidance, retrieved context, the text), `retrievedNodes`, `pendingNodes`, `retrievalQuality` (entry-node count, closest distance, and a note), `ingestionMode`, `scope`, and `instructions`.
- `submit_ingest` — `{ records, text, scope, author?, source? }`. `scope` is stored on the proposal and filters the pending-proposal reconciliation. Submits the agent's record block. It is prepared exactly like a web ingestion (reconciled with pending proposals, normalized, checked against the graph), then applied in `auto` mode when clean or stored as a proposal (see Graph Schema for the review reasons). Returns `status`, `applied`, `ref` and `id` when pending, `reviewReasons`, `counts`, `nodeIds`, `relationIds`, `schemaViolations`, and `schemaWarnings`.
- `get_regenerate_prompt` — `{ ref, notes? }`. The extraction prompt plus the reviewer-revision section for one proposal. `notes` from chat win over notes saved in the HITL UI; one of them is required. Also returns the original text, the previous proposal, `retrievedNodes`, and `instructions`. The proposal itself is excluded from pending context.
- `submit_regeneration` — `{ ref, records, notes?, author? }`. Overwrites the pending proposal with the revised records, saves the notes, and marks it regenerated with origin `agent`. A block with no records is rejected and the proposal is left unchanged.
- `save_reviewer_notes` — `{ ref, notes }`. Saves (replaces) the reviewer notes on a proposal.

### Review decisions (off by default)

Registered only when `mcp.allowReviewDecisions` is `true` in `config.json` (default `false`); otherwise the server cannot approve or reject, whatever the agent does.

- `approve_proposal` — `{ ref, reviewer, records? }`. Exactly like Approve in the HITL UI, optionally with edited records: schema check, approved type suggestions merged, graph applied through `GraphWriteService`, proposal removed. Logged to stderr.
- `reject_proposal` — `{ ref, reviewer, reason }`. Deletes the proposal. The reason is logged to stderr only; MindMesh keeps no proposal history yet.

### Resources

- `mindmesh://schema` — the editable graph schema.
- `mindmesh://graph` — graph preview.
- `mindmesh://hitl/notes` — pending HITL proposals.
- `mindmesh://nodes/{nodeId}` — a single graph node.
- `mindmesh://relations/{relationId}` — a single graph relation.

### Agent workflows

The tool descriptions, the `instructions` returned by the prompt tools, and the server instructions describe these; the user configures nothing.

- Question: `search_context` first; then `search_nodes`, `get_node`, `explore_graph`, `find_paths`, or `query_cypher` when it misses something. Cite node and relation ids; keep pending knowledge separate.
- Ingestion: ask the user for the scope if not given → `get_ingest_prompt` → check every entity in the text against `retrievedNodes` / `pendingNodes` and look up the missing ones (`search_nodes` text, then semantic; `get_node` to confirm) → extract, reusing exact names → `submit_ingest` → report the outcome and `ref`.
- Regeneration: `get_regenerate_prompt` → apply the notes, keeping unchanged records → `submit_regeneration` → report the `ref`.
- Review: `list_proposals` / `search_proposals` → `get_proposal` → `save_reviewer_notes`; approval by a person in the HITL UI, or with `approve_proposal` / `reject_proposal` when enabled and the user explicitly asks.

The MCP server never creates an LLM provider. `src/mcp/smokeTest.js` (requires Neo4j and ChromaDB) starts the server over stdio, calls the main tools, checks that stdout carries only protocol messages, and removes its throwaway nodes or proposal afterwards. Tests: `test/mcpServer.test.js`.

## Admin Panel

`/admin` is a password-protected maintenance page for the owner. It is reachable from any machine that can reach the web server, so it relies on the password alone.

Setup: run `npm run kg:admin:password` on the machine running MindMesh, then restart the web server. The command asks for the password twice, without echoing it (at least 10 characters), and stores only a scrypt hash in `admin.passwordHash` of `config.json`. It keeps the file's placeholders and line endings. Run it again to change the password; `--stdin` reads the password from standard input (exactly; only the line break is stripped), and `--config <path>` writes to another config file. Until a hash is set, `/admin` shows setup instructions and every `/api/admin` route returns 503.

Security:

- Login creates an in-memory session (cookie `mm_admin`: `HttpOnly`, `SameSite=Strict`, `Path=/api/admin`), valid for `admin.sessionMinutes` (default 30). Restarting the server ends all sessions.
- Five wrong passwords from one address lock it out for 15 minutes (status 429). Wrong passwords count both at login and when re-entering the password for a wipe.
- The four wipes need a session, the password again, and the typed confirmation word `DELETE`. The UI keeps their buttons disabled until both are entered. Reindex and Repair rebuild only derived vectors, so they need just the session (and a browser confirm for Reindex).
- Over plain HTTP the password and the session cookie travel unencrypted. Use the admin panel from another machine only on a trusted network, or put HTTPS in front of the server.
- Every login, rejected password, backup download, wipe, reindex, and repair (with its outcome) is appended as one JSON line to `admin-audit.log` in `logging.directory`. Passwords are never logged.

Tabs:

- **Overview**: runtime (providers, models, Neo4j and Chroma addresses), the Neo4j version and edition, constraints and indexes, nodes outside `KnowledgeNode`, node and relation counts per type, every Chroma collection with its role (`nodes`, `relations`, `proposals`, or other) and count, and the number of pending proposals. Schema health lists types present in the graph but missing from the schema, and approved types no node or relation uses.
- **Maintenance**:
  - The consistency check compares Neo4j ids with the node and relation vectors and reports records without a vector and vectors without a record. **Repair** indexes the missing records and deletes the orphan vectors.
  - **Download backup** saves a JSON file (`format: "mindmesh-backup"`, `version: 1`) with the graph (up to 10000 nodes; `truncated` says when there were more) and all pending proposals, the only data that cannot be rebuilt. Restoring from a backup is not implemented yet.- **Query console**: read-only Cypher with JSON parameters and a row limit, under the same rules as MCP `query_cypher`, with the results in a table. Vector match runs one text query against the selected Chroma collections and lists the top matches per collection; a collection that fails (for example one built with another embedding) shows its error without stopping the others.
- **Danger zone**:
  - **Reindex** rebuilds `kg_nodes` and `kg_relationships` from Neo4j, like `npm run kg:reindex-vectors`.
  - **Delete Neo4j data** removes every `KnowledgeNode` and its relations (in batches of 1000) and clears the graph vectors to keep the stores in sync. Other node labels, constraints, and indexes are kept.
  - **Delete graph vectors** clears only `kg_nodes` and `kg_relationships`. Run Reindex or Repair afterwards.
  - **Delete all proposals** clears the HITL collection.
  - **Delete everything** does all of the above.
  - Download a backup first.
- **Audit log**: the newest admin actions.

Graph and vector maintenance goes through `GraphWriteService` like every other graph write; the proposal wipe goes through `HitlService`.

API (session required, except `status`, `login` and `logout`):

- `GET /api/admin/status`: `{ configured, authenticated }`.
- `POST /api/admin/login` `{ password }`, `POST /api/admin/logout`.
- `GET /api/admin/overview`, `GET /api/admin/consistency`, `GET /api/admin/audit?limit=100`.
- `GET /api/admin/backup`: the backup as a JSON attachment.
- `POST /api/admin/consistency/repair`, `POST /api/admin/reindex`.
- `POST /api/admin/wipe` `{ target, password, confirm: "DELETE" }`, with `target` = `graph`, `vectors`, `proposals`, or `all`.
- `POST /api/admin/query/cypher` `{ cypher, params, limit }`, `POST /api/admin/query/vector` `{ query, collections, topK }` (`topK` 1-20, default 5).

Tests: `test/admin.test.js`.

## Commands

Test both databases:

```powershell
npm run kg:test-db
```

Test the selected LLM provider:

```powershell
npm run kg:test-llm
```

Run the test suite without external services (`node:test`; web API and MCP tools over in-memory stores and a scripted LLM, files in `test/`):

```powershell
npm test
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

Ingest or ask for one scope (see Scope):

```powershell
npm run kg:ingest -- --scope uc "The UC QDE screen calls the PAN API."
npm run kg:ask -- --scope uc "What does the QDE screen call?"
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

Set or change the admin panel password (see Admin Panel):

```powershell
npm run kg:admin:password
```

To rebuild only the browser bundle:

```powershell
npm run kg:web:build
```

Use a provider override for a single CLI run:

```powershell
npm run kg:ask -- --provider ollama "What does the EKYC screen use?"
```

Use the custom HTTP (bridge) provider. It is meant for networks where the LLM API must be reached through a local relay: MindMesh POSTs to `endpoint`, and the relay forwards the call to `bridgedEndpoint`. `subProvider` selects the request/response format (`gemini` or `openai`):

```json
{
  "llm": {
    "provider": "custom",
    "custom": {
      "subProvider": "openai",
      "openai": {
        "endpoint": "http://localhost:3001/llm",
        "bridgedEndpoint": "https://api.example.com/v1/chat/completions",
        "apiKey": "{{CUSTOM_LLM_API_KEY}}",
        "model": "model-name"
      }
    }
  }
}
```

```powershell
npm run kg:test-llm -- --provider custom
```

The relay receives `{ endpoint, method, headers, body }`: `endpoint` is `bridgedEndpoint`, the headers carry the API key (`Authorization: Bearer` for `openai`, `X-goog-api-key` for `gemini`), and `body` is an OpenAI chat-completions request (`model`, system + user messages) or a Gemini `contents` request (system prompt and prompt joined into one text part). The relay returns the provider's JSON response; MindMesh reads `choices[0].message.content` (`openai`) or the first non-thought text part of `candidates[0]` (`gemini`). A plain-string response is also accepted. `config.example.json` contains ready-to-edit `openai` and `gemini` blocks.

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

`--provider <name>` is parsed by the shared input helper and passed only to the LLM provider factory. `--scope <value>` sets the ingest scope (`kg:ingest`) or the scope filter (`kg:ask`).

## Graph Extraction Contract

The ingestion pipeline now uses a single, custom line-oriented extraction format. Extraction prompt files are templates. Ingestion renders `{{GRAPH_SCHEMA}}`, `{{FIELD_GUIDANCE}}`, `{{EXISTING_GRAPH_CONTEXT}}`, `{{INGEST_SCOPE}}` (the selected scope, see Scope), `{{USER_INPUT}}`, and `{{REVIEWER_REVISION}}` into the custom extraction prompt before calling the LLM. `{{REVIEWER_REVISION}}` is empty for normal ingestion; when a HITL proposal is regenerated it holds the reviewer notes and the previous proposal (see HITL Regeneration). Existing graph context is retrieved from Chroma and expanded through Neo4j; pending HITL context is also retrieved from the Chroma HITL collection. Both context sources are intended for identity resolution, node-name reuse, disambiguation, and avoiding duplicate facts. New graph facts should still come from `{{USER_INPUT}}`.

Records are one-per-line using `|` as an unescaped field separator. To include special characters inside a field you must use backslash escapes: `\n` for newline, `\r` for carriage return, `\t` for tab, `\|` for a literal pipe, and `\\` for a literal backslash. The parser decodes these escapes into their runtime characters.

The custom extraction prompt asks the model to wrap records in explicit demarcators. The parser consumes only the text inside the first delimited block when present, so extra model commentary outside the block is ignored:

```text
<start#$#$>
NODE|name|label|type|description|scope
RELATION|source_name|target_name|relation|information|description|scope
NODE_CREATE|name|label|type|description|scope|metadata
NODE_UPDATE|name|label|type|description|scope|metadata
NODE_DELETE|name|metadata
RELATION_CREATE|source_name|target_name|relation|information|description|scope|metadata
RELATION_UPDATE|source_name|target_name|relation|information|description|scope|metadata
RELATION_DELETE|source_name|target_name|relation|metadata
NODE_TYPE_SUGGESTION|type_name|description|reason
RELATION_TYPE_SUGGESTION|relation_name|description|reason
</end#$#$>
```

Example:

```text
<start#$#$>
NODE|uc_ekyc_screen|EKYC Screen|screen|Screen that captures identity verification details.|uc
NODE|pan_api|PAN API|api|API used to verify PAN details.|
RELATION|uc_ekyc_screen|pan_api|uses|during identity verification|Triggered during identity verification.|
</end#$#$>
```

A relation endpoint is either a node created in the same output or an existing node referenced by its exact name. The prompt tells the model not to emit `NODE_UPDATE` for an existing endpoint unless the input adds or changes information about it, so a relation on its own never rewrites an existing node's type or label. Nodes that exist only in pending HITL context still get a `NODE_UPDATE` record, because they are not in the graph yet.

`scope` is a comma-separated list (`uc` or `nc,uc`; empty for none), always the field before `metadata` (see Scope). There is no compatibility with the older format without the scope column.

The trailing `metadata` field only carries HITL review signals (`AMBIGUITY:<reason>` or `CONTRADICTION:<reason>`). It exists only inside proposals, where it drives review-signal counts, filters and badges, and is never persisted to Neo4j or Chroma when a proposal is applied.

For relationships, `sourceName`, `relation`, and `targetName` already express the core fact. `information` should contain only extra qualifiers such as conditions, timing, scope, state, or reason; leave it empty when it would merely repeat the relation. `description` is reserved for longer source-backed explanation. Node descriptions should add useful context or disambiguation, not restate the label/type.

`extractCustomGraph()` accepts raw, fenced, or demarcated custom graph records. When demarcators are present, text outside them is ignored; otherwise it falls back to parsing the full response. It ignores blank/header lines, captures schema suggestion records, and supports create/update/delete operation records. Unparseable text yields an empty graph rather than an error, so callers that overwrite data (HITL regeneration) check for zero records themselves.

`normalizeGraphPayload()` then:

- Converts node names, node types, and relation names to lowercase snake case.
- Enforces the loaded graph schema when one is supplied.
- Preserves unknown node or relationship types as schema violations so HITL can review the exact model output, and records them as implicit type suggestions in the payload (not in the schema file).
- Treats a blank node type or relationship type as a schema violation. There are no fallback types.
- Blocks graph application while schema violations are present.
- Creates node IDs as `node:<name>` when no ID is provided.
- Never creates nodes for relation endpoints. An endpoint without a node record in the payload is a reference to an existing node (see the graph check below).
- Creates relationship IDs as `rel:<12-char-sha1>` when no ID is provided.
- Defaults missing descriptions to empty strings.
- Preserves empty relation `information` instead of generating redundant relation text.
- Carries node/relation create, update, and delete operations into HITL or graph application.
- Returns `schemaSuggestions`, `schemaWarnings`, and `schemaViolations` for CLI/API visibility and HITL schema approval.

`resolveGraphPayload()` then checks the normalized payload against the graph. It runs when a proposal is stored (ingest, MCP `submit_ingest`, regeneration, manual web edits) and again inside `GraphWriteService.applyPayload()`, so every graph apply (auto mode, MCP auto mode, HITL approval) passes it against the current graph:

- Every relation endpoint must have a node record in the same payload or already exist in the graph. Otherwise the relation is a `relationEndpoint` violation: auto mode stores a proposal instead, and approval fails until the reviewer adds the node or fixes the name. An endpoint deleted by the same payload is also a violation.
- An endpoint that already exists and has no node record is only referenced; its type, label, and description are never written.
- `NODE_CREATE` for a node that already exists is applied as `NODE_UPDATE` and gets an `AMBIGUITY:` review signal asking the reviewer to confirm it is the same entity.
- When the check changes a proposal (a converted create, or a flagged endpoint), the stored proposal text is rewritten from the checked payload so the HITL card shows the change.

## Neo4j Schema

Nodes use label `KnowledgeNode`.

Node properties:

- `id`
- `label`
- `name`
- `type`
- `description`
- `scope` (list of strings; absent when unscoped)
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
- `scope` (list of strings; absent when unscoped)
- `createdAt`
- `updatedAt`

The `type` and `relation` properties carry the semantic type; Neo4j labels and relationship types are fixed (`KnowledgeNode`, `RELATES_TO`) so schema types can change without database migrations. The configured database is `graph.neo4j.database` (the default database is used when it is `neo4j`).

### Identity and uniqueness

MindMesh uses its own `id` property, never Neo4j's internal element id. The same `id` is the record id in Chroma, so no cross-reference field is needed.

- Node ids are `node:<name>`, derived from the snake_case name.
- Relationship ids are `rel:<12-char-sha1>` of `sourceId:relation:targetId`.
- Uniqueness is enforced by Neo4j constraints that the graph store creates once per process before its first write: `knowledge_node_id` (unique `KnowledgeNode.id`) and `relates_to_id` (unique `RELATES_TO.id`). Both are created on demand (`IF NOT EXISTS`), not by `npm run kg:test-db`. On a server older than 5.23 the first write fails with a clear version error.
- The name of a node that already exists is permanent, because it is part of the id. The web/HITL update routes reject a different name and the UI shows the Name field read-only; the label can always be changed. Nodes that exist only in a pending proposal can still be renamed.
- Editing a relation directly in the HITL workspace recomputes its id from the new source, relation, and target; if the id changes, the old relation and its vector are deleted. Relation updates submitted as proposals become a delete of the old relation plus a create of the new one.

### Write behavior

`applyGraph()` applies a whole payload in one Neo4j transaction, in this order: relation deletes, node deletes, node upserts, relation upserts. Either all of it is committed or none of it. Deletes of items that are already gone are no-ops, so applying the same payload again is safe. Upserts use `MERGE` by node `id` and relationship `id`. Re-ingesting the same normalized fact updates properties and preserves `createdAt`. In this path an empty `description` (and empty relation `information`, and an empty `scope`) keeps the stored value instead of clearing it, so passing mentions do not wipe existing text. `label`, `name`, and `type` are always overwritten. Direct HITL edits (`upsertNode()`, `upsertRelation()`) set fields exactly as submitted, so clearing a description is done through the edit form.

`applyGraph()` returns the nodes and relationships as Neo4j stored them, plus the deleted node and relation ids, and the vector index is built from that result. Ingestion and `kg:reindex-vectors` therefore produce identical vector documents. Endpoints are checked before apply; if one disappears in the meantime, `applyGraph()` fails with status 409 and rolls back the whole transaction, including its deletes.

Chroma cannot join the Neo4j transaction, so `GraphWriteService` syncs vectors after the commit (for payloads and for direct reviewer edits). Relation vectors of deleted nodes are removed by their stored `sourceId`/`targetId` (`deleteRelationsForNodes()`), so a retry also cleans them. If the sync fails, the request fails with status 503 and code `VECTOR_SYNC_FAILED`, and the message (shown in the UI, not replaced by the generic server error) says the graph was saved. A HITL proposal stays pending, so approving again re-syncs; for `auto` ingest or MCP, run `npm run kg:reindex-vectors`.

A direct relation edit that changes the relation id (`upsertRelation(relation, { replaceId })`) deletes the old relation and writes the new one in one transaction, keeping the earliest `createdAt`; if the write fails, the old relation is kept.

Graph deletes are supported by normalized `nodeDeletes` and `relationDeletes`. Direct node/relation CRUD helpers are used by the web and HITL review flows and keep vector documents synchronized through the server layer.

`expandFromNodes(nodeIds, depth, options)` expands breadth-first from the entry nodes, one query per hop, so the cost follows the size of the neighbourhood rather than the number of paths. It returns every node within `depth` hops (with its hop `distance`) and every relation traversed. Depth is clamped to `0..8` and at most 2000 nodes are returned. `options` (used by `explore_graph`) set `direction`, `relationTypes`, `nodeTypes`, and `limit`. The default configured depth is `4`. The graph store also creates indexes on node `type` and relation `relation` with its constraints.

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
- `scope` (text, `nc,uc`), `scoped` (false when unscoped), and one flag per value (`scope_uc: true`), because Chroma metadata holds no lists. Scope filters query these flags; vectors written before scope existed have no `scoped` flag and are missed by scope filters until `npm run kg:reindex-vectors`.

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
- the same scope fields as nodes

Node and relationship vectors share their ids with Neo4j and are derived from it; `npm run kg:reindex-vectors` rebuilds them (see Commands).

HITL note documents contain the pending proposal status, user/source metadata, original input, and LLM proposed graph mutations. Their metadata includes:

- counts for proposed node/relation upserts, deletions, schema suggestions, ambiguity signals, and contradiction signals
- `scope`: the ingest scope (empty for none); pending-context retrieval and `queryHitlNotes` with a scope filter keep proposals of that scope, `common`, or none
- `reviewerNotes`: the latest reviewer notes, saved from the HITL UI or by an agent
- `regenerated`, `regeneratedBy`, `regeneratedAt`, `regenerationOrigin` (`ui` or `agent`): set when the proposal was regenerated. The proposal is overwritten and no history is kept.

HITL note ids look like `hitl:<base36-time>:<12 hex>`. The HITL UI also shows a short reference made of `#` plus the first 6 hex characters (e.g. `#d964db`), and the MCP tools accept it in place of the full id when it matches exactly one pending note.

When `embedding.provider` is `gemini`, the app sends document/query text to Gemini, stores explicit embeddings in Chroma, and queries with explicit query embeddings. This avoids Chroma's JavaScript default embedding function and its Hugging Face model download.

The current RAG flow queries only `kg_nodes`; relationship vectors are indexed for future retrieval paths. HITL notes are queried separately when ingestion needs pending context or ASK opts into unverified knowledge.

## Ingestion Context Flow

`HitlService.ingestText({ text, source, userName, scope })` runs `IngestionService.ingestText()`, which performs retrieval-augmented extraction and then hands the prepared payload to `HitlService.submit()`:

1. Query Chroma node collection with `ingestion.contextTopK`. With an ingest scope, every retrieval step uses the scope filter (see Scope).
2. Expand Neo4j graph from returned node IDs with `ingestion.contextDepth`.
3. Query/list pending HITL notes and parse their proposed mutations as unverified pending context.
4. Format approved graph and pending HITL context as human-readable node/fact lists while preserving exact `node:*` IDs.
5. Render the extraction prompt template with schema, existing graph context, the ingest scope, and new user input.
6. Ask the selected LLM to extract graph records from the new input while using existing/pending context for identity resolution only.
7. Prepare the response (`prepareExtraction()`): reconcile creates for pending nodes into updates, normalize it into upserts, deletes, suggestions, warnings, and violations, and check it against the graph. MCP `submit_ingest` prepares an agent's records the same way.
8. `HitlService.submit()` stores a pending HITL proposal when `ingestion.mode` is `hitl` or `reviewReasons()` finds a reason (see Graph Schema); otherwise `GraphWriteService` applies the mutations and syncs Chroma vectors.

## HITL Regeneration

A reviewer can regenerate a pending proposal with instructions instead of editing it row by row. Both entry points share `IngestionService.buildHitlRegenerationPrompt()` and `HitlService.storeRegeneration()`:

- Web UI: reviewer notes + **Regenerate** call `POST /api/hitl/notes/:id/regenerate`, which runs the server's configured LLM (`HitlService.regenerate()`).
- MCP: `get_regenerate_prompt` and `submit_regeneration`, where the calling agent does the reasoning.

Behavior:

1. The original user input is extracted again with the normal extraction prompt plus the `{{REVIEWER_REVISION}}` section (`formatReviewerRevision()` in `src/prompts/promptRegistry.js`). That section contains the reviewer notes as top-priority instructions and the previous proposal as the baseline to keep unless the notes ask for a change. The web UI sends the current draft, including unsaved manual edits, as that baseline.
2. Graph context is retrieved again with the proposal's stored ingest scope, with this note excluded from the pending HITL context. Otherwise its own previous creates would be reconciled into updates.
3. The response must contain at least one record. The parser returns an empty graph for unparseable text, so an empty result is rejected and the proposal is left unchanged.
4. The proposal is overwritten (no history), counts are recomputed, the notes are saved, and the regeneration fields are set. The original submitter and creation time are kept, and the proposal stays pending for approval.

If ingestion context config is omitted, `contextTopK` and `contextDepth` fall back to the configured RAG `topK` and `depth`. For the hackathon POC, `contextDepth: 1` is recommended to keep extraction grounded and avoid context noise.

## RAG Flow

`HybridRagService.answer({ query, source, scope })` performs (with `scope`, steps 3, 5, and 6 use the scope filter; see Scope):

1. Normalize optional browser-session memory messages.
2. Build a retrieval query from the current question plus recent memory. There is no LLM query rewriting (it would need an extra LLM call, which the MCP path cannot make).
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
- `scope`
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
- `/admin`: password-protected admin panel (see Admin Panel).

Layout and behavior:

- Desktop: the graph preview and the side panel are split by a draggable divider (keyboard-resizable, snaps closed near the edges, double-click resets). The side panel starts at 25% of the width on `/` and 40% on `/hitl`, `/jobs`, and `/schema`.
- Mobile: graph preview stacks above the side panel.
- The graph preview has two renderers, toggled in the graph header: NeoVis (default) and Graphology + Sigma with force-layout positioning. Both support pan/zoom, hover focus, click-to-select focus, and compact relationship labels.
- The graph panel includes instant client-side search over the loaded preview and full Neo4j search on submit. Search results focus a loaded node or fetch its neighborhood.
- The main workspace side panel has **Ask** and **Ingest** tabs, with one **Scope** picker for both (None plus the schema's scope values, kept for the browser session): Ask answers from that scope, `common`, and unscoped knowledge; Ingest sends it as the ingest scope.
- Node and relation forms (main page and HITL) have a Scope field with one toggle per allowed value; `common` clears the other values. The NeoVis hover tooltip shows the scope; the Sigma renderer has no tooltip.
- Clicking a node or relation opens a details modal to edit or delete it. The Name field is read-only for nodes that already exist in the graph, because the name is part of the node id; change the label instead.
- Graph action buttons open modals to create nodes and relationships manually. Node and relation forms start with an empty type, which must be filled with a schema type; the Name placeholder shows the name derived from the label, which becomes the permanent id if Name is left empty.
- On `/`, manual node and relationship mutations create HITL proposals. On `/hitl`, reviewer mutations apply directly when schema-valid, or update the open proposal draft when one is selected.
- The HITL workspace previews pending proposals over the approved graph, allows reviewer edits, and applies approved graph/schema mutations.
  - Submission cards show per-operation counts, e.g. `12N (8C 3U 1D) 5R (5C) 2NT 1RT` (N nodes, R relations, NT/RT node/relation type suggestions; C/U/D create/update/delete, zero counts omitted). They are parsed client-side with the same parser as the detail view. Cards also show the short `#ref`, the ingest scope, and Regenerated/Notes tags.
  - The proposal detail is a collapsible tree: Nodes and Relations each split into Create, Update, and Delete; Schema suggestions split into Node types and Relation types; then Review signals.
  - Update and delete rows compare Current against the approved DB version: preview graph items carry an `approved` snapshot because the preview merges the proposal over the DB item.
  - Rows show scope chips; Current vs Proposed shows both scopes, or "Scope unchanged" when the record leaves it blank. The preview shows the stored scope for such records.
  - The detail shows the ingest scope and a collapsible Review checklist (names and prefixes, scopes, reuse across units, relations, signals).
  - The detail shows the full proposal id with a copy button, a Reviewer notes box with **Save notes** and **Regenerate** (see HITL Regeneration), and a copy button on the raw piped response for backups before regenerating.
- Direct HITL reviewer graph edits update Neo4j first and then sync the corresponding Chroma vector documents.
- Node vector documents include label, name, type, and description (scope is vector metadata only). Relationship vector documents include relation, information, description, source ID, and target ID.
- The chat tab supports asking, ingesting text, and ingesting uploaded PDF/DOCX/DOC files.
- Browser chat messages are local UI state. Recent messages can be sent as request memory for follow-up resolution, but they are not persisted server-side.
- Frontend source lives in `src/server/public`: `app.js` holds the `App` component (state, handlers, routes) and the entry point; components are one per file under `components/` (`common`, `graph`, `chat`, `entity`, `hitl`, `schema`, `jobs`); shared helpers are in `lib/`. `npm run kg:web:build` bundles everything from `app.js` into `app.bundle.js`. The bundle is gitignored; `npm run kg:web` rebuilds it every time it starts the server, so run that (not `node src/server/server.js` directly) after pulling UI changes.

API endpoints:

- `GET /api/graph?limit=150`: returns `{ nodes, relations, limit }`.
- `GET /api/nodes/search?q=pan&limit=12`: searches all Neo4j nodes by id, label, name, type, or description.
- `GET /api/nodes/:id/neighborhood?depth=1`: returns a focused graph around a node.
- `GET /api/nodes/:id/relations`: returns relationships attached to a node.
- `POST /api/nodes`: creates a pending HITL node-create proposal. Node routes (here and under `/api/hitl/nodes`) require a type. A create for a node that already exists is stored as an update with an `AMBIGUITY:` signal.
- `PUT /api/nodes/:id`: creates a pending HITL node-update proposal.
- `DELETE /api/nodes/:id`: creates a pending HITL node-delete proposal.
- `POST /api/relations`: creates a pending HITL relation-create proposal. Relation create/update routes (here and under `/api/hitl/relations`) require a relation type and return 400 unless both endpoints already exist; endpoints accept a node id or a bare node name.
- `PUT /api/relations/:id`: creates a pending HITL relation-update proposal.
- `DELETE /api/relations/:id`: creates a pending HITL relation-delete proposal.
- `POST /api/ask`: accepts `{ "text": "question", "sessionId": "...", "memoryMessages": [], "includeUnverifiedKnowledge": false, "scope": "" }` and returns `{ answer, entryNodes, graph, depth, scope, sessionId }`. An unknown scope is a 400.
- `POST /api/ingest`: accepts multipart `text`, `userName`, `scope` (optional ingest scope), and up to 10 `file`/`files` uploads, or JSON/form text; returns applied or pending HITL graph mutation details.
- `POST /api/jobs/scanner`: runs the scanner job over a selected/random graph neighborhood.
- `POST /api/jobs/nugget`: runs the nugget job over a selected/random graph neighborhood.
- `GET /api/schema`: returns the editable graph schema.
- `PUT /api/schema`: saves editable graph schema JSON.
- `GET /api/hitl/notes`: lists pending HITL notes, each with its counts, review-signal counts, reviewer notes, regeneration fields, and `llmResponse` (used for per-operation card counts), oldest first, plus `total` (all pending notes) and `limit`. When `total` is larger than the page, the HITL list says how many are hidden.
- `GET /api/hitl/notes/:id`: returns one HITL proposal: its counts and review fields, the pipe-delimited `llmResponse`, and `records` (the same proposal parsed into `nodes`, `relations`, `nodeDeletes`, `relationDeletes`, `schemaSuggestions`, `schemaViolations`, `schemaWarnings`). List items carry `records` too.
- `GET /api/hitl/notes/:id/graph`: previews one HITL proposal over graph context.
- `POST /api/hitl/notes/:id/graph`: previews edited HITL proposal text.
- `GET /api/hitl/graph`: returns approved graph overlaid with pending HITL proposals. In both preview endpoints, pending items carry `pendingHitl`, `pendingOperation`, `hitlNoteId`, and `approved` (the DB version before the proposal, absent for items not yet in the graph).
- `POST /api/hitl/nodes`, `PUT /api/hitl/nodes/:id`, `DELETE /api/hitl/nodes/:id`: direct reviewer node mutations, or pending proposals when schema validation fails.
- `POST /api/hitl/relations`, `PUT /api/hitl/relations/:id`, `DELETE /api/hitl/relations/:id`: direct reviewer relation mutations, or pending proposals when schema validation fails.
- `PUT /api/hitl/notes/:id/reviewer-notes`: saves reviewer notes on a pending proposal.
- `POST /api/hitl/notes/:id/regenerate`: accepts `{ reviewerNotes, llmResponse, reviewedBy }`, re-runs extraction on the original input with the notes and the current draft as baseline, and overwrites the proposal. Fails without changing the note if the LLM output has no records.
- `POST /api/hitl/notes/:id/approve`: validates and applies an edited HITL proposal, merges its approved type suggestions into the schema only after the graph apply succeeds, then removes the pending note.
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
- optionally `extractGraphWithRawResponse({ text, systemPrompt, prompt, debugLogger })`, returning `{ graph, rawResponse }`. All current providers implement it; ingestion and regeneration use it so the stored HITL proposal is the model's exact output.

Graph stores should implement the methods currently used by CLIs and services:

- `verifyConnectivity()`
- `applyGraph(graphPayload)` (deletes and upserts in one transaction; returns stored records and deleted ids)
- `getExistingNodeIds(nodeIds)`
- `getNodesByIds(nodeIds)`, `getRelationsByIds(relationIds)`
- `countByType()` (nodes per node type, relations per relation type)
- `expandFromNodes(nodeIds, depth, { direction, relationTypes, nodeTypes, limit })`
- `findPaths(fromId, toId, { maxDepth, relationTypes, limit })`
- `runReadOnlyQuery(cypher, params, { limit, timeoutMs })` (enforces read-only; used by `query_cypher`)
- `getGraphPreview(limit)`
- `getGraphSnapshot(limit)`
- `getRandomNode()`
- `searchNodes(query, limit, { type })`
- `getNode(nodeId)`
- `getNodeNeighborhood(nodeId, depth)`
- `getRelationsForNode(nodeId)`
- `getRelation(relationId)`
- `upsertNode(node)`
- `deleteNode(nodeId)`
- `upsertRelation(relation, { replaceId })`
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
- `deleteRelationsForNodes(nodeIds)`
- `queryNodes(query, topK, { type })`, `queryRelations(query, topK, { relation })`
- `upsertHitlNote(note)`
- `listHitlNotePage({ status, limit, offset, order })` returning `{ notes, total }`, and `listHitlNotes(options)` returning the notes. Notes are sorted by `createdAt` across all matching notes before the page is cut (`order`: `oldest` default, or `newest`); `limit` 0 returns all
- `getHitlNote(id)`
- `deleteHitlNotes(ids)`
- `queryHitlNotes(query, topK)`
- `clearGraphIndex()` (drops only the node and relation collections; used by `kg:reindex-vectors`)
- `smokeTest()`

The Neo4j store also enforces id uniqueness itself (`ensureConstraints()`, called before writes); another graph store must guarantee unique node and relation ids in its own way.

To add a provider, create the adapter and update the relevant `providerFactory.js`.

## Agent Notes

- This is a POC, not a hardened service. There is no migration system, no delete/update reconciliation for removed facts, and no automated unit test framework beyond smoke-test scripts.
- `config.json` may contain local placeholders or local secrets. Inspect `config.example.json` for shape, and keep real replacement values in local-only `config.replacements.json` or another private source.
- Prompt behavior is part of the application contract. Update prompt files and README together when changing extraction or answer semantics.
- Chroma retrieval depends on its configured embedding implementation. If you switch embedding providers or dimensions, run `npm run kg:reindex-vectors` to rebuild the node and relation collections. HITL proposals are embedded too and cannot be rebuilt from Neo4j, so approve or reject pending proposals first, then recreate the HITL collection (`kg:clear-chroma` deletes it).
- Neo4j relationship type is always `RELATES_TO`; the semantic relation is stored in the `relation` property.
- The fallback ingestion text in `src/cli/ingest.js` is intentionally large and domain-specific. It is sample data, not a schema definition.
