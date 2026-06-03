# MindMesh Decisions

Durable architectural and product decisions go here. Keep this file short. Do not add temporary task notes.

## 2026-06-03: Use A Minimal Memory Bank

Decision:

- Use `core.md`, `codeMap.md`, `decisions.md`, and `activeContext.md` instead of a larger seven-file memory bank.

Reason:

- MindMesh already has a strong README, and duplicating architecture across many files would waste tokens and create drift.

Consequence:

- `README.md` remains canonical for full project documentation.
- `core.md` provides compressed project context for agents.
- `codeMap.md` prevents repeated rediscovery of important code pathways.
- `activeContext.md` carries the current task plan across separate agent chats.

## 2026-06-03: Codex Plans And Reviews, Smaller Agent Implements

Decision:

- Use Codex as architect/planner/reviewer and a smaller agent as the scoped implementation agent.

Reason:

- Planning and review benefit from higher reasoning/context capacity, while implementation can often be delegated with a precise task packet.

Consequence:

- Codex should produce a decision-complete `activeContext.md` before implementation.
- The developer agent should follow the plan and avoid broad exploration unless the plan is ambiguous.
- Codex should review the resulting diff against the same `activeContext.md`.

## 2026-06-03: Use JSON Replacement Config

Decision:

- Runtime application config comes from root `config.json`, with `{{KEY}}` placeholders resolved from `config.replacements.json` or caller-supplied replacement maps.

Reason:

- A dedicated JSON replacement file is simpler than maintaining broad environment-variable precedence in `src/config.js`.

Consequence:

- Application settings are documented by JSON config paths, not `KG_*` environment variables.
- Required defaults must live in `config.json` / `config.example.json`; the loader no longer supplies hardcoded fallback defaults.
- Real secrets should stay out of shared docs and commits by using placeholders plus private replacement values.
