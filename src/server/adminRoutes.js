import path from "node:path";
import { AdminSessions, verifyPassword } from "../admin/adminAuth.js";
import { AdminAuditLog } from "../admin/auditLog.js";
import { CONFIRM_WORD } from "../admin/adminService.js";

// /api/admin/*: the admin panel's API. Every route except status and login needs an admin session (cookie);
// wipes also need the password again and a typed confirmation word. Every action that changes data is written
// to the audit log. The admin panel is disabled until `npm run kg:admin:password` has stored a password hash.

const COOKIE_NAME = "mm_admin";

function httpError(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function readCookie(req, name) {
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) {
			return decodeURIComponent(rest.join("="));
		}
	}
	return "";
}

function clientAddress(req) {
	return req.ip || req.socket?.remoteAddress || "unknown";
}

export function registerAdminRoutes(app, { config, adminService, asyncRoute, sessions = null, auditLog = null }) {
	const passwordHash = config.admin?.passwordHash || "";
	const adminSessions = sessions ?? new AdminSessions({ sessionMinutes: Number(config.admin?.sessionMinutes) || 30 });
	const audit = auditLog ?? new AdminAuditLog(path.resolve(config.logging?.directory || "logs", "admin-audit.log"));

	function requireConfigured() {
		if (!passwordHash) {
			// expose: the server's error handler would otherwise replace this 5xx message with a generic one.
			throw Object.assign(httpError("The admin panel is not set up. Run `npm run kg:admin:password` and restart the server.", 503), { expose: true });
		}
	}

	// A wrong password counts towards the lockout, whether it is a login or a re-entry.
	function checkPassword(req, password) {
		const key = clientAddress(req);
		const lockedMs = adminSessions.lockedFor(key);
		if (lockedMs > 0) {
			throw httpError(`Too many wrong passwords. Try again in ${Math.ceil(lockedMs / 60000)} minute(s).`, 429);
		}
		if (!verifyPassword(password, passwordHash)) {
			adminSessions.recordFailure(key);
			audit.write({ action: "password_rejected", ip: key, path: req.path });
			throw httpError("Wrong admin password.", 401);
		}
		adminSessions.clearFailures(key);
	}

	function requireSession(req, _res, next) {
		try {
			requireConfigured();
			if (!adminSessions.isValid(readCookie(req, COOKIE_NAME))) {
				throw httpError("Admin login required.", 401);
			}
			next();
		} catch (error) {
			next(error);
		}
	}

	// Wipes: valid session (middleware) + password again + the exact confirmation word.
	function requireConfirmation(req) {
		checkPassword(req, req.body?.password);
		if (String(req.body?.confirm ?? "") !== CONFIRM_WORD) {
			throw httpError(`Type ${CONFIRM_WORD} to confirm.`, 400);
		}
	}

	// Runs an action and records it in the audit log, with its outcome.
	async function audited(req, action, details, run) {
		try {
			const result = await run();
			audit.write({ action, ip: clientAddress(req), ok: true, details, result: summarizeResult(result) });
			return result;
		} catch (error) {
			audit.write({ action, ip: clientAddress(req), ok: false, details, error: error.message });
			throw error;
		}
	}

	app.get("/api/admin/status", (req, res) => {
		res.json({
			configured: Boolean(passwordHash),
			authenticated: Boolean(passwordHash) && adminSessions.isValid(readCookie(req, COOKIE_NAME)),
		});
	});

	app.post("/api/admin/login", asyncRoute(async (req, res) => {
		requireConfigured();
		checkPassword(req, req.body?.password);
		const { token, maxAgeSeconds } = adminSessions.create();
		audit.write({ action: "login", ip: clientAddress(req), ok: true });
		res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${maxAgeSeconds}`);
		res.json({ authenticated: true, expiresInSeconds: maxAgeSeconds });
	}));

	app.post("/api/admin/logout", (req, res) => {
		adminSessions.destroy(readCookie(req, COOKIE_NAME));
		res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0`);
		res.json({ authenticated: false });
	});

	app.use("/api/admin", (req, res, next) => (["/status", "/login", "/logout"].includes(req.path) ? next() : requireSession(req, res, next)));

	app.get("/api/admin/overview", asyncRoute(async (_req, res) => {
		res.json(await adminService.overview());
	}));

	app.get("/api/admin/consistency", asyncRoute(async (_req, res) => {
		const { ids: _ids, ...report } = await adminService.consistency();
		res.json(report);
	}));

	app.post("/api/admin/consistency/repair", asyncRoute(async (req, res) => {
		res.json(await audited(req, "repair_vector_index", {}, () => adminService.repairVectorIndex()));
	}));

	app.post("/api/admin/reindex", asyncRoute(async (req, res) => {
		res.json(await audited(req, "reindex_vectors", { fresh: true }, () => adminService.reindexVectors()));
	}));

	app.post("/api/admin/wipe", asyncRoute(async (req, res) => {
		requireConfirmation(req);
		const target = String(req.body?.target ?? "");
		res.json(await audited(req, "wipe", { target }, () => adminService.wipe(target)));
	}));

	app.get("/api/admin/backup", asyncRoute(async (req, res) => {
		const backup = await audited(req, "backup_download", {}, () => adminService.backup());
		const stamp = backup.exportedAt.replace(/[:.]/g, "-");
		res.setHeader("Content-Disposition", `attachment; filename="mindmesh-backup-${stamp}.json"`);
		res.json(backup);
	}));

	app.post("/api/admin/query/cypher", asyncRoute(async (req, res) => {
		res.json(await adminService.queryCypher({ cypher: req.body?.cypher, params: req.body?.params, limit: req.body?.limit }));
	}));

	app.post("/api/admin/query/vector", asyncRoute(async (req, res) => {
		res.json(await adminService.vectorMatch({ query: req.body?.query, collections: req.body?.collections, topK: req.body?.topK }));
	}));

	app.get("/api/admin/audit", asyncRoute(async (req, res) => {
		res.json({ entries: audit.readRecent(Math.max(1, Math.min(Number(req.query.limit) || 100, 500))) });
	}));
}

// Keeps audit entries short: counts and names, not whole result payloads.
function summarizeResult(result) {
	if (!result || typeof result !== "object") {
		return result;
	}
	if (result.format === "mindmesh-backup") {
		return { nodes: result.graph.nodes.length, relations: result.graph.relations.length, proposals: result.proposals.length };
	}
	return result;
}
