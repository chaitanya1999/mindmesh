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

Goal: P1 from the architecture review. Move the proposal lifecycle and direct reviewer edits into `HitlService`, and every graph write into `GraphWriteService`, behind characterization tests. No behavior change.

Agreed design:
- `HitlService`: submit, approve, reject, regenerate, reviewer notes, preview, list, short refs, and direct reviewer edits. Decides whether something may be written (schema rules, `reviewReasons()`, approved type merge). Returns both pipe text and structured records.
- `GraphWriteService`: graph check, one Neo4j transaction, vector sync, vector sync error. The only caller of store write methods.
- `IngestionService` shrinks to context retrieval, prompt, LLM call, parsing.
- No spaces / context argument for now.

Plan (one commit per step; all tests pass after each):
1. Composition root: `createMindMesh(config, overrides)` builds stores and services once (server, MCP, ingest/ask CLIs); `createApp(services)` and `createMcpServer(services)` build without listening/connecting.
2. Characterization tests with `node:test` in `test/` (`npm test`), fake in-memory stores, HTTP and MCP in-memory transport.
3. Extract `GraphWriteService`; direct-edit routes use it.
4. Extract `HitlService`; server and MCP become thin.
5. Docs: README, codeMap, core, review file.

Done when: `npm test` and `kg:test-parser` pass after every step, and the server, MCP, and CLIs start as before.

## Last Completed (2026-10-11)

Review cleanups (uncommitted): deleted `src/config.js.bak`; `config.json`, `config.replacements.json`, and `src/server/public/app.bundle.js` untracked and gitignored (local files kept); `.gitignore` no longer lists itself; unused `soft_deleted` filters removed from `getGraphPreview()` and `getRandomNode()`. Config loader: placeholders replaced in parsed string values (quotes, backslashes, Windows paths safe; whole-string placeholders keep type), broken replacements file is an error, unresolved placeholders warn (or throw with `strict`); new `config.replacements.example.json`; tests added.

Before that (commit `df47939`), review bugs 5 and 6, together with the Neo4j cleanup below:

- `Neo4jGraphStore.applyGraph()` replaces `upsertGraph()`: relation deletes, node deletes, node upserts, and relation upserts in one transaction. Direct relation edits use `upsertRelation(relation, { replaceId })`, one transaction.
- Vector sync after commit; relation vectors of deleted nodes are removed by stored endpoints (`deleteRelationsForNodes()`); a sync failure is a 503 `VECTOR_SYNC_FAILED` error with an exposed message; HITL approval stays retryable.
- `listHitlNotePage()` sorts all matching notes before paging and returns `total`; the HITL list shows when notes are hidden; pending ingest context uses `order: "newest"`; short-ref lookup searches all.
- Checks: `kg:test-parser` passes (new tests for one-call apply, vector sync error, listing order); bundle builds; throwaway check on home Neo4j 2026.04 + Chroma passed 13/13 with both stores restored (rollback of a failed apply, relation replace, vector cleanup on retry, listing order).

Neo4j cleanup: `expandFromNodes()` uses `CALL (paths) { ... }` instead of the deprecated importing `WITH` (no more deprecation warning on Ask/ingest); `createConstraints()` drops the 3.5 / 4.x branches and requires Neo4j 5.23+ with a clear error. Verified on the home Neo4j 2026.04 (constraints no-op, expansion runs, no notifications).

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
