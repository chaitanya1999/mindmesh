import { useEffect, useState } from "preact/hooks";

// The newest admin actions from the audit log (logs/admin-audit.log).
export function AdminAuditLog({ request, onMessage }) {
	const [entries, setEntries] = useState(null);

	async function load() {
		try {
			setEntries((await request("GET", "/api/admin/audit?limit=200")).entries);
		} catch (error) {
			onMessage(error.message, true);
		}
	}

	useEffect(() => {
		load();
	}, []);

	return (
		<div class="admin-stack">
			<div class="admin-toolbar">
				<button type="button" onClick={load}>Refresh</button>
			</div>
			{entries === null ? <p class="muted-copy">Loading...</p> : entries.length === 0 ? <p class="muted-copy">No admin actions yet.</p> : (
				<div class="admin-scroll">
					<table class="admin-table">
						<thead><tr><th>When</th><th>Action</th><th>From</th><th>Outcome</th><th>Details</th></tr></thead>
						<tbody>
							{entries.map((entry, index) => (
								<tr key={`${entry.at}-${index}`}>
									<td>{String(entry.at).slice(0, 19).replace("T", " ")}</td>
									<td>{entry.action}</td>
									<td>{entry.ip ?? ""}</td>
									<td class={entry.ok === false ? "admin-bad" : ""}>{entry.ok === undefined ? "" : entry.ok ? "ok" : `failed: ${entry.error ?? ""}`}</td>
									<td><code>{JSON.stringify({ ...(entry.details ? { details: entry.details } : {}), ...(entry.result ? { result: entry.result } : {}) })}</code></td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
