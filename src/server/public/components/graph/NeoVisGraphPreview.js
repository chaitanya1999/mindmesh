import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import NeoVisPackage from "neovis.js";
import { GraphPanelHeader } from "./GraphPanelHeader.js";
import { DEFAULT_NODE_COLOR, HITL_CONTEXT_NODE_COLOR, GRAPH_SELECTED_NODE_BORDER_WIDTH, GRAPH_SELECTION_COLOR, GRAPH_SELECTION_DIM_NODE_COLOR, GRAPH_SELECTION_DIM_EDGE_COLOR, NEOVIS_EDGE_SIZE, HITL_PENDING_EDGE_WIDTH, createNodeTypeColorMap, nodeColorFromTypeMap, hitlOperationColor, selectedNodeColor, selectedEdgeColor, hitlOperationEdgeStyle, hitlNodeColor, createLinkCountByNodeId, nodeSizeForLinkCount } from "./graphStyle.js";
import { normalizeGraph } from "../../lib/graphData.js";
import { truncate, relationLabel, displayText, clampNumber } from "../../lib/utils.js";

const NEOVIS_ARROW_SCALE_FACTOR = 0.6;
const NEOVIS_NODE_FOCUS_SCALE = 1.55;
const NeoVis = NeoVisPackage.NeoVis ?? NeoVisPackage.default?.NeoVis ?? NeoVisPackage.default ?? NeoVisPackage;
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
				description: displayText(node.description),
				metadata: displayText(node.metadata),
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
					["Description", displayText(node.description)],
					["Metadata", displayText(node.metadata)],
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
					information: displayText(relation.information),
					description: displayText(relation.description),
					metadata: displayText(relation.metadata),
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
						["Information", displayText(relation.information)],
						["Description", displayText(relation.description)],
						["Metadata", displayText(relation.metadata)],
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

	// Visual style sets: full neighborhood for dimming/highlighting (no drag impact)
	const styleNodeVisIds = new Set(
		(highlightNodeIds ?? [])
			.map((nodeId) => graphData.nodeVisIdById.get(nodeId))
			.filter((nodeId) => nodeId !== undefined),
	);
	const styleRelationVisIds = new Set(
		(highlightRelationIds ?? [])
			.map((relationId) => graphData.relationVisIdById.get(relationId))
			.filter((relationId) => relationId !== undefined),
	);

	// Interaction selection sets: only the directly focused item (avoids group drag)
	const selectionNodeVisIds = new Set();
	const selectionRelationVisIds = new Set();

	function addConnectedNeighborhood(nodeId, targetSets) {
		const { nodeSet, relationSet } = targetSets;
		for (const [relationId, endpoints] of graphData.edgeEndpointById.entries()) {
			if (endpoints.sourceId !== nodeId && endpoints.targetId !== nodeId) {
				continue;
			}

			const relationVisId = graphData.relationVisIdById.get(relationId);
			if (relationVisId !== undefined) {
				relationSet.add(relationVisId);
			}

			const neighborId = endpoints.sourceId === nodeId ? endpoints.targetId : endpoints.sourceId;
			const neighborVisId = graphData.nodeVisIdById.get(neighborId);
			if (neighborVisId !== undefined) {
				nodeSet.add(neighborVisId);
			}
		}
	}

	for (const nodeId of highlightNodeIds ?? []) {
		addConnectedNeighborhood(nodeId, { nodeSet: styleNodeVisIds, relationSet: styleRelationVisIds });
	}

	if (focusedItem?.type === "node") {
		const nodeVisId = graphData.nodeVisIdById.get(focusedItem.id);
		if (nodeVisId !== undefined) {
			// Visual: full neighborhood
			styleNodeVisIds.add(nodeVisId);
			addConnectedNeighborhood(focusedItem.id, { nodeSet: styleNodeVisIds, relationSet: styleRelationVisIds });
			// Selection: just the focused node
			selectionNodeVisIds.add(nodeVisId);
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
			// Visual: relation highlighted
			styleRelationVisIds.add(relationVisId);
			// Selection: relation selected for interaction
			selectionRelationVisIds.add(relationVisId);
		}

		const endpoints = graphData.edgeEndpointById.get(focusedItem.id);
		const endpointVisIds = endpoints
			? [endpoints.sourceId, endpoints.targetId]
				.map((nodeId) => graphData.nodeVisIdById.get(nodeId))
				.filter((nodeId) => nodeId !== undefined)
			: [];
		for (const nodeVisId of endpointVisIds) {
			// Visual: highlight the relation's endpoint nodes
			styleNodeVisIds.add(nodeVisId);
			// Do NOT add to selectionNodeVisIds — avoids group drag on connected nodes
		}
		if (focusCamera && endpointVisIds.length > 0) {
			network.fit({
				animation: { duration: 420, easingFunction: "easeInOutQuad" },
				nodes: endpointVisIds,
			});
		}
	}

	// Only select the minimal set for interaction (avoids group drag on click+click-drag)
	network.setSelection({
		nodes: [...selectionNodeVisIds],
		edges: [...selectionRelationVisIds],
	}, {
		highlightEdges: true,
		unselectAll: true,
	});
	applyNeoVisSelectionStyles(visualization, graphData, styleNodeVisIds, styleRelationVisIds);
}

export function NeoVisGraphPreview({
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
			const graphData = graphDataRef.current;
			if (!visualization?.network || !graphData) {
				return;
			}

			const previewNodeVisIds = new Set();
			const previewRelationVisIds = new Set();

			function addConnectedNeighborhood(nodeId) {
				for (const [relationId, endpoints] of graphData.edgeEndpointById.entries()) {
					if (endpoints.sourceId !== nodeId && endpoints.targetId !== nodeId) {
						continue;
					}

					const relationVisId = graphData.relationVisIdById.get(relationId);
					if (relationVisId !== undefined) {
						previewRelationVisIds.add(relationVisId);
					}

					const neighborId = endpoints.sourceId === nodeId ? endpoints.targetId : endpoints.sourceId;
					const neighborVisId = graphData.nodeVisIdById.get(neighborId);
					if (neighborVisId !== undefined) {
						previewNodeVisIds.add(neighborVisId);
					}
				}
			}

			if (item?.type === "node") {
				const nodeVisId = graphData.nodeVisIdById.get(item.id);
				if (nodeVisId !== undefined) {
					previewNodeVisIds.add(nodeVisId);
					addConnectedNeighborhood(item.id);
				}
			} else if (item?.type === "relation") {
				const relationVisId = graphData.relationVisIdById.get(item.id);
				if (relationVisId !== undefined) {
					previewRelationVisIds.add(relationVisId);
				}

				const endpoints = graphData.edgeEndpointById.get(item.id);
				if (endpoints) {
					for (const nodeId of [endpoints.sourceId, endpoints.targetId]) {
						const nodeVisId = graphData.nodeVisIdById.get(nodeId);
						if (nodeVisId !== undefined) {
							previewNodeVisIds.add(nodeVisId);
						}
					}
				}
			}

			applyNeoVisSelectionStyles(visualization, graphData, previewNodeVisIds, previewRelationVisIds);
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

			let isDragging = false;

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
			const handleDragStart = () => {
				isDragging = true;
			};
			const handleDragEnd = () => {
				isDragging = false;
			};

			const handleHoverNode = (params) => {
				if (isDragging) {
					return;
				}
				const nodeId = graphDataRef.current?.nodeIdByVisId.get(Number(params.node));
				if (nodeId) {
					previewSelection({ type: "node", id: nodeId, skipCamera: true });
				}
			};
			const handleBlurNode = () => {
				if (isDragging) {
					return;
				}
				restoreSelection();
			};
			const handleHoverEdge = (params) => {
				if (isDragging) {
					return;
				}
				const relationId = graphDataRef.current?.relationIdByVisId.get(Number(params.edge));
				if (relationId) {
					previewSelection({ type: "relation", id: relationId });
				}
			};
			const handleBlurEdge = () => {
				if (isDragging) {
					return;
				}
				restoreSelection();
			};

			network.on("click", handleClickStage);
			network.on("doubleClick", handleDoubleClick);
			network.on("dragStart", handleDragStart);
			network.on("dragEnd", handleDragEnd);
			network.on("hoverNode", handleHoverNode);
			network.on("blurNode", handleBlurNode);
			network.on("hoverEdge", handleHoverEdge);
			network.on("blurEdge", handleBlurEdge);
			return () => {
				network.off("click", handleClickStage);
				network.off("doubleClick", handleDoubleClick);
				network.off("dragStart", handleDragStart);
				network.off("dragEnd", handleDragEnd);
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
