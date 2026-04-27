# Knowledge Graph POC

Prototype personal knowledge management system using Node.js, an LLM, Neo4j, and ChromaDB.

## Runtime

- Default LLM: Gemini via `@google/genai`
- Optional local LLM: Ollama with model `mistral`
- Graph DB: Neo4j
- Vector DB: ChromaDB, used for graph entry-point node search

## Setup

Install dependencies from the repo root:

```powershell
npm install
```

Run Neo4j and ChromaDB locally. Chroma defaults to:

```text
http://localhost:8000
```

Optional local POC config:

```powershell
Copy-Item .\knowledgeGraphPOC\config.example.json .\knowledgeGraphPOC\config.json
```

Secrets can also come from environment variables:

```powershell
$env:GEMINI_API_KEY="your-key"
$env:KG_LLM_PROVIDER="gemini"
```

## Commands

Test both databases:

```powershell
npm run kg:test-db
```

Run parser smoke tests:

```powershell
npm run kg:test-parser
```

Ingest with the hardcoded fallback sample:

```powershell
npm run kg:ingest
```

Ingest CLI text:

```powershell
npm run kg:ingest -- "EKYC Screen uses PAN Verification API."
```

Ingest from a file:

```powershell
npm run kg:ingest -- --file .\notes\input.txt
```

Ingest via runtime input:

```powershell
npm run kg:ingest -- --interactive
```

Ask with the hardcoded fallback question:

```powershell
npm run kg:ask
```

Ask a CLI question:

```powershell
npm run kg:ask -- "What does the EKYC screen use?"
```

Use Ollama instead of Gemini:

```powershell
npm run kg:ask -- --provider ollama "What does the EKYC screen use?"
```

## Schema

Neo4j nodes use label `KnowledgeNode` with:

- `id`
- `label`
- `name`
- `type`
- `description`
- `createdAt`
- `updatedAt`

Neo4j relationships use type `RELATES_TO` with:

- `id`
- `sourceId`
- `targetId`
- `relation`
- `information`
- `description`
- `createdAt`
- `updatedAt`

Chroma collections:

- `kg_nodes`
- `kg_relationships`

The current RAG path queries `kg_nodes`, expands matching Neo4j nodes to depth `4`, then sends that graph context to the selected LLM.
