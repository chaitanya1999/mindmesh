import { useCallback, useEffect, useState } from "preact/hooks";
import { requestJson } from "../../lib/api.js";
import { Field } from "../common/Field.js";
import { RouteSwitcher } from "../common/RouteSwitcher.js";
import { AdminAuditLog } from "./AdminAuditLog.js";
import { AdminDangerZone } from "./AdminDangerZone.js";
import { AdminMaintenance } from "./AdminMaintenance.js";
import { AdminOverview } from "./AdminOverview.js";
import { AdminQueryConsole } from "./AdminQueryConsole.js";

// The /admin page: setup notice, login, then tabs. The session is an HttpOnly cookie, so the page only knows
// whether it is logged in from /api/admin/status and from 401 answers.

const TABS = [
	{ id: "overview", label: "Overview" },
	{ id: "maintenance", label: "Maintenance" },
	{ id: "query", label: "Query console" },
	{ id: "danger", label: "Danger zone" },
	{ id: "audit", label: "Audit log" },
];

export function AdminApp() {
	const [status, setStatus] = useState(null);
	const [password, setPassword] = useState("");
	const [tab, setTab] = useState("overview");
	const [overview, setOverview] = useState(null);
	const [loadingOverview, setLoadingOverview] = useState(false);
	const [message, setMessage] = useState({ text: "", error: false });

	const showMessage = useCallback((text, error = false) => setMessage({ text, error }), []);

	const loadStatus = useCallback(async () => {
		try {
			setStatus(await requestJson("/api/admin/status"));
		} catch (error) {
			showMessage(error.message, true);
		}
	}, [showMessage]);

	// Every admin call goes through here: an expired session sends the page back to the login.
	const request = useCallback(async (method, url, body) => {
		try {
			return await requestJson(url, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
		} catch (error) {
			if (error.status === 401 && !/password/i.test(error.message)) {
				setStatus((current) => ({ ...current, authenticated: false }));
			}
			throw error;
		}
	}, []);

	const loadOverview = useCallback(async () => {
		setLoadingOverview(true);
		try {
			setOverview(await request("GET", "/api/admin/overview"));
		} catch (error) {
			showMessage(error.message, true);
		} finally {
			setLoadingOverview(false);
		}
	}, [request, showMessage]);

	useEffect(() => {
		loadStatus();
	}, [loadStatus]);

	useEffect(() => {
		if (status?.authenticated) {
			loadOverview();
		}
	}, [status?.authenticated, loadOverview]);

	async function login(event) {
		event.preventDefault();
		try {
			await requestJson("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
			setPassword("");
			showMessage("");
			await loadStatus();
		} catch (error) {
			showMessage(error.message, true);
		}
	}

	async function logout() {
		await requestJson("/api/admin/logout", { method: "POST", body: "{}" }).catch(() => {});
		setOverview(null);
		await loadStatus();
	}

	const header = (
		<header class="hitl-header">
			<div>
				<p class="eyebrow">MindMesh</p>
				<h2>Admin</h2>
			</div>
			<div class="hitl-header-actions">
				{status?.authenticated && <button type="button" onClick={logout}>Log out</button>}
				<RouteSwitcher />
			</div>
		</header>
	);
	const statusLine = message.text && <div class={`status-line${message.error ? " error-status" : ""}`}>{message.text}</div>;

	if (!status) {
		return <main class="admin-page">{header}<div class="admin-body"><p class="muted-copy">Loading...</p>{statusLine}</div></main>;
	}

	if (!status.configured) {
		return (
			<main class="admin-page">
				{header}
				<div class="admin-body">
					<section class="admin-card admin-narrow">
						<h3>Admin panel not set up</h3>
						<p class="muted-copy">Set an admin password on the machine running MindMesh, then restart the web server:</p>
						<pre class="admin-code">npm run kg:admin:password</pre>
						<p class="muted-copy">Only a hash of the password is stored, in config.json.</p>
					</section>
				</div>
			</main>
		);
	}

	if (!status.authenticated) {
		return (
			<main class="admin-page">
				{header}
				<div class="admin-body">
					<form class="admin-card admin-narrow admin-form" onSubmit={login}>
						<h3>Admin login</h3>
						<Field label="Admin password">
							<input type="password" autocomplete="current-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} autofocus />
						</Field>
						<button type="submit" class="primary" disabled={!password}>Log in</button>
						{statusLine}
					</form>
				</div>
			</main>
		);
	}

	return (
		<main class="admin-page">
			{header}
			<div class="schema-tabs admin-tabs" role="tablist" aria-label="Admin sections">
				{TABS.map((item) => (
					<button type="button" class={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)} key={item.id}>
						{item.label}
					</button>
				))}
			</div>
			<div class="admin-body">
				{statusLine}
				{tab === "overview" && <AdminOverview overview={overview} loading={loadingOverview} onRefresh={loadOverview} />}
				{tab === "maintenance" && <AdminMaintenance request={request} onMessage={showMessage} onChanged={loadOverview} />}
				{tab === "query" && (overview
					? <AdminQueryConsole request={request} collections={overview.chroma.collections} onMessage={showMessage} />
					: <p class="muted-copy">Loading collections...</p>)}
				{tab === "danger" && <AdminDangerZone request={request} onMessage={showMessage} onChanged={loadOverview} />}
				{tab === "audit" && <AdminAuditLog request={request} onMessage={showMessage} />}
			</div>
		</main>
	);
}
