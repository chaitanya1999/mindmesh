# MindMesh Roadmap

Planned work that is not started. Each item is written so a fresh session can resume it: goal, why, the design agreed so far, steps, open questions. When an item starts, copy its plan into `activeContext.md`; when it ships, delete it here and document the result in `README.md` / `codeMap.md`.

The user's own brainstorm list is `TODO.md` (scratch, user-owned; do not edit it). This file holds only items with an agreed direction.

Status legend: **Next** (resume this first), **Planned** (direction agreed), **Idea** (needs a decision before planning).

---

## 1. Split `App()` into hooks and pages: **Next**

**Goal.** `src/server/public/app.js` still holds a ~1,700-line `App()` with about 40 `useState` hooks and 50 handlers for every route. Components were already moved into one file each (commit `5a1fefd`); this is the second phase.

**Why.** The owner must be able to read and own the frontend. A single huge component makes every HITL or UI change risky.

**Target structure** (inside `src/server/public`):

```text
app.js                     render(<App/>) + route switch only (~40 lines)
config/constants.js        limits, storage keys, routes, welcome messages (from the top of app.js)
hooks/
  useGraph.js              graph, loadGraph, selection, focus, highlight
  useGraphMutations.js     save/create/delete node and relation (main and HITL direct variants)
  useSearch.js             client and server search
  useAskChat.js            ask messages, session memory, runAsk
  useIngest.js             ingest text/files, runIngest
  useHitlDraft.js          selected note, edited response, original response, dirty flag, draft CRUD
  useJobs.js               job state, runJob
  useWorkspaceResize.js    divider drag/keyboard/snap/reset
  useUserName.js           workspace user name and HITL reviewer name
lib/pipelineDraft.js       pipeline editing helpers still in app.js (updatePipelineNode, ...);
                           merge duplicates with lib/hitlProposal.js (decodePipelineField, toSnakeCase, ...)
components/graph/GraphView.js   picks NeoVis or Sigma; replaces the 4x duplicated renderer JSX in App
pages/
  WorkspaceLayout.js       graph | divider | side panel shell shared by all routes
  MainPage.js  HitlPage.js  SchemaPage.js  JobsPage.js
```

**Steps** (one commit each; verify after each):

1. `config/constants.js` and `lib/pipelineDraft.js` (pure moves; merge duplicate helpers with `lib/hitlProposal.js`).
2. `GraphView.js`, replacing the four renderer blocks.
3. Hooks, one per commit, `useGraph` first because almost everything depends on it. This is the only risky step: state shared inside `App` must be passed explicitly.
4. `WorkspaceLayout` and the four pages; `App` becomes a route switch.

**Verification** (same method as the component split):

- ESLint `no-undef` / `no-unused-vars` with the React JSX rules (esbuild does not report missing imports).
- Render all four routes headlessly (jsdom) with the old and new bundles and compare the HTML.
- Manual click-through: select and edit nodes on `/`, edit/approve/regenerate on `/hitl`, schema save, jobs, divider resize.

**Open questions.**

- Keep both graph renderers? NeoVis is the default; dropping Sigma removes about 600 lines.
- Per-component CSS files (LWC-style folders) or keep one `styles.css`? esbuild can bundle CSS imports.
- Keep the Jobs page? Its jobs need the server LLM, which is unavailable at work.

---

## 2. Richer MCP tools: **Planned**

**Goal.** MCP is the main way the owner uses MindMesh at work (Coding Agents in VS Code). The current tools cover ask, ingest, and regeneration only.

**Design agreed so far.** Thin tools in MindMesh, workflows as agent skills/prompts. A skill can suggest, but a tool must enforce.

| Tool | Purpose |
|---|---|
| `search_entities(query, type?, bu?)` | check whether something exists before proposing it |
| `get_entity(id)` | node with description and direct relations |
| `get_dependencies(id, depth, direction)` | impact traversal ("where is Mobile Number used") |
| `submit_proposals(records, mode, source, batchLabel)` | `mode` = `nodes` / `relations` / `full`; reject records that do not match the mode |
| `get_schema()` | types and field guidance |

Skills on top: `seed-entities` (nodes only), `seed-relations` (relations over existing nodes), `impact-analysis`, `rework-feedback` (regeneration already covers part of this).

**Steps.** Add read tools first (search, get, dependencies), then `submit_proposals` with mode enforcement, then write the skill files under a `skills/` folder.

**Open questions.** Batch labels and source documents need a proper proposal store (item 3) to be queryable.

---

## 3. Move HITL proposals out of Chroma: **Planned**

**Goal.** Proposals live as Chroma documents parsed by section markers, with flat metadata. That is awkward for batches, provenance, history, and agent feedback, and proposals cannot be rebuilt if the collection is lost.

**Direction.** A small proposal store, for example SQLite through Node's built-in `node:sqlite` (no native module, no server; check its stability status in the installed Node version) or JSON files. Keep embedding pending proposals in Chroma only for the pending-context retrieval.

**Steps.** Define the store interface (the existing `upsertHitlNote` / `listHitlNotes` / `getHitlNote` / `deleteHitlNotes` / `queryHitlNotes` set plus batches), implement it, migrate existing notes, switch the server and MCP to it.

**Open questions.** Keep regeneration history once a real store exists (original + latest variant was discussed)?

---

## 4. Folder restructure: **Planned**

**Goal.** Clearer structure, after items 1 and 3 so files are not moved twice.

```text
core/       ingestion, rag, schema, proposals
adapters/   neo4j, chroma, embedding, llm
apps/api/   Express routes (split out of server.js)
apps/mcp/   MCP server
apps/cli/   commands only; smoke tests to tests/
apps/web/   frontend
prompts/  schema/  skills/  docs/
```

Do it with `git mv` on a branch, with no behavior change; run the smoke tests before and after each move.

---

## 5. UI revamp: **Idea**

**Direction discussed.** Two main views instead of a graph-plus-sidebar for everything:

- **Review**: table-first proposal review (approve, edit inline, merge into an existing node, reject, send back with notes), with an optional "show in graph" split for relation batches.
- **Explore**: dependency-focused view (pick an entity; dependents grouped by relation type and layer, BU filter), plus an entity page (description, grouped relations, backlinks, pending changes). The free force graph stays as a secondary toggle.

**Open questions.** Framework: stay on Preact, or Lit / Angular (owner prefers separated HTML/CSS/JS files, as in LWC). Decide after using the current UI more.

---

## 6. Validate on one real groomed story: **Idea**

**Goal.** Prove the knowledge graph catches indirect dependencies before investing in larger rewrites.

**Plan from the v2 discussion.**

1. Pull Salesforce metadata for only the area one story touches (components, classes, flows, fields) and build that technical slice deterministically with a small parser; node ids come from API names.
2. Add the functional knowledge for that area through ingest + HITL.
3. Run the agent's impact analysis with and without the knowledge graph and compare what each catches.

**Related design.** Technical layer parsed from metadata (exact, shared across business units); functional layer from prose + HITL (business-unit specific); vector similarity never creates edges.

---

## Open Risks

- **How Agentforce reaches the knowledge graph.** Agentforce for Developers in VS Code can use a local MCP server; an org-side Agentforce agent would need a hosted endpoint, which makes hosting a priority.
- **OneNote ingestion.** The bank tenant likely blocks Microsoft Graph app consent; the fallback is periodic export plus diff.

---

## Ideas Without A Plan Yet

- **LLM query rewriting for Ask follow-ups.** Removed as dead code. If wanted, do it agent-side for MCP, or as an optional server step when an LLM is configured.
- **Minimal users and roles.** Also closes review bug 3: today the write API has no auth and the server listens on all interfaces; the owner chose to solve this with user management rather than a bind-address fix. Owner / contributor / agent; agent writes always become proposals; enforce at the API layer.
- **Tiered HITL (severity levels).** The first tier is done: `auto` mode applies only clean creates and updates, and any ambiguity, contradiction, or delete goes to review. Next idea from the owner: the LLM emits a severity per signal (for example `AMBIGUITY:HIGH:<reason>`, levels HIGH / MEDIUM / LOW); HIGH and MEDIUM need HITL, LOW can auto-apply. Needs a prompt change, a parser for the level, and a rule change in `reviewReasons()`.
