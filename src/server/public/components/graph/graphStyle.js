import { toSnakeCase, clampNumber } from "../../lib/utils.js";

export const DEFAULT_NODE_COLOR = "#94a3b8";
export const HITL_CONTEXT_NODE_COLOR = "#94a3b8";
const HITL_CONTEXT_EDGE_COLOR = "#64748b";
export const HITL_OPERATION_COLORS = Object.freeze({
	create: "#2f9e44",
	update: "#f59f00",
	delete: "#d94848",
	fallback: "#64748b",
});
export const GRAPH_SELECTED_NODE_BORDER_WIDTH = 3;
export const GRAPH_SELECTION_COLOR = "#67e8f9";
const GRAPH_SELECTION_BORDER_COLOR = "#f8fafc";
export const GRAPH_SELECTION_DIM_NODE_COLOR = "#475569";
export const GRAPH_SELECTION_DIM_EDGE_COLOR = "#334155";
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
export const DEFAULT_NODE_SIZE = 3.2;
const NODE_LINK_SIZE_STEP = 2.6;
const NODE_LINK_SIZE_MAX_BONUS = 14.4;
export const NEOVIS_EDGE_SIZE = 1.4;
export const HITL_PENDING_EDGE_WIDTH = NEOVIS_EDGE_SIZE * 1.7;
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

export function createNodeTypeColorMap(nodes) {
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

export function nodeColorFromTypeMap(type, colorByType) {
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

export function hitlOperationColor(operation) {
	return HITL_OPERATION_COLORS[normalizedHitlOperation(operation)] ?? HITL_OPERATION_COLORS.fallback;
}

export function selectedNodeColor(baseColor) {
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

export function selectedEdgeColor(baseColor) {
	return {
		color: baseColor || GRAPH_SELECTION_COLOR,
		highlight: GRAPH_SELECTION_COLOR,
		hover: GRAPH_SELECTION_COLOR,
	};
}

export function hitlOperationEdgeStyle(relation, hasPendingHitl = false) {
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

export function hitlNodeColor(node, fillColor, hasPendingHitl = false) {
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

export function createLinkCountByNodeId(nodes, relations) {
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

export function nodeSizeForLinkCount(linkCount, scale = 1) {
	const count = Math.max(0, Number(linkCount) || 0);
	const linkBonus = Math.min(Math.sqrt(count) * NODE_LINK_SIZE_STEP, NODE_LINK_SIZE_MAX_BONUS);
	return (DEFAULT_NODE_SIZE + linkBonus) * scale;
}
