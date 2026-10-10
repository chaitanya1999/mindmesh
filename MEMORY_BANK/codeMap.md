# MindMesh Code Map

Where things live in the code. One entry per recurring pathway: entry points, call chain, and the files to touch. For what the code does and why, follow the README section named in each entry; do not duplicate behavior here.

## Ingestion

README: Graph Extraction Contract, Ingestion Context Flow.

Entry points: `src/cli/ingest.js`, `POST /api/ingest` in `src/server/server.js` (text and PDF/DOCX/DOC uploads), MCP `ingest-context` + `apply-ingestion` in `src/mcp/server.js`.

```text
IngestionService.ingestText()                      src/ingestion/ingestionService.js
  -> retrieveExistingContext()                     Chroma queryNodes + Neo4j expandFromNodes
       -> retrievePendingHitlContext()             pending notes, parsed as unverified context
  -> buildExtractionPrompt()                       src/prompts/promptRegistry.js
  -> extractGraphWithRawResponse()                 src/llm/*Provider.js
  -> reconcileExtractionWithPendingHitl()
  -> normalizeGraphPayload()                       src/ingestion/graphPayload.js
  -> storeHitlProposal()                           ChromaVectorStore.upsertHitlNote()
     or applyGraphPayload()                        Neo4jGraphStore.upsertGraph() + ChromaVectorStore.upsertGraphIndex()
```

Also: `src/ingestion/reviewSignals.js` (signal counts), `src/rag/graphContext.js::formatExtractionGraphContext()`, `prompts/extraction-system-custom.md`.

## HITL Review

README: Web UI (HITL workspace), Chroma Schema (HITL notes).

Entry points: `/hitl` UI, `/api/hitl/*` in `src/server/server.js`.

```text
GET /api/hitl/notes, /api/hitl/notes/:id           ChromaVectorStore.listHitlNotes() / getHitlNote(); hitlNoteSummary()
GET|POST /api/hitl/notes/:id/graph, /api/hitl/graph
  -> buildHitlNoteGraphPreview() / buildHitlGraphPreview()
  -> mergeHitlPayloadIntoGraph()                   adds pendingHitl, pendingOperation, approved snapshot
POST /api/hitl/notes/:id/approve
  -> parseGraphExtraction() + buildApprovalSchema() + normalizeGraphPayload()
  -> persistHitlSchemaSuggestions()                mergeSchemaTypes() in src/schema/graphSchema.js
  -> IngestionService.applyGraphPayload(), then deleteHitlNotes()
DELETE /api/hitl/notes/:id                         reject
/api/hitl/nodes, /api/hitl/relations               direct reviewer CRUD (proposal on schema violation)
```

Frontend:

- `components/hitl/HitlReviewPanel.js`: list, filters, card counts, detail, reviewer notes, approve/reject/regenerate.
- `components/hitl/HitlProposalSummary.js`: Create/Update/Delete tree, Current vs Proposed.
- `lib/hitlProposal.js`: client-side proposal parser and counts. Keep it consistent with `src/ingestion/graphPayload.js`.
- Draft editing of proposal text from graph/detail edits: pipeline helpers in `src/server/public/app.js`.

## HITL Regeneration

README: HITL Regeneration.

```text
Web:  POST /api/hitl/notes/:id/regenerate  -> IngestionService.regenerateHitlProposal()
      PUT  /api/hitl/notes/:id/reviewer-notes -> IngestionService.saveHitlReviewerNotes()
MCP:  regenerate-context / apply-regeneration in src/mcp/server.js
Both: buildHitlRegenerationPrompt() -> retrieveExistingContext({ excludeNoteIds })
      storeHitlRegeneration()          -> ChromaVectorStore.upsertHitlNote()
Prompt section: formatReviewerRevision() in src/prompts/promptRegistry.js
Short refs: IngestionService.resolveHitlNoteId(); UI hitlShortRef() in lib/hitlProposal.js
```

## Ask / RAG

README: RAG Flow.

Entry points: `src/cli/ask.js`, `POST /api/ask`, MCP `ask`.

```text
HybridRagService.answer()                          src/rag/hybridRagService.js
  (MCP uses retrieveContext(): same retrieval, no LLM)
  -> ChromaVectorStore.queryNodes() -> Neo4jGraphStore.expandFromNodes()
  -> optional queryHitlNotes() for unverified context
  -> formatGraphContext()                          src/rag/graphContext.js
  -> LLM generateAnswer()
```

Prompts: `prompts/answer-system.md`, `prompts/context-format.md`.

## Schema

README: Graph Schema.

- Load and format: `src/schema/graphSchema.js` (`loadGraphSchema`, `formatSchemaCatalog` -> `{{GRAPH_SCHEMA}}`, `formatFieldGuidance` -> `{{FIELD_GUIDANCE}}`, `mergeSchemaTypes`, `saveEditableGraphSchema`).
- Validation: `normalizeGraphPayload()` and optional `validatePropertyConstraints()` in `src/ingestion/graphPayload.js`.
- Editor: `GET`/`PUT /api/schema`, `components/schema/`.
- File: `schema/graphSchema.json` (gitignored; template `schema/graphSchema.example.json`).

## Graph Identity and Vector Sync

README: Neo4j Schema (Identity and uniqueness, Write behavior), Commands (reindex).

- Ids: built in `src/ingestion/graphPayload.js` (normalization) and `normalizeManualNode()` / `normalizeManualRelation()` in `src/server/server.js` (manual and reviewer edits).
- Constraints: `Neo4jGraphStore.ensureConstraints()` in `src/graph/neo4jGraphStore.js`, called by `upsertGraph`, `upsertNode`, `upsertRelation`.
- Rename guard: `normalizeManualNode()` (server) and `isNameLocked` in `components/entity/NodeForm.js`.
- Relation re-id on edit: `PUT /api/hitl/relations/:id` in `src/server/server.js`.
- Vector documents: `nodeDocument()` / `relationDocument()` / `upsertGraphIndex()` in `src/vector/chromaVectorStore.js`.
- Reindex: `src/cli/reindexVectors.js` (`--fresh` -> `ChromaVectorStore.clearGraphIndex()`); full wipe: `src/cli/clearChroma.js`.

## Providers

README: Provider Interfaces, Commands (provider configs).

- Factories: `src/llm/providerFactory.js`, `src/embedding/providerFactory.js`, `src/graph/providerFactory.js`, `src/vector/providerFactory.js`.
- LLM: `src/llm/geminiProvider.js`, `ollamaProvider.js`, `customHttpProvider.js` (relay bridge), `hubChatProvider.js`.
- Embedding: `src/embedding/geminiEmbeddingProvider.js`, `hubEmbeddingProvider.js`; `chroma` uses Chroma's default embedder.
- Stores: `src/graph/neo4jGraphStore.js`, `src/vector/chromaVectorStore.js`.

## Config and Logging

README: Configuration, Debug Logging.

- `src/config.js` (`getConfig`, `describeRuntime`), `config.json`, `config.replacements.json`, `config.example.json`.
- `src/logging/debugLogger.js`: `createDebugLogger({ name, scope })`; `scope` is matched against `logging.scopes`.

## Web UI

README: Web UI.

- Server: `src/server/server.js` (routes, static files; port from `KG_WEB_PORT` / `PORT`).
- Frontend (`src/server/public`): `app.js` (App state, handlers, routes); `components/common`, `graph` (`NeoVisGraphPreview` default, `GraphPreview` Sigma, `graphStyle.js`), `chat`, `entity`, `hitl`, `schema`, `jobs`; `lib/` (`api.js`, `graphData.js`, `utils.js`, `hitlProposal.js`); `styles.css`.
- Build: `npm run kg:web:build` -> `app.bundle.js` (tracked; rebuild before committing UI changes).

## MCP Server

README: MCP Server.

- `src/mcp/server.js`: tools `ask`, `ingest-context`, `apply-ingestion`, `regenerate-context`, `apply-regeneration`; resources `mindmesh://schema`, `mindmesh://graph`, `mindmesh://hitl/notes`, `mindmesh://nodes/{nodeId}`, `mindmesh://relations/{relationId}`. Reuses `IngestionService`, `HybridRagService`, the stores, and the prompt registry; reads the same `config.json`.
- Smoke test: `src/mcp/smokeTest.js` (leaves a pending proposal in `hitl` mode).

## Jobs

- `src/jobs/kgJobsService.js`, `POST /api/jobs/scanner` and `/api/jobs/nugget`, `components/jobs/JobsPanel.js`, prompts `prompts/job-*.md`. On demand only; uses the server LLM.

## Checks

```powershell
npm run kg:test-parser   # no external services
npm run kg:test-db       # Neo4j + Chroma
npm run kg:test-llm      # configured LLM
npm run kg:web:build     # frontend bundle
```

Database tests write and delete smoke records. When testing against a real database, use throwaway ids and clean up.
