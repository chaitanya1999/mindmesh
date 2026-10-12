# MindMesh Code Map

Where things live in the code. One entry per recurring pathway: entry points, call chain, and the files to touch. For what the code does and why, follow the README section named in each entry; do not duplicate behavior here.

## Composition Root and Tests

- `src/mindmesh.js`: `createMindMesh(config, overrides)` builds stores, `GraphReadService`, `GraphWriteService`, `IngestionService`, `HitlService`, `HybridRagService`, `KgJobsService` once; used by `server.js` (`createApp(services)`), `mcp/server.js` (`createMcpServer(services)`, `withLlm: false`), and the ingest/ask CLIs. `isMainModule()` starts a module only when run directly.
- Tests: `test/*.test.js` (`npm test`). `test/helpers/testServices.js` builds services over `test/helpers/memoryStores.js` (in-memory graph store; real `ChromaVectorStore` on a fake Chroma client with `failNext()`), a scripted LLM, and a temp schema. `test/writeGate.test.js` enforces the write gate.

## Ingestion

README: Graph Extraction Contract, Ingestion Context Flow.

Entry points: `src/cli/ingest.js`, `POST /api/ingest` in `src/server/server.js` (text and PDF/DOCX/DOC uploads), MCP `get_ingest_prompt` + `submit_ingest` in `src/mcp/server.js`.

```text
HitlService.ingestText()                           src/hitl/hitlService.js
  -> IngestionService.ingestText({ submit })       src/ingestion/ingestionService.js
       -> retrieveExistingContext()                Chroma queryNodes + Neo4j expandFromNodes
            -> retrievePendingHitlContext()        pending notes, parsed as unverified context
       -> buildExtractionPrompt()                  src/prompts/promptRegistry.js
       -> extractGraphWithRawResponse()            src/llm/*Provider.js
       -> prepareExtraction()                      reconcileExtractionWithPendingHitl() + normalizeGraphPayload()
                                                   + resolveGraphPayload() (src/ingestion/graphResolution.js)
  -> HitlService.submit()                          reviewReasons() gate
       -> storeProposal()                          ChromaVectorStore.upsertHitlNote()
          or GraphWriteService.applyPayload()      src/graph/graphWriteService.js: resolveGraphPayload() again,
                                                   Neo4jGraphStore.applyGraph() (one transaction), vector sync;
                                                   a sync failure is vectorSyncError() (503 VECTOR_SYNC_FAILED, expose)
MCP submit_ingest -> HitlService.submitRecords() -> prepareExtraction() -> submit()
```

Also: `src/ingestion/reviewSignals.js` (signal counts, `reviewReasons()`), `formatGraphRecords()` in `graphPayload.js` (payload -> stored proposal text), `src/rag/graphContext.js::formatExtractionGraphContext()`, `prompts/extraction-system-custom.md`.

## HITL Review

README: Web UI (HITL workspace), Chroma Schema (HITL notes).

Entry points: `/hitl` UI, `/api/hitl/*` and `/api/nodes|relations` in `src/server/server.js` (HTTP only); logic in `src/hitl/hitlService.js`.

```text
GET /api/hitl/notes, /api/hitl/notes/:id           HitlService.listProposals() / getProposal() + noteDetail() (pipe text + records)
GET|POST /api/hitl/notes/:id/graph, /api/hitl/graph
  -> HitlService.previewProposal() / previewAll()  mergeHitlPayloadIntoGraph(): pendingHitl, pendingOperation, approved snapshot
POST /api/hitl/notes/:id/approve                   HitlService.approve(): buildApprovalSchema() + normalizeGraphPayload()
  -> GraphWriteService.applyPayload(), then mergeSchemaTypes() and deleteHitlNotes()
DELETE /api/hitl/notes/:id                         HitlService.reject()
/api/nodes, /api/relations (main page)             HitlService.propose*() -> proposeRecords() (formatGraphRecords + graph check)
/api/hitl/nodes, /api/hitl/relations               HitlService.editNode() / editRelation() / delete*(): GraphWriteService.write*/delete*,
                                                   or a proposal on schema violation (proposalIfSchemaInvalid())
```

Frontend:

- `components/hitl/HitlReviewPanel.js`: list, filters, card counts, detail, reviewer notes, approve/reject/regenerate.
- `components/hitl/HitlProposalSummary.js`: Create/Update/Delete tree, Current vs Proposed.
- `lib/hitlProposal.js`: client-side proposal parser and counts. Keep it consistent with `src/ingestion/graphPayload.js` (the server now also returns `records`, so this parser can be retired).
- Draft editing of proposal text from graph/detail edits: pipeline helpers in `src/server/public/app.js`.

## HITL Regeneration

README: HITL Regeneration.

```text
Web:  POST /api/hitl/notes/:id/regenerate  -> HitlService.regenerate()
      PUT  /api/hitl/notes/:id/reviewer-notes -> HitlService.saveReviewerNotes()
MCP:  get_regenerate_prompt / submit_regeneration in src/mcp/server.js
Both: IngestionService.buildHitlRegenerationPrompt() -> retrieveExistingContext({ excludeNoteIds })
      HitlService.storeRegeneration() -> prepareExtraction() -> ChromaVectorStore.upsertHitlNote()
Prompt section: formatReviewerRevision() in src/prompts/promptRegistry.js
Short refs: HitlService.resolveRef(); UI hitlShortRef() in lib/hitlProposal.js
```

## Ask / RAG

README: RAG Flow.

Entry points: `src/cli/ask.js`, `POST /api/ask`, MCP `search_context` (retrieval only).

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

- Write gate: `src/graph/graphWriteService.js` is the only caller of store write methods (`applyPayload`, `writeNode`, `deleteNode`, `writeRelation`, `deleteRelation`, and the maintenance methods `wipeGraph`, `clearGraphVectors`, `reindexVectors`, `repairVectorIndex`); `test/writeGate.test.js` lists the allowed exceptions.
- Ids: built in `src/ingestion/graphPayload.js` (normalization) and `normalizeManualNode()` / `normalizeManualRelation()` in `src/hitl/hitlService.js` (manual and reviewer edits).
- Constraints: `Neo4jGraphStore.ensureConstraints()` in `src/graph/neo4jGraphStore.js`, called by `applyGraph`, `upsertNode`, `upsertRelation`.
- Rename guard: `normalizeManualNode()` (HitlService) and `isNameLocked` in `components/entity/NodeForm.js`.
- Relation re-id on edit: `HitlService.editRelation()` -> `GraphWriteService.writeRelation(relation, { replaceId })` -> `Neo4jGraphStore.upsertRelation()` (one transaction).
- Vector documents: `nodeDocument()` / `relationDocument()` / `upsertGraphIndex()` in `src/vector/chromaVectorStore.js`.
- Reindex: `src/cli/reindexVectors.js` and the admin panel -> `GraphWriteService.reindexVectors()` (`fresh` -> `ChromaVectorStore.clearGraphIndex()`); repair of missing/orphan vectors: `GraphWriteService.repairVectorIndex()`; graph wipe: `GraphWriteService.wipeGraph()` (`Neo4jGraphStore.deleteAllKnowledge()` + `clearGraphIndex()`); full Chroma wipe: `src/cli/clearChroma.js`.

## Providers

README: Provider Interfaces, Commands (provider configs).

- Factories: `src/llm/providerFactory.js`, `src/embedding/providerFactory.js`, `src/graph/providerFactory.js`, `src/vector/providerFactory.js`.
- LLM: `src/llm/geminiProvider.js`, `ollamaProvider.js`, `customHttpProvider.js` (relay bridge), `hubChatProvider.js`.
- Embedding: `src/embedding/geminiEmbeddingProvider.js`, `hubEmbeddingProvider.js`; `chroma` uses Chroma's default embedder.
- Stores: `src/graph/neo4jGraphStore.js`, `src/vector/chromaVectorStore.js`.

## Config and Logging

README: Configuration, Debug Logging.

- `src/config.js` (`getConfig`, `describeRuntime`; `applyPlaceholders` replaces `{{KEY}}` in parsed values, `readReplacementsFile`), local `config.json` / `config.replacements.json`, templates `config.example.json` / `config.replacements.example.json`.
- `src/logging/debugLogger.js`: `createDebugLogger({ name, scope })`; `scope` is matched against `logging.scopes`.

## Web UI

README: Web UI.

- Server: `src/server/server.js` (HTTP only: routes, uploads, static files; `createApp(services)`; port from `KG_WEB_PORT` / `PORT`). Tests: `test/webIngest.test.js`, `test/webHitl.test.js`.
- Frontend (`src/server/public`): `app.js` (App state, handlers, routes; `/admin` renders `AdminApp` instead); `components/common`, `graph` (`NeoVisGraphPreview` default, `GraphPreview` Sigma, `graphStyle.js`), `chat`, `entity`, `hitl`, `schema`, `jobs`, `admin`; `lib/` (`api.js`, `graphData.js`, `utils.js`, `hitlProposal.js`); `styles.css`.
- Build: `npm run kg:web:build` -> `app.bundle.js` (gitignored; `npm run kg:web` builds it on start).

## MCP Server

README: MCP Server.

- `src/mcp/server.js`: `createMcpServer(services)`; `registerTool()` / `readTool()` helpers; tools grouped as graph reads (`search_context` -> `HybridRagService.retrieveContext`; `search_nodes`, `search_relations`, `get_node`, `explore_graph`, `find_paths`, `query_cypher`, `get_schema` -> `src/graph/graphReadService.js` -> `Neo4jGraphStore.expandFromNodes` / `findPaths` / `runReadOnlyQuery`), proposal reads (`search_proposals`, `list_proposals`, `get_proposal`, `get_node` pending changes -> `HitlService`), proposing (`get_ingest_prompt` -> `IngestionService.retrieveExistingContext` + `buildExtractionPrompt`, `retrievalQuality()`; `submit_ingest` -> `HitlService.submitRecords`; `get_regenerate_prompt` -> `IngestionService.buildHitlRegenerationPrompt`; `submit_regeneration` -> `HitlService.storeRegeneration`; `save_reviewer_notes`), and review decisions behind `config.mcp.allowReviewDecisions` (`approve_proposal`, `reject_proposal`); resources `mindmesh://schema`, `mindmesh://graph`, `mindmesh://hitl/notes`, `mindmesh://nodes/{nodeId}`, `mindmesh://relations/{relationId}`. `main()` sends console output to stderr. Tests: `test/mcpServer.test.js` (in-memory transport).
- Smoke test: `src/mcp/smokeTest.js` (throwaway nodes; `cleanUp()` removes the created proposal or nodes).

## Admin Panel

README: Admin Panel.

```text
/admin UI                                          components/admin/AdminApp.js (status, login, tabs; a 401 returns to login)
  -> /api/admin/*                                  src/server/adminRoutes.js: registerAdminRoutes() (session middleware,
                                                   requireConfirmation(): password again + CONFIRM_WORD for wipes, audited())
       -> AdminService                             src/admin/adminService.js
            overview()                             Neo4jGraphStore.getDatabaseInfo(), GraphReadService.getSchemaOverview(),
                                                   ChromaVectorStore.listCollectionsWithCounts(), describeRuntime()
            consistency() / repairVectorIndex()    listIds() vs listIndexIds() -> GraphWriteService.repairVectorIndex()
            wipe(target) / reindexVectors()        GraphWriteService.wipeGraph() / clearGraphVectors() / reindexVectors(),
                                                   HitlService.clearAllProposals()
            backup()                               getGraphSnapshot() + HitlService.exportProposals()
            queryCypher() / vectorMatch()          GraphReadService.queryCypher(), ChromaVectorStore.queryCollections()
```

- Auth: `src/admin/adminAuth.js` (`hashPassword`, `verifyPassword`, `AdminSessions`); audit log `src/admin/auditLog.js`; password CLI `src/cli/adminPassword.js` (`npm run kg:admin:password`).
- Frontend: `components/admin/` (`AdminOverview`, `AdminMaintenance`, `AdminQueryConsole`, `AdminDangerZone`, `AdminAuditLog`, `AdminConfirm`); `app.js` renders `AdminApp` on `/admin`.
- Tests: `test/admin.test.js` (`createTestServices({ adminPassword })`; a separate app with `adminRouteOptions.sessions` for the lockout).

## Jobs

- `src/jobs/kgJobsService.js`, `POST /api/jobs/scanner` and `/api/jobs/nugget`, `components/jobs/JobsPanel.js`, prompts `prompts/job-*.md`. On demand only; uses the server LLM.

## Checks

```powershell
npm test                 # no external services: web API + MCP over in-memory stores (test/)
npm run kg:test-parser   # no external services
npm run kg:test-db       # Neo4j + Chroma
npm run kg:test-llm      # configured LLM
npm run kg:web:build     # frontend bundle
```

Database tests write and delete smoke records. When testing against a real database, use throwaway ids and clean up.
