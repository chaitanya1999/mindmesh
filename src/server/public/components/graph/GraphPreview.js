import { useCallback, useEffect, useMemo, useRef } from "preact/hooks";
import Graph from "graphology";
import forceLayout from "graphology-layout-force";
import Sigma from "sigma";
import {
	DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS,
	createEdgeArrowProgram,
} from "sigma/rendering";
import { createEdgeCurveProgram, indexParallelEdgesIndex } from "@sigma/edge-curve";
import { GraphPanelHeader } from "./GraphPanelHeader.js";
import { DEFAULT_NODE_COLOR, HITL_CONTEXT_NODE_COLOR, GRAPH_SELECTION_COLOR, GRAPH_SELECTION_DIM_NODE_COLOR, GRAPH_SELECTION_DIM_EDGE_COLOR, DEFAULT_NODE_SIZE, createNodeTypeColorMap, nodeColorFromTypeMap, hitlOperationColor, hitlOperationEdgeStyle, createLinkCountByNodeId, nodeSizeForLinkCount } from "./graphStyle.js";
import { normalizeGraph } from "../../lib/graphData.js";
import { truncate, relationLabel } from "../../lib/utils.js";

const NODE_FOCUS_SIZE_DELTA = 3.2;
const SIGMA_DIMMED_NODE_MIN_SIZE = DEFAULT_NODE_SIZE * 0.72;
const SIGMA_EDGE_SIZE = 1.4;
const SIGMA_DIMMED_EDGE_SIZE = 0.6;
const SIGMA_ARROW_HEAD_SCALE = 2;
const LARGE_ARROW_HEAD_OPTIONS = {
	...DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS,
	lengthToThicknessRatio: DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS.lengthToThicknessRatio * SIGMA_ARROW_HEAD_SCALE,
	widenessToThicknessRatio: DEFAULT_EDGE_ARROW_HEAD_PROGRAM_OPTIONS.widenessToThicknessRatio * SIGMA_ARROW_HEAD_SCALE,
};
const LargeArrowProgram = createEdgeArrowProgram(LARGE_ARROW_HEAD_OPTIONS);
const LargeCurvedArrowProgram = createEdgeCurveProgram({
	arrowHead: LARGE_ARROW_HEAD_OPTIONS,
});

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

		const graphologyGraph = graphologyGraphRef.current;
		if (graphologyGraph && graphologyGraph.order > 0) {
			forceLayout.assign(graphologyGraph, {
				maxIterations: 80,
				settings: {
					attraction: 0.0008,
					repulsion: 0.18,
					gravity: 0.04,
					inertia: 0.6,
					maxMove: 12,
				},
			});
		}

		renderer.refresh();
	});

	return clearPendingNodeSelection;
}

export function GraphPreview({
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
