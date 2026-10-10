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

None. Next up: roadmap item 1, "Split `App()` into hooks and pages" (full plan in `MEMORY_BANK/roadmap.md`).

## Last Completed (2026-10-10)

HITL and graph-integrity work, all pushed to `master` (latest commit `342f517`, plus uncommitted doc consolidation):

- `app.js` split into one component per file; HITL card per-operation counts and a collapsible Create/Update/Delete tree; Current vs Proposed compares against the approved snapshot.
- Reviewer notes and proposal regeneration from the UI and from MCP (`regenerate-context`, `apply-regeneration`), with short `#ref` proposal ids.
- Neo4j id uniqueness constraints, rename guard, relation re-id on edit, vectors built from stored records, `kg:reindex-vectors` runs `--fresh`, review-signal `metadata` no longer persisted.
- README, `core.md`, and `codeMap.md` re-checked against the code; `decisions.md` and `promptTemplates.md` removed (their durable reasons moved into `core.md`).

Cleanup after that: fixed `config.example.json` custom provider shape, removed the unused `rag.memory.rewriteQueryEnabled` setting and its dead code, removed the HITL "Strong" chip mode (Compact counts only), and made `src/mcp/smokeTest.js` use throwaway nodes and clean up after itself.

## Open Follow-Ups

- Verify on the work laptop (Neo4j 3.5): `npm run kg:test-db`, one ingest and one approve (constraint syntax and `neo4j-driver` v6 compatibility are untested there).
- The `auto`-mode branch of the MCP smoke-test cleanup is untested (only `hitl` mode was run).
- Longer-term work lives in `MEMORY_BANK/roadmap.md`.
