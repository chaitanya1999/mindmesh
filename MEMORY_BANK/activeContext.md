# Active Context

## Task Complete: Schema-Driven Property Descriptions & Prompt Restructuring

Schema-driven field descriptors have been implemented, with field guidance now injected via a dedicated `{{FIELD_GUIDANCE}}` placeholder in the extraction prompt — separate from the type-level `{{GRAPH_SCHEMA}}`. The prompt was restructured for LLM recency bias (user input at the end). Duplicate hardcoded field descriptions were removed from the prompt in favor of schema-driven ones.

A new FIELD UNIQUENESS RULE (generic, no field names) was added to combat LLM redundancy where `description`/`information` fields duplicate what the node/relation itself expresses. Specific per-field "MUST NOT" language was strengthened in `graphSchema.json` field descriptors. The `mergeNode` function was fixed to prefer newer descriptions over longer ones, allowing subsequent ingestions to correct bad node descriptions.

`validatePropertyConstraints()` provides optional ingestion-time constraint enforcement.

## Artifacts Changed

- `schema/graphSchema.json` — added `fields` arrays under `nodeProperties`/`relationshipProperties` with descriptors, constraints, and strengthened non-redundancy language
- `schema/graphSchema.example.json` — updated with matching `fields` arrays
- `prompts/extraction-system-custom.md` — restructured order; field descriptions now injected via `{{FIELD_GUIDANCE}}` placeholder; old hardcoded duplicates removed; `{{USER_INPUT}}` moved to absolute end; added FIELD UNIQUENESS RULE; renamed `CRITICAL OUTPUT RULES` to `OUTPUT FORMAT REQUIREMENTS` with positive framing
- `src/schema/graphSchema.js` — `formatSchemaCatalog()` reverted to original (no field guidance); new `formatFieldGuidance()` export dedicated to `{{FIELD_GUIDANCE}}`
- `src/prompts/promptRegistry.js` — added `FIELD_GUIDANCE_PLACEHOLDER` rendering with `formatFieldGuidance()`
- `src/ingestion/graphPayload.js` — `mergeNode` now prefers newer description/metadata over longer; added `validatePropertyConstraints()` (pattern, maxLength, allowedValues checks)
- `src/cli/testParser.js` — tests updated for new merge behavior and separation of `formatSchemaCatalog()` vs `formatFieldGuidance()`
- `README.md` — documented property descriptors, constraint validation
- `MEMORY_BANK/codeMap.md` — documented property descriptor flow

## Key Architecture Decisions

1. **`{{FIELD_GUIDANCE}}` is a separate placeholder** — not appended to `{{GRAPH_SCHEMA}}`. Keeps type-level schema and field-level guidance cleanly separated. Positioned immediately after OUTPUT SYNTAX in the prompt.

2. **FIELD UNIQUENESS RULE is generic** — no field names or record types mentioned. Structurally applies to all records regardless of schema.

3. **`mergeNode` prefers recency** — newer description/metadata from incoming ingestion always replaces existing. Enables correction of bad descriptions over time (e.g., when a node description got polluted with relationship context by the LLM).

## Verification

- `npm run kg:test-parser` — all tests pass