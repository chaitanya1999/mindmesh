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

None. Next: roadmap item 3 (proposal store). Review P1 step 4 (atomic schema file writes, report of nodes with removed types) is still open.

## Last Completed (2026-10-12)

MCP tool set (former roadmap item 2), all steps, uncommitted:

- 16 tools by default: graph reads `search_context`, `search_nodes`, `search_relations`, `get_node`, `explore_graph`, `find_paths`, `query_cypher`, `get_schema`; proposal reads `search_proposals`, `list_proposals`, `get_proposal`; proposing `get_ingest_prompt` (with `retrievalQuality`), `submit_ingest`, `get_regenerate_prompt`, `submit_regeneration`, `save_reviewer_notes`. `approve_proposal` / `reject_proposal` only with `mcp.allowReviewDecisions` (new key in `config.example.json`). Old tools `ask`, `ingest-context`, `apply-ingestion`, `regenerate-context`, `apply-regeneration` removed.
- `src/graph/graphReadService.js`; store reads `getNodesByIds`, `getRelationsByIds`, `countByType`, `findPaths`, `runReadOnlyQuery` (EXPLAIN query type must be `r`, read transaction, 10 s timeout, row cap, LOAD CSV / dbms / apoc / most SHOW refused); breadth-first `expandFromNodes` with direction/type filters (review D); `type` / `relation` indexes (review C).
- Bug fixed: since P1 step 4, MCP `submit` logged to stdout and corrupted the stdio protocol (the pushed code has it). `main()` now sends console output to stderr; the smoke test fails on any non-protocol stdout line.
- Checks: `npm test` 74 pass; lint clean (except the generated bundle); MCP smoke test passes; live checks against the real stores (15 read-tool checks, 36 step 2-5 checks incl. eight refused write/admin queries); an end-to-end agent session over real stdio (15 checks). Stores and the schema file restored every time.

Before that, P1 steps 1-4 of the architecture review (commits `ecdef05`, `2240fe4`, `994fe67`, `db44d42`, `e6d505c`; pushed):

- Composition root `src/mindmesh.js` (`createMindMesh`); `createApp(services)` / `createMcpServer(services)` build without listening or connecting.
- `npm test`: 48 characterization tests (`node:test`) for the web API and MCP tools over in-memory stores; checked by deliberately breaking the auto-mode delete rule and the endpoint check (both caught on web and MCP).
- `GraphWriteService` is the only caller of store write methods (enforced by `test/writeGate.test.js`); direct reviewer edits now report vector sync failures as `VECTOR_SYNC_FAILED`.
- `HitlService` owns proposals and direct reviewer edits; `server.js` is HTTP only; `IngestionService` keeps context, prompt, LLM, and `prepareExtraction()`.
- Intended behavior changes: MCP `apply-ingestion` reconciles with pending proposals like web ingest; proposal responses also carry `records`.
- Checks after each step: `npm test`, `kg:test-parser`, lint, MCP smoke test, and live throwaway round trips on port 3100 (direct edits; propose + approve) with both stores restored.

Earlier (2026-10-11, pushed): review bugs 1, 2, 5, 6, the Neo4j 5.23+ cleanup, the cleanups (untracked config files and bundle, safe config placeholders). Details are in the git log and the review file.

## Open Follow-Ups

- Commit and push the MCP tool set. After pulling on the work laptop, restart the MCP server in VS Code / Agentforce so the agent sees the new tools; agent setups or saved prompts naming the old tools need the new names.
- The client-side parser `lib/hitlProposal.js` can now be replaced by the server's `records` (review finding F; part of roadmap item 1).
- `src/cli/testParser.js` still holds many assertions in one script; move them into `test/` gradually.
- If a relation references a node that exists only in another pending proposal, with no node record in its own payload, approval fails until that other proposal is approved (no ordering across proposals).
- The HITL preview does not show `relationEndpoint` violations; they appear as the `AMBIGUITY:` signal on the card and as the approve error.
- `NODE_UPDATE` for a node that does not exist still creates it (operations as enforced checks is still open).
- Change the Neo4j password that was exposed in public commit `8ab0051`.
- The `auto`-mode branch of the MCP smoke-test cleanup is untested (only `hitl` mode was run).
- Longer-term work lives in `MEMORY_BANK/roadmap.md`.
