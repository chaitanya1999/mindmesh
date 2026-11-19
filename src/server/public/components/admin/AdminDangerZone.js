import { useState } from "preact/hooks";
import { AdminConfirm } from "./AdminConfirm.js";
import { downloadBackup } from "./AdminMaintenance.js";

// Reindex, wipes and restore, all written to the audit log. Wipes and restore need the admin password again and
// a typed word; reindex only rebuilds derived vectors, so a browser confirm is enough.

const WIPE_ACTIONS = [
	{
		target: "graph",
		title: "Delete Neo4j data",
		description: "Deletes every MindMesh node and relation (KnowledgeNode / RELATES_TO) and, to keep the stores in step, their vectors. Other data in the same database is not touched. Pending proposals stay.",
	},
	{
		target: "vectors",
		title: "Delete graph vectors",
		description: "Deletes the Chroma node and relation collections. The graph is not touched; Reindex rebuilds them from it.",
	},
	{
		target: "proposals",
		title: "Delete all proposals",
		description: "Deletes the Chroma proposal collection: every pending HITL proposal. Proposals cannot be rebuilt; download a backup first.",
	},
	{
		target: "all",
		title: "Delete everything",
		description: "Deletes the Neo4j data, the graph vectors, and all proposals. Download a backup first.",
	},
];

function summary(result) {
	const parts = [];
	if (result.graph) {
		parts.push(`${result.graph.deletedNodes} nodes and ${result.graph.deletedRelations} relations deleted`);
	}
	if (result.vectors || result.graph) {
		parts.push(`collections dropped: ${(result.vectors ?? result.graph).clearedCollections.join(", ") || "none"}`);
	}
	if (result.proposals) {
		parts.push(`${result.proposals.deletedProposals} proposals deleted`);
	}
	return parts.join("; ");
}

// What a chosen backup file contains, shown before the restore is confirmed. The server checks the file again.
function describeBackup(backup) {
	if (backup?.format !== "mindmesh-backup") {
		return { error: "This is not a MindMesh backup file." };
	}
	if (backup.version !== 2 || !backup.schema) {
		return { error: `Backup version ${backup.version} has no schema and cannot be restored. Download a new backup.` };
	}
	return {
		lines: [
			`Exported ${backup.exportedAt || "(unknown time)"}${backup.source?.neo4jDatabase ? ` from database ${backup.source.neo4jDatabase}` : ""}.`,
			`${backup.graph?.nodes?.length ?? 0} nodes, ${backup.graph?.relations?.length ?? 0} relations, ${backup.proposals?.length ?? 0} pending proposals, ${backup.schema.nodeTypes?.length ?? 0} node types and ${backup.schema.relationshipTypes?.length ?? 0} relation types.`,
		],
		truncated: Boolean(backup.graph?.truncated),
	};
}

function RestoreBackup({ busy, run, request, onMessage }) {
	const [file, setFile] = useState(null);

	async function chooseFile(event) {
		const chosen = event.currentTarget.files?.[0];
		if (!chosen) {
			setFile(null);
			return;
		}
		try {
			const backup = JSON.parse(await chosen.text());
			setFile({ name: chosen.name, backup, ...describeBackup(backup) });
		} catch {
			setFile({ name: chosen.name, error: "The file is not valid JSON." });
		}
	}

	return (
		<section class="admin-card admin-danger">
			<h3>Restore from backup</h3>
			<p class="muted-copy">Replaces the graph schema, every node and relation, the graph vectors and every pending proposal with the contents of a backup file (version 2, which includes the schema). Vectors are rebuilt from the restored graph. Download a backup of the current state first.</p>
			<input type="file" accept="application/json,.json" disabled={Boolean(busy)} onChange={chooseFile} />
			{file?.error && <p class="admin-warning">{file.name}: {file.error}</p>}
			{file?.lines && (
				<div>
					{file.lines.map((line) => <p class="muted-copy" key={line}>{line}</p>)}
					{file.truncated && <p class="admin-warning">This backup was truncated at the node limit; nodes beyond it are not in the file and will be lost.</p>}
				</div>
			)}
			{file?.lines && (
				<AdminConfirm
					word="DELETE"
					actionLabel="Restore backup"
					busy={busy === "restore"}
					onConfirm={(confirmation) => run("restore", async () => {
						const result = await request("POST", "/api/admin/restore", { backup: file.backup, ...confirmation });
						const { restored, deleted } = result;
						onMessage(`Restored ${file.name}: schema, ${restored.nodes} nodes, ${restored.relations} relations, ${restored.proposals} proposals (replaced ${deleted.nodes} nodes, ${deleted.relations} relations, ${deleted.proposals} proposals).`);
						setFile(null);
					})}
				/>
			)}
		</section>
	);
}

export function AdminDangerZone({ request, onMessage, onChanged }) {
	const [busy, setBusy] = useState("");

	async function run(label, action) {
		setBusy(label);
		try {
			await action();
			onChanged();
			return true;
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
				<h3>Before you delete</h3>
				<p class="muted-copy">A backup contains the graph schema, the graph and all pending proposals.</p>
				<div class="admin-toolbar">
					<button type="button" class="primary" disabled={Boolean(busy)} onClick={() => run("backup", async () => onMessage(`Saved ${await downloadBackup()}.`))}>
						Download backup
					</button>
				</div>
			</section>

			<section class="admin-card">
				<h3>Reindex vectors</h3>
				<p class="muted-copy">Empties the node and relation vectors and rebuilds them from Neo4j (like npm run kg:reindex-vectors). Proposals are not touched.</p>
				<div class="admin-toolbar">
					<button type="button" class="primary" disabled={Boolean(busy)} onClick={() => window.confirm("Rebuild all graph vectors from Neo4j?") && run("reindex", async () => {
						const result = await request("POST", "/api/admin/reindex", {});
						onMessage(`Reindexed ${result.nodes} nodes and ${result.relations} relations.`);
					})}>
						{busy === "reindex" ? "Reindexing..." : "Reindex"}
					</button>
				</div>
			</section>

			{WIPE_ACTIONS.map((action) => (
				<section class="admin-card admin-danger" key={action.target}>
					<h3>{action.title}</h3>
					<AdminConfirm
						word="DELETE"
						actionLabel={action.title}
						description={action.description}
						busy={busy === action.target}
						onConfirm={(confirmation) => run(action.target, async () => {
							const result = await request("POST", "/api/admin/wipe", { target: action.target, ...confirmation });
							onMessage(`${action.title}: ${summary(result)}.`);
						})}
					/>
				</section>
			))}

			<RestoreBackup busy={busy} run={run} request={request} onMessage={onMessage} />
		</div>
	);
}
