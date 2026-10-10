# Active Context

The current task only. Rewrite this file when a task starts and update it when the task ends. Durable facts belong in `README.md` (behavior), `codeMap.md` (code locations), or `core.md` (rules), not here.

## How To Use

At task start, replace "Current Task" with:

- Goal: one or two sentences.
- Plan: numbered steps.
- Files: the files expected to change.
- Done when: acceptance criteria and the checks to run.

At task end, record the outcome under "Last Completed", move unfinished items to "Open Follow-Ups", and update the README / codeMap / core if behavior, locations, or rules changed.

## Current Task

None.

## Last Completed (2026-10-10)

HITL and graph-integrity work, all pushed to `master` (latest commit `342f517`, plus uncommitted doc consolidation):

- `app.js` split into one component per file; HITL card per-operation counts and a collapsible Create/Update/Delete tree; Current vs Proposed compares against the approved snapshot.
- Reviewer notes and proposal regeneration from the UI and from MCP (`regenerate-context`, `apply-regeneration`), with short `#ref` proposal ids.
- Neo4j id uniqueness constraints, rename guard, relation re-id on edit, vectors built from stored records, `kg:reindex-vectors` runs `--fresh`, review-signal `metadata` no longer persisted.
- README, `core.md`, and `codeMap.md` re-checked against the code; `decisions.md` and `promptTemplates.md` removed (their durable reasons moved into `core.md`).

## Open Follow-Ups

- `config.example.json` shows a flat `llm.custom.endpoint`; the custom provider needs `subProvider` plus a `gemini`/`openai` block.
- `rag.memory.rewriteQueryEnabled` is ignored (query rewriting is disabled in `HybridRagService`).
- `HitlReviewPanel.js` imports an unused `deleteCount`.
- `src/mcp/smokeTest.js` leaves a pending HITL proposal behind in `hitl` mode.
- Planned direction (from the v2 planning discussion): richer MCP tools (entity search/get, dependency traversal, mode-checked proposal submission), moving HITL proposals out of Chroma into a proper proposal store, a folder restructure, and a UI revamp.
