import { useState } from "preact/hooks";
import { Field } from "../common/Field.js";

// Trial queries: read-only Cypher (the same guard as the MCP query_cypher tool) and one vector match against
// several Chroma collections.

const SAMPLE_CYPHER = "MATCH (n:KnowledgeNode)\nRETURN n.type AS type, count(n) AS nodes\nORDER BY nodes DESC";

function cellText(value) {
	if (value === null || value === undefined) {
		return "";
	}
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function AdminQueryConsole({ request, collections, onMessage }) {
	const [cypher, setCypher] = useState(SAMPLE_CYPHER);
	const [params, setParams] = useState("{}");
	const [limit, setLimit] = useState(100);
	const [cypherResult, setCypherResult] = useState(null);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState(() => collections.filter((item) => item.role !== "other").map((item) => item.name));
	const [topK, setTopK] = useState(5);
	const [vectorResult, setVectorResult] = useState(null);
	const [busy, setBusy] = useState("");

	async function runCypher(event) {
		event.preventDefault();
		let parsedParams;
		try {
			parsedParams = JSON.parse(params || "{}");
		} catch {
			onMessage("Params must be a JSON object.", true);
			return;
		}
		setBusy("cypher");
		try {
			setCypherResult(await request("POST", "/api/admin/query/cypher", { cypher, params: parsedParams, limit: Number(limit) }));
		} catch (error) {
			setCypherResult(null);
			onMessage(error.message, true);
		} finally {
			setBusy("");
		}
	}

	async function runVector(event) {
		event.preventDefault();
		setBusy("vector");
		try {
			setVectorResult(await request("POST", "/api/admin/query/vector", { query, collections: selected, topK: Number(topK) }));
		} catch (error) {
			setVectorResult(null);
			onMessage(error.message, true);
		} finally {
			setBusy("");
		}
	}

	function toggle(name) {
		setSelected((current) => (current.includes(name) ? current.filter((item) => item !== name) : [...current, name]));
	}

	return (
		<div class="admin-stack">
			<section class="admin-card">
				<h3>Cypher (read-only)</h3>
				<p class="muted-copy">Neo4j checks that the query only reads; writes, schema changes, LOAD CSV, dbms.*, apoc.* and most SHOW commands are refused. 10 second timeout.</p>
				<form class="admin-form" onSubmit={runCypher}>
					<Field label="Query"><textarea class="admin-code" rows="6" value={cypher} onInput={(event) => setCypher(event.currentTarget.value)} spellcheck={false} /></Field>
					<div class="admin-filter-grid">
						<Field label="Params (JSON)"><input class="admin-code" value={params} onInput={(event) => setParams(event.currentTarget.value)} spellcheck={false} /></Field>
						<Field label="Row limit"><input type="number" min="1" max="500" value={limit} onInput={(event) => setLimit(event.currentTarget.value)} /></Field>
					</div>
					<button type="submit" class="primary" disabled={busy === "cypher" || !cypher.trim()}>{busy === "cypher" ? "Running..." : "Run query"}</button>
				</form>
				{cypherResult && (
					cypherResult.rows.length === 0 ? <p class="muted-copy">No rows.</p> : (
						<div class="admin-scroll">
							<table class="admin-table">
								<thead><tr>{cypherResult.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
								<tbody>
									{cypherResult.rows.map((row, index) => (
										<tr key={index}>{cypherResult.columns.map((column) => <td key={column}>{cellText(row[column])}</td>)}</tr>
									))}
								</tbody>
							</table>
							{cypherResult.truncated && <p class="admin-warning">Showing the first {cypherResult.rows.length} rows.</p>}
						</div>
					)
				)}
			</section>

			<section class="admin-card">
				<h3>Vector match</h3>
				<form class="admin-form" onSubmit={runVector}>
					<Field label="Query text"><input value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder="screen that verifies PAN" /></Field>
					<div class="admin-collections">
						{collections.map((item) => (
							<label class="admin-checkbox" key={item.name}>
								<input type="checkbox" checked={selected.includes(item.name)} onChange={() => toggle(item.name)} />
								<span>{item.name}</span>
								<small>{item.role} · {item.count}</small>
							</label>
						))}
					</div>
					<Field label="Results per collection"><input type="number" min="1" max="20" value={topK} onInput={(event) => setTopK(event.currentTarget.value)} /></Field>
					<button type="submit" class="primary" disabled={busy === "vector" || !query.trim() || selected.length === 0}>{busy === "vector" ? "Matching..." : "Match"}</button>
				</form>
				{vectorResult && vectorResult.results.map((result) => (
					<div class="admin-vector-result" key={result.collection}>
						<h4>{result.collection} {result.role && <span class={`admin-role role-${result.role}`}>{result.role}</span>}</h4>
						{result.error ? <p class="admin-warning">{result.error}</p> : result.matches.length === 0 ? <p class="muted-copy">No matches.</p> : (
							<table class="admin-table">
								<thead><tr><th>Id</th><th class="admin-number">Distance</th><th>Document</th></tr></thead>
								<tbody>
									{result.matches.map((match) => (
										<tr key={match.id}>
											<td><code>{match.id}</code></td>
											<td class="admin-number">{typeof match.distance === "number" ? match.distance.toFixed(3) : ""}</td>
											<td>{match.document}</td>
										</tr>
									))}
								</tbody>
							</table>
						)}
					</div>
				))}
			</section>
		</div>
	);
}
