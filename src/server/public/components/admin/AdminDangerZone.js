import { useState } from "preact/hooks";
import { AdminConfirm } from "./AdminConfirm.js";
import { downloadBackup } from "./AdminMaintenance.js";

// Wipes and reindex. Each needs the admin password again and a typed word; each is written to the audit log.

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
				<p class="muted-copy">A backup contains the graph and all pending proposals.</p>
				<div class="admin-toolbar">
					<button type="button" class="primary" disabled={Boolean(busy)} onClick={() => run("backup", async () => onMessage(`Saved ${await downloadBackup()}.`))}>
						Download backup
					</button>
				</div>
			</section>

			<section class="admin-card">
				<h3>Reindex vectors</h3>
				<AdminConfirm
					word="REINDEX"
					actionLabel="Reindex"
					danger={false}
					description="Empties the node and relation vectors and rebuilds them from Neo4j (like npm run kg:reindex-vectors). Proposals are not touched."
					busy={busy === "reindex"}
					onConfirm={(confirmation) => run("reindex", async () => {
						const result = await request("POST", "/api/admin/reindex", confirmation);
						onMessage(`Reindexed ${result.nodes} nodes and ${result.relations} relations.`);
					})}
				/>
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
		</div>
	);
}
