import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import Graph from "graphology";
import forceLayout from "graphology-layout-force";
import Sigma from "sigma";
import {
	DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS,
	createEdgeArrowProgram,
} from "sigma/rendering";
import { createEdgeCurveProgram, indexParallelEdgesIndex } from "@sigma/edge-curve";
import NeoVisPackage from "neovis.js";
import { HitlReviewPanel } from "./components/hitl/HitlReviewPanel.js";
import { formatHitlDate } from "./lib/hitlProposal.js";

const GRAPH_LIMIT = 150;
const EMPTY_GRAPH = { nodes: [], relations: [] };
const ASK_WELCOME_MESSAGE = "Ask a question using the current graph context.";
const ASK_MEMORY_STORAGE_KEY = "mindmesh.askMemory";
const ASK_SESSION_STORAGE_KEY = "mindmesh.askSessionId";
const WORKSPACE_USER_STORAGE_KEY = "mindmesh.workspaceUserName";
const HITL_REVIEWER_STORAGE_KEY = "mindmesh.hitlReviewerName";
const DEFAULT_JOB_DEPTH = 2;
const INGEST_WELCOME_MESSAGE = "Paste source text to extract nodes and relationships.";
const INGEST_FILE_ACCEPT = ".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_INGEST_FILES = 10;
const MAX_INGEST_FILE_SIZE_BYTES = 25 * 1024 * 1024;
const ASK_MEMORY_MAX_MESSAGES = 10;
const ASK_MEMORY_MAX_MESSAGE_CHARS = 2000;
const SUPPORTED_INGEST_FILE_EXTENSIONS = new Set(["pdf", "docx", "doc"]);
const DEFAULT_NODE_COLOR = "#94a3b8";
const HITL_CONTEXT_NODE_COLOR = "#94a3b8";
const HITL_CONTEXT_EDGE_COLOR = "#64748b";
const HITL_OPERATION_COLORS = Object.freeze({
	create: "#2f9e44",
	update: "#f59f00",
	delete: "#d94848",
	fallback: "#64748b",
});
const GRAPH_SELECTED_NODE_BORDER_WIDTH = 3;
const GRAPH_SELECTION_COLOR = "#67e8f9";
const GRAPH_SELECTION_BORDER_COLOR = "#f8fafc";
const GRAPH_SELECTION_DIM_NODE_COLOR = "#475569";
const GRAPH_SELECTION_DIM_EDGE_COLOR = "#334155";
const NODE_TYPE_PALETTE = [
	"#2563eb",
	"#facc15",
	"#06b6d4",
	"#7c3aed",
	"#db2777",
	"#84cc16",
	"#14b8a6",
	"#38bdf8",
	"#a855f7",
	"#22d3ee",
	"#c084fc",
	"#bef264",
	"#0ea5e9",
	"#e879f9",
	"#2dd4bf",
	"#fde047",
];
const DEFAULT_NODE_SIZE = 3.2;
const NODE_LINK_SIZE_STEP = 2.6;
const NODE_LINK_SIZE_MAX_BONUS = 14.4;
const NODE_FOCUS_SIZE_DELTA = 3.2;
const SIGMA_DIMMED_NODE_MIN_SIZE = DEFAULT_NODE_SIZE * 0.72;
const SIGMA_EDGE_SIZE = 1.4;
const SIGMA_DIMMED_EDGE_SIZE = 0.6;
const SIGMA_ARROW_HEAD_SCALE = 2;
const NEOVIS_EDGE_SIZE = 1.4;
const HITL_PENDING_EDGE_WIDTH = NEOVIS_EDGE_SIZE * 1.7;
const NEOVIS_ARROW_SCALE_FACTOR = 0.6;
const NEOVIS_NODE_FOCUS_SCALE = 1.55;
const DEFAULT_WORKSPACE_WIDTH = 25;
const DEFAULT_TOOL_WORKSPACE_WIDTH = 40;
const MIN_WORKSPACE_WIDTH = 0;
const MAX_WORKSPACE_WIDTH = 100;
const PANEL_SNAP_THRESHOLD = 10;
const GRAPH_RENDERERS = {
	sigma: "sigma",
	neovis: "neovis",
};
const APP_ROUTES = [
	{ href: "/", label: "Ask/Ingest" },
	{ href: "/hitl", label: "HITL" },
	{ href: "/jobs", label: "Jobs" },
	{ href: "/schema", label: "Schema" },
];
const NeoVis = NeoVisPackage.NeoVis ?? NeoVisPackage.default?.NeoVis ?? NeoVisPackage.default ?? NeoVisPackage;
const LARGE_ARROW_HEAD_OPTIONS = {
	...DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS,
	lengthToThicknessRatio: DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS.lengthToThicknessRatio * SIGMA_ARROW_HEAD_SCALE,
	widenessToThicknessRatio: DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS.widenessToThicknessRatio * SIGMA_ARROW_HEAD_SCALE,
};
const LargeArrowProgram = createEdgeArrowProgram(LARGE_ARROW_HEAD_OPTIONS);
const LargeCurvedArrowProgram = createEdgeCurveProgram({
	arrowHead: LARGE_ARROW_HEAD_OPTIONS,
});

function truncate(value, length = 34) {
	const text = String(value ?? "");
	return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function hasCopyableLlmText(value) {
	const text = String(value ?? "").trim();
	return Boolean(text && !["thinking...", "thinking", "loading...", "loading"].includes(text.toLowerCase()));
}

function markdownBlocks(text) {
	const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
	const blocks = [];
	let paragraph = [];
	let list = null;

	function flushParagraph() {
		if (paragraph.length > 0) {
			blocks.push({ type: "paragraph", lines: paragraph });
			paragraph = [];
		}
	}

	function flushList() {
		if (list) {
			blocks.push(list);
			list = null;
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();

		if (!trimmed) {
			flushParagraph();
			flushList();
			continue;
		}

		if (trimmed.startsWith("```")) {
			flushParagraph();
			flushList();
			const codeLines = [];
			index += 1;
			while (index < lines.length && !lines[index].trim().startsWith("```")) {
				codeLines.push(lines[index]);
				index += 1;
			}
			blocks.push({ type: "code", text: codeLines.join("\n") });
			continue;
		}

		const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
		if (heading) {
			flushParagraph();
			flushList();
			blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
			continue;
		}

		const unorderedItem = /^[-*+]\s+(.+)$/.exec(trimmed);
		const orderedItem = /^\d+[.)]\s+(.+)$/.exec(trimmed);
		if (unorderedItem || orderedItem) {
			flushParagraph();
			const listType = unorderedItem ? "unordered-list" : "ordered-list";
			if (!list || list.type !== listType) {
				flushList();
				list = { type: listType, items: [] };
			}
			list.items.push(unorderedItem?.[1] ?? orderedItem[1]);
			continue;
		}

		flushList();
		paragraph.push(line);
	}

	flushParagraph();
	flushList();
	return blocks;
}

function renderInlineMarkdown(text, keyPrefix) {
	const value = String(text ?? "");
	const parts = [];
	const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
	let cursor = 0;
	let match = pattern.exec(value);

	while (match) {
		if (match.index > cursor) {
			parts.push(value.slice(cursor, match.index));
		}

		const token = match[0];
		if (token.startsWith("`")) {
			parts.push(<code key={`${keyPrefix}-code-${match.index}`}>{token.slice(1, -1)}</code>);
		} else {
			parts.push(<strong key={`${keyPrefix}-strong-${match.index}`}>{token.slice(2, -2)}</strong>);
		}

		cursor = match.index + token.length;
		match = pattern.exec(value);
	}

	if (cursor < value.length) {
		parts.push(value.slice(cursor));
	}

	return parts;
}

function MarkdownPreview({ className = "", emptyText = "No preview text yet.", text }) {
	const blocks = markdownBlocks(text);

	return (
		<div class={`markdown-preview${className ? ` ${className}` : ""}`}>
			{blocks.length === 0 ? (
				<p class="muted-copy">{emptyText}</p>
			) : blocks.map((block, blockIndex) => {
				if (block.type === "heading") {
					const HeadingTag = `h${Math.min(block.level + 2, 6)}`;
					return (
						<HeadingTag key={`heading-${blockIndex}`}>
							{renderInlineMarkdown(block.text, `heading-${blockIndex}`)}
						</HeadingTag>
					);
				}

				if (block.type === "code") {
					return (
						<pre key={`code-${blockIndex}`}>
							<code>{block.text}</code>
						</pre>
					);
				}

				if (block.type === "unordered-list" || block.type === "ordered-list") {
					const ListTag = block.type === "ordered-list" ? "ol" : "ul";
					return (
						<ListTag key={`list-${blockIndex}`}>
							{block.items.map((item, itemIndex) => (
								<li key={`item-${blockIndex}-${itemIndex}`}>
									{renderInlineMarkdown(item, `item-${blockIndex}-${itemIndex}`)}
								</li>
							))}
						</ListTag>
					);
				}

				return (
					<p key={`paragraph-${blockIndex}`}>
						{block.lines.map((line, lineIndex) => (
							<span key={`line-${blockIndex}-${lineIndex}`}>
								{lineIndex > 0 && <br />}
								{renderInlineMarkdown(line, `line-${blockIndex}-${lineIndex}`)}
							</span>
						))}
					</p>
				);
			})}
		</div>
	);
}

async function copyTextToClipboard(value) {
	const text = String(value ?? "");
	if (!text.trim()) {
		return false;
	}

	if (navigator.clipboard?.writeText) {
		await navigator.clipboard.writeText(text);
		return true;
	}

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.left = "-9999px";
	document.body.appendChild(textarea);
	textarea.select();
	const copied = document.execCommand("copy");
	document.body.removeChild(textarea);
	return copied;
}

function CopyIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
			<rect x="9" y="9" width="10" height="10" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
		</svg>
	);
}

function CopyButton({ className = "", label = "Copy to clipboard", onStatus, text }) {
	const [copied, setCopied] = useState(false);
	const timeoutRef = useRef(null);
	const hasText = hasCopyableLlmText(text);

	useEffect(() => () => {
		if (timeoutRef.current) {
			window.clearTimeout(timeoutRef.current);
		}
	}, []);

	const handleCopy = useCallback(async () => {
		try {
			const didCopy = await copyTextToClipboard(text);
			if (!didCopy) {
				onStatus?.("Nothing to copy.");
				return;
			}

			setCopied(true);
			onStatus?.("Copied to clipboard.");
			if (timeoutRef.current) {
				window.clearTimeout(timeoutRef.current);
			}
			timeoutRef.current = window.setTimeout(() => setCopied(false), 1400);
		} catch (error) {
			onStatus?.(error.message || "Copy failed.");
		}
	}, [onStatus, text]);

	if (!hasText) {
		return null;
	}

	return (
		<button
			type="button"
			class={`copy-button${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
			onClick={handleCopy}
			title={copied ? "Copied" : label}
			aria-label={copied ? "Copied" : label}
		>
			<CopyIcon />
			<span class="sr-only">{copied ? "Copied" : label}</span>
		</button>
	);
}

function toSnakeCase(value) {
	return String(value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

function stableStringHash(value) {
	let hash = 0;
	for (let index = 0; index < value.length; index += 1) {
		hash = ((hash * 31) + value.charCodeAt(index)) >>> 0;
	}

	return hash;
}

function hslToHex(hue, saturation, lightness) {
	const normalizedHue = ((hue % 360) + 360) % 360;
	const normalizedSaturation = clampNumber(saturation, 0, 100) / 100;
	const normalizedLightness = clampNumber(lightness, 0, 100) / 100;
	const chroma = (1 - Math.abs(2 * normalizedLightness - 1)) * normalizedSaturation;
	const secondary = chroma * (1 - Math.abs((normalizedHue / 60) % 2 - 1));
	const match = normalizedLightness - chroma / 2;
	let red = 0;
	let green = 0;
	let blue = 0;

	if (normalizedHue < 60) {
		red = chroma;
		green = secondary;
	} else if (normalizedHue < 120) {
		red = secondary;
		green = chroma;
	} else if (normalizedHue < 180) {
		green = chroma;
		blue = secondary;
	} else if (normalizedHue < 240) {
		green = secondary;
		blue = chroma;
	} else if (normalizedHue < 300) {
		red = secondary;
		blue = chroma;
	} else {
		red = chroma;
		blue = secondary;
	}

	const toHex = (channel) => Math.round((channel + match) * 255)
		.toString(16)
		.padStart(2, "0");
	return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function nodeTypeColor(type) {
	const normalizedType = toSnakeCase(type);
	if (!normalizedType) {
		return DEFAULT_NODE_COLOR;
	}

	return NODE_TYPE_PALETTE[stableStringHash(normalizedType) % NODE_TYPE_PALETTE.length];
}

function generatedNodeTypeColor(type, attempt = 0) {
	const hash = stableStringHash(`${type}:${attempt}`);
	const hue = (hash * 137.508) % 360;
	const saturation = 42 + (hash % 9);
	const lightness = 54 + ((hash >>> 4) % 8);
	return hslToHex(hue, saturation, lightness);
}

function createNodeTypeColorMap(nodes) {
	const nodeTypes = [...new Set(
		(nodes ?? [])
			.map((node) => toSnakeCase(node?.type))
			.filter(Boolean),
	)].sort((firstType, secondType) => (
		stableStringHash(firstType) - stableStringHash(secondType)
		|| firstType.localeCompare(secondType)
	));
	const usedColors = new Set();
	const colorByType = new Map();

	for (const type of nodeTypes) {
		const hash = stableStringHash(type);
		let color = "";
		for (let offset = 0; offset < NODE_TYPE_PALETTE.length; offset += 1) {
			const candidate = NODE_TYPE_PALETTE[(hash + offset) % NODE_TYPE_PALETTE.length];
			if (!usedColors.has(candidate)) {
				color = candidate;
				break;
			}
		}

		let attempt = 0;
		while (!color || usedColors.has(color)) {
			color = generatedNodeTypeColor(type, attempt);
			attempt += 1;
		}

		usedColors.add(color);
		colorByType.set(type, color);
	}

	return colorByType;
}

function nodeColorFromTypeMap(type, colorByType) {
	const normalizedType = toSnakeCase(type);
	if (!normalizedType) {
		return DEFAULT_NODE_COLOR;
	}

	return colorByType.get(normalizedType) ?? nodeTypeColor(normalizedType);
}

function normalizedHitlOperation(operation) {
	const normalized = String(operation ?? "").trim().toLowerCase();
	if (normalized === "create" || normalized === "update" || normalized === "delete") {
		return normalized;
	}

	return "fallback";
}

function hitlOperationColor(operation) {
	return HITL_OPERATION_COLORS[normalizedHitlOperation(operation)] ?? HITL_OPERATION_COLORS.fallback;
}

function selectedNodeColor(baseColor) {
	return {
		background: baseColor || DEFAULT_NODE_COLOR,
		border: GRAPH_SELECTION_BORDER_COLOR,
		highlight: {
			background: baseColor || DEFAULT_NODE_COLOR,
			border: GRAPH_SELECTION_BORDER_COLOR,
		},
		hover: {
			background: baseColor || DEFAULT_NODE_COLOR,
			border: GRAPH_SELECTION_COLOR,
		},
	};
}

function selectedEdgeColor(baseColor) {
	return {
		color: baseColor || GRAPH_SELECTION_COLOR,
		highlight: GRAPH_SELECTION_COLOR,
		hover: GRAPH_SELECTION_COLOR,
	};
}

function HitlOperationLegend() {
	const entries = [
		{ color: HITL_OPERATION_COLORS.create, label: "Create" },
		{ color: HITL_OPERATION_COLORS.update, label: "Update" },
		{ color: HITL_OPERATION_COLORS.delete, label: "Delete" },
		{ color: HITL_CONTEXT_NODE_COLOR, label: "Context" },
	];

	return (
		<div class="hitl-operation-legend" aria-label="HITL graph colors">
			{/* <strong>HITL colors</strong> */}
			<div>
				{entries.map((entry) => (
					<span class="hitl-operation-item" key={entry.label}>
						<span
							class="hitl-operation-swatch"
							title={`${entry.label} color`}
							style={{ "--operation-color": entry.color }}
						/>
						{entry.label}
					</span>
				))}
			</div>
		</div>
	);
}

function hitlOperationEdgeStyle(relation, hasPendingHitl = false) {
	if (!relation.pendingHitl) {
		return {
			color: hasPendingHitl ? HITL_CONTEXT_EDGE_COLOR : "#65758a",
			highlightColor: GRAPH_SELECTION_COLOR,
			hoverColor: GRAPH_SELECTION_COLOR,
			dashes: false,
			width: NEOVIS_EDGE_SIZE,
		};
	}

	const operation = normalizedHitlOperation(relation.pendingOperation);
	const color = hitlOperationColor(operation);
	return {
		color,
		highlightColor: GRAPH_SELECTION_COLOR,
		hoverColor: GRAPH_SELECTION_COLOR,
		dashes: operation === "delete",
		width: HITL_PENDING_EDGE_WIDTH,
	};
}

function hitlNodeColor(node, fillColor, hasPendingHitl = false) {
	const contextColor = hasPendingHitl ? HITL_CONTEXT_NODE_COLOR : fillColor;

	if (!node.pendingHitl) {
		return contextColor || DEFAULT_NODE_COLOR;
	}

	const operationColor = hitlOperationColor(node.pendingOperation);
	return {
		background: operationColor,
		border: operationColor,
		highlight: {
			background: operationColor,
			border: GRAPH_SELECTION_BORDER_COLOR,
		},
		hover: {
			background: operationColor,
			border: GRAPH_SELECTION_COLOR,
		},
	};
}

function relationLabel(relation) {
	return String(relation ?? "relates_to").replaceAll("_", " ");
}

function graphNameFromId(id) {
	return String(id ?? "").replace(/^node:/i, "");
}

function safePipelineField(value) {
	return String(value ?? "").replaceAll("|", " ").trim();
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
	return String(line ?? "").split("|").map((part) => part.trim());
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

function displayNameFromIdentifier(value) {
	const text = String(value ?? "")
		.replace(/^node:/i, "")
		.trim();

	if (!text) {
		return "Unknown";
	}

	return text
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

function nodeReferenceKey(value) {
	return String(value ?? "")
		.replace(/^node:/i, "")
		.trim();
}

function operationVerb(operation, fallback = "Saved") {
	const normalized = String(operation ?? "").toLowerCase();

	if (normalized === "create") {
		return "Created";
	}

	if (normalized === "update") {
		return "Updated";
	}

	if (normalized === "delete") {
		return "Deleted";
	}

	return fallback;
}

function formatFileSize(bytes) {
	const size = Number(bytes) || 0;

	if (size < 1024) {
		return `${size} B`;
	}

	if (size < 1024 * 1024) {
		return `${(size / 1024).toFixed(1)} KB`;
	}

	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtension(file) {
	return String(file?.name ?? "")
		.split(".")
		.pop()
		?.toLowerCase() ?? "";
}

function fileKey(file) {
	return `${file?.name ?? ""}:${file?.size ?? 0}:${file?.lastModified ?? 0}`;
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

function clampNumber(value, min, max) {
	return Math.min(Math.max(value, min), max);
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

function normalizeGraph(graph) {
	return {
		nodes: graph?.nodes ?? [],
		relations: graph?.relations ?? [],
	};
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
	};
}

function createLinkCountByNodeId(nodes, relations) {
	const nodeIds = new Set((nodes ?? []).map((node) => node.id));
	const linkCountByNodeId = new Map((nodes ?? []).map((node) => [node.id, 0]));

	for (const relation of relations ?? []) {
		const sourceId = relation?.sourceId;
		const targetId = relation?.targetId;
		if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
			continue;
		}

		linkCountByNodeId.set(sourceId, (linkCountByNodeId.get(sourceId) ?? 0) + 1);
		if (targetId !== sourceId) {
			linkCountByNodeId.set(targetId, (linkCountByNodeId.get(targetId) ?? 0) + 1);
		}
	}

	return linkCountByNodeId;
}

function nodeSizeForLinkCount(linkCount, scale = 1) {
	const count = Math.max(0, Number(linkCount) || 0);
	const linkBonus = Math.min(Math.sqrt(count) * NODE_LINK_SIZE_STEP, NODE_LINK_SIZE_MAX_BONUS);
	return (DEFAULT_NODE_SIZE + linkBonus) * scale;
}

function replaceNode(graph, node) {
	const current = normalizeGraph(graph);
	const exists = current.nodes.some((entry) => entry.id === node.id);
	return {
		nodes: exists
			? current.nodes.map((entry) => entry.id === node.id ? node : entry)
			: [node, ...current.nodes],
		relations: current.relations,
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
	};
}

function removeNodeFromGraph(graph, nodeId) {
	const current = normalizeGraph(graph);
	return {
		nodes: current.nodes.filter((node) => node.id !== nodeId),
		relations: current.relations.filter((relation) => relation.sourceId !== nodeId && relation.targetId !== nodeId),
	};
}

function removeRelationFromGraph(graph, relationId) {
	const current = normalizeGraph(graph);
	return {
		nodes: current.nodes,
		relations: current.relations.filter((relation) => relation.id !== relationId),
	};
}

function getGraphSize(container) {
	const rect = container.getBoundingClientRect();
	return {
		width: Math.max(rect.width, 320),
		height: Math.max(rect.height, 320),
	};
}

function initialPosition(index, total, container) {
	const { width, height } = getGraphSize(container);
	const radius = Math.min(width, height) * 0.34;
	const scale = 1 / Math.max(width, height);
	const angle = (index / Math.max(total, 1)) * Math.PI * 2;

	return {
		x: (Math.cos(angle) * radius) * scale,
		y: (Math.sin(angle) * radius) * scale,
	};
}

function createGraphologyGraph(graph, container) {
	const normalized = normalizeGraph(graph);
	const hasPendingHitl = normalized.nodes.some((node) => node.pendingHitl)
		|| normalized.relations.some((relation) => relation.pendingHitl);
	const colorByType = createNodeTypeColorMap(normalized.nodes);
	const linkCountByNodeId = createLinkCountByNodeId(normalized.nodes, normalized.relations);
	const nextGraph = new Graph({ multi: true, type: "directed" });
	const edgeEndpointById = new Map();

	for (const [index, node] of normalized.nodes.entries()) {
		const position = initialPosition(index, normalized.nodes.length, container);
		const nodeFillColor = nodeColorFromTypeMap(node.type, colorByType);
		const nodeDisplayColor = node.pendingHitl
			? hitlOperationColor(node.pendingOperation)
			: (hasPendingHitl ? HITL_CONTEXT_NODE_COLOR : nodeFillColor);
		nextGraph.addNode(node.id, {
			x: position.x,
			y: position.y,
			size: nodeSizeForLinkCount(linkCountByNodeId.get(node.id)),
			label: truncate(node.label, 42),
			color: nodeDisplayColor,
			baseColor: nodeDisplayColor,
			typeColor: nodeFillColor,
			fullLabel: node.label,
			kgType: node.type,
			description: node.description,
			metadata: node.metadata,
			pendingHitl: Boolean(node.pendingHitl),
			pendingOperation: node.pendingOperation,
		});
	}

	for (const relation of normalized.relations) {
		if (!nextGraph.hasNode(relation.sourceId) || !nextGraph.hasNode(relation.targetId)) {
			continue;
		}

		edgeEndpointById.set(relation.id, {
			sourceId: relation.sourceId,
			targetId: relation.targetId,
		});
		const edgeStyle = hitlOperationEdgeStyle(relation, hasPendingHitl);
		nextGraph.mergeDirectedEdgeWithKey(relation.id, relation.sourceId, relation.targetId, {
			size: edgeStyle.width,
			label: truncate(relationLabel(relation.relation), 32),
			color: edgeStyle.color,
			baseColor: edgeStyle.color,
			labelColor: relation.pendingHitl
				? hitlOperationColor(relation.pendingOperation)
				: (hasPendingHitl ? "#cbd5e1" : "#f6ad55"),
			information: relation.information,
			description: relation.description,
			metadata: relation.metadata,
			pendingHitl: Boolean(relation.pendingHitl),
			pendingOperation: relation.pendingOperation,
			forceLabel: Boolean(relation.pendingHitl),
		});
	}

	indexParallelEdgesIndex(nextGraph);
	nextGraph.forEachEdge((edge, attributes) => {
		const parallelIndex = attributes.parallelIndex;
		if (Number.isFinite(parallelIndex)) {
			nextGraph.mergeEdgeAttributes(edge, {
				type: "curved",
				curvature: parallelIndex * 0.11,
			});
		}
	});

	forceLayout.assign(nextGraph, {
		maxIterations: normalized.nodes.length > 90 ? 220 : 320,
		settings: {
			attraction: 0.0008,
			repulsion: 0.18,
			gravity: 0.04,
			inertia: 0.6,
			maxMove: 12,
		},
	});

	return { graphologyGraph: nextGraph, edgeEndpointById };
}

function drawDarkNodeHover(context, data, settings) {
	const size = settings.labelSize;
	const font = settings.labelFont;
	const weight = settings.labelWeight;
	const padding = 5;
	const label = typeof data.label === "string" ? data.label : "";

	context.font = `${weight} ${size}px ${font}`;
	context.shadowOffsetX = 0;
	context.shadowOffsetY = 0;
	context.shadowBlur = 12;
	context.shadowColor = "rgba(0, 0, 0, 0.45)";
	context.fillStyle = "#111827";

	if (label) {
		const textWidth = context.measureText(label).width;
		const boxWidth = Math.round(textWidth + 12);
		const boxHeight = Math.round(size + padding * 2);
		const radius = Math.max(data.size, size / 2) + padding;
		const angleRadian = Math.asin(boxHeight / 2 / radius);
		const xDeltaCoord = Math.sqrt(Math.abs(radius ** 2 - (boxHeight / 2) ** 2));

		context.beginPath();
		context.moveTo(data.x + xDeltaCoord, data.y + boxHeight / 2);
		context.lineTo(data.x + radius + boxWidth, data.y + boxHeight / 2);
		context.lineTo(data.x + radius + boxWidth, data.y - boxHeight / 2);
		context.lineTo(data.x + xDeltaCoord, data.y - boxHeight / 2);
		context.arc(data.x, data.y, radius, angleRadian, -angleRadian);
		context.closePath();
		context.fill();
	} else {
		context.beginPath();
		context.arc(data.x, data.y, data.size + padding, 0, Math.PI * 2);
		context.closePath();
		context.fill();
	}

	context.shadowBlur = 0;
	context.fillStyle = data.color || "#2dd4bf";
	context.beginPath();
	context.arc(data.x, data.y, data.size, 0, Math.PI * 2);
	context.closePath();
	context.fill();

	if (label) {
		context.fillStyle = "#f8fafc";
		context.fillText(label, data.x + data.size + 9, data.y + size / 3);
	}
}

async function requestJson(url, options = {}) {
	const isFormData = options.body instanceof FormData;
	const headers = {
		...(isFormData ? {} : { "content-type": "application/json" }),
		...(options.headers ?? {}),
	};
	const response = await fetch(url, {
		...options,
		headers,
	});
	const body = await response.json().catch(() => ({}));

	if (!response.ok) {
		const error = new Error(body.error || `Request failed with status ${response.status}.`);
		error.status = response.status;
		error.url = url;
		throw error;
	}

	return body;
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

function neoVisInt(value) {
	return { low: Number(value) || 0, high: 0 };
}

function neoVisRecord(keys, fields) {
	return {
		keys,
		length: keys.length,
		_fields: fields,
		_fieldLookup: Object.fromEntries(keys.map((key, index) => [key, index])),
	};
}

function neoVisTitle(entries) {
	return entries
		.filter(([, value]) => String(value ?? "").trim())
		.map(([label, value]) => `${label}: ${value}`)
		.join("\n");
}

function neoVisNodeSortValue(node) {
	return String(node?.label || node?.name || node?.id || "").toLowerCase();
}

function compareNeoVisNodes(firstNode, secondNode) {
	return neoVisNodeSortValue(firstNode).localeCompare(neoVisNodeSortValue(secondNode))
		|| String(firstNode?.id ?? "").localeCompare(String(secondNode?.id ?? ""));
}

function neoVisCirclePosition(index, total) {
	const radius = clampNumber(total * 34, 220, 520);
	const angle = ((index / Math.max(total, 1)) * Math.PI * 2) - (Math.PI / 2);

	return {
		x: Math.cos(angle) * radius,
		y: Math.sin(angle) * radius,
	};
}

function createNeoVisGraphData(graph) {
	const normalized = normalizeGraph(graph);
	const hasPendingHitl = normalized.nodes.some((node) => node.pendingHitl)
		|| normalized.relations.some((relation) => relation.pendingHitl);
	const nodes = [...normalized.nodes].sort(compareNeoVisNodes);
	const colorByType = createNodeTypeColorMap(nodes);
	const linkCountByNodeId = createLinkCountByNodeId(nodes, normalized.relations);
	const nodeVisIdById = new Map();
	const nodeIdByVisId = new Map();
	const relationVisIdById = new Map();
	const relationIdByVisId = new Map();
	const edgeEndpointById = new Map();
	const edgeStyleByVisId = new Map();
	const fakeNodeById = new Map();
	const nodeStyleByVisId = new Map();

	nodes.forEach((node, index) => {
		const position = neoVisCirclePosition(index, nodes.length);
		const nodeFillColor = nodeColorFromTypeMap(node.type, colorByType);
		const nodeColor = hitlNodeColor(node, nodeFillColor, hasPendingHitl);
		const nodeDisplayColor = node.pendingHitl
			? hitlOperationColor(node.pendingOperation)
			: (hasPendingHitl ? HITL_CONTEXT_NODE_COLOR : nodeFillColor);
		nodeVisIdById.set(node.id, index);
		nodeIdByVisId.set(index, node.id);
		nodeStyleByVisId.set(index, {
			borderWidth: 0,
			borderWidthSelected: GRAPH_SELECTED_NODE_BORDER_WIDTH,
			baseColor: nodeDisplayColor,
			color: nodeColor,
			pendingHitl: Boolean(node.pendingHitl),
			pendingOperation: node.pendingOperation,
			shadow: false,
		});
		fakeNodeById.set(node.id, {
			identity: neoVisInt(index),
			labels: ["KnowledgeNode"],
			properties: {
				id: node.id,
				label: truncate(node.label, 42),
				name: node.name,
				type: node.type,
				description: node.description,
				metadata: node.metadata,
				size: nodeSizeForLinkCount(linkCountByNodeId.get(node.id), 1.12),
				borderWidth: 0,
				borderWidthSelected: GRAPH_SELECTED_NODE_BORDER_WIDTH,
				baseColor: nodeDisplayColor,
				color: nodeColor,
				pendingHitl: Boolean(node.pendingHitl),
				pendingOperation: node.pendingOperation,
				shadow: false,
				x: position.x,
				y: position.y,
				title: neoVisTitle([
					["Label", node.label],
					["Type", node.type],
					["Description", node.description],
					["Metadata", node.metadata],
					["HITL", node.pendingHitl ? `${node.pendingOperation || "pending"} by ${node.ingestedBy || "unknown"}` : ""],
				]),
			},
			elementId: `kg-node:${node.id}`,
		});
	});

	const records = nodes.map((node) => neoVisRecord(["node"], [fakeNodeById.get(node.id)]));
	let relationIndex = 0;
	for (const relation of normalized.relations) {
		const sourceVisId = nodeVisIdById.get(relation.sourceId);
		const targetVisId = nodeVisIdById.get(relation.targetId);
		const sourceNode = fakeNodeById.get(relation.sourceId);
		const targetNode = fakeNodeById.get(relation.targetId);
		if (sourceVisId === undefined || targetVisId === undefined || !sourceNode || !targetNode) {
			continue;
		}

		const relationVisId = relationIndex;
		relationIndex += 1;
		relationVisIdById.set(relation.id, relationVisId);
		relationIdByVisId.set(relationVisId, relation.id);
		edgeEndpointById.set(relation.id, {
			sourceId: relation.sourceId,
			targetId: relation.targetId,
		});
		const edgeStyle = hitlOperationEdgeStyle(relation, hasPendingHitl);
		edgeStyleByVisId.set(relationVisId, {
			color: {
				color: edgeStyle.color,
				highlight: edgeStyle.highlightColor,
				hover: edgeStyle.hoverColor,
			},
			dashes: edgeStyle.dashes,
			width: edgeStyle.width,
			font: {
				align: "middle",
				color: relation.pendingHitl
					? hitlOperationColor(relation.pendingOperation)
					: (hasPendingHitl ? "#cbd5e1" : "#f6ad55"),
				face: "Inter, sans-serif",
				size: 14,
				strokeWidth: 4,
				strokeColor: "#111827",
			},
		});

		records.push(neoVisRecord(["source", "relationship", "target"], [
			sourceNode,
			{
				identity: neoVisInt(relationVisId),
				start: neoVisInt(sourceVisId),
				end: neoVisInt(targetVisId),
				type: "RELATES_TO",
				properties: {
					id: relation.id,
					sourceId: relation.sourceId,
					targetId: relation.targetId,
					relation: relation.relation,
					label: truncate(relationLabel(relation.relation), 32),
					information: relation.information,
					description: relation.description,
					metadata: relation.metadata,
					width: edgeStyle.width,
					color: {
						color: edgeStyle.color,
						highlight: edgeStyle.highlightColor,
						hover: edgeStyle.hoverColor,
					},
					dashes: edgeStyle.dashes,
					font: {
						align: "middle",
						color: relation.pendingHitl
							? hitlOperationColor(relation.pendingOperation)
							: (hasPendingHitl ? "#cbd5e1" : "#f6ad55"),
						face: "Inter, sans-serif",
						size: 14,
						strokeWidth: 4,
						strokeColor: "#111827",
					},
					title: neoVisTitle([
						["Relation", relationLabel(relation.relation)],
						["Information", relation.information],
						["Description", relation.description],
						["Metadata", relation.metadata],
						["HITL", relation.pendingHitl ? `${relation.pendingOperation || "pending"} by ${relation.ingestedBy || "unknown"}` : ""],
					]),
				},
				elementId: `kg-rel:${relation.id}`,
				startNodeElementId: `kg-node:${relation.sourceId}`,
				endNodeElementId: `kg-node:${relation.targetId}`,
			},
			targetNode,
		]));
	}

	return {
		records,
		nodeVisIdById,
		nodeIdByVisId,
		relationVisIdById,
		relationIdByVisId,
		edgeEndpointById,
		edgeStyleByVisId,
		nodeStyleByVisId,
	};
}

function createNeoVisConfig(containerId, dataFunction) {
	return {
		containerId,
		dataFunction,
		groupAsLabel: false,
		labels: {
			KnowledgeNode: {
				label: "label",
				size: "size",
				title: "title",
				color: "color",
				borderWidth: "borderWidth",
				borderWidthSelected: "borderWidthSelected",
				shadow: "shadow",
				x: "x",
				y: "y",
			},
		},
		relationships: {
			RELATES_TO: {
				label: "label",
				width: "width",
				title: "title",
				color: "color",
				dashes: "dashes",
				font: "font",
			},
		},
		visConfig: {
			autoResize: true,
			nodes: {
				borderWidth: 0,
				color: {
					background: DEFAULT_NODE_COLOR,
					border: DEFAULT_NODE_COLOR,
					highlight: {
						background: "#f6ad55",
						border: "#f6ad55",
					},
					hover: {
						background: "#f6ad55",
						border: "#f6ad55",
					},
				},
				font: {
					color: "#edf2f7",
					face: "Inter, sans-serif",
					size: 14,
					strokeWidth: 5,
					strokeColor: "#111827",
				},
				shape: "dot",
			},
			edges: {
				arrowStrikethrough: true,
				arrows: {
					to: {
						enabled: true,
						scaleFactor: NEOVIS_ARROW_SCALE_FACTOR,
					},
				},
				color: {
					color: "#65758a",
					highlight: "#f6ad55",
					hover: "#f6ad55",
				},
				font: {
					align: "middle",
					color: "#f6ad55",
					face: "Inter, sans-serif",
					size: 14,
					strokeWidth: 4,
					strokeColor: "#111827",
				},
				smooth: {
					enabled: true,
					type: "dynamic",
					roundness: 0.18,
				},
				endPointOffset: {
					to: -2,
				},
				hoverWidth: 0.25,
				selectionWidth: 0.6,
				width: NEOVIS_EDGE_SIZE,
			},
			interaction: {
				hover: true,
				multiselect: false,
				navigationButtons: false,
				tooltipDelay: 160,
			},
			layout: {
				improvedLayout: false,
				randomSeed: 12,
			},
			physics: {
				adaptiveTimestep: true,
				solver: "forceAtlas2Based",
				stabilization: {
					enabled: false,
				},
			},
		},
	};
}

function getNeoVisNodeId(event, graphData) {
	return event?.node?.raw?.properties?.id ?? graphData.nodeIdByVisId.get(Number(event?.nodeId));
}

function getNeoVisRelationId(event, graphData) {
	return event?.edge?.raw?.properties?.id ?? graphData.relationIdByVisId.get(Number(event?.edgeId));
}

function applyNeoVisOperationStyles(visualization, graphData) {
	if (!visualization || !graphData) {
		return;
	}

	const nodeUpdates = [...graphData.nodeStyleByVisId.entries()].map(([id, style]) => ({
		id,
		...style,
	}));
	const edgeUpdates = [...graphData.edgeStyleByVisId.entries()].map(([id, style]) => ({
		id,
		...style,
	}));

	if (nodeUpdates.length > 0) {
		visualization.nodes?.update?.(nodeUpdates);
	}
	if (edgeUpdates.length > 0) {
		visualization.edges?.update?.(edgeUpdates);
	}
	visualization.network?.redraw?.();
}

function nodeBackgroundColor(style) {
	if (style?.baseColor) {
		return style.baseColor;
	}

	const color = style?.color;
	if (typeof color === "string") {
		return color;
	}

	return color?.background || color?.color || DEFAULT_NODE_COLOR;
}

function edgeBaseColor(style) {
	const color = style?.color;
	if (typeof color === "string") {
		return color;
	}

	return color?.color || "#65758a";
}

function selectedNeoVisNodeStyle(style) {
	const baseColor = nodeBackgroundColor(style);
	const borderWidth = Math.max(
		Number(style?.borderWidth) || 0,
		GRAPH_SELECTED_NODE_BORDER_WIDTH,
	);

	return {
		...style,
		borderWidth,
		borderWidthSelected: borderWidth + 1,
		color: selectedNodeColor(baseColor),
		shadow: false,
	};
}

function selectedNeoVisEdgeStyle(style) {
	const width = Math.max(Number(style?.width) || NEOVIS_EDGE_SIZE, HITL_PENDING_EDGE_WIDTH) + 1.4;
	return {
		...style,
		color: selectedEdgeColor(edgeBaseColor(style)),
		width,
		font: {
			...(style?.font ?? {}),
			color: GRAPH_SELECTION_COLOR,
			strokeWidth: Math.max(Number(style?.font?.strokeWidth) || 0, 5),
			strokeColor: "#020617",
		},
	};
}

function dimmedNeoVisNodeStyle(style) {
	return {
		...style,
		borderWidth: 0,
		borderWidthSelected: 0,
		color: {
			...(typeof style?.color === "object" && style.color !== null ? style.color : {}),
			background: GRAPH_SELECTION_DIM_NODE_COLOR,
			border: GRAPH_SELECTION_DIM_NODE_COLOR,
			highlight: {
				background: GRAPH_SELECTION_DIM_NODE_COLOR,
				border: GRAPH_SELECTION_DIM_NODE_COLOR,
			},
			hover: {
				background: GRAPH_SELECTION_DIM_NODE_COLOR,
				border: GRAPH_SELECTION_DIM_NODE_COLOR,
			},
		},
		shadow: false,
	};
}

function dimmedNeoVisEdgeStyle(style) {
	const width = Math.max(0.8, (Number(style?.width) || NEOVIS_EDGE_SIZE) * 0.72);
	return {
		...style,
		color: {
			...(typeof style?.color === "object" && style.color !== null ? style.color : {}),
			color: GRAPH_SELECTION_DIM_EDGE_COLOR,
			highlight: GRAPH_SELECTION_DIM_EDGE_COLOR,
			hover: GRAPH_SELECTION_DIM_EDGE_COLOR,
		},
		width,
		font: {
			...(style?.font ?? {}),
			color: "#64748b",
			strokeColor: "#020617",
			strokeWidth: 2,
		},
		shadow: false,
	};
}

function applyNeoVisSelectionStyles(visualization, graphData, selectedNodeVisIds, selectedRelationVisIds) {
	if (!visualization || !graphData) {
		return;
	}

	const hasActiveFocus = selectedNodeVisIds.size > 0 || selectedRelationVisIds.size > 0;
	const nodeUpdates = [...graphData.nodeStyleByVisId.entries()].map(([id, style]) => ({
		id,
		...(selectedNodeVisIds.has(id)
			? selectedNeoVisNodeStyle(style)
			: hasActiveFocus
				? dimmedNeoVisNodeStyle(style)
				: style),
	}));
	const edgeUpdates = [...graphData.edgeStyleByVisId.entries()].map(([id, style]) => ({
		id,
		...(selectedRelationVisIds.has(id)
			? selectedNeoVisEdgeStyle(style)
			: hasActiveFocus
				? dimmedNeoVisEdgeStyle(style)
				: style),
	}));

	if (nodeUpdates.length > 0) {
		visualization.nodes?.update?.(nodeUpdates);
	}
	if (edgeUpdates.length > 0) {
		visualization.edges?.update?.(edgeUpdates);
	}
	visualization.network?.redraw?.();
}

function syncNeoVisSelection(visualization, graphData, focusedItem, highlightNodeIds, highlightRelationIds, options = {}) {
	const network = visualization?.network;
	if (!network || !graphData) {
		return;
	}

	const focusCamera = options.focusCamera ?? true;
	const selectedNodeVisIds = new Set(
		(highlightNodeIds ?? [])
			.map((nodeId) => graphData.nodeVisIdById.get(nodeId))
			.filter((nodeId) => nodeId !== undefined),
	);
	const selectedRelationVisIds = new Set(
		(highlightRelationIds ?? [])
			.map((relationId) => graphData.relationVisIdById.get(relationId))
			.filter((relationId) => relationId !== undefined),
	);

	function addConnectedNeighborhood(nodeId) {
		for (const [relationId, endpoints] of graphData.edgeEndpointById.entries()) {
			if (endpoints.sourceId !== nodeId && endpoints.targetId !== nodeId) {
				continue;
			}

			const relationVisId = graphData.relationVisIdById.get(relationId);
			if (relationVisId !== undefined) {
				selectedRelationVisIds.add(relationVisId);
			}

			const neighborId = endpoints.sourceId === nodeId ? endpoints.targetId : endpoints.sourceId;
			const neighborVisId = graphData.nodeVisIdById.get(neighborId);
			if (neighborVisId !== undefined) {
				selectedNodeVisIds.add(neighborVisId);
			}
		}
	}

	for (const nodeId of highlightNodeIds ?? []) {
		addConnectedNeighborhood(nodeId);
	}

	if (focusedItem?.type === "node") {
		const nodeVisId = graphData.nodeVisIdById.get(focusedItem.id);
		if (nodeVisId !== undefined) {
			selectedNodeVisIds.add(nodeVisId);
			addConnectedNeighborhood(focusedItem.id);
			if (focusCamera && !focusedItem.skipCamera) {
				network.focus(nodeVisId, {
					animation: { duration: 420, easingFunction: "easeInOutQuad" },
					scale: NEOVIS_NODE_FOCUS_SCALE,
				});
			}
		}
	} else if (focusedItem?.type === "relation") {
		const relationVisId = graphData.relationVisIdById.get(focusedItem.id);
		if (relationVisId !== undefined) {
			selectedRelationVisIds.add(relationVisId);
		}

		const endpoints = graphData.edgeEndpointById.get(focusedItem.id);
		const endpointVisIds = endpoints
			? [endpoints.sourceId, endpoints.targetId]
				.map((nodeId) => graphData.nodeVisIdById.get(nodeId))
				.filter((nodeId) => nodeId !== undefined)
			: [];
		for (const nodeVisId of endpointVisIds) {
			selectedNodeVisIds.add(nodeVisId);
		}
		if (focusCamera && endpointVisIds.length > 0) {
			network.fit({
				animation: { duration: 420, easingFunction: "easeInOutQuad" },
				nodes: endpointVisIds,
			});
		}
	}

	network.setSelection({
		nodes: [...selectedNodeVisIds],
		edges: [...selectedRelationVisIds],
	}, {
		highlightEdges: true,
		unselectAll: true,
	});
	applyNeoVisSelectionStyles(visualization, graphData, selectedNodeVisIds, selectedRelationVisIds);
}

function findNodeNearViewportPoint({ graphologyGraph, point, renderer }) {
	if (!renderer || !graphologyGraph || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
		return null;
	}

	const displayedLabels = renderer.getNodeDisplayedLabels?.() ?? new Set();
	const labelsCanvas = renderer.getCanvases?.().labels;
	const labelsContext = labelsCanvas?.getContext?.("2d");
	const settings = renderer.getSettings?.() ?? {};
	const labelSize = settings.labelSize ?? 12;
	const labelWeight = settings.labelWeight ?? "normal";
	const labelFont = settings.labelFont ?? "Arial";
	if (labelsContext) {
		labelsContext.font = `${labelWeight} ${labelSize}px ${labelFont}`;
	}

	let bestNodeId = null;
	let bestDistance = Infinity;
	graphologyGraph.forEachNode((nodeId, attributes) => {
		if (!Number.isFinite(attributes?.x) || !Number.isFinite(attributes?.y)) {
			return;
		}

		const displayData = renderer.getNodeDisplayData(nodeId) ?? attributes;
		if (displayData.hidden) {
			return;
		}

		const viewportPosition = renderer.graphToViewport({ x: attributes.x, y: attributes.y });
		const nodeSize = renderer.scaleSize?.(displayData.size ?? attributes.size ?? 8) ?? (displayData.size ?? attributes.size ?? 8);
		const nodeDistance = Math.hypot(point.x - viewportPosition.x, point.y - viewportPosition.y);
		if (nodeDistance <= Math.max(nodeSize + 10, 18) && nodeDistance < bestDistance) {
			bestNodeId = nodeId;
			bestDistance = nodeDistance;
		}

		const label = displayData.label ?? attributes.label;
		if (!label || (!displayedLabels.has(nodeId) && !displayData.highlighted)) {
			return;
		}

		const labelText = String(label);
		const labelWidth = labelsContext?.measureText(labelText).width ?? labelText.length * labelSize * 0.58;
		const labelLeft = viewportPosition.x + nodeSize + 3;
		const labelRight = labelLeft + labelWidth + 16;
		const labelTop = viewportPosition.y - labelSize - 3;
		const labelBottom = viewportPosition.y + labelSize + 3;
		const insideLabel = point.x >= labelLeft && point.x <= labelRight && point.y >= labelTop && point.y <= labelBottom;
		if (insideLabel && nodeDistance < bestDistance) {
			bestNodeId = nodeId;
			bestDistance = nodeDistance;
		}
	});

	return bestNodeId;
}

function bindInteractionHandlers({
	centerCameraOnNode,
	draggedNodeRef,
	graphologyGraphRef,
	hoveredNodeIdRef,
	onFocus,
	onOpenItem,
	pinnedNodeIdRef,
	renderer,
	syncHighlightSettings,
}) {
	renderer.on("enterNode", (event) => {
		hoveredNodeIdRef.current = event.node;
		syncHighlightSettings();
	});

	renderer.on("leaveNode", () => {
		hoveredNodeIdRef.current = null;
		syncHighlightSettings();
	});

	let pendingNodeSelection = null;
	const selectionDelay = renderer.getSetting("doubleClickTimeout") ?? 300;

	function clearPendingNodeSelection() {
		if (pendingNodeSelection) {
			window.clearTimeout(pendingNodeSelection);
			pendingNodeSelection = null;
		}
	}

	function focusNode(nodeId) {
		pinnedNodeIdRef.current = nodeId;
		onFocus({ type: "node", id: nodeId });
		syncHighlightSettings();
	}

	function selectNode(nodeId) {
		focusNode(nodeId);
		window.requestAnimationFrame(() => centerCameraOnNode(nodeId));
	}

	function scheduleNodeSelection(nodeId) {
		clearPendingNodeSelection();
		pendingNodeSelection = window.setTimeout(() => {
			pendingNodeSelection = null;
			selectNode(nodeId);
		}, selectionDelay);
	}

	renderer.on("clickNode", (event) => {
		event.preventSigmaDefault();
		scheduleNodeSelection(event.node);
	});

	renderer.on("clickEdge", (event) => {
		clearPendingNodeSelection();
		pinnedNodeIdRef.current = null;
		event.preventSigmaDefault();
		onFocus({ type: "relation", id: event.edge });
		syncHighlightSettings();
	});

	renderer.on("doubleClickNode", (event) => {
		clearPendingNodeSelection();
		event.preventSigmaDefault();
		pinnedNodeIdRef.current = event.node;
		onOpenItem({ type: "node", id: event.node, skipCamera: true });
		syncHighlightSettings();
	});

	renderer.on("doubleClickEdge", (event) => {
		clearPendingNodeSelection();
		pinnedNodeIdRef.current = null;
		event.preventSigmaDefault();
		onFocus({ type: "relation", id: event.edge });
		onOpenItem({ type: "relation", id: event.edge });
		syncHighlightSettings();
	});

	renderer.on("clickStage", (event) => {
		const graphologyGraph = graphologyGraphRef.current;
		const nodeId = findNodeNearViewportPoint({
			graphologyGraph,
			point: event.event,
			renderer,
		});

		if (nodeId) {
			event.preventSigmaDefault();
			scheduleNodeSelection(nodeId);
			return;
		}

		clearPendingNodeSelection();
		pinnedNodeIdRef.current = null;
		onFocus(null);
		syncHighlightSettings();
	});

	renderer.on("doubleClickStage", (event) => {
		const graphologyGraph = graphologyGraphRef.current;
		const nodeId = findNodeNearViewportPoint({
			graphologyGraph,
			point: event.event,
			renderer,
		});

		if (!nodeId) {
			return;
		}

		clearPendingNodeSelection();
		event.preventSigmaDefault();
		pinnedNodeIdRef.current = nodeId;
		onOpenItem({ type: "node", id: nodeId, skipCamera: true });
		syncHighlightSettings();
	});

	renderer.on("downNode", (event) => {
		draggedNodeRef.current = event.node;
		event.preventSigmaDefault();
		renderer.setSetting("enableCameraPanning", false);
	});

	renderer.getMouseCaptor().on("mousemovebody", (event) => {
		const draggedNode = draggedNodeRef.current;
		const graphologyGraph = graphologyGraphRef.current;
		if (!draggedNode || !graphologyGraph) {
			return;
		}

		const position = renderer.viewportToGraph({ x: event.x, y: event.y });
		graphologyGraph.mergeNodeAttributes(draggedNode, position);
		renderer.refresh({ partialGraph: { nodes: [draggedNode] }, skipIndexation: true });
	});

	renderer.getMouseCaptor().on("mouseup", () => {
		if (!draggedNodeRef.current) {
			return;
		}

		draggedNodeRef.current = null;
		renderer.setSetting("enableCameraPanning", true);
		renderer.refresh();
	});

	return clearPendingNodeSelection;
}

function GraphRendererToggle({ onRendererMode, rendererMode }) {
	return (
		<div class="renderer-toggle" aria-label="Graph renderer" role="group">
			<button
				type="button"
				class={rendererMode === GRAPH_RENDERERS.sigma ? "active" : ""}
				onClick={() => onRendererMode(GRAPH_RENDERERS.sigma)}
			>
				Sigma
			</button>
			<button
				type="button"
				class={rendererMode === GRAPH_RENDERERS.neovis ? "active" : ""}
				onClick={() => onRendererMode(GRAPH_RENDERERS.neovis)}
			>
				NeoVis
			</button>
		</div>
	);
}

function normalizedRoutePath(pathname = window.location.pathname) {
	return pathname.replace(/\/+$/, "") || "/";
}

function RouteSwitcher() {
	const currentPath = normalizedRoutePath();
	const activeRoute = APP_ROUTES.find((route) => route.href === currentPath) ?? APP_ROUTES[0];
	const renderRouteLinks = () => APP_ROUTES.map((route) => (
		<a
			class={`route-switcher-link${route.href === activeRoute.href ? " active" : ""}`}
			href={route.href}
			key={route.href}
			aria-current={route.href === activeRoute.href ? "page" : undefined}
		>
			{route.label}
		</a>
	));

	return (
		<nav class="route-switcher" aria-label="Workspace navigation">
			<div class="route-switcher-links">
				{renderRouteLinks()}
			</div>
			<details class="route-switcher-menu">
				<summary>{activeRoute.label}</summary>
				<div>
					{renderRouteLinks()}
				</div>
			</details>
		</nav>
	);
}

function GraphPanelHeader({ onReload, onRendererMode, rendererMode, statsText }) {
	return (
		<header class="panel-header graph-header">
			<div>
				<p class="eyebrow">Knowledge Graph</p>
				<h1 id="graph-title">Graph preview</h1>
			</div>
			<div class="header-actions">
				<GraphRendererToggle onRendererMode={onRendererMode} rendererMode={rendererMode} />
				<button type="button" class="compact-button" onClick={onReload}>Reload</button>
				<div class="graph-stats">{statsText}</div>
			</div>
		</header>
	);
}

function GraphPreview({
	actionPanel,
	focusedItem,
	graph,
	highlightNodeIds,
	highlightRelationIds,
	onFocus,
	onOpenItem,
	onReload,
	onRendererMode,
	rendererMode,
	searchPanel,
	statsText,
}) {
	const containerRef = useRef(null);
	const draggedNodeRef = useRef(null);
	const edgeEndpointByIdRef = useRef(new Map());
	const graphologyGraphRef = useRef(new Graph({ multi: true, type: "directed" }));
	const hoveredNodeIdRef = useRef(null);
	const pinnedNodeIdRef = useRef(null);
	const rendererRef = useRef(null);
	const resultNodeIdsRef = useRef(new Set());
	const resultRelationIdsRef = useRef(new Set());
	const focusedItemRef = useRef(null);
	const normalizedGraph = useMemo(() => normalizeGraph(graph), [graph]);

	const centerCameraOnNode = useCallback((nodeId) => {
		const renderer = rendererRef.current;
		const graphologyGraph = graphologyGraphRef.current;
		if (!renderer || !graphologyGraph?.hasNode(nodeId)) {
			return false;
		}

		renderer.resize();
		renderer.refresh();

		const camera = renderer.getCamera();
		const cameraState = camera.getState();
		const nodeAttributes = graphologyGraph.getNodeAttributes(nodeId);
		if (!Number.isFinite(nodeAttributes?.x) || !Number.isFinite(nodeAttributes?.y)) {
			return false;
		}

		const nodeViewportPosition = renderer.graphToViewport({
			x: nodeAttributes.x,
			y: nodeAttributes.y,
		});
		const framedNodePosition = renderer.viewportToFramedGraph(nodeViewportPosition);
		const targetRatio = camera.getBoundedRatio(Math.min(cameraState.ratio, 0.45));

		camera.animate({
			x: framedNodePosition.x,
			y: framedNodePosition.y,
			ratio: targetRatio,
			angle: cameraState.angle,
		}, { duration: 420 });

		return true;
	}, []);

	const syncHighlightSettings = useCallback(() => {
		const renderer = rendererRef.current;
		const graphologyGraph = graphologyGraphRef.current;
		if (!renderer || !graphologyGraph) {
			return;
		}

		const focused = focusedItemRef.current;
		const activeNodeId = pinnedNodeIdRef.current || hoveredNodeIdRef.current || (focused?.type === "node" ? focused.id : null);
		const focusNodeIds = new Set(resultNodeIdsRef.current);
		const focusRelationIds = new Set(resultRelationIdsRef.current);

		if (focused?.type === "relation") {
			focusRelationIds.add(focused.id);
			const endpoints = edgeEndpointByIdRef.current.get(focused.id);
			if (endpoints) {
				focusNodeIds.add(endpoints.sourceId);
				focusNodeIds.add(endpoints.targetId);
			}
		}

		if (activeNodeId && graphologyGraph.hasNode(activeNodeId)) {
			focusNodeIds.add(activeNodeId);
			for (const neighbor of graphologyGraph.neighbors(activeNodeId)) {
				focusNodeIds.add(neighbor);
			}
		}

		const hasFocus = focusNodeIds.size > 0 || focusRelationIds.size > 0;
		renderer.setSetting("nodeReducer", (node, data) => {
			const isFocused = focusNodeIds.has(node);
			const baseColor = data.baseColor || data.color || DEFAULT_NODE_COLOR;

			if (!hasFocus) {
				return data;
			}

			return {
				...data,
				color: isFocused
					? (data.pendingHitl ? baseColor : GRAPH_SELECTION_COLOR)
					: (data.pendingHitl ? baseColor : GRAPH_SELECTION_DIM_NODE_COLOR),
				size: isFocused
					? (data.size ?? DEFAULT_NODE_SIZE) + NODE_FOCUS_SIZE_DELTA
					: Math.max((data.size ?? DEFAULT_NODE_SIZE) - NODE_FOCUS_SIZE_DELTA, SIGMA_DIMMED_NODE_MIN_SIZE),
				highlighted: isFocused,
				label: isFocused ? data.label : "",
			};
		});
		renderer.setSetting("edgeReducer", (edge, data) => {
			const endpoints = edgeEndpointByIdRef.current.get(edge);
			const touchesActiveNode = Boolean(activeNodeId && endpoints && (
				endpoints.sourceId === activeNodeId || endpoints.targetId === activeNodeId
			));
			const isFocused = focusRelationIds.has(edge) || touchesActiveNode;
			const baseColor = data.baseColor || data.color || "#65758a";

			if (!hasFocus) {
				return data;
			}

			return {
				...data,
				color: isFocused
					? (data.pendingHitl ? baseColor : GRAPH_SELECTION_COLOR)
					: (data.pendingHitl ? baseColor : GRAPH_SELECTION_DIM_EDGE_COLOR),
				size: isFocused ? (data.size ?? SIGMA_EDGE_SIZE) + 1.8 : SIGMA_DIMMED_EDGE_SIZE,
				labelColor: isFocused ? GRAPH_SELECTION_COLOR : data.labelColor,
				label: isFocused ? data.label : "",
			};
		});
		renderer.refresh();
	}, []);

	useEffect(() => {
		resultNodeIdsRef.current = new Set(highlightNodeIds);
		resultRelationIdsRef.current = new Set(highlightRelationIds);
		syncHighlightSettings();
	}, [highlightNodeIds, highlightRelationIds, syncHighlightSettings]);

	useEffect(() => {
		focusedItemRef.current = focusedItem;
		pinnedNodeIdRef.current = focusedItem?.type === "node" ? focusedItem.id : null;

		if (focusedItem?.type === "node" && !focusedItem.skipCamera) {
			window.requestAnimationFrame(() => centerCameraOnNode(focusedItem.id));
		}

		syncHighlightSettings();
	}, [centerCameraOnNode, focusedItem, syncHighlightSettings]);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) {
			return undefined;
		}

		draggedNodeRef.current = null;
		hoveredNodeIdRef.current = null;

		if (rendererRef.current) {
			rendererRef.current.kill();
			rendererRef.current = null;
		}

		container.replaceChildren();
		graphologyGraphRef.current = new Graph({ multi: true, type: "directed" });
		edgeEndpointByIdRef.current = new Map();

		if (normalizedGraph.nodes.length === 0) {
			return undefined;
		}

		const { graphologyGraph, edgeEndpointById } = createGraphologyGraph(normalizedGraph, container);
		graphologyGraphRef.current = graphologyGraph;
		edgeEndpointByIdRef.current = edgeEndpointById;

		const renderer = new Sigma(graphologyGraph, container, {
			allowInvalidContainer: true,
			autoCenter: true,
			autoRescale: true,
			doubleClickZoomingRatio: 1,
			defaultEdgeColor: "#65758a",
			defaultEdgeType: "arrow",
			defaultNodeColor: DEFAULT_NODE_COLOR,
			defaultDrawNodeHover: drawDarkNodeHover,
			enableEdgeEvents: true,
			labelColor: { color: "#edf2f7" },
			labelDensity: 0.12,
			labelRenderedSizeThreshold: 3,
			labelSize: 12,
			renderEdgeLabels: true,
			edgeLabelColor: { attribute: "labelColor", color: "#f6ad55" },
			edgeLabelSize: 14,
			edgeProgramClasses: {
				arrow: LargeArrowProgram,
				curved: LargeCurvedArrowProgram,
			},
			hideEdgesOnMove: false,
			hideLabelsOnMove: false,
		});
		rendererRef.current = renderer;
		const clearInteractionState = bindInteractionHandlers({
			centerCameraOnNode,
			draggedNodeRef,
			graphologyGraphRef,
			hoveredNodeIdRef,
			onFocus,
			onOpenItem,
			pinnedNodeIdRef,
			renderer,
			syncHighlightSettings,
		});
		syncHighlightSettings();

		if (focusedItemRef.current?.type === "node" && !focusedItemRef.current.skipCamera) {
			window.requestAnimationFrame(() => centerCameraOnNode(focusedItemRef.current.id));
		}

		return () => {
			clearInteractionState();
			if (rendererRef.current === renderer) {
				rendererRef.current = null;
			}
			renderer.kill();
		};
	}, [centerCameraOnNode, normalizedGraph, onFocus, onOpenItem, syncHighlightSettings]);

	useEffect(() => {
		function handleResize() {
			const renderer = rendererRef.current;
			if (renderer) {
				renderer.resize();
				renderer.refresh();
			}
		}

		window.addEventListener("resize", handleResize);
		return () => window.removeEventListener("resize", handleResize);
	}, []);

	return (
		<section class="graph-panel" aria-labelledby="graph-title">
			<GraphPanelHeader
				onReload={onReload}
				onRendererMode={onRendererMode}
				rendererMode={rendererMode}
				statsText={statsText}
			/>
			{searchPanel}
			<div class="graph-stage">
				<div id="graph-container" ref={containerRef} role="img" aria-label="Knowledge graph preview"></div>
				<div class="empty-state" hidden={normalizedGraph.nodes.length > 0}>
					<h2>No graph data yet</h2>
					<p>Ingest text from the chat panel to populate the preview.</p>
				</div>
				{actionPanel}
			</div>
		</section>
	);
}

function NeoVisGraphPreview({
	actionPanel,
	focusedItem,
	graph,
	highlightNodeIds,
	highlightRelationIds,
	onFocus,
	onOpenItem,
	onReload,
	onRendererMode,
	rendererMode,
	searchPanel,
	statsText,
}) {
	const containerIdRef = useRef(`neovis-graph-${Math.random().toString(36).slice(2)}`);
	const graphDataRef = useRef(null);
	const focusStateRef = useRef({ focusedItem, highlightNodeIds, highlightRelationIds });
	const neoVisRef = useRef(null);
	const [renderStatus, setRenderStatus] = useState("");
	const normalizedGraph = useMemo(() => normalizeGraph(graph), [graph]);
	const neoVisGraphData = useMemo(() => createNeoVisGraphData(normalizedGraph), [normalizedGraph]);

	useEffect(() => {
		graphDataRef.current = neoVisGraphData;
	}, [neoVisGraphData]);

	useEffect(() => {
		focusStateRef.current = { focusedItem, highlightNodeIds, highlightRelationIds };
	}, [focusedItem, highlightNodeIds, highlightRelationIds]);

	useEffect(() => {
		const container = document.getElementById(containerIdRef.current);
		if (!container) {
			return undefined;
		}

		if (neoVisRef.current?.network) {
			neoVisRef.current.network.destroy();
		}
		neoVisRef.current?.clearNetwork?.();
		neoVisRef.current = null;
		container.replaceChildren();

		if (normalizedGraph.nodes.length === 0) {
			setRenderStatus("");
			return undefined;
		}

		let isActive = true;
		setRenderStatus("Loading NeoVis...");
		const visualization = new NeoVis(createNeoVisConfig(containerIdRef.current, () => neoVisGraphData.records));
		neoVisRef.current = visualization;
		const clickDelay = 260;
		const doubleClickDelay = 360;
		let pendingClickTimer = null;
		let lastEdgeClick = { relationId: "", time: 0 };

		function clearPendingClick() {
			if (pendingClickTimer) {
				window.clearTimeout(pendingClickTimer);
				pendingClickTimer = null;
			}
		}

		function scheduleFocus(item) {
			clearPendingClick();
			pendingClickTimer = window.setTimeout(() => {
				pendingClickTimer = null;
				onFocus(item);
			}, clickDelay);
		}

		function suppressNativeEvent(params) {
			params?.event?.preventDefault?.();
			params?.event?.srcEvent?.preventDefault?.();
			params?.event?.srcEvent?.stopPropagation?.();
		}

		function previewSelection(item) {
			syncNeoVisSelection(visualization, graphDataRef.current, item, [], [], { focusCamera: false });
		}

		function restoreSelection() {
			const focusState = focusStateRef.current;
			syncNeoVisSelection(
				visualization,
				graphDataRef.current,
				focusState.focusedItem,
				focusState.highlightNodeIds,
				focusState.highlightRelationIds,
				{ focusCamera: false },
			);
		}

		function handleClickNode(event) {
			const nodeId = getNeoVisNodeId(event, graphDataRef.current);
			if (nodeId) {
				lastEdgeClick = { relationId: "", time: 0 };
				previewSelection({ type: "node", id: nodeId, skipCamera: true });
				scheduleFocus({ type: "node", id: nodeId });
			}
		}

		function handleClickEdge(event) {
			const relationId = getNeoVisRelationId(event, graphDataRef.current);
			if (relationId) {
				const now = window.performance.now();
				const isDoubleClick = lastEdgeClick.relationId === relationId && now - lastEdgeClick.time <= doubleClickDelay;
				lastEdgeClick = { relationId, time: now };
				previewSelection({ type: "relation", id: relationId });
				if (isDoubleClick) {
					clearPendingClick();
					onFocus({ type: "relation", id: relationId });
					onOpenItem({ type: "relation", id: relationId });
					return;
				}
				scheduleFocus({ type: "relation", id: relationId });
			}
		}

		function bindNetworkEvents() {
			const network = visualization.network;
			if (!network) {
				return () => {};
			}

			const handleClickStage = (params) => {
				if ((params.nodes?.length ?? 0) === 0 && (params.edges?.length ?? 0) === 0) {
					lastEdgeClick = { relationId: "", time: 0 };
					previewSelection(null);
					scheduleFocus(null);
				}
			};
			const handleDoubleClick = (params) => {
				clearPendingClick();
				suppressNativeEvent(params);
				const graphData = graphDataRef.current;
				const nodeVisId = params.nodes?.[0];
				if (nodeVisId !== undefined) {
					const nodeId = graphData?.nodeIdByVisId.get(Number(nodeVisId));
					if (nodeId) {
						onOpenItem({ type: "node", id: nodeId, skipCamera: true });
					}
					return;
				}

				const relationVisId = params.edges?.[0];
				if (relationVisId !== undefined) {
					const relationId = graphData?.relationIdByVisId.get(Number(relationVisId));
					if (relationId) {
						onFocus({ type: "relation", id: relationId });
						onOpenItem({ type: "relation", id: relationId });
					}
				}
			};
			const handleHoverNode = (params) => {
				const nodeId = graphDataRef.current?.nodeIdByVisId.get(Number(params.node));
				if (nodeId) {
					previewSelection({ type: "node", id: nodeId, skipCamera: true });
				}
			};
			const handleBlurNode = () => {
				restoreSelection();
			};
			const handleHoverEdge = (params) => {
				const relationId = graphDataRef.current?.relationIdByVisId.get(Number(params.edge));
				if (relationId) {
					previewSelection({ type: "relation", id: relationId });
				}
			};
			const handleBlurEdge = () => {
				restoreSelection();
			};

			network.on("click", handleClickStage);
			network.on("doubleClick", handleDoubleClick);
			network.on("hoverNode", handleHoverNode);
			network.on("blurNode", handleBlurNode);
			network.on("hoverEdge", handleHoverEdge);
			network.on("blurEdge", handleBlurEdge);
			return () => {
				network.off("click", handleClickStage);
				network.off("doubleClick", handleDoubleClick);
				network.off("hoverNode", handleHoverNode);
				network.off("blurNode", handleBlurNode);
				network.off("hoverEdge", handleHoverEdge);
				network.off("blurEdge", handleBlurEdge);
			};
		}

		let clearNetworkEvents = () => {};
		visualization.registerOnEvent("clickNode", handleClickNode);
		visualization.registerOnEvent("clickEdge", handleClickEdge);
		visualization.registerOnEvent("completed", () => {
			if (!isActive) {
				return;
			}
			setRenderStatus("");
			clearNetworkEvents = bindNetworkEvents();
			applyNeoVisOperationStyles(visualization, neoVisGraphData);
			const focusState = focusStateRef.current;
			if (!focusState.focusedItem) {
				visualization.network?.fit?.({ animation: false });
			}
			syncNeoVisSelection(
				visualization,
				neoVisGraphData,
				focusState.focusedItem,
				focusState.highlightNodeIds,
				focusState.highlightRelationIds,
			);
		});
		visualization.registerOnEvent("error", ({ error }) => {
			if (isActive) {
				setRenderStatus(error?.message || "NeoVis render failed.");
			}
		});
		visualization.render();

		return () => {
			isActive = false;
			clearPendingClick();
			clearNetworkEvents();
			if (neoVisRef.current === visualization) {
				neoVisRef.current = null;
			}
			visualization.network?.destroy?.();
			visualization.clearNetwork?.();
		};
	}, [neoVisGraphData, normalizedGraph.nodes.length, onFocus, onOpenItem]);

	useEffect(() => {
		syncNeoVisSelection(neoVisRef.current, neoVisGraphData, focusedItem, highlightNodeIds, highlightRelationIds);
	}, [focusedItem, highlightNodeIds, highlightRelationIds, neoVisGraphData]);

	return (
		<section class="graph-panel" aria-labelledby="graph-title">
			<GraphPanelHeader
				onReload={onReload}
				onRendererMode={onRendererMode}
				rendererMode={rendererMode}
				statsText={statsText}
			/>
			{searchPanel}
			<div class="graph-stage">
				<div
					id={containerIdRef.current}
					class="neovis-container"
					role="img"
					aria-label="NeoVis knowledge graph preview"
				/>
				<div class="empty-state" hidden={normalizedGraph.nodes.length > 0}>
					<h2>No graph data yet</h2>
					<p>Ingest text from the chat panel to populate the preview.</p>
				</div>
				{renderStatus && normalizedGraph.nodes.length > 0 && (
					<div class="graph-render-status" role="status">{renderStatus}</div>
				)}
				{actionPanel}
			</div>
		</section>
	);
}

function TripletContent({ triplets }) {
	const list = triplets ?? [];

	return (
		<div>
			<div>
				{list.length === 0
					? "Ingest complete, but no relations were extracted."
					: `Ingest complete. Extracted ${list.length} triplet${list.length === 1 ? "" : "s"}.`}
			</div>
			{list.length > 0 && (
				<div class="triplet-list">
					{list.map((triplet, index) => (
						<div class="triplet" key={`${triplet.sourceId}-${triplet.targetId}-${triplet.relation}-${index}`}>
							<strong>{triplet.sourceLabel}</strong>
							{` ${relationLabel(triplet.relation)} `}
							<strong>{triplet.targetLabel}</strong>
							{triplet.information && <div>{triplet.information}</div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

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
	};
}

function MutationContent({ mutation }) {
	const nodes = mutation?.nodes ?? [];
	const relations = mutation?.relations ?? [];
	const nodeDeletes = mutation?.nodeDeletes ?? [];
	const relationDeletes = mutation?.relationDeletes ?? [];
	const triplets = mutation?.triplets ?? [];
	const totalMutations = nodes.length + relations.length + nodeDeletes.length + relationDeletes.length;
	const isPendingHitl = mutation?.status === "pending_hitl";
	const summaryParts = [
		nodes.length > 0 ? `${nodes.length} node upsert${nodes.length === 1 ? "" : "s"}` : "",
		relations.length > 0 ? `${relations.length} relation upsert${relations.length === 1 ? "" : "s"}` : "",
		nodeDeletes.length > 0 ? `${nodeDeletes.length} node delete${nodeDeletes.length === 1 ? "" : "s"}` : "",
		relationDeletes.length > 0 ? `${relationDeletes.length} relation delete${relationDeletes.length === 1 ? "" : "s"}` : "",
	].filter(Boolean);
	const nodeLabels = new Map();

	for (const node of nodes) {
		const key = nodeReferenceKey(node.name || node.id);
		if (key) {
			nodeLabels.set(key, node.label || displayNameFromIdentifier(key));
		}
	}

	function nodeLabel(reference) {
		const key = nodeReferenceKey(reference);
		return nodeLabels.get(key) ?? displayNameFromIdentifier(key);
	}

	return (
		<div>
			<div>
				{isPendingHitl
					? totalMutations === 0
						? "Ingest produced no graph mutations. The LLM response was saved for HITL review."
						: "Ingest proposal saved for HITL review. No graph changes were applied."
					: totalMutations === 0
					? "Ingest complete. No graph mutations were extracted or applied."
					: `Ingest complete. Applied ${totalMutations} graph mutation${totalMutations === 1 ? "" : "s"}.`}
			</div>
			{summaryParts.length > 0 && <div>{isPendingHitl ? "Proposed: " : ""}{summaryParts.join(", ")}.</div>}
			{totalMutations > 0 && (
				<div class="triplet-list">
					{nodes.map((node, index) => (
						<div class="triplet" key={`node-${node.id ?? node.name}-${index}`}>
							<strong>{operationVerb(node.operation)} node</strong>
							{`: ${node.label || displayNameFromIdentifier(node.name || node.id)}`}
							{node.description && <div>{node.description}</div>}
							{node.metadata && <div>{node.metadata}</div>}
						</div>
					))}
					{nodeDeletes.map((node, index) => (
						<div class="triplet" key={`node-delete-${node.id ?? node.name}-${index}`}>
							<strong>Deleted node</strong>
							{`: ${nodeLabel(node.name || node.id)}`}
							{node.metadata && <div>{node.metadata}</div>}
						</div>
					))}
					{relations.map((relation, index) => {
						const triplet = triplets[index];
						const sourceLabel = triplet?.sourceLabel ?? nodeLabel(relation.sourceId);
						const targetLabel = triplet?.targetLabel ?? nodeLabel(relation.targetId);

						return (
							<div class="triplet" key={`relation-${relation.id ?? index}`}>
								<strong>{operationVerb(relation.operation)} relation</strong>
								<div>
									<strong>{sourceLabel}</strong>
									{` ${relationLabel(relation.relation)} `}
									<strong>{targetLabel}</strong>
								</div>
								{relation.information && <div>{relation.information}</div>}
								{relation.description && <div>{relation.description}</div>}
								{relation.metadata && <div>{relation.metadata}</div>}
							</div>
						);
					})}
					{relationDeletes.map((relation, index) => (
						<div class="triplet" key={`relation-delete-${relation.id ?? index}`}>
							<strong>Deleted relation</strong>
							<div>
								<strong>{nodeLabel(relation.sourceId || relation.sourceName)}</strong>
								{` ${relationLabel(relation.relation)} `}
								<strong>{nodeLabel(relation.targetId || relation.targetName)}</strong>
							</div>
							{relation.metadata && <div>{relation.metadata}</div>}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function MessageContent({ message }) {
	if (message.mutation) {
		return <MutationContent mutation={message.mutation} />;
	}

	if (message.triplets) {
		return <TripletContent triplets={message.triplets} />;
	}

	if (message.role === "assistant" && typeof message.text === "string" && !message.error) {
		return <MarkdownPreview text={message.text} />;
	}

	return message.text;
}

function MessageList({ className = "", messages }) {
	const messagesRef = useRef(null);
	const isAskMessages = className.split(/\s+/).includes("ask-messages");

	useEffect(() => {
		const element = messagesRef.current;
		if (element) {
			element.scrollTop = element.scrollHeight;
		}
	}, [messages]);

	return (
		<div class={`messages${className ? ` ${className}` : ""}`} ref={messagesRef} aria-live="polite">
			{messages.map((message) => {
				const canCopy = (
					isAskMessages
					&& message.role === "assistant"
					&& !message.error
					&& typeof message.text === "string"
					&& message.copyable === true
					&& hasCopyableLlmText(message.text)
				);

				return (
					<article class={`message ${message.role}${message.error ? " error" : ""}`} key={message.id}>
						<div class="message-stack">
							<div class="bubble">
								<MessageContent message={message} />
							</div>
							{canCopy && (
								<div class="message-copy-row">
									<CopyButton className="message-copy-button" text={message.text} />
								</div>
							)}
						</div>
					</article>
				);
			})}
		</div>
	);
}

function PaperclipIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
			<path d="m21.4 11.05-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.65 5.65l-8.9 8.9a2.2 2.2 0 0 1-3.1-3.1l8.45-8.45" />
		</svg>
	);
}

function TrashIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
			<path d="M3 6h18" />
			<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
			<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
			<path d="M10 11v6" />
			<path d="M14 11v6" />
		</svg>
	);
}

function Composer({
	actionLabel,
	autoGrow = false,
	className = "",
	clearAction = null,
	files = [],
	fileAccept,
	inputId,
	inputRef,
	disabled = false,
	isBusy,
	onFileClear,
	onFilesSelect,
	onInput,
	onSubmit,
	placeholder,
	value,
}) {
	const [isDragActive, setIsDragActive] = useState(false);
	const dragDepthRef = useRef(0);
	const fileInputRef = useRef(null);
	const textareaRef = useRef(null);
	const canAttachFile = Boolean(onFilesSelect);
	const hasFiles = files.length > 0;
	const isDisabled = isBusy || disabled;

	function resizeTextarea(element = textareaRef.current) {
		if (!autoGrow || !element) {
			return;
		}

		const maxHeight = 180;
		const minHeight = 42;
		element.style.height = "auto";
		const nextHeight = Math.max(minHeight, Math.min(element.scrollHeight, maxHeight));
		element.style.height = `${nextHeight}px`;
		element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
	}

	function setTextareaRef(element) {
		textareaRef.current = element;

		if (typeof inputRef === "function") {
			inputRef(element);
		} else if (inputRef) {
			inputRef.current = element;
		}

		resizeTextarea(element);
	}

	useEffect(() => {
		resizeTextarea();
	}, [autoGrow, files.length, value]);

	function handleSubmit(event) {
		event.preventDefault();
		if (isDisabled) {
			return;
		}
		onSubmit();
	}

	function handleKeyDown(event) {
		if (!isDisabled && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			onSubmit();
		}
	}

	function handleTextareaInput(event) {
		if (isDisabled) {
			return;
		}
		resizeTextarea(event.currentTarget);
		onInput(event.currentTarget.value);
	}

	function hasDraggedFiles(event) {
		return Array.from(event.dataTransfer?.types ?? []).includes("Files");
	}

	function handleDragEnter(event) {
		if (!canAttachFile || isDisabled || !hasDraggedFiles(event)) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current += 1;
		setIsDragActive(true);
	}

	function handleDragOver(event) {
		if (!canAttachFile || isDisabled || !hasDraggedFiles(event)) {
			return;
		}

		event.preventDefault();
		event.dataTransfer.dropEffect = "copy";
		setIsDragActive(true);
	}

	function handleDragLeave(event) {
		if (!canAttachFile) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current = Math.max(dragDepthRef.current - 1, 0);
		if (dragDepthRef.current === 0) {
			setIsDragActive(false);
		}
	}

	function handleDrop(event) {
		if (!canAttachFile || isDisabled) {
			return;
		}

		event.preventDefault();
		dragDepthRef.current = 0;
		setIsDragActive(false);
		const nextFiles = Array.from(event.dataTransfer?.files ?? []);
		if (nextFiles.length > 0) {
			onFilesSelect(nextFiles);
		}
	}

	function handleFileInput(event) {
		const nextFiles = Array.from(event.currentTarget.files ?? []);
		if (nextFiles.length > 0) {
			onFilesSelect(nextFiles);
		}
		event.currentTarget.value = "";
	}

	return (
		<form class={`composer${className ? ` ${className}` : ""}`} onSubmit={handleSubmit}>
			<label class="sr-only" htmlFor={inputId}>Text input</label>
			<div
				class={`composer-input-shell${isDragActive ? " drag-active" : ""}${hasFiles ? " has-file" : ""}`}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
			>
				{hasFiles && (
					<div class="file-list">
						{files.map((file) => (
							<div class="file-pill" key={fileKey(file)}>
								<span>{file.name}</span>
								<small>{formatFileSize(file.size)}</small>
								<button
									aria-label={`Remove ${file.name}`}
									class="file-remove"
									disabled={isDisabled}
									onClick={() => onFileClear(file)}
									type="button"
								>
									x
								</button>
							</div>
						))}
					</div>
				)}
			<textarea
				id={inputId}
				rows={autoGrow ? "1" : "5"}
				placeholder={placeholder}
				disabled={isDisabled}
				onInput={handleTextareaInput}
				onKeyDown={handleKeyDown}
				ref={setTextareaRef}
				value={value}
			/>
				{isDragActive && <div class="drop-hint">Drop to attach</div>}
			</div>
			<div class={`actions${clearAction || canAttachFile ? " with-tools" : ""}`}>
				{clearAction && (
					<button
						type="button"
						class="icon-action-button trash-button"
						aria-label={clearAction.label}
						data-tooltip={clearAction.label}
						title={clearAction.label}
						disabled={isDisabled}
						onClick={clearAction.onClick}
					>
						<TrashIcon />
						{/*
						{"🗑"}
						*/}
					</button>
				)}
				{canAttachFile && (
					<>
						<input
							accept={fileAccept}
							class="sr-only"
							disabled={isDisabled}
							multiple
							onChange={handleFileInput}
							ref={fileInputRef}
							type="file"
						/>
						<button
							aria-label="Add PDF, Word Doc"
							class="icon-action-button upload-button"
							data-tooltip="Add PDF, Word Doc"
							disabled={isDisabled}
							onClick={() => fileInputRef.current?.click()}
							title="Add PDF, Word Doc"
							type="button"
						>
							<PaperclipIcon />
						</button>
					</>
				)}
				<button type="submit" class="primary" disabled={isDisabled}>{actionLabel}</button>
			</div>
		</form>
	);
}

function SearchPanel({ clientResults, isSearching, onFocusNode, onQuery, onSearch, query, searchMessage, serverResults }) {
	const panelRef = useRef(null);
	const [isOpen, setIsOpen] = useState(false);
	const shownResults = serverResults.length > 0 ? serverResults : clientResults;
	const hasQuery = Boolean(query.trim());
	const hasResults = shownResults.length > 0;

	useEffect(() => {
		if (!hasQuery) {
			setIsOpen(false);
			return undefined;
		}

		function handlePointerDown(event) {
			if (!panelRef.current?.contains(event.target)) {
				setIsOpen(false);
			}
		}

		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => document.removeEventListener("pointerdown", handlePointerDown, true);
	}, [hasQuery]);

	function handleSubmit(event) {
		event.preventDefault();
		setIsOpen(true);
		onSearch();
	}

	return (
		<form class="search-panel" onSubmit={handleSubmit} ref={panelRef}>
			<label class="sr-only" htmlFor="node-search">Search nodes</label>
			<input
				id="node-search"
				type="search"
				placeholder="Search loaded nodes, or press Enter for full search..."
				value={query}
				onFocus={() => {
					if (hasQuery) {
						setIsOpen(true);
					}
				}}
				onInput={(event) => {
					onQuery(event.currentTarget.value);
					setIsOpen(Boolean(event.currentTarget.value.trim()));
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						setIsOpen(false);
					}
				}}
			/>
			<button type="submit" class="compact-button" disabled={isSearching}>
				{isSearching ? "Searching" : "Search"}
			</button>
			{searchMessage && (
				<div class="search-status" role="status">{searchMessage}</div>
			)}
			{isOpen && hasQuery && hasResults && (
				<div class="search-results">
					{shownResults.map((node) => (
						<button
							type="button"
							class="search-result"
							key={node.id}
							onClick={() => {
								setIsOpen(false);
								onFocusNode(node);
							}}
						>
							<span>{node.label}</span>
							<small>{node.type}</small>
						</button>
					))}
				</div>
			)}
		</form>
	);
}

function Field({ label, children }) {
	return (
		<label class="field">
			<span>{label}</span>
			{children}
		</label>
	);
}

function createNodeDraft(node) {
	return {
		label: node?.label ?? "",
		name: node?.name ?? "",
		type: node?.type ?? "concept",
		description: node?.description ?? "",
	};
}

function createRelationDraft(relation) {
	return {
		sourceId: relation?.sourceId ?? "",
		targetId: relation?.targetId ?? "",
		relation: relation?.relation ?? "relates_to",
		information: relation?.information ?? "",
		description: relation?.description ?? "",
	};
}

function NodeForm({
	deleteLabel = "Delete",
	draft: controlledDraft,
	node,
	onCancel,
	onDelete,
	onDraftChange,
	onSave,
	saveLabel = "Save node",
}) {
	const isControlled = Boolean(controlledDraft && onDraftChange);
	const [localDraft, setLocalDraft] = useState(() => createNodeDraft(node));
	const draft = isControlled ? controlledDraft : localDraft;
	const setDraft = isControlled ? onDraftChange : setLocalDraft;

	useEffect(() => {
		if (!isControlled) {
			setLocalDraft(createNodeDraft(node));
		}
	}, [isControlled, node]);

	function updateField(field, value) {
		setDraft((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event) {
		event.preventDefault();
		onSave({ ...draft, name: draft.name || toSnakeCase(draft.label) });
	}

	return (
		<form class="edit-form" onSubmit={handleSubmit}>
			<Field label="Label">
				<input value={draft.label} onInput={(event) => updateField("label", event.currentTarget.value)} required />
			</Field>
			<Field label="Name">
				<input value={draft.name} onInput={(event) => updateField("name", event.currentTarget.value)} placeholder="auto_from_label" />
			</Field>
			<Field label="Type">
				<input value={draft.type} onInput={(event) => updateField("type", event.currentTarget.value)} required />
			</Field>
			<Field label="Description">
				<textarea rows="4" value={draft.description} onInput={(event) => updateField("description", event.currentTarget.value)} />
			</Field>
			<div class="form-actions">
				<button type="submit" class="primary">{saveLabel}</button>
				{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
				{onDelete && <button type="button" class="danger-button" onClick={onDelete}>{deleteLabel}</button>}
			</div>
		</form>
	);
}

function RelationForm({
	deleteLabel = "Delete",
	draft: controlledDraft,
	graph,
	onCancel,
	onDelete,
	onDraftChange,
	onSave,
	relation,
	saveLabel = "Save relation",
}) {
	const isControlled = Boolean(controlledDraft && onDraftChange);
	const [localDraft, setLocalDraft] = useState(() => createRelationDraft(relation));
	const draft = isControlled ? controlledDraft : localDraft;
	const setDraft = isControlled ? onDraftChange : setLocalDraft;

	useEffect(() => {
		if (!isControlled) {
			setLocalDraft(createRelationDraft(relation));
		}
	}, [isControlled, relation]);

	function updateField(field, value) {
		setDraft((current) => ({ ...current, [field]: value }));
	}

	function handleSubmit(event) {
		event.preventDefault();
		onSave({ ...draft, relation: toSnakeCase(draft.relation) || "relates_to" });
	}

	return (
		<form class="edit-form" onSubmit={handleSubmit}>
			<datalist id="node-id-options">
				{graph.nodes.map((node) => <option value={node.id} key={node.id}>{node.label}</option>)}
			</datalist>
			<Field label="Source node">
				<input list="node-id-options" value={draft.sourceId} onInput={(event) => updateField("sourceId", event.currentTarget.value)} required />
			</Field>
			<Field label="Target node">
				<input list="node-id-options" value={draft.targetId} onInput={(event) => updateField("targetId", event.currentTarget.value)} required />
			</Field>
			<Field label="Relation">
				<input value={draft.relation} onInput={(event) => updateField("relation", event.currentTarget.value)} required />
			</Field>
			<Field label="Information">
				<textarea rows="3" value={draft.information} onInput={(event) => updateField("information", event.currentTarget.value)} />
			</Field>
			<Field label="Description">
				<textarea rows="4" value={draft.description} onInput={(event) => updateField("description", event.currentTarget.value)} />
			</Field>
			<div class="form-actions">
				<button type="submit" class="primary">{saveLabel}</button>
				{onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
				{onDelete && <button type="button" class="danger-button" onClick={onDelete}>{deleteLabel}</button>}
			</div>
		</form>
	);
}

function nodeLabelById(graph, nodeId) {
	return graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

function NodeRelationshipList({ graph, nodeId, onSelectItem }) {
	const relationships = graph.relations.filter((relation) => (
		relation.sourceId === nodeId || relation.targetId === nodeId
	));

	return (
		<section class="relationship-section">
			<div class="section-heading">
				<h3>Relationships</h3>
				<span>{relationships.length}</span>
			</div>
			{relationships.length === 0 ? (
				<p class="muted-copy">No loaded relationships for this node.</p>
			) : (
				<div class="relationship-list">
					{relationships.map((relation) => {
						const isOutgoing = relation.sourceId === nodeId;
						const sourceLabel = nodeLabelById(graph, relation.sourceId);
						const targetLabel = nodeLabelById(graph, relation.targetId);

						return (
							<button
								type="button"
								class="relationship-row"
								key={relation.id}
								onClick={() => onSelectItem({ type: "relation", id: relation.id, returnToNodeId: nodeId })}
							>
								<span class="direction-badge">{isOutgoing ? "out" : "in"}</span>
								<span>
									<strong>{sourceLabel}</strong>
									<small>{relationLabel(relation.relation)}</small>
									<strong>{targetLabel}</strong>
								</span>
							</button>
						);
					})}
				</div>
			)}
		</section>
	);
}

function DetailPanel({
	graph,
	nodeDeleteLabel = "Delete",
	nodeSaveLabel = "Save node",
	onDeleteNode,
	onDeleteRelation,
	onSaveNode,
	onSaveRelation,
	onSelectItem,
	relationDeleteLabel = "Delete",
	relationSaveLabel = "Save relation",
	selectedItem,
}) {
	const selectedNode = selectedItem?.type === "node"
		? graph.nodes.find((node) => node.id === selectedItem.id)
		: null;
	const selectedRelation = selectedItem?.type === "relation"
		? graph.relations.find((relation) => relation.id === selectedItem.id)
		: null;
	const returnNode = selectedItem?.returnToNodeId
		? graph.nodes.find((node) => node.id === selectedItem.returnToNodeId)
		: null;

	if (!selectedItem) {
		return (
			<div class="placeholder-panel">
				<p>Select a node or relation in the graph to inspect and edit it.</p>
			</div>
		);
	}

	if (selectedNode) {
		return (
			<div class="detail-panel">
				<div class="detail-heading">
					<p class="eyebrow">Node</p>
					<h3>{selectedNode.label}</h3>
					<code>{selectedNode.id}</code>
				</div>
				{selectedNode.metadata && (
					<div class="detail-kv">
						<span>Metadata</span>
						<strong>{selectedNode.metadata}</strong>
					</div>
				)}
				<NodeForm
					deleteLabel={nodeDeleteLabel}
					node={selectedNode}
					onDelete={() => onDeleteNode(selectedNode)}
					onSave={(draft) => onSaveNode(selectedNode.id, draft)}
					saveLabel={nodeSaveLabel}
				/>
				<NodeRelationshipList
					graph={graph}
					nodeId={selectedNode.id}
					onSelectItem={onSelectItem}
				/>
			</div>
		);
	}

	if (selectedRelation) {
		return (
			<div class="detail-panel">
				<div class="detail-heading">
					<div class="detail-title-row">
						<div>
							<p class="eyebrow">Relation</p>
							<h3>{relationLabel(selectedRelation.relation)}</h3>
							<code>{selectedRelation.id}</code>
						</div>
						{returnNode && (
							<button
								type="button"
								class="compact-button"
								onClick={() => onSelectItem({ type: "node", id: returnNode.id })}
							>
								Back to node
							</button>
						)}
					</div>
				</div>
				{selectedRelation.metadata && (
					<div class="detail-kv">
						<span>Metadata</span>
						<strong>{selectedRelation.metadata}</strong>
					</div>
				)}
				<RelationForm
					deleteLabel={relationDeleteLabel}
					graph={graph}
					relation={selectedRelation}
					onCancel={returnNode ? () => onSelectItem({ type: "node", id: returnNode.id }) : undefined}
					onDelete={() => onDeleteRelation(selectedRelation)}
					onSave={(draft) => onSaveRelation(selectedRelation.id, draft)}
					saveLabel={relationSaveLabel}
				/>
			</div>
		);
	}

	return (
		<div class="placeholder-panel">
			<p>The selected item is not in the current graph view.</p>
		</div>
	);
}

function GraphActionButtons({ onCreateNode, onCreateRelation }) {
	return (
		<div class="graph-action-bar" aria-label="Create graph items">
			<button type="button" class="primary" onClick={onCreateNode}>{"⊕"} Node</button>
			<button type="button" onClick={onCreateRelation}>{"↔"} Relation</button>
		</div>
	);
}

function HitlGraphActionPanel({ isDraftMode, isDirty, onCreateNode, onCreateRelation }) {
	return (
		<div class="hitl-graph-action-panel">
			<div class={`hitl-mode-banner ${isDraftMode ? "draft" : "direct"}${isDirty ? " dirty" : ""}`}>
				<strong>{isDraftMode ? "Proposal draft mode" : "Direct graph edit mode"}</strong>
				<span>
					{isDraftMode
						? "Graph edits update the open HITL proposal only."
						: "Approved graph edits apply directly to the DB."}
				</span>
			</div>
			<GraphActionButtons
				onCreateNode={onCreateNode}
				onCreateRelation={onCreateRelation}
			/>
			<HitlOperationLegend />
		</div>
	);
}

function EntityModal({ children, onClose, title }) {
	useEffect(() => {
		function handleKeyDown(event) {
			if (event.key === "Escape") {
				onClose();
			}
		}

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onClose]);

	return (
		<div class="modal-backdrop" role="presentation" onMouseDown={onClose}>
			<section
				class="modal-panel"
				role="dialog"
				aria-modal="true"
				aria-labelledby="modal-title"
				onMouseDown={(event) => event.stopPropagation()}
			>
				<header class="modal-header">
					<h3 id="modal-title">{title}</h3>
					<button type="button" class="icon-button" aria-label="Close modal" onClick={onClose}>x</button>
				</header>
				{children}
			</section>
		</div>
	);
}

function RequiredNameModal({
	eyebrow = "Workspace access",
	fieldLabel = "Name",
	helperText = "Ask and Ingest unlock after this step. The name is kept only for this page session.",
	initialName = "",
	onSubmit,
	placeholder = "Enter your name to continue",
	title = "Enter your name",
}) {
	const [draftName, setDraftName] = useState(initialName);
	const cleanName = draftName.trim();

	function handleSubmit(event) {
		event.preventDefault();
		if (cleanName) {
			onSubmit(cleanName);
		}
	}

	return (
		<div class="modal-backdrop locked-modal-backdrop" role="presentation">
			<section
				class="modal-panel name-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="name-modal-title"
			>
				<header class="modal-header">
					<div>
						<p class="eyebrow">{eyebrow}</p>
						<h3 id="name-modal-title">{title}</h3>
					</div>
				</header>
				<form class="edit-form" onSubmit={handleSubmit}>
					<label class="field">
						<span>{fieldLabel}</span>
						<input
							autoFocus
							type="text"
							placeholder={placeholder}
							value={draftName}
							onInput={(event) => setDraftName(event.currentTarget.value)}
						/>
					</label>
					<p class="muted-copy">{helperText}</p>
					<button type="submit" class="primary" disabled={!cleanName}>Continue</button>
				</form>
			</section>
		</div>
	);
}

function jobTitle(jobType) {
	return jobType === "scanner" ? "Graph Scanner" : "Knowledge Nugget";
}

function JobsPanel({
	depth,
	errorMessage,
	isBusy,
	onDepthChange,
	onRunJob,
	result,
	statusMessage,
}) {
	const activeJobTitle = result?.jobType ? jobTitle(result.jobType) : "No job has run yet";
	const anchorLabel = result?.anchorNode?.label || result?.anchorNode?.name || result?.anchorNode?.id || "";

	return (
		<aside class="jobs-panel" aria-label="Graph jobs workspace">
			<header class="hitl-header">
				<div>
					<p class="eyebrow">Graph jobs</p>
					<h2>Manual intelligence jobs</h2>
				</div>
				<div class="hitl-header-actions">
					<RouteSwitcher />
				</div>
			</header>
			<div class="jobs-content">
				<section class="jobs-section">
					<div class="hitl-section-header">
						<h3>Run a job</h3>
						<span>{isBusy ? "Running" : "Ready"}</span>
					</div>
					<label class="field">
						<span>Neighborhood depth</span>
						<select
							value={depth}
							disabled={isBusy}
							onChange={(event) => onDepthChange(Number(event.currentTarget.value))}
						>
							{[0, 1, 2, 3, 4].map((value) => (
								<option value={value} key={value}>{value}</option>
							))}
						</select>
					</label>
					<div class="job-action-grid">
						<button
							type="button"
							class="primary"
							disabled={isBusy}
							onClick={() => onRunJob("scanner")}
						>
							Run Scanner
						</button>
						<button
							type="button"
							disabled={isBusy}
							onClick={() => onRunJob("nugget")}
						>
							Generate Knowledge Nugget
						</button>
					</div>
					{statusMessage && <div class="status-line">{statusMessage}</div>}
					{errorMessage && <div class="status-line error-status">{errorMessage}</div>}
				</section>

				<section class="jobs-section jobs-result-section">
					<div class="hitl-section-header">
						<h3>{activeJobTitle}</h3>
						<span>{result ? `${result.graph?.nodes?.length ?? 0}N / ${result.graph?.relations?.length ?? 0}R` : ""}</span>
					</div>
					{result ? (
						<>
							<div class="detail-kv">
								<span>Anchor</span>
								<strong>{anchorLabel}</strong>
							</div>
							<div class="detail-kv">
								<span>Completed</span>
								<strong>{formatHitlDate(result.completedAt)}</strong>
							</div>
							<pre class="job-output">{result.outputMarkdown || "No output returned."}</pre>
						</>
					) : (
						<div class="empty-review-state">Run a job to inspect a random graph neighborhood.</div>
					)}
				</section>
			</div>
		</aside>
	);
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value ?? {}));
}

function normalizeSchemaEntries(entries, { includeReason = false } = {}) {
	const merged = new Map();
	for (const entry of Array.isArray(entries) ? entries : []) {
		const name = toSnakeCase(entry?.name);
		if (!name) {
			continue;
		}

		const existing = merged.get(name);
		merged.set(name, {
			name,
			description: String(entry?.description ?? existing?.description ?? "").trim(),
			...(includeReason ? { reason: String(entry?.reason ?? existing?.reason ?? "").trim() } : {}),
		});
	}

	return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSchemaDraft(schema) {
	const nextSchema = {
		...cloneJson(schema),
		nodeTypes: normalizeSchemaEntries(schema?.nodeTypes),
		relationshipTypes: normalizeSchemaEntries(schema?.relationshipTypes),
		suggestions: {
			nodeTypes: normalizeSchemaEntries(schema?.suggestions?.nodeTypes, { includeReason: true }),
			relationshipTypes: normalizeSchemaEntries(schema?.suggestions?.relationshipTypes, { includeReason: true }),
		},
	};
	delete nextSchema.path;
	delete nextSchema.fallbacks;
	return nextSchema;
}

function formatSchemaJson(schema) {
	return `${JSON.stringify(normalizeSchemaDraft(schema), null, "\t")}\n`;
}

function updateSchemaEntries(draft, key, updater) {
	return {
		...draft,
		[key]: updater(Array.isArray(draft?.[key]) ? draft[key] : []),
	};
}

function updateSchemaSuggestions(draft, key, updater) {
	const currentSuggestions = draft?.suggestions ?? {};
	return {
		...draft,
		suggestions: {
			...currentSuggestions,
			[key]: updater(Array.isArray(currentSuggestions[key]) ? currentSuggestions[key] : []),
		},
	};
}

function SchemaPropertySummary({ schema }) {
	const nodeRequired = schema?.nodeProperties?.required ?? [];
	const nodeOptional = schema?.nodeProperties?.optional ?? [];
	const relationRequired = schema?.relationshipProperties?.required ?? [];
	const relationOptional = schema?.relationshipProperties?.optional ?? [];

	return (
		<section class="schema-property-summary" aria-label="Schema property summary">
			<div>
				<span>Version</span>
				<strong>{schema?.version ?? "n/a"}</strong>
			</div>
			<div>
				<span>Node properties</span>
				<strong>{[...nodeRequired, ...nodeOptional].join(", ") || "None"}</strong>
			</div>
			<div>
				<span>Relation properties</span>
				<strong>{[...relationRequired, ...relationOptional].join(", ") || "None"}</strong>
			</div>
		</section>
	);
}

function SchemaEntryList({ entries, onEntriesChange, title }) {
	function updateEntry(index, field, value) {
		onEntriesChange(entries.map((entry, entryIndex) => (
			entryIndex === index ? { ...entry, [field]: value } : entry
		)));
	}

	return (
		<section class="schema-section">
			<div class="hitl-section-header">
				<h3>{title}</h3>
				<span>{entries.length}</span>
			</div>
			<div class="schema-entry-list">
				{entries.map((entry, index) => (
					<div class="schema-entry-row" key={`${title}-${index}`}>
						<input
							aria-label={`${title} name`}
							value={entry.name ?? ""}
							placeholder="type_name"
							onInput={(event) => updateEntry(index, "name", event.currentTarget.value)}
						/>
						<textarea
							aria-label={`${title} description`}
							rows="2"
							value={entry.description ?? ""}
							placeholder="Description"
							onInput={(event) => updateEntry(index, "description", event.currentTarget.value)}
						/>
						<button
							type="button"
							class="danger-button"
							onClick={() => onEntriesChange(entries.filter((_, entryIndex) => entryIndex !== index))}
						>
							Delete
						</button>
					</div>
				))}
				<button
					type="button"
					class="compact-button schema-add-button"
					onClick={() => onEntriesChange([...entries, { name: "", description: "" }])}
				>
					Add {title.toLowerCase().replace(/s$/, "")}
				</button>
			</div>
		</section>
	);
}

function SchemaSuggestionSection({ approvedKey, draft, suggestionKey, title, onDraftChange }) {
	const suggestions = draft?.suggestions?.[suggestionKey] ?? [];

	function approveSuggestion(index) {
		const suggestion = suggestions[index];
		onDraftChange((currentDraft) => {
			const withoutSuggestion = (currentDraft.suggestions?.[suggestionKey] ?? [])
				.filter((_, suggestionIndex) => suggestionIndex !== index);
			const approvedEntries = normalizeSchemaEntries([
				...(currentDraft[approvedKey] ?? []),
				{ name: suggestion.name, description: suggestion.description },
			]);

			return updateSchemaSuggestions(
				{ ...currentDraft, [approvedKey]: approvedEntries },
				suggestionKey,
				() => withoutSuggestion,
			);
		});
	}

	function rejectSuggestion(index) {
		onDraftChange((currentDraft) => updateSchemaSuggestions(
			currentDraft,
			suggestionKey,
			(currentSuggestions) => currentSuggestions.filter((_, suggestionIndex) => suggestionIndex !== index),
		));
	}

	return (
		<section class="schema-section">
			<div class="hitl-section-header">
				<h3>{title}</h3>
				<span>{suggestions.length}</span>
			</div>
			{suggestions.length === 0 ? (
				<p class="muted-copy">No pending suggestions.</p>
			) : (
				<div class="schema-suggestion-list">
					{suggestions.map((suggestion, index) => (
						<article class="schema-suggestion-card" key={`${title}-${suggestion.name}-${index}`}>
							<div>
								<strong>{suggestion.name}</strong>
								<p>{suggestion.description || "No description."}</p>
								{suggestion.reason && <small>{suggestion.reason}</small>}
							</div>
							<div class="schema-suggestion-actions">
								<button type="button" class="primary compact-button" onClick={() => approveSuggestion(index)}>Approve</button>
								<button type="button" class="compact-button danger-button" onClick={() => rejectSuggestion(index)}>Reject</button>
							</div>
						</article>
					))}
				</div>
			)}
		</section>
	);
}

function SchemaPanel() {
	const [activeTab, setActiveTab] = useState("types");
	const [draft, setDraft] = useState(null);
	const [jsonDraft, setJsonDraft] = useState("");
	const [savedDraftJson, setSavedDraftJson] = useState("");
	const [schemaPath, setSchemaPath] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [message, setMessage] = useState("");
	const [errorMessage, setErrorMessage] = useState("");
	const draftJson = useMemo(() => (draft ? formatSchemaJson(draft) : ""), [draft]);
	const hasStructuredChanges = Boolean(draft && savedDraftJson && draftJson !== savedDraftJson);
	const hasUnappliedJson = activeTab === "json" && jsonDraft !== draftJson;

	const applyServerSchema = useCallback((result) => {
		const nextDraft = normalizeSchemaDraft(result.schema);
		const nextJson = result.formattedJson || result.rawJson || formatSchemaJson(nextDraft);
		setDraft(nextDraft);
		setJsonDraft(nextJson);
		setSavedDraftJson(formatSchemaJson(nextDraft));
		setSchemaPath(result.pathLabel || result.path || "");
	}, []);

	const loadSchema = useCallback(async () => {
		setIsLoading(true);
		setErrorMessage("");
		try {
			const result = await requestJson("/api/schema");
			applyServerSchema(result);
			setMessage("Schema loaded.");
		} catch (error) {
			setErrorMessage(error.message || "Schema load failed.");
		} finally {
			setIsLoading(false);
		}
	}, [applyServerSchema]);

	useEffect(() => {
		loadSchema();
	}, [loadSchema]);

	useEffect(() => {
		if (activeTab !== "json" && draft) {
			setJsonDraft(draftJson);
		}
	}, [activeTab, draft, draftJson]);

	function changeDraft(updater) {
		setDraft((currentDraft) => cloneJson(
			typeof updater === "function" ? updater(currentDraft) : updater,
		));
		setMessage("");
		setErrorMessage("");
	}

	function applyJsonDraft() {
		try {
			const parsed = JSON.parse(jsonDraft);
			const normalized = normalizeSchemaDraft(parsed);
			setDraft(normalized);
			setJsonDraft(formatSchemaJson(normalized));
			setMessage("JSON applied to draft.");
			setErrorMessage("");
		} catch (error) {
			setErrorMessage(error.message || "Invalid schema JSON.");
		}
	}

	async function saveSchema() {
		setIsSaving(true);
		setErrorMessage("");
		try {
			const body = activeTab === "json" && hasUnappliedJson
				? { rawJson: jsonDraft }
				: { schema: normalizeSchemaDraft(draft) };
			const result = await requestJson("/api/schema", {
				method: "PUT",
				body: JSON.stringify(body),
			});
			applyServerSchema(result);
			setMessage("Schema saved.");
		} catch (error) {
			setErrorMessage(error.message || "Schema save failed.");
		} finally {
			setIsSaving(false);
		}
	}

	if (isLoading && !draft) {
		return (
			<aside class="schema-panel" aria-label="Graph schema workspace">
				<header class="hitl-header">
					<div>
						<p class="eyebrow">Graph schema</p>
						<h2>Schema manager</h2>
					</div>
					<RouteSwitcher />
				</header>
				<div class="schema-content">
					<p class="muted-copy">Loading schema...</p>
				</div>
			</aside>
		);
	}

	const nodeTypes = draft?.nodeTypes ?? [];
	const relationshipTypes = draft?.relationshipTypes ?? [];

	return (
		<aside class="schema-panel" aria-label="Graph schema workspace">
			<header class="hitl-header">
				<div>
					<p class="eyebrow">Graph schema</p>
					<h2>Schema manager</h2>
				</div>
				<div class="hitl-header-actions">
					<RouteSwitcher />
				</div>
			</header>
			<div class="schema-meta">
				<span>File</span>
				<strong>{schemaPath || "graphSchema.json"}</strong>
			</div>
			{(message || errorMessage || hasStructuredChanges || hasUnappliedJson) && (
				<div class={`status-line${errorMessage ? " error-status" : ""}`}>
					{errorMessage || (hasUnappliedJson ? "JSON has unapplied edits." : hasStructuredChanges ? "Unsaved schema changes." : message)}
				</div>
			)}
			<div class="schema-tabs" role="tablist" aria-label="Schema views">
				{[
					{ id: "types", label: "Types" },
					{ id: "suggestions", label: "Suggestions" },
					{ id: "json", label: "JSON" },
				].map((tab) => (
					<button
						type="button"
						class={activeTab === tab.id ? "active" : ""}
						onClick={() => setActiveTab(tab.id)}
						key={tab.id}
					>
						{tab.label}
					</button>
				))}
			</div>
			<div class="schema-content">
				{activeTab === "types" && (
					<>
						<SchemaPropertySummary schema={draft} />
						<SchemaEntryList
							title="Node types"
							entries={nodeTypes}
							onEntriesChange={(entries) => changeDraft((currentDraft) => updateSchemaEntries(currentDraft, "nodeTypes", () => entries))}
						/>
						<SchemaEntryList
							title="Relationship types"
							entries={relationshipTypes}
							onEntriesChange={(entries) => changeDraft((currentDraft) => updateSchemaEntries(currentDraft, "relationshipTypes", () => entries))}
						/>
					</>
				)}
				{activeTab === "suggestions" && (
					<>
						<SchemaSuggestionSection
							approvedKey="nodeTypes"
							draft={draft}
							suggestionKey="nodeTypes"
							title="Suggested node types"
							onDraftChange={changeDraft}
						/>
						<SchemaSuggestionSection
							approvedKey="relationshipTypes"
							draft={draft}
							suggestionKey="relationshipTypes"
							title="Suggested relationship types"
							onDraftChange={changeDraft}
						/>
					</>
				)}
				{activeTab === "json" && (
					<section class="schema-section">
						<div class="hitl-section-header">
							<h3>Advanced JSON</h3>
							<span>{jsonDraft.length} chars</span>
						</div>
						<textarea
							class="schema-json-editor"
							value={jsonDraft}
							spellCheck={false}
							onInput={(event) => {
								setJsonDraft(event.currentTarget.value);
								setMessage("");
								setErrorMessage("");
							}}
						/>
						<div class="schema-json-actions">
							<button type="button" class="compact-button" onClick={() => setJsonDraft(formatSchemaJson(draft))}>Format</button>
							<button type="button" class="compact-button" onClick={applyJsonDraft}>Apply JSON</button>
						</div>
					</section>
				)}
			</div>
			<div class="schema-footer-actions">
				<button type="button" class="primary" onClick={saveSchema} disabled={isSaving || isLoading || !draft}>
					{isSaving ? "Saving..." : "Save schema"}
				</button>
				<button type="button" onClick={loadSchema} disabled={isSaving || isLoading}>
					Reset
				</button>
			</div>
		</aside>
	);
}

function ChatPanel({
	activeTab,
	askMessages,
	askText,
	includeUnverifiedKnowledge,
	ingestFiles,
	ingestMessages,
	ingestText,
	inputRef,
	isBusy,
	onClearIngest,
	onIngestFileClear,
	onIngestFiles,
	onIngestText,
	onAsk,
	onAskText,
	onIncludeUnverifiedKnowledgeChange,
	onIngest,
	onTab,
	statusMessage,
	userName,
	onChangeUserName,
	workspaceLocked = false,
}) {
	return (
		<aside class="chat-panel" aria-label="Ask and ingest workspace">
			<div class="workspace-identity">
				<div class="workspace-identity-main">
					<span>Workspace user</span>
					<strong>{userName || "Name required"}</strong>
				</div>
				<button type="button" class="identity-change-button" onClick={onChangeUserName}>
					Change
				</button>
				<RouteSwitcher />
			</div>
			<div class="tabs" role="tablist" aria-label="Workspace views">
				{["ask", "ingest"].map((tab) => (
					<button
						type="button"
						class={activeTab === tab ? "active" : ""}
						onClick={() => onTab(tab)}
						key={tab}
					>
						{tab}
					</button>
				))}
			</div>
			{statusMessage && <div class="status-line">{statusMessage}</div>}
			{activeTab === "ask" && (
				<>
					<MessageList className="ask-messages" messages={askMessages} />
					<Composer
						actionLabel="Ask"
						autoGrow
						className="ask-composer"
						disabled={workspaceLocked}
						inputId="ask-input"
						inputRef={inputRef}
						isBusy={isBusy}
						onInput={onAskText}
						onSubmit={onAsk}
						placeholder="Ask a question about the graph..."
						value={askText}
					/>
					<label class="ask-unverified-option">
						<input
							type="checkbox"
							checked={includeUnverifiedKnowledge}
							disabled={isBusy || workspaceLocked}
							onChange={(event) => onIncludeUnverifiedKnowledgeChange(event.currentTarget.checked)}
						/>
						<span>Include unapproved HITL information?</span>
					</label>
				</>
			)}
			{activeTab === "ingest" && (
				<>
					<MessageList className="ingest-messages" messages={ingestMessages} />
					<Composer
						actionLabel="Ingest"
						autoGrow
						className="ingest-composer"
						clearAction={{ label: "Clear ingest chat", onClick: onClearIngest }}
						disabled={workspaceLocked}
						files={ingestFiles}
						fileAccept={INGEST_FILE_ACCEPT}
						inputId="ingest-input"
						inputRef={inputRef}
						isBusy={isBusy}
						onFileClear={onIngestFileClear}
						onFilesSelect={onIngestFiles}
						onInput={onIngestText}
						onSubmit={onIngest}
						placeholder="Paste source text to extract nodes and relationships..."
						value={ingestText}
					/>
				</>
			)}
		</aside>
	);
}

function WorkspaceDivider({
	handleClick,
	maxWidth,
	minWidth,
	onCloseGraph,
	onCloseWorkspace,
	onDoubleClick,
	onKeyDown,
	onPointerDown,
	workspaceLabel = "Ask/Ingest",
	workspaceWidth,
}) {
	return (
		<div
			aria-label={`Resize ${workspaceLabel} panel`}
			aria-orientation="vertical"
			aria-valuemax={maxWidth}
			aria-valuemin={minWidth}
			aria-valuenow={Math.round(workspaceWidth)}
			class="workspace-resize-handle"
			onClick={handleClick}
			onDblClick={onDoubleClick}
			onKeyDown={onKeyDown}
			onPointerDown={onPointerDown}
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
						onCloseGraph();
					}}
					onDblClick={onDoubleClick}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{"\u25C0"}
				</button>
				<button
					type="button"
					class="workspace-resize-action"
					aria-label={`Close ${workspaceLabel} panel`}
					title={`Close ${workspaceLabel} panel`}
					onClick={(event) => {
						event.stopPropagation();
						onCloseWorkspace();
					}}
					onDblClick={onDoubleClick}
					onPointerDown={(event) => event.stopPropagation()}
				>
					{"\u25B6"}
				</button>
			</div>
		</div>
	);
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
							nodeDeleteLabel={hitlDeleteLabel}
							nodeSaveLabel={hitlNodeSaveLabel}
							onDeleteNode={deleteHitlDraftNode}
							onDeleteRelation={deleteHitlDraftRelation}
							onSaveNode={saveHitlDraftNode}
							onSaveRelation={saveHitlDraftRelation}
							onSelectItem={handleHitlOpenItem}
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
						onDeleteNode={deleteNode}
						onDeleteRelation={deleteRelation}
						onSaveNode={saveNode}
						onSaveRelation={saveRelation}
						onSelectItem={handleOpenItem}
						selectedItem={selectedItem}
					/>
				</EntityModal>
			)}
			{createModalType === "node" && (
				<EntityModal title="Create node" onClose={closeCreateModal}>
					<NodeForm
						draft={createNodeDraftValue}
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
