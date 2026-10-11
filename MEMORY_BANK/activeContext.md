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

None. Next from the architecture review (`claude-arch-design-REVIEW.md`, local file): P1 step 3, the proposal store (roadmap item 3: move HITL proposals out of Chroma; `HitlService` is now the only user of the proposal methods, so it is the seam to swap). Then P1 step 4 (atomic schema file writes, report of nodes with removed types).

## Last Completed (2026-10-12)

P1 steps 1-4 of the architecture review (commits `ecdef05`, `2240fe4`, `994fe67`, `db44d42`; not pushed yet):

- Composition root `src/mindmesh.js` (`createMindMesh`); `createApp(services)` / `createMcpServer(services)` build without listening or connecting.
- `npm test`: 48 characterization tests (`node:test`) for the web API and MCP tools over in-memory stores; checked by deliberately breaking the auto-mode delete rule and the endpoint check (both caught on web and MCP).
- `GraphWriteService` is the only caller of store write methods (enforced by `test/writeGate.test.js`); direct reviewer edits now report vector sync failures as `VECTOR_SYNC_FAILED`.
- `HitlService` owns proposals and direct reviewer edits; `server.js` is HTTP only; `IngestionService` keeps context, prompt, LLM, and `prepareExtraction()`.
- Intended behavior changes: MCP `apply-ingestion` reconciles with pending proposals like web ingest; proposal responses also carry `records`.
- Checks after each step: `npm test`, `kg:test-parser`, lint, MCP smoke test, and live throwaway round trips on port 3100 (direct edits; propose + approve) with both stores restored.

Earlier (2026-10-11, pushed): review bugs 1, 2, 5, 6, the Neo4j 5.23+ cleanup, the cleanups (untracked config files and bundle, safe config placeholders). Details are in the git log and the review file.

## Open Follow-Ups

- Push P1 steps 1-4 once reviewed.
- The client-side parser `lib/hitlProposal.js` can now be replaced by the server's `records` (review finding F; part of roadmap item 1).
- `src/cli/testParser.js` still holds many assertions in one script; move them into `test/` gradually.
- If a relation references a node that exists only in another pending proposal, with no node record in its own payload, approval fails until that other proposal is approved (no ordering across proposals).
- The HITL preview does not show `relationEndpoint` violations; they appear as the `AMBIGUITY:` signal on the card and as the approve error.
- `NODE_UPDATE` for a node that does not exist still creates it (operations as enforced checks is still open).
- Change the Neo4j password that was exposed in public commit `8ab0051`.
- The `auto`-mode branch of the MCP smoke-test cleanup is untested (only `hitl` mode was run).
- Longer-term work lives in `MEMORY_BANK/roadmap.md`.
