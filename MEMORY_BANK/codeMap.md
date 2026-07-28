# MindMesh Code Map

This file documents stable code pathways that agents should not repeatedly rediscover from scratch. Add only pathways that recur across tasks.

## Ingestion Flow

Entrypoints:

- `src/cli/ingest.js`
- `src/server/server.js`

Main path:

```text
input text
  -> readInput() or Express request body
  -> IngestionService
  -> ChromaVectorStore.queryNodes() for existing semantic context
  -> Neo4jGraphStore.expandFromNodes() for graph context
  -> ChromaVectorStore.queryHitlNotes()/listHitlNotes() for pending context
  -> LLM provider extraction
  -> normalizeGraphPayload()
  -> ChromaVectorStore.upsertHitlNote() when HITL mode or schema violations apply
  -> otherwise Neo4jGraphStore.upsertGraph()
  -> ChromaVectorStore.upsertGraphIndex()
```

Important modules:

- `src/ingestion/ingestionService.js`: orchestration.
- `src/ingestion/graphPayload.js`: parsing and normalization.
- `src/ingestion/reviewSignals.js`: HITL/review signal handling.
- `prompts/extraction-system-custom.md`: extraction prompt.

Notes:

- `ingestion.mode` controls whether schema-valid ingestion applies directly (`auto`) or stores HITL proposals (`hitl`).
- Web ingestion also accepts PDF/DOCX/DOC uploads through `src/server/server.js`.
- Extraction supports node/relation create, update, delete, and schema suggestion records.

## Ask/RAG Flow

Entrypoints:

- `src/cli/ask.js`
- `src/server/server.js`

Main path:

```text
question
  -> HybridRagService
  -> optional memoryMessages/sessionId from web requests
  -> ChromaVectorStore.queryNodes()
  -> Neo4jGraphStore.expandFromNodes()
  -> optional ChromaVectorStore.queryHitlNotes() for unverified context
  -> formatGraphContext()
  -> LLM provider answer generation
```

Important modules:

- `src/rag/hybridRagService.js`: retrieval and answer orchestration.
- `src/rag/graphContext.js`: context formatting helpers.
- `prompts/answer-system.md`: answer behavior.
- `prompts/context-format.md`: graph context formatting guidance.

Notes:

- Browser chat memory is local UI state and can be sent in request payloads for follow-up reference resolution.
- LLM query rewriting is present as commented reference code; current retrieval uses conversation-augmented query text.

## Schema Flow

Schema source:

- `schema/graphSchema.json`

Main path:

```text
schema/graphSchema.json
  -> src/schema/graphSchema.js
  -> extraction prompt schema catalog (includes property guidance when fields are defined)
  -> graph payload validation/normalization
  -> optional validatePropertyConstraints() for property-level constraint enforcement
  -> HITL when unknown schema terms appear
  -> editable schema API/UI
```

Important behavior:

- Approved node and relationship types live in top-level schema arrays only.
- There is no `suggestions` section in `graphSchema.json`. Type suggestions from LLM live only in HITL proposal records (ChromaDB).
- Unknown types cause schema violations → HITL proposal. Approval adds them directly to approved `nodeTypes`/`relationshipTypes` via `mergeSchemaTypes()`.
- Schema can be edited through `GET /api/schema`, `PUT /api/schema`, and the `/schema` route.
- Schema no longer uses `autoApplySuggestions` — types are never auto-promoted.

### Property Descriptors (Schema-Driven Field Guidance)

`schema/graphSchema.json` supports per-property descriptor objects in `nodeProperties.fields` and `relationshipProperties.fields`. Each descriptor includes:

- `name`: property key (e.g., `name`, `label`, `description`, `information`, `metadata`)
- `description`: brief human-facing guidance for the property
- `constraints` (optional): machine-readable guidance such as `pattern` (regex), `immutable` flag, `maxLength`, and `allowedValues`

These descriptors are injected into the extraction prompt via the dedicated `{{FIELD_GUIDANCE}}` placeholder in `prompts/extraction-system-custom.md`, positioned immediately after the OUTPUT SYNTAX section. This keeps field-level guidance separate from type-level schema (`{{GRAPH_SCHEMA}}`).

The rendering pipeline:
```
schema/graphSchema.json
  -> src/schema/graphSchema.js::formatFieldGuidance()
  -> src/prompts/promptRegistry.js (replaces {{FIELD_GUIDANCE}})
  -> prompts/extraction-system-custom.md (in extraction prompt sent to LLM)
```

Previously hardcoded field descriptions in the prompt's CRUD RULES and EXTRACTION RULES sections have been removed and replaced by this schema-driven approach. The `graphSchema.json` file is now the single source of truth for field semantics.

Optional runtime validation is available through `validatePropertyConstraints()` in `src/ingestion/graphPayload.js`. It checks payload fields against schema-defined constraints and returns violation objects. This validation is modular and toggleable — callers can use default (warning-only) or `strict` mode that also returns error strings.

## Provider Flow

Provider factories:

- `src/llm/providerFactory.js`
- `src/embedding/providerFactory.js`
- `src/graph/providerFactory.js`
- `src/vector/providerFactory.js`

Provider implementations:

- LLM: `src/llm/geminiProvider.js`, `src/llm/ollamaProvider.js`, `src/llm/customHttpProvider.js`, `src/llm/hubChatProvider.js`
- Embedding: `src/embedding/geminiEmbeddingProvider.js`, `src/embedding/hubEmbeddingProvider.js`; `chroma` means use Chroma's default embedder.
- Graph: `src/graph/neo4jGraphStore.js`
- Vector: `src/vector/chromaVectorStore.js`

## Config Flow

Main module:

- `src/config.js`

Current model:

- `config.json` is the complete runtime application config.
- `src/config.js` applies `{{KEY}}` placeholders using caller-supplied replacements and root `config.replacements.json`.
- `config.replacements.json` is merged over caller-supplied replacements by the current loader.
- The config loader does not read application settings from environment variables or provide hardcoded defaults; defaults must live in JSON config files.
- Keep real secrets out of shared docs and commits. Use placeholders such as `{{GEMINI_API_KEY}}` and private replacement values.
- Important config paths include `ingestion.mode`, `rag.memory.*`, `vector.chroma.hitlCollection`, hub embedding config, and prompt path overrides.

## Web UI Flow

Server:

- `src/server/server.js`

Frontend:

- `src/server/public/app.js`
- `src/server/public/components/hitl/HitlReviewPanel.js`
- `src/server/public/components/hitl/HitlProposalSummary.js`
- `src/server/public/lib/hitlProposal.js`
- `src/server/public/styles.css`

Routes/API groups:

- `/`: main graph/chat workspace.
- `/hitl`: HITL review workspace.
- `/schema`: schema editor.
- `/jobs`: graph jobs workspace.
- APIs cover graph preview/search, ask, ingest/upload, manual HITL proposals, direct reviewer HITL CRUD, schema save, job runs, and HITL approval/rejection.

Bundle output:

- `src/server/public/app.bundle.js`

Typical command:

```powershell
npm run kg:web:build
```

## Smoke Test Commands

```powershell
npm run kg:test-parser
npm run kg:test-llm
npm run kg:test-db
npm run kg:web:build
```

Use only the commands relevant to the task. Database and LLM tests require configured external services.
