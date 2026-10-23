import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mammoth from "mammoth";
import multer from "multer";
import { PDFParse } from "pdf-parse";
import WordExtractor from "word-extractor";
import { getConfig, describeRuntime } from "../config.js";
import { buildTriplets } from "../hitl/hitlService.js";
import { createMindMesh, isMainModule } from "../mindmesh.js";
import { registerAdminRoutes } from "./adminRoutes.js";
import { readEditableGraphSchema, saveEditableGraphSchema } from "../schema/graphSchema.js";
import { getScopeSettings } from "../schema/scope.js";

// HTTP layer only: request parsing, file uploads, and response shapes. HITL decisions live in HitlService,
// graph writes in GraphWriteService.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const DEFAULT_GRAPH_LIMIT = 150;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_NEIGHBORHOOD_DEPTH = 1;
const DEFAULT_JOB_DEPTH = 2;
const MAX_INGEST_FILES = 10;
const MAX_INGEST_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const SUPPORTED_INGEST_FILE_EXTENSIONS = new Set(["pdf", "docx", "doc"]);
const port = Number(process.env.KG_WEB_PORT || process.env.PORT || 3000);

const wordExtractor = new WordExtractor();

const upload = multer({
	storage: multer.memoryStorage(),
	limits: {
		fileSize: MAX_INGEST_FILE_SIZE_BYTES,
		files: MAX_INGEST_FILES,
	},
	fileFilter(_req, file, callback) {
		if (SUPPORTED_INGEST_FILE_EXTENSIONS.has(fileExtension(file))) {
			callback(null, true);
			return;
		}

		const error = new Error("Only PDF, DOCX, or DOC files can be uploaded.");
		error.status = 400;
		callback(error);
	},
});

function parseLimit(value) {
	return Math.max(1, Math.min(Number(value) || DEFAULT_GRAPH_LIMIT, 500));
}

function parseSearchLimit(value) {
	return Math.max(1, Math.min(Number(value) || DEFAULT_SEARCH_LIMIT, 100));
}

function parseDepth(value) {
	return Math.max(0, Math.min(Number(value) || DEFAULT_NEIGHBORHOOD_DEPTH, 4));
}

function parseJobDepth(value) {
	return Math.max(0, Math.min(Number(value) || DEFAULT_JOB_DEPTH, 4));
}

function requireText(body) {
	const text = String(body?.text ?? "").trim();
	if (!text) {
		const error = new Error("Text is required.");
		error.status = 400;
		throw error;
	}

	return text;
}

function optionalSessionId(body) {
	const text = String(body?.sessionId ?? "").trim();
	return text || undefined;
}

function optionalMemoryMessages(body) {
	return Array.isArray(body?.memoryMessages) ? body.memoryMessages : [];
}

function fileExtension(file) {
	return String(file?.originalname ?? "")
		.split(".")
		.pop()
		?.toLowerCase() ?? "";
}

function uploadedFiles(req) {
	if (Array.isArray(req.files)) {
		return req.files;
	}

	if (req.files && typeof req.files === "object") {
		return Object.values(req.files).flat();
	}

	return [];
}

async function extractPdfText(file) {
	const parser = new PDFParse({ data: file.buffer });
	try {
		const result = await parser.getText();
		return result.text;
	} finally {
		await parser.destroy().catch(() => {});
	}
}

async function extractWordText(file) {
	const extension = fileExtension(file);

	if (extension === "docx") {
		const result = await mammoth.extractRawText({ buffer: file.buffer });
		return result.value;
	}

	const document = await wordExtractor.extract(file.buffer);
	return document.getBody();
}

async function extractUploadedText(file) {
	const extension = fileExtension(file);

	if (extension === "pdf") {
		return extractPdfText(file);
	}

	if (extension === "doc" || extension === "docx") {
		return extractWordText(file);
	}

	const error = new Error("Only PDF, DOCX, or DOC files can be uploaded.");
	error.status = 400;
	throw error;
}

async function buildIngestText(req) {
	const text = String(req.body?.text ?? "").trim();
	const files = uploadedFiles(req);

	if (files.length === 0) {
		return requireText(req.body);
	}

	const extractedTexts = await Promise.all(files.map(async (file) => (
		String(await extractUploadedText(file) ?? "").trim()
	)));
	const combinedText = [text, ...extractedTexts]
		.filter(Boolean)
		.join("\n\n");

	if (!combinedText) {
		const error = new Error("Uploaded files did not contain readable text.");
		error.status = 400;
		throw error;
	}

	return combinedText;
}

function requireIngestUserName(req) {
	const userName = String(req.body?.userName ?? "").trim();
	if (!userName) {
		const error = new Error("User name is required for ingestion.");
		error.status = 400;
		throw error;
	}

	return userName;
}

// HitlService validates the reviewer name; responses echo it trimmed.
function reviewerName(body) {
	return String(body?.reviewedBy ?? "").trim();
}

function asyncRoute(handler) {
	return async (req, res, next) => {
		try {
			await handler(req, res);
		} catch (error) {
			next(error);
		}
	};
}

// Builds the Express app without listening, so tests can start it with in-memory stores.
export function createApp(services) {
	const { config, graphStore, hitlService, ragService, jobsService, adminService } = services;
	const app = express();

	// The UI reads type lists and scope values from `schema`, and which scope fields to show from `scopeSettings`.
	function withGraphSchema(graph) {
		return {
			...graph,
			schema: hitlService.currentSchema(),
			scopeSettings: getScopeSettings(),
		};
	}

	// A proposal response also carries the refreshed approved graph for the UI.
	async function withApprovedGraph(proposal) {
		return {
			...proposal,
			graph: withGraphSchema(await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT)),
		};
	}

	async function hitlGraph() {
		return withGraphSchema(await hitlService.previewAll(DEFAULT_GRAPH_LIMIT));
	}

	app.use(express.json({ limit: "25mb" }));
	app.use(express.static(publicDir));

	app.get("/api/graph", asyncRoute(async (req, res) => {
		const limit = parseLimit(req.query.limit);
		const graph = await graphStore.getGraphPreview(limit);

		res.json({
			...withGraphSchema(graph),
			limit,
		});
	}));

	app.get("/api/nodes/search", asyncRoute(async (req, res) => {
		const query = String(req.query.q ?? "").trim();
		const limit = parseSearchLimit(req.query.limit);
		const nodes = await graphStore.searchNodes(query, limit);

		res.json({ nodes, query, limit });
	}));

	app.get("/api/nodes/:id/neighborhood", asyncRoute(async (req, res) => {
		const depth = parseDepth(req.query.depth);
		const graph = await graphStore.getNodeNeighborhood(req.params.id, depth);

		res.json({ ...withGraphSchema(graph), depth });
	}));

	app.get("/api/nodes/:id/relations", asyncRoute(async (req, res) => {
		const relations = await graphStore.getRelationsForNode(req.params.id);

		res.json({ relations });
	}));

	// Main-page edits are always proposals.

	app.post("/api/nodes", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeNode({ body: req.body, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.put("/api/nodes/:id", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeNode({ body: req.body, nodeId: req.params.id, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.delete("/api/nodes/:id", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeNodeDelete({ nodeId: req.params.id, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.post("/api/relations", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeRelation({ body: req.body, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.put("/api/relations/:id", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeRelation({ body: req.body, relationId: req.params.id, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.delete("/api/relations/:id", asyncRoute(async (req, res) => {
		const proposal = await hitlService.proposeRelationDelete({ relationId: req.params.id, userName: req.body?.userName });
		res.status(202).json(await withApprovedGraph(proposal));
	}));

	app.post("/api/ask", asyncRoute(async (req, res) => {
		const text = requireText(req.body);
		const result = await ragService.answer({
			query: text,
			source: "web",
			sessionId: optionalSessionId(req.body),
			memoryMessages: optionalMemoryMessages(req.body),
			includeUnverifiedKnowledge: Boolean(req.body?.includeUnverifiedKnowledge),
			scope: String(req.body?.scope ?? ""),
		});

		res.json({
			answer: result.answer,
			entryNodes: result.entryNodes,
			graph: result.graph,
			depth: result.depth,
			scope: result.scope,
			sessionId: result.sessionId,
		});
	}));

	app.post("/api/jobs/scanner", asyncRoute(async (req, res) => {
		const result = await jobsService.runJob({
			jobType: "scanner",
			depth: parseJobDepth(req.body?.depth),
			nodeId: req.body?.nodeId,
		});

		res.json(result);
	}));

	app.post("/api/jobs/nugget", asyncRoute(async (req, res) => {
		const result = await jobsService.runJob({
			jobType: "nugget",
			depth: parseJobDepth(req.body?.depth),
			nodeId: req.body?.nodeId,
		});

		res.json(result);
	}));

	app.get("/api/schema", asyncRoute(async (_req, res) => {
		res.json(readEditableGraphSchema(config));
	}));

	app.put("/api/schema", asyncRoute(async (req, res) => {
		try {
			const result = saveEditableGraphSchema(config, {
				rawJson: req.body?.rawJson,
				schema: req.body?.schema,
			});

			res.json({
				...result,
				status: "saved",
			});
		} catch (error) {
			error.status = 400;
			throw error;
		}
	}));

	// HITL proposals.

	app.get("/api/hitl/notes", asyncRoute(async (req, res) => {
		const limit = parseSearchLimit(req.query.limit || 100);
		const { notes, total } = await hitlService.listProposals({ limit });

		res.json({ notes, total, limit });
	}));

	app.get("/api/hitl/notes/:id", asyncRoute(async (req, res) => {
		const note = await hitlService.getProposal(req.params.id);

		res.json({ note: hitlService.noteDetail(note) });
	}));

	app.put("/api/hitl/notes/:id/reviewer-notes", asyncRoute(async (req, res) => {
		const note = await hitlService.saveReviewerNotes({ noteId: req.params.id, reviewerNotes: req.body?.reviewerNotes });

		res.json({ note: hitlService.noteDetail(note) });
	}));

	// Overwrites the proposal with a fresh extraction guided by the reviewer notes; the note is untouched if it fails.
	app.post("/api/hitl/notes/:id/regenerate", asyncRoute(async (req, res) => {
		const result = await hitlService.regenerate({
			noteId: req.params.id,
			reviewerNotes: req.body?.reviewerNotes,
			previousProposal: req.body?.llmResponse,
			regeneratedBy: req.body?.reviewedBy,
		});

		res.json({ note: hitlService.noteDetail(result.note) });
	}));

	app.get("/api/hitl/notes/:id/graph", asyncRoute(async (req, res) => {
		res.json(await hitlService.previewProposal({ noteId: req.params.id, depth: parseDepth(req.query.depth ?? 2) }));
	}));

	app.post("/api/hitl/notes/:id/graph", asyncRoute(async (req, res) => {
		res.json(await hitlService.previewProposal({
			noteId: req.params.id,
			depth: parseDepth(req.body?.depth ?? 2),
			llmResponse: req.body?.llmResponse,
		}));
	}));

	app.get("/api/hitl/graph", asyncRoute(async (req, res) => {
		res.json(await hitlService.previewAll(parseLimit(req.query.limit)));
	}));

	app.post("/api/hitl/notes/:id/approve", asyncRoute(async (req, res) => {
		const { storedGraph, graphPayload } = await hitlService.approve({
			noteId: req.params.id,
			reviewedBy: req.body?.reviewedBy,
			llmResponse: req.body?.llmResponse ?? req.body?.editedResponse,
		});

		res.json({
			status: "approved",
			applied: true,
			reviewedBy: reviewerName(req.body),
			nodes: storedGraph.nodes,
			relations: storedGraph.relations,
			nodeDeletes: storedGraph.nodeDeletes,
			relationDeletes: storedGraph.relationDeletes,
			deletedNodeIds: storedGraph.deletedNodeIds,
			deletedRelationIds: storedGraph.deletedRelationIds,
			triplets: buildTriplets(storedGraph),
			schemaSuggestions: graphPayload.schemaSuggestions,
			schemaViolations: graphPayload.schemaViolations ?? [],
			schemaWarnings: graphPayload.schemaWarnings,
			graph: await hitlGraph(),
		});
	}));

	app.delete("/api/hitl/notes/:id", asyncRoute(async (req, res) => {
		const note = await hitlService.reject({ noteId: req.params.id });

		res.json({
			status: "rejected",
			deleted: true,
			id: note.id,
		});
	}));

	// Direct reviewer edits: applied at once when schema-valid, otherwise stored as a proposal (202).

	async function sendReviewerEdit(req, res, result, field) {
		if (result.pending) {
			res.status(202).json(await withApprovedGraph(result.pending));
			return;
		}

		res.json({
			status: "applied",
			applied: true,
			reviewedBy: reviewerName(req.body),
			[field]: result[field],
			graph: await hitlGraph(),
		});
	}

	app.post("/api/hitl/nodes", asyncRoute(async (req, res) => {
		const result = await hitlService.editNode({ body: req.body, reviewedBy: req.body?.reviewedBy });
		await sendReviewerEdit(req, res, result, "node");
	}));

	app.put("/api/hitl/nodes/:id", asyncRoute(async (req, res) => {
		const result = await hitlService.editNode({ body: req.body, nodeId: req.params.id, reviewedBy: req.body?.reviewedBy });
		await sendReviewerEdit(req, res, result, "node");
	}));

	app.delete("/api/hitl/nodes/:id", asyncRoute(async (req, res) => {
		const result = await hitlService.deleteNode({ nodeId: req.params.id, reviewedBy: req.body?.reviewedBy });

		res.json({
			status: "applied",
			applied: true,
			reviewedBy: reviewerName(req.body),
			deletedNodeId: result.nodeId,
			deletedRelationIds: result.relationIds ?? [],
			graph: await hitlGraph(),
		});
	}));

	app.post("/api/hitl/relations", asyncRoute(async (req, res) => {
		const result = await hitlService.editRelation({ body: req.body, reviewedBy: req.body?.reviewedBy });
		await sendReviewerEdit(req, res, result, "relation");
	}));

	app.put("/api/hitl/relations/:id", asyncRoute(async (req, res) => {
		const result = await hitlService.editRelation({ body: req.body, relationId: req.params.id, reviewedBy: req.body?.reviewedBy });
		await sendReviewerEdit(req, res, result, "relation");
	}));

	app.delete("/api/hitl/relations/:id", asyncRoute(async (req, res) => {
		const result = await hitlService.deleteRelation({ relationId: req.params.id, reviewedBy: req.body?.reviewedBy });

		res.json({
			status: "applied",
			applied: true,
			reviewedBy: reviewerName(req.body),
			deletedRelationId: result.relationId,
			graph: await hitlGraph(),
		});
	}));

	app.post("/api/ingest", upload.fields([
		{ name: "files", maxCount: MAX_INGEST_FILES },
		{ name: "file", maxCount: MAX_INGEST_FILES },
	]), asyncRoute(async (req, res) => {
		const text = await buildIngestText(req);
		const storedGraph = await hitlService.ingestText({
			text,
			source: "web",
			userName: requireIngestUserName(req),
			scope: String(req.body?.scope ?? ""),
		});
		const graph = await graphStore.getGraphPreview(DEFAULT_GRAPH_LIMIT);

		res.json({
			status: storedGraph.status || "applied",
			applied: storedGraph.applied ?? true,
			hitlNote: storedGraph.hitlNote,
			nodes: storedGraph.nodes,
			relations: storedGraph.relations,
			nodeDeletes: storedGraph.nodeDeletes,
			relationDeletes: storedGraph.relationDeletes,
			deletedNodeIds: storedGraph.deletedNodeIds,
			deletedRelationIds: storedGraph.deletedRelationIds,
			triplets: buildTriplets(storedGraph),
			schemaSuggestions: storedGraph.schemaSuggestions,
			schemaViolations: storedGraph.schemaViolations ?? [],
			schemaWarnings: storedGraph.schemaWarnings,
			reviewReasons: storedGraph.reviewReasons ?? [],
			graph: withGraphSchema(graph),
		});
	}));

	// Admin panel API (session, password re-entry, audit log): src/server/adminRoutes.js. Tests pass
	// `adminRouteOptions` (sessions, audit log) through the services.
	registerAdminRoutes(app, { config, adminService, asyncRoute, ...services.adminRouteOptions });

	app.get(/^\/admin\/?$/, (_req, res) => {
		res.sendFile(path.join(publicDir, "index.html"));
	});

	app.get(/^\/hitl\/?$/, (_req, res) => {
		res.sendFile(path.join(publicDir, "index.html"));
	});

	app.get(/^\/jobs\/?$/, (_req, res) => {
		res.sendFile(path.join(publicDir, "index.html"));
	});

	app.get(/^\/schema\/?$/, (_req, res) => {
		res.sendFile(path.join(publicDir, "index.html"));
	});

	app.use((req, res) => {
		res.status(404).json({ error: "Not found." });
	});

	app.use((error, req, res, _next) => {
		const status = Number(error.status) || (error.name === "MulterError" ? 400 : 500);
		// 5xx details stay in the terminal unless the error is marked `expose` (for example a vector sync
		// failure, where the user must know the graph was saved).
		const message = status >= 500 && !error.expose ? "Server error. Check the terminal for details." : error.message;

		if (status >= 500) {
			console.error(error);
		}

		res.status(status).json({ error: message });
	});

	return app;
}

async function main() {
	const services = createMindMesh(getConfig());
	const app = createApp(services);
	const server = app.listen(port, () => {
		console.log("MindMesh web server started.");
		console.log(JSON.stringify({
			...describeRuntime(services.config),
			port,
			url: `http://localhost:${port}`,
		}, null, 2));
	});

	async function shutdown(signal) {
		console.log(`\nReceived ${signal}. Closing MindMesh web server.`);
		server.close(async () => {
			try {
				await services.close();
				process.exit(0);
			} catch (error) {
				console.error(error);
				process.exit(1);
			}
		});
	}

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (isMainModule(import.meta.url)) {
	main();
}
