# CLAUDE.md

Instructions for Claude Code in the MindMesh repository.

## Memory Bank

The project briefing is imported below and is always in context:

@MEMORY_BANK/core.md

Use the rest of the memory bank like this:

- At the start of every task, read `MEMORY_BANK/activeContext.md`. For any task larger than a quick fix, replace its "Current Task" section with the goal, plan, files, and done-when criteria before writing code.
- Before changing a pathway, read its entry in `MEMORY_BANK/codeMap.md` to find the entry points and files instead of searching the repo from scratch.
- `README.md` is the full reference for behavior. Read the section named in the codeMap entry, not the whole file.
- At the end of a task, update `activeContext.md` (Last Completed, Open Follow-Ups).

Keep the docs single-sourced. Never copy the same fact into two files:

| Change | Update |
|---|---|
| Behavior, data model, API, config, commands | `README.md` |
| Files, functions, or call chains moved or added | `MEMORY_BANK/codeMap.md` |
| A hard rule or a design reason | `MEMORY_BANK/core.md` |
| Task progress | `MEMORY_BANK/activeContext.md` |

Before finishing, check that every doc you touched still matches the code.

## Git

- Do not commit or push unless the user asks.
- Never stage `config.json`, `claude-chat.md`, or `mindmesh-v2-handoff.md`; they are local-only.
- `src/server/public/app.bundle.js` is tracked: run `npm run kg:web:build` before committing UI changes.
- End commit messages with the attribution line given by the session, if any.

## Testing

- `npm run kg:test-parser` needs no services; `kg:test-db` and `kg:test-llm` need Neo4j, Chroma, and the configured LLM.
- There is no lint config in the repo. ESLint `no-undef` is the reliable way to catch missing imports in the frontend, because esbuild does not report undefined identifiers.
- When testing against the user's real databases, use throwaway ids (for example `zztest_*`), delete them afterwards, and confirm the graph and HITL counts are unchanged. `src/mcp/smokeTest.js` leaves a pending HITL proposal behind, so do not run it casually.
- The user's web server runs on port 3000. Start test servers on another port (`KG_WEB_PORT=3100`) and stop them afterwards.
- Scripts that open their own Neo4j session must pass `graph.neo4j.database`; the configured database may not be the default one.

## Environment

- Windows. Bash (Git Bash) and PowerShell are both available.
- Many files use CRLF line endings, and `sed -i` in Git Bash rewrites them to LF. Preserve the existing line endings when editing.
