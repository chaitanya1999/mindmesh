// Read-only overview: runtime, Neo4j, Chroma collections, pending proposals, and schema health.

function CountTable({ title, rows, emptyText }) {
	return (
		<section class="admin-card">
			<h3>{title}</h3>
			{rows.length === 0 ? <p class="muted-copy">{emptyText}</p> : (
				<table class="admin-table">
					<tbody>
						{rows.map((row) => (
							<tr key={row.type}>
								<td>{row.type || "(none)"}</td>
								<td class="admin-number">{row.count}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	);
}

export function AdminOverview({ overview, onRefresh, loading }) {
	if (!overview) {
		return <p class="muted-copy">{loading ? "Loading overview..." : "No overview loaded."}</p>;
	}

	const { runtime, neo4j, chroma, proposals, schemaHealth } = overview;
	const unapprovedNodes = schemaHealth.unapprovedTypesInGraph.nodeTypes;
	const unapprovedRelations = schemaHealth.unapprovedTypesInGraph.relationTypes;

	return (
		<div class="admin-stack">
			<div class="admin-toolbar">
				<button type="button" onClick={onRefresh} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
			</div>

			<div class="admin-stats">
				<div><span>Nodes</span><strong>{neo4j.totals.nodes}</strong></div>
				<div><span>Relations</span><strong>{neo4j.totals.relations}</strong></div>
				<div><span>Pending proposals</span><strong>{proposals.pending}</strong></div>
				<div><span>Chroma collections</span><strong>{chroma.collections.length}</strong></div>
			</div>

			<div class="admin-grid">
				<section class="admin-card">
					<h3>Neo4j</h3>
					<dl class="admin-facts">
						<dt>Server</dt><dd>{neo4j.name} {neo4j.version} ({neo4j.edition})</dd>
						<dt>Database</dt><dd>{neo4j.database}</dd>
						<dt>Nodes outside MindMesh</dt><dd>{neo4j.nodesOutsideMindMesh}</dd>
						<dt>Constraints</dt><dd>{neo4j.constraints.map((item) => item.name).join(", ") || "none"}</dd>
						<dt>Indexes</dt><dd>{neo4j.indexes.map((item) => `${item.name} (${item.state})`).join(", ") || "none"}</dd>
					</dl>
				</section>

				<section class="admin-card">
					<h3>Chroma</h3>
					<dl class="admin-facts">
						<dt>URL</dt><dd>{chroma.url}</dd>
						<dt>Tenant / database</dt><dd>{chroma.tenant} / {chroma.database}</dd>
					</dl>
					<table class="admin-table">
						<thead><tr><th>Collection</th><th>Role</th><th class="admin-number">Records</th></tr></thead>
						<tbody>
							{chroma.collections.map((collection) => (
								<tr key={collection.name}>
									<td>{collection.name}</td>
									<td><span class={`admin-role role-${collection.role}`}>{collection.role}</span></td>
									<td class="admin-number">{collection.count}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>

				<CountTable title="Nodes per type" rows={neo4j.nodeTypes} emptyText="No nodes." />
				<CountTable title="Relations per type" rows={neo4j.relationTypes} emptyText="No relations." />

				<section class="admin-card">
					<h3>Schema health</h3>
					{unapprovedNodes.length + unapprovedRelations.length === 0
						? <p class="muted-copy">Every type in the graph is approved in the schema.</p>
						: (
							<p class="admin-warning">
								Types in the graph but not in the schema: {[...unapprovedNodes, ...unapprovedRelations].map((row) => `${row.type || "(none)"} (${row.count})`).join(", ")}
							</p>
						)}
					<dl class="admin-facts">
						<dt>Unused node types</dt><dd>{schemaHealth.unusedNodeTypes.join(", ") || "none"}</dd>
						<dt>Unused relation types</dt><dd>{schemaHealth.unusedRelationTypes.join(", ") || "none"}</dd>
					</dl>
				</section>

				<section class="admin-card">
					<h3>Runtime</h3>
					<dl class="admin-facts">
						{Object.entries(runtime)
							.filter(([, value]) => value !== undefined && value !== null && value !== "")
							.map(([key, value]) => [
								<dt key={`${key}-k`}>{key}</dt>,
								<dd key={`${key}-v`}>{Array.isArray(value) ? value.join(", ") : String(value)}</dd>,
							])}
					</dl>
				</section>
			</div>
		</div>
	);
}
