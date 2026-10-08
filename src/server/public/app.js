import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { HitlReviewPanel } from "./components/hitl/HitlReviewPanel.js";
import { ChatPanel } from "./components/chat/ChatPanel.js";
import { fileKey } from "./components/chat/Composer.js";
import { EntityModal } from "./components/common/EntityModal.js";
import { RequiredNameModal } from "./components/common/RequiredNameModal.js";
import { RouteSwitcher } from "./components/common/RouteSwitcher.js";
import { WorkspaceDivider } from "./components/common/WorkspaceDivider.js";
import { DetailPanel } from "./components/entity/DetailPanel.js";
import { createNodeDraft, NodeForm } from "./components/entity/NodeForm.js";
import { createRelationDraft, RelationForm } from "./components/entity/RelationForm.js";
import { SearchPanel } from "./components/entity/SearchPanel.js";
import { GraphActionButtons } from "./components/graph/GraphActionButtons.js";
import { GraphPreview } from "./components/graph/GraphPreview.js";
import { GRAPH_RENDERERS } from "./components/graph/GraphRendererToggle.js";
import { HitlGraphActionPanel } from "./components/graph/HitlGraphActionPanel.js";
import { NeoVisGraphPreview } from "./components/graph/NeoVisGraphPreview.js";
import { jobTitle, JobsPanel } from "./components/jobs/JobsPanel.js";
import { SchemaPanel } from "./components/schema/SchemaPanel.js";
import { requestJson } from "./lib/api.js";
import { normalizeGraph } from "./lib/graphData.js";
import { toSnakeCase, relationLabel, decodePipelineField, displayNameFromIdentifier, clampNumber } from "./lib/utils.js";

const GRAPH_LIMIT = 150;
const EMPTY_GRAPH = { nodes: [], relations: [] };
const ASK_WELCOME_MESSAGE = "Ask a question using the current graph context.";
const ASK_MEMORY_STORAGE_KEY = "mindmesh.askMemory";
const ASK_SESSION_STORAGE_KEY = "mindmesh.askSessionId";
const WORKSPACE_USER_STORAGE_KEY = "mindmesh.workspaceUserName";
const HITL_REVIEWER_STORAGE_KEY = "mindmesh.hitlReviewerName";
const DEFAULT_JOB_DEPTH = 2;
const INGEST_WELCOME_MESSAGE = "Paste source text to extract nodes and relationships.";
const MAX_INGEST_FILES = 10;
const MAX_INGEST_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const ASK_MEMORY_MAX_MESSAGES = 10;
const ASK_MEMORY_MAX_MESSAGE_CHARS = 2000;
const SUPPORTED_INGEST_FILE_EXTENSIONS = new Set(["pdf", "docx", "doc"]);
const DEFAULT_WORKSPACE_WIDTH = 25;
const DEFAULT_TOOL_WORKSPACE_WIDTH = 40;
const MIN_WORKSPACE_WIDTH = 0;
const MAX_WORKSPACE_WIDTH = 100;
const PANEL_SNAP_THRESHOLD = 10;
function graphNameFromId(id) {
	return String(id ?? "").replace(/^node:/i, "");
}

function encodePipelineField(value) {
	if (value === undefined || value === null) {
		return "";
	}

	return String(value)
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\r/g, "\\r")
		.replace(/\n/g, "\\n")
		.replace(/\t/g, "\\t")
		.trim();
}

function safePipelineField(value) {
	return encodePipelineField(value);
}

function pipelineRecordLine(recordType, fields) {
	return [recordType, ...fields].map(safePipelineField).join("|");
}

function pipelineNodeLine(recordType, node) {
	const name = toSnakeCase(node.name || node.label || graphNameFromId(node.id));
	return pipelineRecordLine(recordType, [
		name,
		node.label || displayNameFromIdentifier(name),
		node.type || "concept",
		node.description || "",
		node.metadata || "",
	]);
}

function pipelineNodeDeleteLine(node) {
	return pipelineRecordLine("NODE_DELETE", [
		graphNameFromId(node.name || node.id),
		node.metadata || "",
	]);
}

function pipelineRelationLine(recordType, relation) {
	return pipelineRecordLine(recordType, [
		graphNameFromId(relation.sourceId),
		graphNameFromId(relation.targetId),
		relation.relation || "relates_to",
		relation.information || "",
		relation.description || "",
		relation.metadata || "",
	]);
}

function pipelineRelationDeleteLine(relation) {
	return pipelineRecordLine("RELATION_DELETE", [
		graphNameFromId(relation.sourceId),
		graphNameFromId(relation.targetId),
		relation.relation || "relates_to",
		relation.metadata || "",
	]);
}

function isPipelineStart(line) {
	return ["<start#$#$>", "start#$#$"].includes(String(line ?? "").trim().toLowerCase());
}

function isPipelineEnd(line) {
	return ["</end#$#$>", "<end#$#$>", "end#$#$"].includes(String(line ?? "").trim().toLowerCase());
}

function pipelineLines(text) {
	const rawLines = String(text ?? "").split(/\r?\n/);
	const startIndex = rawLines.findIndex(isPipelineStart);
	const endIndex = rawLines.findIndex((line, index) => index > startIndex && isPipelineEnd(line));
	const bodyLines = startIndex === -1
		? rawLines
		: rawLines.slice(startIndex + 1, endIndex === -1 ? undefined : endIndex);

	return bodyLines.map((line) => line.trim()).filter(Boolean);
}

function pipelineEditorText(text) {
	return pipelineLines(text).join("\n");
}

function withPipelineMarkers(lines) {
	return lines.filter(Boolean).join("\n");
}

function pipelineParts(line) {
	const raw = String(line ?? "");
	const parts = [];
	let current = "";

	for (let index = 0; index < raw.length; index += 1) {
		const char = raw[index];
		if (char === "\\" && index + 1 < raw.length) {
			current += char + raw[index + 1];
			index += 1;
			continue;
		}

		if (char === "|") {
			parts.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	parts.push(current.trim());
	return parts.map(decodePipelineField);
}

function isNodeRecord(parts) {
	return ["NODE", "NODE_CREATE", "NODE_UPDATE"].includes(parts[0]?.toUpperCase());
}

function isNodeDeleteRecord(parts) {
	return parts[0]?.toUpperCase() === "NODE_DELETE";
}

function isNodeMutationRecord(parts) {
	return isNodeRecord(parts) || isNodeDeleteRecord(parts);
}

function isRelationRecord(parts) {
	return ["RELATION", "EDGE", "RELATION_CREATE", "RELATION_UPDATE"].includes(parts[0]?.toUpperCase());
}

function isRelationMutationRecord(parts) {
	return isRelationRecord(parts) || parts[0]?.toUpperCase() === "RELATION_DELETE";
}

function normalizedPipelineName(value) {
	return toSnakeCase(graphNameFromId(value));
}

function updatePipelineNode(text, node, draft) {
	const oldName = normalizedPipelineName(node.name || node.id);
	const newNode = {
		...node,
		...draft,
		name: toSnakeCase(draft.name || draft.label || node.name || graphNameFromId(node.id)),
	};
	const lines = pipelineLines(text);
	let found = false;
	const nextLines = lines.map((line) => {
		const parts = pipelineParts(line);
		const recordType = parts[0]?.toUpperCase();
		if (!isNodeMutationRecord(parts) || normalizedPipelineName(parts[1]) !== oldName) {
			if (isRelationMutationRecord(parts)) {
				const sourceName = normalizedPipelineName(parts[1]);
				const targetName = normalizedPipelineName(parts[2]);
				if (sourceName === oldName || targetName === oldName) {
					const nextParts = [...parts];
					if (sourceName === oldName) {
						nextParts[1] = newNode.name;
					}
					if (targetName === oldName) {
						nextParts[2] = newNode.name;
					}
					return nextParts.map(safePipelineField).join("|");
				}
			}
			return line;
		}

		found = true;
		if (recordType === "NODE_DELETE") {
			return pipelineNodeDeleteLine(newNode);
		}

		return pipelineNodeLine(recordType === "NODE" ? "NODE_UPDATE" : recordType, newNode);
	});

	if (!found) {
		nextLines.push(pipelineNodeLine("NODE_UPDATE", newNode));
	}

	return withPipelineMarkers(nextLines);
}

function removePipelineNode(text, node) {
	const nodeName = normalizedPipelineName(node.name || node.id);
	const nextLines = pipelineLines(text).filter((line) => {
		const parts = pipelineParts(line);
		if (isNodeMutationRecord(parts)) {
			return normalizedPipelineName(parts[1]) !== nodeName;
		}
		if (isRelationMutationRecord(parts)) {
			return normalizedPipelineName(parts[1]) !== nodeName && normalizedPipelineName(parts[2]) !== nodeName;
		}
		return true;
	});

	return withPipelineMarkers(nextLines);
}

function appendPipelineLine(text, nextLine) {
	const lines = pipelineLines(text);
	if (!lines.some((line) => line === nextLine)) {
		lines.push(nextLine);
	}

	return withPipelineMarkers(lines);
}

function deletePipelineNode(text, node, { removeOnly = false } = {}) {
	const cleanedText = removePipelineNode(text, node);
	return removeOnly
		? cleanedText
		: appendPipelineLine(cleanedText, pipelineNodeDeleteLine(node));
}

function relationMatchesPipeline(parts, relation) {
	return normalizedPipelineName(parts[1]) === normalizedPipelineName(relation.sourceId)
		&& normalizedPipelineName(parts[2]) === normalizedPipelineName(relation.targetId)
		&& toSnakeCase(parts[3]) === toSnakeCase(relation.relation);
}

function updatePipelineRelation(text, relation, draft) {
	const nextRelation = {
		...relation,
		...draft,
		relation: toSnakeCase(draft.relation) || "relates_to",
	};
	const lines = pipelineLines(text);
	let found = false;
	const nextLines = lines.map((line) => {
		const parts = pipelineParts(line);
		const recordType = parts[0]?.toUpperCase();
		if (!isRelationMutationRecord(parts) || !relationMatchesPipeline(parts, relation)) {
			return line;
		}

		found = true;
		if (recordType === "RELATION_DELETE") {
			return pipelineRelationDeleteLine(nextRelation);
		}

		return pipelineRelationLine(recordType === "RELATION" || recordType === "EDGE" ? "RELATION_UPDATE" : recordType, nextRelation);
	});

	if (!found) {
		nextLines.push(pipelineRelationLine("RELATION_UPDATE", nextRelation));
	}

	return withPipelineMarkers(nextLines);
}

function removePipelineRelation(text, relation) {
	const nextLines = pipelineLines(text).filter((line) => {
		const parts = pipelineParts(line);
		return !isRelationMutationRecord(parts)
			|| !relationMatchesPipeline(parts, relation);
	});

	return withPipelineMarkers(nextLines);
}

function deletePipelineRelation(text, relation, { removeOnly = false } = {}) {
	const cleanedText = removePipelineRelation(text, relation);
	return removeOnly
		? cleanedText
		: appendPipelineLine(cleanedText, pipelineRelationDeleteLine(relation));
}

function createPipelineNode(text, node) {
	return appendPipelineLine(text, pipelineNodeLine("NODE_CREATE", node));
}

function createPipelineRelation(text, relation) {
	return appendPipelineLine(text, pipelineRelationLine("RELATION_CREATE", relation));
}

function fileExtension(file) {
	return String(file?.name ?? "")
		.split(".")
		.pop()
		?.toLowerCase() ?? "";
}

function isSupportedIngestFile(file) {
	return SUPPORTED_INGEST_FILE_EXTENSIONS.has(fileExtension(file));
}

function normalizedSearchText(value) {
	return String(value ?? "").trim().toLowerCase();
}

function nodeSearchValues(node) {
	return [node?.label, node?.name, node?.id, node?.type, node?.description]
		.map((value) => normalizedSearchText(value))
		.filter(Boolean);
}

function findBestLoadedSearchResult(results, query) {
	const normalizedQuery = normalizedSearchText(query);
	if (!normalizedQuery || results.length === 0) {
		return null;
	}

	return results.find((node) => nodeSearchValues(node).some((value) => value === normalizedQuery))
		?? (results.length === 1 ? results[0] : null);
}

function snapWorkspaceWidth(value) {
	const boundedValue = clampNumber(value, MIN_WORKSPACE_WIDTH, MAX_WORKSPACE_WIDTH);
	if (boundedValue <= PANEL_SNAP_THRESHOLD) {
		return MIN_WORKSPACE_WIDTH;
	}
	if (boundedValue >= MAX_WORKSPACE_WIDTH - PANEL_SNAP_THRESHOLD) {
		return MAX_WORKSPACE_WIDTH;
	}

	return boundedValue;
}

function graphStatsLabel(graph) {
	const normalized = normalizeGraph(graph);
	return `${normalized.nodes.length} nodes / ${normalized.relations.length} relations`;
}

function mergeGraph(currentGraph, nextGraph) {
	const current = normalizeGraph(currentGraph);
	const next = normalizeGraph(nextGraph);
	const nodeMap = new Map(current.nodes.map((node) => [node.id, node]));
	const relationMap = new Map(current.relations.map((relation) => [relation.id, relation]));

	for (const node of next.nodes) {
		nodeMap.set(node.id, node);
	}

	for (const relation of next.relations) {
		relationMap.set(relation.id, relation);
	}

	return {
		nodes: [...nodeMap.values()],
		relations: [...relationMap.values()],
		schema: next.schema ?? current.schema ?? null,
	};
}

function replaceNode(graph, node) {
	const current = normalizeGraph(graph);
	const exists = current.nodes.some((entry) => entry.id === node.id);
	return {
		nodes: exists
			? current.nodes.map((entry) => entry.id === node.id ? node : entry)
			: [node, ...current.nodes],
		relations: current.relations,
		schema: current.schema ?? null,
	};
}

function replaceRelation(graph, relation) {
	const current = normalizeGraph(graph);
	const exists = current.relations.some((entry) => entry.id === relation.id);
	return {
		nodes: current.nodes,
		relations: exists
			? current.relations.map((entry) => entry.id === relation.id ? relation : entry)
			: [relation, ...current.relations],
		schema: current.schema ?? null,
	};
}

function removeNodeFromGraph(graph, nodeId) {
	const current = normalizeGraph(graph);
	return {
		nodes: current.nodes.filter((node) => node.id !== nodeId),
		relations: current.relations.filter((relation) => relation.sourceId !== nodeId && relation.targetId !== nodeId),
		schema: current.schema ?? null,
	};
}

function removeRelationFromGraph(graph, relationId) {
	const current = normalizeGraph(graph);
	return {
		nodes: current.nodes,
		relations: current.relations.filter((relation) => relation.id !== relationId),
		schema: current.schema ?? null,
	};
}

function hitlDirectSaveErrorMessage(error) {
	if (error?.status === 404 && error?.message === "Not found.") {
		return "Direct HITL save API is not loaded yet. Restart the web server and try again.";
	}

	return error.message;
}

function isPageRefreshNavigation() {
	try {
		const [navigationEntry] = window.performance?.getEntriesByType?.("navigation") ?? [];
		if (navigationEntry?.type) {
			return navigationEntry.type === "reload";
		}

		return window.performance?.navigation?.type === 1;
	} catch {
		return false;
	}
}

function clearAskSessionStorage() {
	try {
		const keysToRemove = [];
		for (let index = 0; index < window.sessionStorage.length; index += 1) {
			const key = window.sessionStorage.key(index);
			if (key === ASK_SESSION_STORAGE_KEY || key?.startsWith(`${ASK_MEMORY_STORAGE_KEY}:`)) {
				keysToRemove.push(key);
			}
		}

		keysToRemove.forEach((key) => window.sessionStorage.removeItem(key));
	} catch {
		// If browser storage is unavailable, there is nothing to clear.
	}
}

function clearAskSessionStorageOnPageRefresh() {
	if (isPageRefreshNavigation()) {
		clearAskSessionStorage();
	}
}

function createAskSessionId() {
	if (window.crypto?.randomUUID) {
		return window.crypto.randomUUID();
	}

	return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getAskSessionId() {
	try {
		const currentSessionId = window.sessionStorage.getItem(ASK_SESSION_STORAGE_KEY);
		if (currentSessionId) {
			return currentSessionId;
		}

		const nextSessionId = createAskSessionId();
		window.sessionStorage.setItem(ASK_SESSION_STORAGE_KEY, nextSessionId);
		return nextSessionId;
	} catch {
		return createAskSessionId();
	}
}

function readSessionValue(key) {
	try {
		return window.sessionStorage?.getItem(key) ?? "";
	} catch {
		return "";
	}
}

function writeSessionValue(key, value) {
	const text = String(value ?? "").trim();
	try {
		if (text) {
			window.sessionStorage?.setItem(key, text);
		} else {
			window.sessionStorage?.removeItem(key);
		}
	} catch {
		// If browser storage is unavailable, the in-memory state remains usable.
	}
}

function askMemoryStorageKey(sessionId) {
	return `${ASK_MEMORY_STORAGE_KEY}:${sessionId}`;
}

function normalizeAskMemoryMessage(message) {
	const content = String(message?.content ?? message?.text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (!content) {
		return null;
	}

	return {
		role: message?.role === "assistant" ? "assistant" : "user",
		content: content.length > ASK_MEMORY_MAX_MESSAGE_CHARS
			? `${content.slice(0, ASK_MEMORY_MAX_MESSAGE_CHARS - 3)}...`
			: content,
	};
}

function normalizeAskMemoryMessages(messages) {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.map(normalizeAskMemoryMessage)
		.filter(Boolean)
		.slice(-ASK_MEMORY_MAX_MESSAGES);
}

function readAskMemory(sessionId) {
	try {
		const rawMemory = window.sessionStorage.getItem(askMemoryStorageKey(sessionId));
		return normalizeAskMemoryMessages(JSON.parse(rawMemory || "[]"));
	} catch {
		return [];
	}
}

function writeAskMemory(sessionId, messages) {
	try {
		window.sessionStorage.setItem(
			askMemoryStorageKey(sessionId),
			JSON.stringify(normalizeAskMemoryMessages(messages)),
		);
	} catch {
		// sessionStorage can be unavailable or full; the current ask should still work.
	}
}

function appendAskMemoryTurn(sessionId, { user, assistant }) {
	const messages = readAskMemory(sessionId);
	writeAskMemory(sessionId, [
		...messages,
		{ role: "user", content: user },
		{ role: "assistant", content: assistant },
	]);
}

clearAskSessionStorageOnPageRefresh();

function buildIngestMutation(result) {
	return {
		status: result.status || "applied",
		applied: result.applied ?? true,
		hitlNote: result.hitlNote,
		nodes: result.nodes ?? [],
		relations: result.relations ?? [],
		nodeDeletes: result.nodeDeletes ?? [],
		relationDeletes: result.relationDeletes ?? [],
		deletedNodeIds: result.deletedNodeIds ?? [],
		deletedRelationIds: result.deletedRelationIds ?? [],
		triplets: result.triplets ?? [],
		schemaViolations: result.schemaViolations ?? [],
		schemaWarnings: result.schemaWarnings ?? [],
	};
}

function App() {
	const currentPath = window.location.pathname.replace(/\/+$/, "") || "/";
	const isHitlRoute = currentPath === "/hitl";
	const isJobsRoute = currentPath === "/jobs";
	const isSchemaRoute = currentPath === "/schema";
	const [activeTab, setActiveTab] = useState("ask");
	const [askMessages, setAskMessages] = useState([
		{ id: "ask-message-0", role: "assistant", text: ASK_WELCOME_MESSAGE },
	]);
	const [askText, setAskText] = useState("");
	const [includeUnverifiedKnowledge, setIncludeUnverifiedKnowledge] = useState(false);
	const [createModalType, setCreateModalType] = useState(null);
	const [createNodeDraftValue, setCreateNodeDraftValue] = useState(() => createNodeDraft());
	const [createRelationDraftValue, setCreateRelationDraftValue] = useState(() => createRelationDraft());
	const [focusedItem, setFocusedItem] = useState(null);
	const [graph, setGraph] = useState(EMPTY_GRAPH);
	const [graphRenderer, setGraphRenderer] = useState(GRAPH_RENDERERS.neovis);
	const [highlight, setHighlight] = useState({ nodeIds: [], relationIds: [] });
	const [ingestMessages, setIngestMessages] = useState([
		{ id: "ingest-message-0", role: "assistant", text: INGEST_WELCOME_MESSAGE },
	]);
	const [ingestFiles, setIngestFiles] = useState([]);
	const [ingestText, setIngestText] = useState("");
	const [isBusy, setIsBusy] = useState(false);
	const [isJobBusy, setIsJobBusy] = useState(false);
	const [jobDepth, setJobDepth] = useState(DEFAULT_JOB_DEPTH);
	const [jobErrorMessage, setJobErrorMessage] = useState("");
	const [jobResult, setJobResult] = useState(null);
	const [jobStatusMessage, setJobStatusMessage] = useState("");
	const [isSearching, setIsSearching] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchStatusMessage, setSearchStatusMessage] = useState("");
	const [selectedItem, setSelectedItem] = useState(null);
	const [serverSearchResults, setServerSearchResults] = useState([]);
	const [statsText, setStatsText] = useState("Loading...");
	const [statusMessage, setStatusMessage] = useState("");
	const [hitlReviewerName, setHitlReviewerName] = useState(() => (
		readSessionValue(HITL_REVIEWER_STORAGE_KEY) || readSessionValue(WORKSPACE_USER_STORAGE_KEY)
	));
	const [isEditingHitlReviewerName, setIsEditingHitlReviewerName] = useState(false);
	const [hitlEditedResponse, setHitlEditedResponse] = useState("");
	const [hitlOriginalResponse, setHitlOriginalResponse] = useState("");
	const [hitlPreviewMessage, setHitlPreviewMessage] = useState("");
	const [hitlSelectedNote, setHitlSelectedNote] = useState(null);
	const [userName, setUserName] = useState(() => readSessionValue(WORKSPACE_USER_STORAGE_KEY));
	const [isEditingUserName, setIsEditingUserName] = useState(false);
	const defaultWorkspaceWidth = isHitlRoute || isJobsRoute || isSchemaRoute
		? DEFAULT_TOOL_WORKSPACE_WIDTH
		: DEFAULT_WORKSPACE_WIDTH;
	const [workspaceWidth, setWorkspaceWidth] = useState(defaultWorkspaceWidth);
	const dividerPressRef = useRef({ time: 0, x: 0, y: 0 });
	const askSessionIdRef = useRef(getAskSessionId());
	const hitlEditedResponseRef = useRef("");
	const hitlSelectedNoteRef = useRef(null);
	const inputRef = useRef(null);
	const messageIdRef = useRef(0);
	const shellRef = useRef(null);

	const normalizedGraph = useMemo(() => normalizeGraph(graph), [graph]);
	const schemaNodeTypes = useMemo(() => (
		(graph?.schema?.nodeTypes ?? [])
			.map((entry) => entry?.name)
			.filter(Boolean)
	), [graph]);
	const schemaRelationshipTypes = useMemo(() => (
		(graph?.schema?.relationshipTypes ?? [])
			.map((entry) => entry?.name)
			.filter(Boolean)
	), [graph]);
	const hitlProposalDirty = Boolean(hitlSelectedNote) && hitlEditedResponse !== hitlOriginalResponse;
	const hitlDraftMode = Boolean(hitlSelectedNote);
	const loadedSearchResults = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) {
			return [];
		}

		return normalizedGraph.nodes
			.filter((node) => [node.label, node.name, node.type, node.description, node.id]
				.some((value) => String(value ?? "").toLowerCase().includes(query)));
	}, [normalizedGraph.nodes, searchQuery]);
	const clientSearchResults = useMemo(() => loadedSearchResults.slice(0, 8), [loadedSearchResults]);

	useEffect(() => {
		hitlSelectedNoteRef.current = hitlSelectedNote;
	}, [hitlSelectedNote]);

	useEffect(() => {
		hitlEditedResponseRef.current = hitlEditedResponse;
	}, [hitlEditedResponse]);

	useEffect(() => {
		if (!hitlProposalDirty) {
			return undefined;
		}

		function handleBeforeUnload(event) {
			event.preventDefault();
			event.returnValue = "";
			return "";
		}

		window.addEventListener("beforeunload", handleBeforeUnload);
		return () => window.removeEventListener("beforeunload", handleBeforeUnload);
	}, [hitlProposalDirty]);

	const selectHitlNote = useCallback((note) => {
		hitlSelectedNoteRef.current = note;
		setHitlSelectedNote(note);
		setHitlOriginalResponse(note ? pipelineEditorText(note.llmResponse ?? "") : "");
	}, []);

	const changeHitlEditedResponse = useCallback((value) => {
		hitlEditedResponseRef.current = value;
		setHitlEditedResponse(value);
	}, []);

	const closeHitlNoteDetail = useCallback(() => {
		selectHitlNote(null);
		changeHitlEditedResponse("");
		setFocusedItem(null);
		setHighlight({ nodeIds: [], relationIds: [] });
	}, [changeHitlEditedResponse, selectHitlNote]);

	const saveUserName = useCallback((value) => {
		const nextName = String(value ?? "").trim();
		setUserName(nextName);
		writeSessionValue(WORKSPACE_USER_STORAGE_KEY, nextName);
		setIsEditingUserName(false);
		if (!hitlReviewerName.trim()) {
			setHitlReviewerName(nextName);
			writeSessionValue(HITL_REVIEWER_STORAGE_KEY, nextName);
		}
	}, [hitlReviewerName]);

	const saveHitlReviewerName = useCallback((value) => {
		const nextName = String(value ?? "").trim();
		setHitlReviewerName(nextName);
		writeSessionValue(HITL_REVIEWER_STORAGE_KEY, nextName);
		setIsEditingHitlReviewerName(false);
	}, []);

	const appendMessage = useCallback((scope, message) => {
		messageIdRef.current += 1;
		const id = `${scope}-message-${messageIdRef.current}`;
		const setMessages = scope === "ingest" ? setIngestMessages : setAskMessages;
		setMessages((currentMessages) => [...currentMessages, { id, ...message }]);
		return id;
	}, []);

	const updateMessage = useCallback((scope, id, patch) => {
		const setMessages = scope === "ingest" ? setIngestMessages : setAskMessages;
		setMessages((currentMessages) => currentMessages.map((message) => (
			message.id === id ? { ...message, ...patch } : message
		)));
	}, []);

	const showStatus = useCallback((message) => {
		setStatusMessage(message);
		if (message) {
			window.setTimeout(() => {
				setStatusMessage((current) => current === message ? "" : current);
			}, 3500);
		}
	}, []);

	const showSearchStatus = useCallback((message) => {
		setSearchStatusMessage(message);
		if (message) {
			window.setTimeout(() => {
				setSearchStatusMessage((current) => current === message ? "" : current);
			}, 3500);
		}
	}, []);

	const selectIngestFiles = useCallback((files) => {
		const incomingFiles = Array.from(files ?? []);
		if (incomingFiles.length === 0) {
			return;
		}

		const validFiles = [];
		let skippedCount = 0;
		for (const file of incomingFiles) {
			if (!isSupportedIngestFile(file) || file.size > MAX_INGEST_FILE_SIZE_BYTES) {
				skippedCount += 1;
				continue;
			}
			validFiles.push(file);
		}

		if (validFiles.length === 0) {
			showStatus(skippedCount > 0
				? "Upload PDF, DOCX, or DOC files that are 25 MB or smaller."
				: "Upload a PDF, DOCX, or DOC file.");
			return;
		}

		let addedCount = 0;
		let reachedLimit = false;
		setIngestFiles((currentFiles) => {
			const currentKeys = new Set(currentFiles.map(fileKey));
			const nextFiles = [...currentFiles];

			for (const file of validFiles) {
				if (nextFiles.length >= MAX_INGEST_FILES) {
					reachedLimit = true;
					break;
				}

				const key = fileKey(file);
				if (!currentKeys.has(key)) {
					nextFiles.push(file);
					currentKeys.add(key);
					addedCount += 1;
				}
			}

			return nextFiles;
		});

		const details = [
			addedCount > 0 ? `Attached ${addedCount} file${addedCount === 1 ? "" : "s"}.` : "Those files are already attached.",
			skippedCount > 0 ? `Skipped ${skippedCount}.` : "",
			reachedLimit ? `Maximum ${MAX_INGEST_FILES} files.` : "",
		].filter(Boolean).join(" ");
		showStatus(details);
	}, [showStatus]);

	const clearIngestFile = useCallback((fileToRemove) => {
		setIngestFiles((currentFiles) => currentFiles.filter((file) => fileKey(file) !== fileKey(fileToRemove)));
	}, []);

	const loadGraph = useCallback(async () => {
		setStatsText("Loading...");
		try {
			const activeHitlNote = hitlSelectedNoteRef.current;
			const graphResult = isHitlRoute && activeHitlNote?.id
				? await requestJson(`/api/hitl/notes/${encodeURIComponent(activeHitlNote.id)}/graph`, {
					method: "POST",
					body: JSON.stringify({
						depth: 2,
						llmResponse: hitlEditedResponseRef.current || activeHitlNote.llmResponse || "",
					}),
				})
				: await requestJson(isHitlRoute ? `/api/hitl/graph?limit=${GRAPH_LIMIT}` : `/api/graph?limit=${GRAPH_LIMIT}`);
			const nextGraph = normalizeGraph(graphResult);
			setHighlight({ nodeIds: [], relationIds: [] });
			setGraph(nextGraph);
			setFocusedItem(null);
			setSelectedItem(null);
			setStatsText(graphStatsLabel(nextGraph));
			setHitlPreviewMessage("");
		} catch (error) {
			setStatsText("Unavailable");
			if (isHitlRoute) {
				setHitlPreviewMessage(error.message);
				showStatus(error.message);
			} else if (isJobsRoute) {
				setJobErrorMessage(error.message);
				showStatus(error.message);
			} else if (isSchemaRoute) {
				showStatus(error.message);
			} else {
				appendMessage("ask", { role: "assistant", text: error.message, error: true });
			}
		}
	}, [appendMessage, isHitlRoute, isJobsRoute, isSchemaRoute, showStatus]);

	useEffect(() => {
		loadGraph();
	}, [loadGraph]);

	useEffect(() => {
		if (!isHitlRoute) {
			return undefined;
		}

		const timer = window.setTimeout(() => {
			loadGraph();
		}, hitlSelectedNote?.id ? 300 : 0);

		return () => window.clearTimeout(timer);
	}, [hitlEditedResponse, hitlSelectedNote?.id, isHitlRoute, loadGraph]);

	const selectHitlNoteDetail = useCallback(async (noteId) => {
		if (!noteId) {
			return null;
		}

		const result = await requestJson(`/api/hitl/notes/${encodeURIComponent(noteId)}`);
		const note = result.note ?? null;
		selectHitlNote(note);
		changeHitlEditedResponse(pipelineEditorText(note?.llmResponse ?? ""));
		return note;
	}, [changeHitlEditedResponse, selectHitlNote]);

	const loadHitlNoteForGraphItem = useCallback(async (graphItem) => {
		if (
			graphItem?.pendingHitl
			&& graphItem.hitlNoteId
			&& graphItem.hitlNoteId !== hitlSelectedNoteRef.current?.id
		) {
			return selectHitlNoteDetail(graphItem.hitlNoteId);
		}

		return hitlSelectedNoteRef.current;
	}, [selectHitlNoteDetail]);

	const finishDirectHitlGraphChange = useCallback(async ({
		focusedItem: nextFocusedItem = null,
		graph: nextGraphData = null,
		nodeIds = [],
		relationIds = [],
		statusText,
	}) => {
		if (nextGraphData) {
			const nextGraph = normalizeGraph(nextGraphData);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
		} else {
			await loadGraph();
		}
		setSelectedItem(null);
		setFocusedItem(nextFocusedItem);
		setHighlight({ nodeIds, relationIds });
		showStatus(statusText);
	}, [loadGraph, showStatus]);

	const focusNode = useCallback(async (node, options = {}) => {
		try {
			setServerSearchResults([]);
			setFocusedItem({ type: "node", id: node.id });
			setSelectedItem(null);
			setHighlight({ nodeIds: [node.id], relationIds: [] });

			if (!normalizedGraph.nodes.some((entry) => entry.id === node.id)) {
				const neighborhood = await requestJson(`/api/nodes/${encodeURIComponent(node.id)}/neighborhood?depth=1`);
				const mergedGraph = mergeGraph(normalizedGraph, neighborhood);
				setGraph(mergedGraph);
				setStatsText(graphStatsLabel(mergedGraph));
			}
		} catch (error) {
			(options.onError ?? showStatus)(error.message);
		}
	}, [normalizedGraph, showStatus]);

	const focusSearchNode = useCallback((node) => (
		focusNode(node, { onError: showSearchStatus })
	), [focusNode, showSearchStatus]);

	const runServerSearch = useCallback(async () => {
		const query = searchQuery.trim();
		if (!query) {
			setServerSearchResults([]);
			setSearchStatusMessage("");
			return;
		}

		const loadedMatch = findBestLoadedSearchResult(loadedSearchResults, query);
		if (loadedMatch) {
			setServerSearchResults([]);
			setSearchStatusMessage("");
			await focusSearchNode(loadedMatch);
			return;
		}

		setIsSearching(true);
		setSearchStatusMessage("");
		try {
			const result = await requestJson(`/api/nodes/search?q=${encodeURIComponent(query)}&limit=12`);
			const nodes = result.nodes ?? [];
			setServerSearchResults(nodes);
			if (nodes.length === 1) {
				await focusSearchNode(nodes[0]);
			} else if (nodes.length === 0) {
				showSearchStatus("No matching node found.");
			}
		} catch (error) {
			const fallbackMatch = findBestLoadedSearchResult(loadedSearchResults, query) ?? loadedSearchResults[0];
			if (fallbackMatch) {
				await focusSearchNode(fallbackMatch);
			} else {
				showSearchStatus(error.message);
			}
		} finally {
			setIsSearching(false);
		}
	}, [focusSearchNode, loadedSearchResults, searchQuery, showSearchStatus]);

	const runAsk = useCallback(async () => {
		if (!userName.trim()) {
			return;
		}

		const text = askText.trim();
		if (!text) {
			appendMessage("ask", { role: "assistant", text: "Enter a question before asking.", error: true });
			return;
		}

		appendMessage("ask", { role: "user", text });
		setAskText("");
		setIsBusy(true);
		const pendingMessageId = appendMessage("ask", {
			role: "assistant",
			copyable: false,
			text: "Thinking...",
		});

		try {
			const sessionId = askSessionIdRef.current;
			const memoryMessages = readAskMemory(sessionId);
			const result = await requestJson("/api/ask", {
				method: "POST",
				body: JSON.stringify({
					text,
					sessionId,
					memoryMessages,
					includeUnverifiedKnowledge,
				}),
			});
			const answerText = result.answer || "The graph does not contain enough information yet.";
			updateMessage("ask", pendingMessageId, {
				copyable: true,
				text: answerText,
			});
			appendAskMemoryTurn(sessionId, { user: text, assistant: answerText });
			setHighlight({
				nodeIds: (result.entryNodes ?? []).map((node) => node.id),
				relationIds: [],
			});
		} catch (error) {
			updateMessage("ask", pendingMessageId, {
				error: true,
				text: error.message,
			});
		} finally {
			setIsBusy(false);
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [appendMessage, askText, includeUnverifiedKnowledge, updateMessage, userName]);

	const runJob = useCallback(async (jobType) => {
		setIsJobBusy(true);
		setJobErrorMessage("");
		setJobStatusMessage(`Running ${jobTitle(jobType).toLowerCase()}...`);

		try {
			const result = await requestJson(`/api/jobs/${encodeURIComponent(jobType)}`, {
				method: "POST",
				body: JSON.stringify({ depth: jobDepth }),
			});
			const nextGraph = normalizeGraph(result.graph);
			const anchorNodeId = result.anchorNode?.id;
			setJobResult(result);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setSelectedItem(null);
			setFocusedItem(anchorNodeId ? { type: "node", id: anchorNodeId } : null);
			setHighlight(anchorNodeId ? { nodeIds: [anchorNodeId], relationIds: [] } : { nodeIds: [], relationIds: [] });
			setJobStatusMessage(`${jobTitle(jobType)} complete.`);
		} catch (error) {
			setJobErrorMessage(error.message);
			setJobStatusMessage("");
		} finally {
			setIsJobBusy(false);
		}
	}, [jobDepth]);

	const runIngest = useCallback(async () => {
		const activeUserName = userName.trim();
		if (!activeUserName) {
			return;
		}

		const text = ingestText.trim();
		const files = ingestFiles;
		if (!text && files.length === 0) {
			appendMessage("ingest", { role: "assistant", text: "Enter source text or attach a PDF/Word file before ingesting.", error: true });
			return;
		}

		const fileSummary = files.length > 0
			? `Attached ${files.length} file${files.length === 1 ? "" : "s"} for ingestion.`
			: "";
		const messageText = [text, fileSummary].filter(Boolean).join("\n\n");
		appendMessage("ingest", { role: "user", text: messageText });
		setIngestText("");
		setIngestFiles([]);
		setIsBusy(true);
		const pendingMessageId = appendMessage("ingest", {
			role: "assistant",
			text: files.length > 0 ? "Extracting file text and graph facts..." : "Extracting graph facts...",
		});

		try {
			const requestOptions = files.length > 0
				? (() => {
					const formData = new FormData();
					formData.append("text", text);
					formData.append("userName", activeUserName);
					for (const file of files) {
						formData.append("files", file);
					}
					return {
						method: "POST",
						body: formData,
					};
				})()
				: {
					method: "POST",
					body: JSON.stringify({ text, userName: activeUserName }),
				};
			const result = await requestJson("/api/ingest", requestOptions);
			const nextGraph = normalizeGraph(result.graph);
			updateMessage("ingest", pendingMessageId, {
				text: "",
				mutation: buildIngestMutation(result),
				triplets: undefined,
			});
			const changesApplied = result.applied ?? result.status !== "pending_hitl";
			setHighlight({
				nodeIds: changesApplied ? (result.nodes ?? []).map((node) => node.id) : [],
				relationIds: changesApplied ? (result.relations ?? []).map((relation) => relation.id) : [],
			});
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
		} catch (error) {
			updateMessage("ingest", pendingMessageId, {
				error: true,
				text: error.message,
				mutation: undefined,
				triplets: undefined,
			});
		} finally {
			setIsBusy(false);
			setTimeout(() => inputRef.current?.focus(), 0);
		}
	}, [appendMessage, ingestFiles, ingestText, updateMessage, userName]);

	const clearIngestChat = useCallback(() => {
		setIngestMessages([
			{ id: "ingest-message-0", role: "assistant", text: INGEST_WELCOME_MESSAGE },
		]);
		setTimeout(() => inputRef.current?.focus(), 0);
	}, []);

	const saveNode = useCallback(async (nodeId, draft) => {
		try {
			const result = await requestJson(`/api/nodes/${encodeURIComponent(nodeId)}`, {
				method: "PUT",
				body: JSON.stringify({ ...draft, userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setSelectedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Node change sent to HITL for approval.");
				return;
			}
			const nextGraph = replaceNode(normalizedGraph, result.node);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setFocusedItem({ type: "node", id: result.node.id });
			setSelectedItem(null);
			setHighlight({ nodeIds: [result.node.id], relationIds: [] });
			showStatus("Node saved and vector updated.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, showStatus, userName]);

	const createNode = useCallback(async (draft) => {
		try {
			const result = await requestJson("/api/nodes", {
				method: "POST",
				body: JSON.stringify({ ...draft, userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setCreateModalType(null);
				setCreateNodeDraftValue(createNodeDraft());
				setSelectedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Node creation sent to HITL for approval.");
				return;
			}
			const nextGraph = replaceNode(normalizedGraph, result.node);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setFocusedItem({ type: "node", id: result.node.id });
			setSelectedItem({ type: "node", id: result.node.id });
			setHighlight({ nodeIds: [result.node.id], relationIds: [] });
			setCreateModalType(null);
			setCreateNodeDraftValue(createNodeDraft());
			showStatus("Node created and indexed.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, showStatus, userName]);

	const deleteNode = useCallback(async (node) => {
		if (!window.confirm(`Delete node "${node.label}" and its relations?`)) {
			return;
		}

		try {
			const result = await requestJson(`/api/nodes/${encodeURIComponent(node.id)}`, {
				method: "DELETE",
				body: JSON.stringify({ userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setSelectedItem(null);
				setFocusedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Node deletion sent to HITL for approval.");
				return;
			}
			const nextGraph = removeNodeFromGraph(normalizedGraph, node.id);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setSelectedItem(null);
			setFocusedItem(null);
			setHighlight({ nodeIds: [], relationIds: [] });
			showStatus("Node deleted from graph and vectors.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, showStatus, userName]);

	const saveRelation = useCallback(async (relationId, draft) => {
		try {
			const result = await requestJson(`/api/relations/${encodeURIComponent(relationId)}`, {
				method: "PUT",
				body: JSON.stringify({ ...draft, userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setSelectedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Relation change sent to HITL for approval.");
				return;
			}
			const nextGraph = replaceRelation(normalizedGraph, result.relation);
			const nextSelectedItem = {
				type: "relation",
				id: result.relation.id,
				...(selectedItem?.type === "relation" && selectedItem.returnToNodeId
					? { returnToNodeId: selectedItem.returnToNodeId }
					: {}),
			};
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setFocusedItem(nextSelectedItem);
			setSelectedItem(null);
			setHighlight({ nodeIds: [result.relation.sourceId, result.relation.targetId], relationIds: [result.relation.id] });
			showStatus("Relation saved and vector updated.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, selectedItem, showStatus, userName]);

	const createRelation = useCallback(async (draft) => {
		try {
			const result = await requestJson("/api/relations", {
				method: "POST",
				body: JSON.stringify({ ...draft, userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setCreateModalType(null);
				setCreateRelationDraftValue(createRelationDraft());
				setSelectedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Relation creation sent to HITL for approval.");
				return;
			}
			const nextGraph = replaceRelation(normalizedGraph, result.relation);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setFocusedItem({ type: "relation", id: result.relation.id });
			setSelectedItem({ type: "relation", id: result.relation.id });
			setHighlight({ nodeIds: [result.relation.sourceId, result.relation.targetId], relationIds: [result.relation.id] });
			setCreateModalType(null);
			setCreateRelationDraftValue(createRelationDraft());
			showStatus("Relation created and indexed.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, showStatus, userName]);

	const deleteRelation = useCallback(async (relation) => {
		if (!window.confirm(`Delete relation "${relationLabel(relation.relation)}"?`)) {
			return;
		}

		try {
			const result = await requestJson(`/api/relations/${encodeURIComponent(relation.id)}`, {
				method: "DELETE",
				body: JSON.stringify({ userName }),
			});
			if (result.status === "pending_hitl") {
				const nextGraph = normalizeGraph(result.graph);
				setGraph(nextGraph);
				setStatsText(graphStatsLabel(nextGraph));
				setSelectedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("Relation deletion sent to HITL for approval.");
				return;
			}
			const nextGraph = removeRelationFromGraph(normalizedGraph, relation.id);
			const returnToNodeId = selectedItem?.type === "relation" && selectedItem.id === relation.id
				? selectedItem.returnToNodeId
				: "";
			const shouldReturnToNode = returnToNodeId && nextGraph.nodes.some((node) => node.id === returnToNodeId);
			setGraph(nextGraph);
			setStatsText(graphStatsLabel(nextGraph));
			setFocusedItem(shouldReturnToNode ? { type: "node", id: returnToNodeId } : null);
			setSelectedItem(null);
			setHighlight(shouldReturnToNode ? { nodeIds: [returnToNodeId], relationIds: [] } : { nodeIds: [], relationIds: [] });
			showStatus("Relation deleted from graph and vectors.");
		} catch (error) {
			showStatus(error.message);
		}
	}, [normalizedGraph, selectedItem, showStatus, userName]);

	const createHitlNode = useCallback(async (draft) => {
		try {
			if (hitlSelectedNoteRef.current) {
				const nextNode = {
					...draft,
					name: toSnakeCase(draft.name || draft.label),
				};
				changeHitlEditedResponse(createPipelineNode(hitlEditedResponseRef.current, nextNode));
				setCreateModalType(null);
				setCreateNodeDraftValue(createNodeDraft());
				showStatus("Added node creation to this HITL proposal. Graph preview will refresh.");
				return;
			}

			const activeReviewerName = hitlReviewerName.trim();
			if (!activeReviewerName) {
				showStatus("Reviewer name is required.");
				return;
			}

			const result = await requestJson("/api/hitl/nodes", {
				method: "POST",
				body: JSON.stringify({ ...draft, reviewedBy: activeReviewerName }),
			});
			setCreateModalType(null);
			setCreateNodeDraftValue(createNodeDraft());
			await finishDirectHitlGraphChange({
				focusedItem: { type: "node", id: result.node.id },
				graph: result.graph,
				nodeIds: [result.node.id],
				statusText: "Node created directly by HITL.",
			});
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, showStatus]);

	const createHitlRelation = useCallback(async (draft) => {
		try {
			const nextRelation = {
				...draft,
				relation: toSnakeCase(draft.relation) || "relates_to",
			};

			if (hitlSelectedNoteRef.current) {
				changeHitlEditedResponse(createPipelineRelation(hitlEditedResponseRef.current, nextRelation));
				setCreateModalType(null);
				setCreateRelationDraftValue(createRelationDraft());
				showStatus("Added relation creation to this HITL proposal. Graph preview will refresh.");
				return;
			}

			const activeReviewerName = hitlReviewerName.trim();
			if (!activeReviewerName) {
				showStatus("Reviewer name is required.");
				return;
			}

			const result = await requestJson("/api/hitl/relations", {
				method: "POST",
				body: JSON.stringify({ ...nextRelation, reviewedBy: activeReviewerName }),
			});
			setCreateModalType(null);
			setCreateRelationDraftValue(createRelationDraft());
			await finishDirectHitlGraphChange({
				focusedItem: { type: "relation", id: result.relation.id },
				graph: result.graph,
				nodeIds: [result.relation.sourceId, result.relation.targetId],
				relationIds: [result.relation.id],
				statusText: "Relation created directly by HITL.",
			});
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, showStatus]);

	const handleFocus = useCallback((item) => {
		setFocusedItem(item);
		if (!item) {
			setHighlight({ nodeIds: [], relationIds: [] });
			return;
		}

		setHighlight(item.type === "node"
			? { nodeIds: [item.id], relationIds: [] }
			: { nodeIds: [], relationIds: [item.id] });
	}, []);

	const handleOpenItem = useCallback((item) => {
		setFocusedItem(item);
		setSelectedItem(item);
		if (!item) {
			setHighlight({ nodeIds: [], relationIds: [] });
			return;
		}

		setHighlight(item.type === "node"
			? { nodeIds: [item.id], relationIds: [] }
			: { nodeIds: [], relationIds: [item.id] });
	}, []);

	const handleHitlOpenItem = useCallback(async (item) => {
		if (!item) {
			handleOpenItem(item);
			return;
		}

		const graphItem = item.type === "node"
			? normalizedGraph.nodes.find((node) => node.id === item.id)
			: normalizedGraph.relations.find((relation) => relation.id === item.id);

		if (!graphItem) {
			handleFocus(item);
			showStatus("The selected graph item is not available.");
			return;
		}

		if (!hitlSelectedNoteRef.current && graphItem.pendingHitl) {
			await loadHitlNoteForGraphItem(graphItem);
			setSelectedItem(null);
			showStatus("Opened the owning HITL proposal. Graph edits are now draft-only.");
			return;
		}

		handleOpenItem(item);
	}, [handleFocus, handleOpenItem, loadHitlNoteForGraphItem, normalizedGraph.nodes, normalizedGraph.relations, showStatus]);

	const focusHitlProposalRecord = useCallback((record) => {
		if (!record) {
			setFocusedItem(null);
			setHighlight({ nodeIds: [], relationIds: [] });
			return;
		}

		if (record.entity === "node" || record.entity === "nodeDelete") {
			const node = normalizedGraph.nodes.find((entry) => entry.id === record.id);
			if (!node) {
				setFocusedItem(null);
				setHighlight({ nodeIds: [], relationIds: [] });
				showStatus("That proposed node is not available in the current graph preview.");
				return;
			}

			setSelectedItem(null);
			setFocusedItem({ type: "node", id: node.id, skipCamera: true });
			setHighlight({ nodeIds: [node.id], relationIds: [] });
			return;
		}

		if (record.entity === "relation" || record.entity === "relationDelete") {
			const relation = normalizedGraph.relations.find((entry) => (
				entry.sourceId === record.sourceId
				&& entry.targetId === record.targetId
				&& entry.relation === record.relation
			));
			const nodeIds = [record.sourceId, record.targetId]
				.filter((nodeId) => normalizedGraph.nodes.some((node) => node.id === nodeId));

			setSelectedItem(null);
			setFocusedItem(relation ? { type: "relation", id: relation.id } : null);
			setHighlight({
				nodeIds,
				relationIds: relation ? [relation.id] : [],
			});
			if (!relation && nodeIds.length === 0) {
				showStatus("That proposed relation is not available in the current graph preview.");
			}
			return;
		}

		showStatus("Schema suggestions do not map to a graph item.");
	}, [normalizedGraph.nodes, normalizedGraph.relations, showStatus]);

	const saveHitlDraftNode = useCallback(async (nodeId, draft) => {
		const node = normalizedGraph.nodes.find((entry) => entry.id === nodeId);
		if (!node) {
			showStatus("The selected node is not available.");
			return;
		}

		try {
			if (!hitlSelectedNoteRef.current) {
				if (node.pendingHitl) {
					await loadHitlNoteForGraphItem(node);
					setSelectedItem(null);
					showStatus("Opened the owning HITL proposal. Edit it there before approval.");
					return;
				}

				const activeReviewerName = hitlReviewerName.trim();
				if (!activeReviewerName) {
					showStatus("Reviewer name is required.");
					return;
				}

				showStatus("Saving node directly to graph...");
				const result = await requestJson(`/api/hitl/nodes/${encodeURIComponent(node.id)}`, {
					method: "PUT",
					body: JSON.stringify({ ...draft, reviewedBy: activeReviewerName }),
				});
				await finishDirectHitlGraphChange({
					focusedItem: { type: "node", id: result.node.id },
					graph: result.graph,
					nodeIds: [result.node.id],
					statusText: "Node saved directly by HITL.",
				});
				return;
			}

			changeHitlEditedResponse(updatePipelineNode(hitlEditedResponseRef.current, node, draft));
			setSelectedItem(null);
			showStatus("Updated HITL response text. Graph preview will refresh.");
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, loadHitlNoteForGraphItem, normalizedGraph.nodes, showStatus]);

	const deleteHitlDraftNode = useCallback(async (node) => {
		if (!node) {
			showStatus("The selected node is not available.");
			return;
		}

		try {
			if (!hitlSelectedNoteRef.current) {
				if (node.pendingHitl) {
					await loadHitlNoteForGraphItem(node);
					setSelectedItem(null);
					showStatus("Opened the owning HITL proposal. Edit it there before approval.");
					return;
				}

				if (!window.confirm(`Delete "${node.label}" directly from the graph and vectors?`)) {
					return;
				}
				const activeReviewerName = hitlReviewerName.trim();
				if (!activeReviewerName) {
					showStatus("Reviewer name is required.");
					return;
				}

				showStatus("Deleting node directly from graph...");
				const result = await requestJson(`/api/hitl/nodes/${encodeURIComponent(node.id)}`, {
					method: "DELETE",
					body: JSON.stringify({ reviewedBy: activeReviewerName }),
				});
				await finishDirectHitlGraphChange({
					graph: result.graph,
					statusText: "Node deleted directly by HITL.",
				});
				return;
			}

			const removesOnly = node.pendingHitl && node.pendingOperation === "create";
			if (!window.confirm(removesOnly
				? `Remove "${node.label}" from this HITL proposal?`
				: `Add deletion of "${node.label}" to this HITL proposal?`)) {
				return;
			}

			changeHitlEditedResponse(deletePipelineNode(hitlEditedResponseRef.current, node, { removeOnly: removesOnly }));
			setSelectedItem(null);
			setHighlight({ nodeIds: [], relationIds: [] });
			showStatus(removesOnly
				? "Removed node from HITL response text. Graph preview will refresh."
				: "Added node deletion to HITL response text. Graph preview will refresh.");
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, loadHitlNoteForGraphItem, showStatus]);

	const saveHitlDraftRelation = useCallback(async (relationId, draft) => {
		const relation = normalizedGraph.relations.find((entry) => entry.id === relationId);
		if (!relation) {
			showStatus("The selected relation is not available.");
			return;
		}

		try {
			if (!hitlSelectedNoteRef.current) {
				if (relation.pendingHitl) {
					await loadHitlNoteForGraphItem(relation);
					setSelectedItem(null);
					showStatus("Opened the owning HITL proposal. Edit it there before approval.");
					return;
				}

				const activeReviewerName = hitlReviewerName.trim();
				if (!activeReviewerName) {
					showStatus("Reviewer name is required.");
					return;
				}

				showStatus("Saving relation directly to graph...");
				const result = await requestJson(`/api/hitl/relations/${encodeURIComponent(relation.id)}`, {
					method: "PUT",
					body: JSON.stringify({ ...draft, reviewedBy: activeReviewerName }),
				});
				await finishDirectHitlGraphChange({
					focusedItem: { type: "relation", id: result.relation.id },
					graph: result.graph,
					nodeIds: [result.relation.sourceId, result.relation.targetId],
					relationIds: [result.relation.id],
					statusText: "Relation saved directly by HITL.",
				});
				return;
			}

			changeHitlEditedResponse(updatePipelineRelation(hitlEditedResponseRef.current, relation, draft));
			setSelectedItem(null);
			showStatus("Updated HITL response text. Graph preview will refresh.");
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, loadHitlNoteForGraphItem, normalizedGraph.relations, showStatus]);

	const deleteHitlDraftRelation = useCallback(async (relation) => {
		if (!relation) {
			showStatus("The selected relation is not available.");
			return;
		}

		try {
			if (!hitlSelectedNoteRef.current) {
				if (relation.pendingHitl) {
					await loadHitlNoteForGraphItem(relation);
					setSelectedItem(null);
					showStatus("Opened the owning HITL proposal. Edit it there before approval.");
					return;
				}

				if (!window.confirm(`Delete relation "${relationLabel(relation.relation)}" directly from the graph and vectors?`)) {
					return;
				}
				const activeReviewerName = hitlReviewerName.trim();
				if (!activeReviewerName) {
					showStatus("Reviewer name is required.");
					return;
				}

				showStatus("Deleting relation directly from graph...");
				const result = await requestJson(`/api/hitl/relations/${encodeURIComponent(relation.id)}`, {
					method: "DELETE",
					body: JSON.stringify({ reviewedBy: activeReviewerName }),
				});
				await finishDirectHitlGraphChange({
					graph: result.graph,
					nodeIds: [relation.sourceId, relation.targetId],
					statusText: "Relation deleted directly by HITL.",
				});
				return;
			}

			const removesOnly = relation.pendingHitl && relation.pendingOperation === "create";
			if (!window.confirm(removesOnly
				? `Remove relation "${relationLabel(relation.relation)}" from this HITL proposal?`
				: `Add deletion of relation "${relationLabel(relation.relation)}" to this HITL proposal?`)) {
				return;
			}

			changeHitlEditedResponse(deletePipelineRelation(hitlEditedResponseRef.current, relation, { removeOnly: removesOnly }));
			setSelectedItem(null);
			setHighlight({ nodeIds: [], relationIds: [] });
			showStatus(removesOnly
				? "Removed relation from HITL response text. Graph preview will refresh."
				: "Added relation deletion to HITL response text. Graph preview will refresh.");
		} catch (error) {
			showStatus(hitlDirectSaveErrorMessage(error));
		}
	}, [changeHitlEditedResponse, finishDirectHitlGraphChange, hitlReviewerName, loadHitlNoteForGraphItem, showStatus]);

	const searchPanel = (
		<SearchPanel
			clientResults={clientSearchResults}
			isSearching={isSearching}
			onFocusNode={focusSearchNode}
			onQuery={(value) => {
				setSearchQuery(value);
				setServerSearchResults([]);
				setSearchStatusMessage("");
			}}
			onSearch={runServerSearch}
			query={searchQuery}
			searchMessage={searchStatusMessage}
			serverResults={serverSearchResults}
		/>
	);

	const openCreateModal = useCallback((type) => {
		if (type === "relation") {
			const activeNodeId = focusedItem?.type === "node"
				? focusedItem.id
				: selectedItem?.type === "node" ? selectedItem.id : "";
			if (activeNodeId) {
				setCreateRelationDraftValue((current) => (
					current.sourceId ? current : { ...current, sourceId: activeNodeId }
				));
			}
		}

		setCreateModalType(type);
	}, [focusedItem, selectedItem]);

	const closeCreateModal = useCallback(() => {
		setCreateModalType(null);
	}, []);

	const closeDetailModal = useCallback(() => {
		setSelectedItem(null);
	}, []);

	const detailModalTitle = selectedItem?.type === "node" ? "Node details" : "Relation details";

	const graphActionPanel = (
		<GraphActionButtons
			onCreateNode={() => openCreateModal("node")}
			onCreateRelation={() => openCreateModal("relation")}
		/>
	);

	const resizeWorkspace = useCallback((clientX) => {
		const rect = shellRef.current?.getBoundingClientRect();
		if (!rect?.width) {
			return workspaceWidth;
		}

		const nextWidth = ((rect.right - clientX) / rect.width) * 100;
		const boundedWidth = clampNumber(nextWidth, MIN_WORKSPACE_WIDTH, MAX_WORKSPACE_WIDTH);
		setWorkspaceWidth(boundedWidth);
		return boundedWidth;
	}, [workspaceWidth]);

	const resetWorkspaceDivision = useCallback((event) => {
		event?.preventDefault?.();
		event?.stopPropagation?.();
		setWorkspaceWidth(defaultWorkspaceWidth);
	}, [defaultWorkspaceWidth]);

	const startWorkspaceResize = useCallback((event) => {
		if (event.button !== 0) {
			return;
		}

		const now = window.performance.now();
		const lastPress = dividerPressRef.current;
		const movement = Math.hypot(event.clientX - lastPress.x, event.clientY - lastPress.y);
		const isDoublePress = now - lastPress.time < 360 && movement < 12;
		dividerPressRef.current = { time: now, x: event.clientX, y: event.clientY };

		if (isDoublePress) {
			resetWorkspaceDivision(event);
			return;
		}

		event.preventDefault();
		let latestWidth = resizeWorkspace(event.clientX);
		document.body.style.cursor = "col-resize";
		document.body.style.userSelect = "none";

		const stopResize = () => {
			document.body.style.cursor = "";
			document.body.style.userSelect = "";
			setWorkspaceWidth(snapWorkspaceWidth(latestWidth));
			window.removeEventListener("pointermove", handleResize);
			window.removeEventListener("pointerup", stopResize);
			window.removeEventListener("pointercancel", stopResize);
		};
		const handleResize = (moveEvent) => {
			latestWidth = resizeWorkspace(moveEvent.clientX);
		};

		window.addEventListener("pointermove", handleResize);
		window.addEventListener("pointerup", stopResize);
		window.addEventListener("pointercancel", stopResize);
	}, [resetWorkspaceDivision, resizeWorkspace]);

	const handleWorkspaceResizeKeyDown = useCallback((event) => {
		const steps = {
			ArrowLeft: 2,
			ArrowRight: -2,
			Home: MIN_WORKSPACE_WIDTH,
			End: MAX_WORKSPACE_WIDTH,
		};
		const nextStep = steps[event.key];
		if (nextStep === undefined) {
			return;
		}

		event.preventDefault();
		setWorkspaceWidth((currentWidth) => (
			event.key === "Home" || event.key === "End"
				? nextStep
				: snapWorkspaceWidth(currentWidth + nextStep)
		));
	}, []);

	const handleWorkspaceDividerClick = useCallback((event) => {
		if (event.detail >= 2) {
			resetWorkspaceDivision(event);
		}
	}, [resetWorkspaceDivision]);

	if (isSchemaRoute) {
		return (
			<main
				class="app-shell schema-shell"
				ref={shellRef}
				style={{
					"--divider-width": "18px",
					"--graph-panel-width": `${100 - workspaceWidth}fr`,
					"--workspace-panel-width": `${workspaceWidth}fr`,
				}}
			>
				{graphRenderer === GRAPH_RENDERERS.neovis ? (
					<NeoVisGraphPreview
						actionPanel={null}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleFocus}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				) : (
					<GraphPreview
						actionPanel={null}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleFocus}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				)}
				<WorkspaceDivider
					handleClick={handleWorkspaceDividerClick}
					maxWidth={MAX_WORKSPACE_WIDTH}
					minWidth={MIN_WORKSPACE_WIDTH}
					onCloseGraph={() => setWorkspaceWidth(MAX_WORKSPACE_WIDTH)}
					onCloseWorkspace={() => setWorkspaceWidth(MIN_WORKSPACE_WIDTH)}
					onDoubleClick={resetWorkspaceDivision}
					onKeyDown={handleWorkspaceResizeKeyDown}
					onPointerDown={startWorkspaceResize}
					workspaceLabel="Graph schema"
					workspaceWidth={workspaceWidth}
				/>
				<SchemaPanel />
			</main>
		);
	}

	if (isJobsRoute) {
		return (
			<main
				class="app-shell jobs-shell"
				ref={shellRef}
				style={{
					"--divider-width": "18px",
					"--graph-panel-width": `${100 - workspaceWidth}fr`,
					"--workspace-panel-width": `${workspaceWidth}fr`,
				}}
			>
				{graphRenderer === GRAPH_RENDERERS.neovis ? (
					<NeoVisGraphPreview
						actionPanel={null}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleFocus}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				) : (
					<GraphPreview
						actionPanel={null}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleFocus}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				)}
				<WorkspaceDivider
					handleClick={handleWorkspaceDividerClick}
					maxWidth={MAX_WORKSPACE_WIDTH}
					minWidth={MIN_WORKSPACE_WIDTH}
					onCloseGraph={() => setWorkspaceWidth(MAX_WORKSPACE_WIDTH)}
					onCloseWorkspace={() => setWorkspaceWidth(MIN_WORKSPACE_WIDTH)}
					onDoubleClick={resetWorkspaceDivision}
					onKeyDown={handleWorkspaceResizeKeyDown}
					onPointerDown={startWorkspaceResize}
					workspaceLabel="Graph jobs"
					workspaceWidth={workspaceWidth}
				/>
				<JobsPanel
					depth={jobDepth}
					errorMessage={jobErrorMessage}
					isBusy={isJobBusy}
					onDepthChange={setJobDepth}
					onRunJob={runJob}
					result={jobResult}
					statusMessage={jobStatusMessage}
				/>
			</main>
		);
	}

	if (isHitlRoute) {
		const hitlGraphActionPanel = (
			<HitlGraphActionPanel
				isDirty={hitlProposalDirty}
				isDraftMode={hitlDraftMode}
				onCreateNode={() => openCreateModal("node")}
				onCreateRelation={() => openCreateModal("relation")}
			/>
		);
		const hitlNodeSaveLabel = hitlDraftMode ? "Update proposal" : "Save directly";
		const hitlRelationSaveLabel = hitlDraftMode ? "Update proposal" : "Save directly";
		const hitlDeleteLabel = hitlDraftMode ? "Add delete to proposal" : "Delete directly";

		return (
			<>
				<main
					class="app-shell hitl-shell"
					ref={shellRef}
					style={{
						"--divider-width": "18px",
						"--graph-panel-width": `${100 - workspaceWidth}fr`,
						"--workspace-panel-width": `${workspaceWidth}fr`,
					}}
				>
					{graphRenderer === GRAPH_RENDERERS.neovis ? (
						<NeoVisGraphPreview
							actionPanel={hitlGraphActionPanel}
							focusedItem={focusedItem}
							graph={normalizedGraph}
							highlightNodeIds={highlight.nodeIds}
							highlightRelationIds={highlight.relationIds}
							onFocus={handleFocus}
							onOpenItem={handleHitlOpenItem}
							onReload={loadGraph}
							onRendererMode={setGraphRenderer}
							rendererMode={graphRenderer}
							searchPanel={searchPanel}
							statsText={statsText}
						/>
					) : (
						<GraphPreview
							actionPanel={hitlGraphActionPanel}
							focusedItem={focusedItem}
							graph={normalizedGraph}
							highlightNodeIds={highlight.nodeIds}
							highlightRelationIds={highlight.relationIds}
							onFocus={handleFocus}
							onOpenItem={handleHitlOpenItem}
							onReload={loadGraph}
							onRendererMode={setGraphRenderer}
							rendererMode={graphRenderer}
							searchPanel={searchPanel}
							statsText={statsText}
						/>
					)}
					<WorkspaceDivider
						handleClick={handleWorkspaceDividerClick}
						maxWidth={MAX_WORKSPACE_WIDTH}
						minWidth={MIN_WORKSPACE_WIDTH}
						onCloseGraph={() => setWorkspaceWidth(MAX_WORKSPACE_WIDTH)}
						onCloseWorkspace={() => setWorkspaceWidth(MIN_WORKSPACE_WIDTH)}
						onDoubleClick={resetWorkspaceDivision}
						onKeyDown={handleWorkspaceResizeKeyDown}
						onPointerDown={startWorkspaceResize}
						workspaceLabel="Human review"
						workspaceWidth={workspaceWidth}
					/>
					<HitlReviewPanel
						editedResponse={hitlEditedResponse}
						graph={normalizedGraph}
						isProposalDirty={hitlProposalDirty}
						onChangeReviewerName={() => setIsEditingHitlReviewerName(true)}
						onCloseSelectedNote={closeHitlNoteDetail}
						onEditedResponseChange={changeHitlEditedResponse}
						onGraphRefresh={loadGraph}
						onProposalFocus={focusHitlProposalRecord}
						onSelectNote={selectHitlNote}
						onStatus={showStatus}
						previewMessage={hitlPreviewMessage}
						requestJson={requestJson}
						reviewerName={hitlReviewerName}
						routeSwitcher={<RouteSwitcher />}
						selectedNote={hitlSelectedNote}
					/>
					{(!hitlReviewerName.trim() || isEditingHitlReviewerName) && (
						<RequiredNameModal
							eyebrow="Human review access"
							fieldLabel="Reviewer name"
							helperText="The reviewer name is kept only for this page session and will be attached to approve/reject actions."
							initialName={hitlReviewerName}
							onSubmit={saveHitlReviewerName}
							placeholder="Enter reviewer name to continue"
							title={hitlReviewerName.trim() ? "Change reviewer name" : "Enter reviewer name"}
						/>
					)}
				</main>
				{selectedItem && (
					<EntityModal title={detailModalTitle} onClose={closeDetailModal}>
						<DetailPanel
							graph={normalizedGraph}
							nodeTypes={schemaNodeTypes}
							nodeDeleteLabel={hitlDeleteLabel}
							nodeSaveLabel={hitlNodeSaveLabel}
							onDeleteNode={deleteHitlDraftNode}
							onDeleteRelation={deleteHitlDraftRelation}
							onSaveNode={saveHitlDraftNode}
							onSaveRelation={saveHitlDraftRelation}
							onSelectItem={handleHitlOpenItem}
							relationshipTypes={schemaRelationshipTypes}
							relationDeleteLabel={hitlDeleteLabel}
							relationSaveLabel={hitlRelationSaveLabel}
							selectedItem={selectedItem}
						/>
					</EntityModal>
				)}
				{createModalType === "node" && (
					<EntityModal title={hitlDraftMode ? "Add node to proposal" : "Create node directly"} onClose={closeCreateModal}>
						<NodeForm
							draft={createNodeDraftValue}
							nodeTypes={schemaNodeTypes}
							onCancel={closeCreateModal}
							onDraftChange={setCreateNodeDraftValue}
							onSave={createHitlNode}
							saveLabel={hitlDraftMode ? "Add to proposal" : "Create directly"}
						/>
					</EntityModal>
				)}
				{createModalType === "relation" && (
					<EntityModal title={hitlDraftMode ? "Add relation to proposal" : "Create relation directly"} onClose={closeCreateModal}>
						<RelationForm
							draft={createRelationDraftValue}
							graph={normalizedGraph}
							onCancel={closeCreateModal}
							onDraftChange={setCreateRelationDraftValue}
							onSave={createHitlRelation}
							relationshipTypes={schemaRelationshipTypes}
							saveLabel={hitlDraftMode ? "Add to proposal" : "Create directly"}
						/>
					</EntityModal>
				)}
			</>
		);
	}

	return (
		<>
			<main
				class="app-shell"
				ref={shellRef}
				style={{
					"--divider-width": "18px",
					"--graph-panel-width": `${100 - workspaceWidth}fr`,
					"--workspace-panel-width": `${workspaceWidth}fr`,
				}}
			>
				{graphRenderer === GRAPH_RENDERERS.neovis ? (
					<NeoVisGraphPreview
						actionPanel={graphActionPanel}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleOpenItem}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				) : (
					<GraphPreview
						actionPanel={graphActionPanel}
						focusedItem={focusedItem}
						graph={normalizedGraph}
						highlightNodeIds={highlight.nodeIds}
						highlightRelationIds={highlight.relationIds}
						onFocus={handleFocus}
						onOpenItem={handleOpenItem}
						onReload={loadGraph}
						onRendererMode={setGraphRenderer}
						rendererMode={graphRenderer}
						searchPanel={searchPanel}
						statsText={statsText}
					/>
				)}
				<div
					aria-label="Resize workspace panel"
					aria-orientation="vertical"
					aria-valuemax={MAX_WORKSPACE_WIDTH}
					aria-valuemin={MIN_WORKSPACE_WIDTH}
					aria-valuenow={Math.round(workspaceWidth)}
					class="workspace-resize-handle"
					onClick={handleWorkspaceDividerClick}
					onDblClick={resetWorkspaceDivision}
					onKeyDown={handleWorkspaceResizeKeyDown}
					onPointerDown={startWorkspaceResize}
					role="separator"
					tabIndex={0}
				>
					<div class="workspace-resize-actions">
						<button
							type="button"
							class="workspace-resize-action"
							aria-label="Close graph panel"
							title="Close graph panel"
							onClick={(event) => {
								event.stopPropagation();
								setWorkspaceWidth(MAX_WORKSPACE_WIDTH);
							}}
							onDblClick={resetWorkspaceDivision}
							onPointerDown={(event) => event.stopPropagation()}
						>
							{"◀"}
						</button>
						<button
							type="button"
							class="workspace-resize-action"
							aria-label="Close Ask/Ingest panel"
							title="Close Ask/Ingest panel"
							onClick={(event) => {
								event.stopPropagation();
								setWorkspaceWidth(MIN_WORKSPACE_WIDTH);
							}}
							onDblClick={resetWorkspaceDivision}
							onPointerDown={(event) => event.stopPropagation()}
						>
							{"▶"}
						</button>
					</div>
				</div>
				<ChatPanel
					activeTab={activeTab}
					askMessages={askMessages}
					askText={askText}
					includeUnverifiedKnowledge={includeUnverifiedKnowledge}
					ingestFiles={ingestFiles}
					ingestMessages={ingestMessages}
					ingestText={ingestText}
					inputRef={inputRef}
					isBusy={isBusy}
					onAsk={runAsk}
					onAskText={setAskText}
					onChangeUserName={() => setIsEditingUserName(true)}
					onIncludeUnverifiedKnowledgeChange={setIncludeUnverifiedKnowledge}
					onClearIngest={clearIngestChat}
					onIngest={runIngest}
					onIngestFileClear={clearIngestFile}
					onIngestFiles={selectIngestFiles}
					onIngestText={setIngestText}
					onTab={setActiveTab}
					statusMessage={statusMessage}
					userName={userName}
					workspaceLocked={!userName.trim()}
				/>
			</main>
			{(!userName.trim() || isEditingUserName) && (
				<RequiredNameModal
					initialName={userName}
					onSubmit={saveUserName}
					title={userName.trim() ? "Change workspace user" : "Enter your name"}
				/>
			)}
			{selectedItem && (
				<EntityModal title={detailModalTitle} onClose={closeDetailModal}>
					<DetailPanel
						graph={normalizedGraph}
						nodeTypes={schemaNodeTypes}
						onDeleteNode={deleteNode}
						onDeleteRelation={deleteRelation}
						onSaveNode={saveNode}
						onSaveRelation={saveRelation}
						onSelectItem={handleOpenItem}
						relationshipTypes={schemaRelationshipTypes}
						selectedItem={selectedItem}
					/>
				</EntityModal>
			)}
			{createModalType === "node" && (
				<EntityModal title="Create node" onClose={closeCreateModal}>
					<NodeForm
						draft={createNodeDraftValue}
						nodeTypes={schemaNodeTypes}
						onCancel={closeCreateModal}
						onDraftChange={setCreateNodeDraftValue}
						onSave={createNode}
						saveLabel="Create node"
					/>
				</EntityModal>
			)}
			{createModalType === "relation" && (
				<EntityModal title="Create relation" onClose={closeCreateModal}>
					<RelationForm
						draft={createRelationDraftValue}
						graph={normalizedGraph}
						onCancel={closeCreateModal}
						onDraftChange={setCreateRelationDraftValue}
						onSave={createRelation}
						relationshipTypes={schemaRelationshipTypes}
						saveLabel="Create relation"
					/>
				</EntityModal>
			)}
		</>
	);
}

const root = document.querySelector("#app");
if (root) {
	render(<App />, root);
}
