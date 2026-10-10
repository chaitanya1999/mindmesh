# MindMesh Core Context

Compressed briefing for coding agents. Behavior details live in `README.md`; code locations live in `codeMap.md`. Do not restate either here.

## Purpose

MindMesh is a HITL-gated, schema-governed knowledge graph for institutional knowledge, not a generic RAG pipeline. Contract: **LLMs suggest, humans approve, schema enforces.** Extracted facts become HITL proposals that a reviewer approves, edits, or regenerates with notes before they reach the graph; `auto` mode applies only schema-valid extractions.

Implemented: hybrid vector + graph RAG (Ask), retrieval-augmented extraction (Ingest), HITL review with reviewer notes and LLM regeneration, an editable schema, an MCP server for external coding agents, and two on-demand graph jobs (scanner, nugget).

Not implemented (do not assume they exist): scheduled/CRON jobs, knowledge synthesis, decay detection.

## Flows At A Glance

- Ingest: text -> graph + pending HITL context -> LLM extraction -> normalize -> HITL proposal (or apply in `auto` mode).
- Ask: question -> Chroma entry nodes -> Neo4j expansion -> graph context -> LLM answer.
- HITL: pending proposal -> edit / reviewer notes + regenerate -> approve (merge schema types, apply graph, index vectors) or reject.
- MCP: the agent does the reasoning; MindMesh returns context and prompts and stores the results through the same proposal/apply path.
- Web UI: Express APIs + Preact frontend on `/`, `/hitl`, `/schema`, `/jobs`.

Stack: Node.js ES modules, Express, Preact (NeoVis and Sigma graph renderers), Neo4j (3.5 through 2025.x+), ChromaDB, pluggable LLM and embedding providers, MCP over stdio.

## Hard Rules

- Every graph write goes through HITL approval, a direct reviewer edit, or schema-valid `auto` mode. No silent mutations.
- Neo4j is the source of truth. Chroma node/relation vectors are derived and rebuildable (`npm run kg:reindex-vectors`); HITL proposals live only in Chroma and are not rebuildable.
- Keep graph writes and vector indexing in sync; index what Neo4j stored, not what was sent.
- Ids are canonical and shared by Neo4j and Chroma: `node:<name>`, `rel:<hash of source:relation:target>`, unique in Neo4j. Never rename an existing node's `name`; recompute a relation's id when its type or endpoints change.
- Record `metadata` holds HITL review signals (`AMBIGUITY:` / `CONTRADICTION:`) and exists only in proposals. Never persist it to the graph.
- Approved types live only in the schema's `nodeTypes`/`relationshipTypes`. Type suggestions stay in proposals and are merged on approval; never auto-promote them.
- The MCP server never creates an LLM provider.
- Config comes from `config.json` with `{{KEY}}` placeholders resolved from `config.replacements.json`; no env-var settings except the web port. Never commit real secrets.
- Prompt behavior is part of the contract. Update the prompt files and README together.

## Design Reasons Worth Keeping

- Extraction prompt order follows recency bias: rules, field guidance, schema, and context come first; `{{USER_INPUT}}` and then `{{REVIEWER_REVISION}}` come last, because the end of the prompt gets the most attention.
- Field guidance has its own `{{FIELD_GUIDANCE}}` placeholder, separate from the type catalog in `{{GRAPH_SCHEMA}}`, so field semantics sit next to the output syntax. `graphSchema.json` is the single source of truth for field meaning.
- When one extraction contains the same node twice, the newer description wins, so later text can correct a bad one. Duplicate relations keep the longer text because they are additive.
- A JSON config with a replacements file replaced env-var precedence because it was simpler to reason about.

## Working Conventions

- Prefer existing service boundaries over new abstractions; for small tasks, change only the relevant pathway.
- Frontend: keep the existing Preact UI; one component per file under `src/server/public/components`; rebuild `app.bundle.js` (tracked) after UI changes.
- Keep docs single-sourced: behavior -> `README.md`, code locations -> `codeMap.md`, rules -> this file, current task -> `activeContext.md`.
