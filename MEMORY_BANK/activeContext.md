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

None. Remaining from the architecture review (`claude-arch-design-REVIEW.md`, local file): the small cleanups (`src/config.js.bak`, `config.json` tracking, `.gitignore`, `soft_deleted`), then P1 (tests, `ProposalService`, proposal store). Bug 3 is deferred to user management (roadmap). The review is not yet reflected in `roadmap.md`.

## Last Completed (2026-10-11)

Review bugs 5 and 6 (uncommitted, together with the Neo4j cleanup below):

- `Neo4jGraphStore.applyGraph()` replaces `upsertGraph()`: relation deletes, node deletes, node upserts, and relation upserts in one transaction. Direct relation edits use `upsertRelation(relation, { replaceId })`, one transaction.
- Vector sync after commit; relation vectors of deleted nodes are removed by stored endpoints (`deleteRelationsForNodes()`); a sync failure is a 503 `VECTOR_SYNC_FAILED` error with an exposed message; HITL approval stays retryable.
- `listHitlNotePage()` sorts all matching notes before paging and returns `total`; the HITL list shows when notes are hidden; pending ingest context uses `order: "newest"`; short-ref lookup searches all.
- Checks: `kg:test-parser` passes (new tests for one-call apply, vector sync error, listing order); bundle builds; throwaway check on home Neo4j 2026.04 + Chroma passed 13/13 with both stores restored (rollback of a failed apply, relation replace, vector cleanup on retry, listing order).

Neo4j cleanup (uncommitted): `expandFromNodes()` uses `CALL (paths) { ... }` instead of the deprecated importing `WITH` (no more deprecation warning on Ask/ingest); `createConstraints()` drops the 3.5 / 4.x branches and requires Neo4j 5.23+ with a clear error. Verified on the home Neo4j 2026.04 (constraints no-op, expansion runs, no notifications).

Before that (commit `0f3bc10`), review bug 2: `auto` mode applies only clean creates and updates. `reviewReasons()` in `src/ingestion/reviewSignals.js` (schema violations, ambiguity, contradiction, node/relation deletes) gates `ingestText()` and MCP `apply-ingestion`; the reasons are returned as `reviewReasons`. Tests cover deletes, ambiguity, contradiction, converted creates, and clean updates; delete mechanics are now tested through `applyGraphPayload()`.

And review bug 1: relations no longer create or rewrite nodes.

- New `src/ingestion/graphResolution.js` checks payloads against Neo4j when proposals are stored and inside `applyGraphPayload()`; missing or same-payload-deleted endpoints are violations; existing endpoints are references only; `NODE_CREATE` of an existing node becomes `NODE_UPDATE` with an `AMBIGUITY:` signal.
- `concept` / `relates_to` fallbacks removed everywhere; blank types are schema violations. Forms start with an empty type and show the derived name.
- Manual relation routes return 400 for missing endpoints; `upsertGraph()` rolls back (409) instead of silently skipping a relation; approve writes schema types only after the graph apply.
- `formatGraphRecords()` in `graphPayload.js` replaces the formatter copy in `ingestionService.js`.
- Extraction prompt: relation endpoints may be bare references to existing nodes; `NODE_UPDATE` only when the input adds information about the node (new reference-only example). Live LLM behavior with the new rule is not yet observed.
- Checks: `kg:test-parser` passes (new resolution tests), bundle builds, ESLint `no-undef` clean, end-to-end run on port 3100 with throwaway nodes passed.

## Earlier (2026-10-10)

HITL and graph-integrity work, all pushed to `master` (latest commit `342f517`, plus uncommitted doc consolidation):

- `app.js` split into one component per file; HITL card per-operation counts and a collapsible Create/Update/Delete tree; Current vs Proposed compares against the approved snapshot.
- Reviewer notes and proposal regeneration from the UI and from MCP (`regenerate-context`, `apply-regeneration`), with short `#ref` proposal ids.
- Neo4j id uniqueness constraints, rename guard, relation re-id on edit, vectors built from stored records, `kg:reindex-vectors` runs `--fresh`, review-signal `metadata` no longer persisted.
- README, `core.md`, and `codeMap.md` re-checked against the code; `decisions.md` and `promptTemplates.md` removed (their durable reasons moved into `core.md`).

Cleanup after that: fixed `config.example.json` custom provider shape, removed the unused `rag.memory.rewriteQueryEnabled` setting and its dead code, removed the HITL "Strong" chip mode (Compact counts only), and made `src/mcp/smokeTest.js` use throwaway nodes and clean up after itself.

## Open Follow-Ups

- If a relation references a node that exists only in another pending proposal, with no node record in its own payload, approval fails until that other proposal is approved (there is no ordering across proposals). The prompt asks the LLM to emit `NODE_UPDATE` for pending endpoints, which avoids this.
- The HITL preview does not show `relationEndpoint` violations; they appear as the `AMBIGUITY:` signal on the card and as the approve error.
- `NODE_UPDATE` for a node that does not exist still creates it; part of P1 (operations as enforced checks).
- The `auto`-mode branch of the MCP smoke-test cleanup is untested (only `hitl` mode was run).
- Longer-term work lives in `MEMORY_BANK/roadmap.md`.
