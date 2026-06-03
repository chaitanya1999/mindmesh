# MindMesh Core Context

## Project Purpose

MindMesh is a prototype personal knowledge management system. It extracts graph facts from user text/documents, stores approved facts in Neo4j, indexes approved graph records and pending HITL proposals in ChromaDB, and answers questions with a hybrid vector + graph RAG flow.

The project is intended to become a practical knowledge assistant where user-provided information can be ingested, reviewed, searched, connected, and queried through both semantic retrieval and graph structure.

## Architecture Summary

Ingestion:

```text
User text
  -> CLI or Web API
  -> IngestionService
  -> approved graph context lookup plus pending HITL context lookup
  -> LLM graph extraction
  -> graph payload normalization and schema validation
  -> pending HITL proposal when HITL mode or schema violations apply
  -> otherwise Neo4j graph mutation and Chroma vector sync
```

Question answering:

```text
Question
  -> CLI or Web API
  -> HybridRagService
  -> optional browser-session memory for follow-up resolution
  -> Chroma vector entry-point search
  -> Neo4j graph expansion
  -> optional unverified HITL context
  -> graph context formatting
  -> LLM final answer
```

Web UI:

```text
Browser
  -> Express server APIs
  -> shared ingestion/RAG/job services
  -> graph, chat, schema, jobs, and HITL review workspaces
  -> Preact + Graphology + Sigma frontend
```

## Runtime Stack

- Node.js ES modules.
- Express server for JSON APIs and static frontend assets.
- Preact frontend bundled with esbuild.
- Neo4j via `neo4j-driver`.
- ChromaDB via `chromadb`.
- Gemini, Ollama, custom HTTP, and hub chat LLM providers.
- Gemini embeddings by default, with hub embeddings and Chroma default embedding support also available.
- Graph UI uses Graphology, Graphology force layout, and Sigma.
- PDF/DOCX/DOC upload text extraction uses `pdf-parse`, `mammoth`, and `word-extractor`.

## Key Project Rules

- Prefer existing service boundaries over new abstractions.
- Keep graph persistence and vector indexing behavior in sync.
- Treat HITL as a first-class pathway. `ingestion.mode` controls whether schema-valid ingestion applies directly (`auto`) or stores proposals for review (`hitl`).
- Keep schema behavior centralized around `schema/graphSchema.json` and `src/schema/graphSchema.js`.
- Preserve HITL behavior for unknown or invalid schema terms.
- Main-workspace manual graph mutations create HITL proposals; reviewer mutations in the HITL workspace can apply directly when schema-valid.
- Do not commit real secrets. Prefer placeholders in `config.json` with local values supplied through private `config.replacements.json` or another caller-provided replacement source.
- Keep frontend changes consistent with the existing Preact/Sigma UI rather than introducing a new UI stack.
- For small tasks, avoid broad refactors and update only the relevant pathway.

## Canonical Docs

- `README.md` is the full canonical architecture/setup reference.
- This file is the compressed always-useful agent briefing.
- `MEMORY_BANK/codeMap.md` explains important code pathways.
- `MEMORY_BANK/decisions.md` tracks durable architectural decisions.
- `MEMORY_BANK/activeContext.md` is rewritten per task.
