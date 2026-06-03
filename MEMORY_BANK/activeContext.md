# Active Context

This file is rewritten per task. Do not treat it as durable history.

## Task

Update documentation after the config simplification. `src/config.js` now reads root `config.json` and applies optional `{{KEY}}` replacements from `config.replacements.json` or caller-supplied maps instead of reading application settings from environment variables.

## Goal

`README.md` and the Memory Bank should accurately describe the JSON replacement config model, the known loader side effects, and the remaining web-port-only process environment override.

## Relevant Code Pathways

```text
src/config.js
  -> reads config.json
  -> merges caller replacements with config.replacements.json
  -> replaces {{KEY}} placeholders
  -> parses JSON and returns runtime config
```

```text
src/server/server.js
  -> still reads KG_WEB_PORT / PORT directly for server launch port
```

## Relevant Files

- `README.md`
- `MEMORY_BANK/core.md`
- `MEMORY_BANK/codeMap.md`
- `MEMORY_BANK/decisions.md`
- `MEMORY_BANK/activeContext.md`

## Implementation Plan

1. Replace README env-var precedence docs with the config/replacements model.
2. Update setup and provider examples to use `config.json` plus `config.replacements.json` placeholders.
3. Keep `KG_WEB_PORT` / `PORT` documented only as process-level web server port overrides.
4. Update Memory Bank rules, code map, and durable decisions to remove the old env-var pattern.
5. Verify the config loader still parses the current config and run the parser smoke test.

## Constraints

- Documentation-only task; do not change `src/config.js`.
- Do not expose real local secrets from `config.json`.
- Keep scope limited to README and Memory Bank updates.

## Acceptance Criteria

- README says `config.json` is the complete application config and `config.replacements.json` provides placeholder values.
- README documents `{{KEY}}` syntax, merge behavior, unresolved placeholders, `strict: true`, and invalid replacement JSON behavior.
- README no longer instructs users to configure LLM, embedding, graph, vector, RAG, schema, logging, or prompt settings through `$env:*` commands.
- Memory Bank no longer describes `KG_*` env vars as the application config mechanism.
- The web port exception remains documented as `KG_WEB_PORT` / `PORT`.

## Test Plan

- `node --input-type=module -e "import { getConfig, describeRuntime } from './src/config.js'; const config = getConfig(); console.log(JSON.stringify(describeRuntime(config), null, 2));"`
- `npm run kg:test-parser`
- Skip DB/LLM smoke tests unless local Neo4j, Chroma, and provider credentials are intentionally available.

## Review Checklist

- Did the implementation satisfy every acceptance criterion?
- Did it avoid touching runtime code?
- Did it avoid exposing local secrets?
- Were relevant tests run or clearly skipped with a reason?
