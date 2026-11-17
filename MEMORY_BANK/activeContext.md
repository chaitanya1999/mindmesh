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

## Last Completed (2026-11-17)

Scope dimensions, plus scope guidance moved into the schema. Owner decisions: named dimensions declared in the schema (LOS: `bu` uc, nc, tw, cv, tr; `module` sbd, hzt, mandate, pai); no `common` (a shared item lists its units; blank = not stated); no rules between dimensions (a module-only node is valid); filtering per dimension (the value, or no value stated); the picker or the agent's `scope` chooses the filter, blank = unscoped search; no open/"more" marker and no scope review job (roadmap ideas); node scopes on, relation scopes off. Behavior: README Graph Schema > Scope; locations: codeMap Scope; rule: core.md.

- Storage: Neo4j keeps one `scope` list of `dimension:value` strings; Chroma flags `scope:<dim>:<value>` plus `scoped:<dim>` for every declared dimension; Ask's pending-proposal filter checks the stored ingest scope text after the query. Records: `bu:nc,uc;module:sbd`. A payload apply replaces only the dimensions a record states.
- MCP `scope` is an object with one string per dimension (ingest tools require every dimension, `""` = none); `get_schema` returns `scopeDimensions`; the smoke test builds a blank scope object from the tool schema.
- UI: one select per dimension (new session key, so old single values are not reused), form toggle rows per dimension, chips per dimension, checklist text.
- Scope guidance: the prompt file keeps only generic SCOPE RULES; the LOS rules (unit prefix naming, shared technical artefacts, module items, relation scope) are `guidance` lines on the schema's `scope` descriptors, rendered into `{{SCOPE_GUIDANCE}}` by `formatScopeGuidance()` for the kinds switched on.
- The owner's local `schema/graphSchema.json` got the dimension descriptors and the `guidance` lines on both `scope` fields. Only the two `scope` descriptors changed; the rest was rewritten with the same content.
- Checks: `npm test` 127 pass (`test/scope.test.js` rewritten; switch-off tests moved to dimensions and check that guidance follows the switches); mutation checks (merge replacing every dimension; an unstated dimension not matching) failed 2 and 5 tests; `kg:test-parser`; bundle builds; lint clean apart from the two old findings.
- Live (real Neo4j + Chroma + hub LLM, throwaway `zztest_*`, stores empty before and after, 0 nodes / 0 relations / 0 proposals): 33 service checks (Neo4j entries, Chroma flags, Cypher and Chroma filters per dimension, expansion, Cypher per-dimension merge and blank-keeps, stale flags on edit, change and out-of-scope signals, proposal list and Ask pending filters, MCP scope object and required dimensions, schema guidance in the prompt and relation guidance left out, `get_schema` dimensions); a real LLM extraction with scope `bu:nc` produced `nc_`-prefixed `bu:nc` nodes, an SBD-owned item as `bu:nc,uc;module:sbd` without prefix, and the link to a UC node flagged. MCP smoke test passed (it cleans up). jsdom UI check on port 3100, 12 checks (two pickers with the right options, session state, Ask sends `bu:uc;module:sbd`, clearing one dimension, node form toggle rows, no script errors; Ask and Ingest intercepted, nothing written).

## Last Completed (2026-10-23, afternoon)

Scope follow-up, owner decisions after the live run: (1) the ingest scope frames the reasoning and no longer filters the ingest context (filtering made the LLM guess the names of other units' nodes); records touching existing nodes scoped outside the ingest scope get an `AMBIGUITY:` signal. (2) Config switches `scope.nodes` and `scope.relations` (both off when not set; `config.example.json` turns nodes on), implemented now instead of a roadmap item; relation scope is therefore off. Behavior: README Graph Schema > Scope; locations: codeMap Scope.

- Also fixed: `runIngest` in `app.js` lacked `workspaceScope` in its dependencies, so Ingest could send a stale scope after the picker changed (bug from `4b601d5`; the UI check reproduced it with the old list). Proposal text is rewritten when a switched-off scope was dropped, so the HITL view never shows it.
- Checks: `npm test` 124 pass (new `test/scopeRelationsOff.test.js`, `test/scopeOff.test.js`; mutation checks on the out-of-scope flag and the prompt sections failed tests as expected); `kg:test-parser`; build; lint (only the two old findings). Live, real stores + hub LLM: 26 store checks (both scopes on); ingests with relations off gave no relation scopes; an nc ingest naming "the UC QDE screen" linked to the real `uc_qde_screen` (no invented edit) and the relation was flagged; nc and uc QDE texts each reused their own unit's screen with both visible; MCP tools offer `scope` only where switched on; jsdom UI check 17/17 (picker, chips, no relation scope field, Ingest sends the changed scope). Stores empty before and after.

Earlier the same day:


Scope (business units), pushed as `4b601d5`, plus a fix from the live run (below). Owner decisions: values `uc, nc, tw, cv, tr, common` from the schema; blank = not curated and matches every filter; filter `uc` matches `uc`, `common`, unscoped; filter `common` matches `common`, unscoped; BU concepts get a name prefix (`uc_qde_screen`), shared technical nodes keep API names; scope column before `metadata`, no backward compatibility; blank update keeps, filled replaces, a change of an existing non-empty node scope is flagged `AMBIGUITY:`; relation scope supported but the prompt keeps it empty; MCP ingest tools require `scope` and tell the agent to ask; one Scope picker for Ask and Ingest. Behavior: README Graph Schema > Scope; locations: codeMap Scope; rule: core.md.

- Also: `--scope` for `kg:ingest` / `kg:ask`; HITL card and detail show the ingest scope; Review checklist in the HITL detail; HITL preview keeps the stored scope for blank-scope records; `list_proposals` scope filter; `get_schema` returns `scopeValues`.
- The owner's local `schema/graphSchema.json` got the two `scope` descriptors (backup of the old file in that session's scratchpad).
- Checks: `npm test` 109 pass (new `test/scope.test.js`, 16 tests; a deliberately broken filter rule failed 6 of them); existing tests and `kg:test-parser` fixtures moved to the new column count; bundle builds; lint clean except the two old findings (`cleanField` in graphPayload.js, `_ids` in adminRoutes.js). Not run at first: the real stores were down.

Live run (2026-10-23, real Neo4j + Chroma + hub LLM, stores empty before and after):

- Service-level script, 26 checks: Neo4j list property (absent when unscoped), Chroma flags, text/semantic/relation search per scope, `$and` with type, explore, search_context, the `query_cypher` example, 400s, proposal scope + pending filter, approve, blank keeps, auto-mode scope change to review then approve, scope violations, preview, direct clear, relation re-id, fresh reindex, regeneration scope.
- Bug found and fixed: Chroma's upsert merges metadata, so a removed value's `scope_<value>` flag stayed true (a node moved uc -> nc still matched uc). `upsertGraphIndex` now sets stale flags to false; the test fake merges like Chroma; regression test added (fails without the fix).
- Real LLM ingests: same text with scope nc / uc reused `nc_qde_screen` / `uc_qde_screen` (context excluded the other unit); BU concepts got the prefix and scope, shared components stayed unscoped; "shared by every unit" became `common`. The LLM set redundant relation scopes, so the prompt rule and the relation `scope` field guidance were tightened (re-run: empty). Ask per scope answered from the right unit.
- MCP: smoke test passed; scoped stdio session (required `scope`, ask-the-user text, bad value refused, filters, query_cypher, list/get/regenerate with scope).
- UI in jsdom on port 3100, 15 checks: picker (None + 6), session memory, Ask sends scope, form chips and the common rule, HITL card tag, ingest scope, checklist, row chips, no script errors.

Before that (2026-10-12), the admin panel (`/admin`), committed as `d200f9b` and `6745324`. Owner decisions: all suggested extras; reachable from any machine with the password; password set by `npm run kg:admin:password`, stored only as a scrypt hash in local `config.json`.

- Backend: `src/admin/` (`adminService.js`, `adminAuth.js`, `auditLog.js`), `src/server/adminRoutes.js`, `src/cli/adminPassword.js`. Maintenance writes go through `GraphWriteService` (`wipeGraph`, `clearGraphVectors`, `reindexVectors`, `repairVectorIndex`) and `HitlService` (proposal export, clear); `kg:reindex-vectors` now uses `GraphWriteService.reindexVectors()` and no longer needs a write-gate exception. New store methods: `deleteAllKnowledge`, `listIds`, `getDatabaseInfo` (Neo4j); `deleteCollections`, `clearHitlCollection`, `listCollectionsWithCounts`, `listIndexIds`, `queryCollections` (Chroma).
- Frontend: `components/admin/` (Overview, Maintenance, Query console, Danger zone, Audit log), `/admin` link in the route switcher.
- `config.example.json`: `admin.passwordHash`, `admin.sessionMinutes`. Docs: README Admin Panel; core.md maintenance exception to the HITL write rule.
- Simplified after a self-review (same day): Reindex and Repair need only the session (wipes keep password + `DELETE`); filtered proposal cleanup removed; the password CLI keeps spaces in `--stdin` passwords and the config file's indentation.
- Checks: `npm test` with `test/admin.test.js` (19 tests); bundle builds; lint clean; headless UI check in jsdom against the real stores on port 3100 (17 checks, nothing destructive pressed); the consistency check and repair were also run live (they found and removed an orphan throwaway vector). Both stores ended empty, as they were before. The live run of wipe/reindex was blocked by the permission classifier and not run; those paths are covered only by the in-memory tests.

Before that, the MCP tool set (former roadmap item 2), pushed as `68b4b86`:

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

- Vectors written before a scope dimension was declared have no `scoped:<dim>` flag; reindex after adding a dimension or restoring old data.
- Scope retrofit (owner): admin backup -> settle pending proposals -> wipe -> re-ingest per area with the scope pickers or MCP `scope`.
- Scope is not shown in the Sigma renderer (no tooltip there) and the HITL list has no scope filter in the UI (the API and MCP have one).
- Admin panel: restoring from a backup file is not implemented. Sessions are in memory (a restart logs out). Over plain HTTP the password travels unencrypted; HTTPS or a trusted network is needed for use from other machines. Run wipe and reindex once live on throwaway data when convenient.
- After pulling on the work laptop, restart the MCP server in VS Code / Agentforce so the agent sees the new tools; agent setups or saved prompts naming the old tools need the new names.
- The client-side parser `lib/hitlProposal.js` can now be replaced by the server's `records` (review finding F; part of roadmap item 1).
- `src/cli/testParser.js` still holds many assertions in one script; move them into `test/` gradually.
- If a relation references a node that exists only in another pending proposal, with no node record in its own payload, approval fails until that other proposal is approved (no ordering across proposals).
- The HITL preview does not show `relationEndpoint` violations; they appear as the `AMBIGUITY:` signal on the card and as the approve error.
- `NODE_UPDATE` for a node that does not exist still creates it (operations as enforced checks is still open).
- Change the Neo4j password that was exposed in public commit `8ab0051`.
- The `auto`-mode branch of the MCP smoke-test cleanup is untested (only `hitl` mode was run).
- Longer-term work lives in `MEMORY_BANK/roadmap.md`.
