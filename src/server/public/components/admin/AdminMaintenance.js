import { useState } from "preact/hooks";

// Consistency check and repair, and backup download.

function IdSummary({ label, summary }) {
	return (
		<div class={`admin-check${summary.count > 0 ? " problem" : ""}`}>
			<strong>{summary.count}</strong>
			<span>{label}</span>
			{summary.count > 0 && <code>{summary.sample.join(", ")}{summary.count > summary.sample.length ? ", ..." : ""}</code>}
		</div>
	);
}

// Saves the backup JSON through a temporary link, so the session cookie is sent with the request.
export async function downloadBackup() {
	const response = await fetch("/api/admin/backup");
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		throw Object.assign(new Error(body.error || `Backup failed (${response.status}).`), { status: response.status });
	}
	const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "mindmesh-backup.json";
	const url = URL.createObjectURL(await response.blob());
	const link = Object.assign(document.createElement("a"), { href: url, download: name });
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
	return name;
}

export function AdminMaintenance({ request, onMessage, onChanged }) {
	const [report, setReport] = useState(null);
	const [busy, setBusy] = useState("");

	async function run(label, action) {
		setBusy(label);
		try {
			return await action();
		} catch (error) {
			onMessage(error.message, true);
			return false;
		} finally {
			setBusy("");
		}
	}

	return (
		<div class="admin-stack">
			<section class="admin-card">
				<h3>Consistency check</h3>
				<p class="muted-copy">Compares the ids in Neo4j with the vector index: records without a vector cannot be found by meaning, and vectors without a record point at deleted data.</p>
				<div class="admin-toolbar">
					<button type="button" onClick={() => run("check", async () => setReport(await request("GET", "/api/admin/consistency")))} disabled={Boolean(busy)}>
						{busy === "check" ? "Checking..." : "Run check"}
					</button>
				</div>
				{report && (
					<>
						<p class={report.inSync ? "admin-ok" : "admin-warning"}>
							{report.inSync ? "In sync." : "Out of sync."} Neo4j {report.counts.graphNodes} nodes / {report.counts.graphRelations} relations; vectors {report.counts.nodeVectors} / {report.counts.relationVectors}.
						</p>
						<div class="admin-checks">
							<IdSummary label="nodes without a vector" summary={report.nodesWithoutVector} />
							<IdSummary label="relations without a vector" summary={report.relationsWithoutVector} />
							<IdSummary label="vectors without a node" summary={report.vectorsWithoutNode} />
							<IdSummary label="vectors without a relation" summary={report.vectorsWithoutRelation} />
						</div>
						{!report.inSync && (
							<>
								<p class="muted-copy">Repair indexes the missing records from Neo4j and deletes the orphan vectors. Graph data is not changed.</p>
								<div class="admin-toolbar">
									<button type="button" class="primary" disabled={Boolean(busy)} onClick={() => run("repair", async () => {
										const result = await request("POST", "/api/admin/consistency/repair", {});
										onMessage(`Repaired: indexed ${result.indexedNodes} nodes and ${result.indexedRelations} relations, deleted ${result.deletedNodeVectors + result.deletedRelationVectors} orphan vectors.`);
										setReport(await request("GET", "/api/admin/consistency"));
										onChanged();
									})}>
										{busy === "repair" ? "Repairing..." : "Repair vector index"}
									</button>
								</div>
							</>
						)}
					</>
				)}
			</section>

			<section class="admin-card">
				<h3>Backup</h3>
				<p class="muted-copy">Downloads the graph and every pending proposal as JSON. Vectors are not included; they are rebuilt from the graph. Proposals exist nowhere else, so back up before deleting them.</p>
				<div class="admin-toolbar">
					<button type="button" class="primary" disabled={Boolean(busy)} onClick={() => run("backup", async () => onMessage(`Saved ${await downloadBackup()}.`))}>
						{busy === "backup" ? "Preparing..." : "Download backup"}
					</button>
				</div>
			</section>

		</div>
	);
}
