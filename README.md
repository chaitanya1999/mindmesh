# LLM Learn

Small starter scripts for learning Gemini integration before moving into RAG and agentic workflows.

## Setup

Rotate any API key that was pasted into chat or committed anywhere.

Set your Gemini API key in `config.json`:

```json
{
  "apiKey": "your-api-key",
  "model": "gemini-2.5-flash"
}
```

Choose a model in `config.json`. The default is `gemini-2.5-flash`.

```json
{
  "apiKey": "your-api-key",
  "model": "gemma-3-27b-it"
}
```

## Python

Install:

```powershell
python -m pip install -r requirements.txt
```

Run:

```powershell
python .\gemini_prompt.py "Explain embeddings in one paragraph"
```

## Node.js

Install:

```powershell
npm install
```

Run:

```powershell
npm run prompt -- "Explain embeddings in one paragraph"
```

Simple local RAG demo with in-place dummy data and keyword search:

```powershell
npm run rag -- "How does the refund policy work?"
```

The RAG demo prints the retrieved documents, the prompt built from that context, and a local answer. To send the retrieved context to Gemini instead, add `--llm`:

```powershell
npm run rag -- --llm "How does the refund policy work?"
```

Neo4j connection smoke test:

```powershell
npm run neo4j:test
```

The Neo4j test defaults to `bolt://localhost:7687`, database `neo4j`, username `neo4j`, password `neo4j`, and instance label `myGraphDB`. Override them with `NEO4J_URI`, `NEO4J_DATABASE`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, or `NEO4J_INSTANCE`.

## Why These Packages?

Google currently recommends the Google GenAI SDKs:

- Python: `google-genai`
- Node.js: `@google/genai`

These are better learning foundations than raw HTTP because the same client style later expands into chat, multimodal prompts, file uploads, structured output, and the pieces you will use before RAG and agentic systems.
