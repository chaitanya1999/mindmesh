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
- `codeMap.md` prevents repeated discovery of important code pathways.
- `activeContext.md` carries the current task plan across separate agent chats.

## 2026-06-03: Codex Plans And Reviews, Smaller Agent Implements

Decision:

- Use Codex as architect/planner/reviewer and a smaller agent as the scoped implementation agent.

Reason:

- Planning and review benefit from higher reasoning/context capacity, while implementation can often be delegated with a precise task packet.

Consequence:

- Codex should produce a decision-complete `activeContext.md` before implementation.
- The developer agent should follow the plan and avoid broad exploration unless the plan is ambiguou s.
- Codex should review the resulting diff against the same `activeContext.md`.

## 2026-06-03: Use JSON Replacement Config

Decision:

- Runtime application config comes from root `config.json`, with `{{KEY}}` placeholders resolved from `config.replacements.json` or caller-supplied replacement maps.

Reason:

- A dedicated JSON replacement file is simpler than maintaining broad environment-variable precedence in `src/config.js`.

Consequence:

- Application settings are documented by JSON config paths, not `KG_*` environment variables.
- Required defaults must live in `config.json` / `config.example.json`; the loader no longer supports hardcoded fallback defaults.
- Real secrets should stay out of shared docs and commits by using placeholders plus private replacement values.

## 2026-06-08: Field Guidance Through Dedicated Prompt Placeholder

Decision:

- Per-property field descriptors from `schema/graphSchema.json` are rendered into a dedicated `{{FIELD_GUIDANCE}}` placeholder in the extraction prompt, rather than being appended to the existing `{{GRAPH_SCHEMA}}` placeholder.

Reason:

- Type-level schema (approved node/relationship types) and field-level guidance (what each field means) serve different purposes and belong in different parts of the prompt. Field guidance is most useful immediately after the OUTPUT SYNTAX section where the pipe-delimited format is defined, whereas type-level schema is contextual reference material.

Consequence:

- `formatFieldGuidance()` was added to `src/schema/graphSchema.js` as a separate export.
- `formatSchemaCatalog()` was reverted to its original form (type-level only).
- `promptRegistry.js` resolves both `{{FIELD_GUIDANCE}}` and `{{GRAPH_SCHEMA}}` independently.
- Field descriptions in `graphSchema.json` remain the single source of truth; the prompt contains no hardcoded field-specific instructions.

## 2026-06-08: mergeNode Prefers Recency Over Length

Decision:

- Node descriptions and metadata from newer ingestions always replace existing values, regardless of which text is longer.

Reason:

- The previous `preferText()` strategy kept the longer text, which meant incorrect descriptions (e.g., a node description polluted with relationship context by the LLM) could never be corrected by subsequent ingestions. Preferring the incoming value enables iterative correction over time.

Consequence:

- `mergeNode()` in `src/ingestion/graphPayload.js` uses `nextNode.description ? nextNode.description : existingNode.description` instead of `preferText()`.
- The same logic applies to `metadata`.
- Relation fields (`information`, `description`, `metadata`) still use `preferText()` since they are additive by nature.

## 2026-06-08: Prompt Restructured For Recency Bias

Decision:

- `{{USER_INPUT}}` always appears last in the extraction prompt. All rules, schema context, and examples precede it.

Reason:

- LLMs exhibit strong recency bias — the last ~20-30% of tokens receive disproportionate attention. Placing the user input before instruction sections meant the actual task got diluted by the instructions that followed it.

Consequence:

- The extraction prompt follows this order: role → output format → syntax → field guidance → schema → existing context → CRUD rules → extraction rules → metadata rules → examples → `{{USER_INPUT}}`.
- The `CRITICAL OUTPUT RULES` header was renamed to `OUTPUT FORMAT REQUIREMENTS` with positive framing ("Your entire response must be...") instead of stacked negative statements ("Do NOT...").