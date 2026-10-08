import { NodeForm } from "./NodeForm.js";
import { NodeRelationshipList } from "./NodeRelationshipList.js";
import { RelationForm } from "./RelationForm.js";
import { relationLabel, displayText } from "../../lib/utils.js";

export function DetailPanel({
	graph,
	nodeTypes = [],
	nodeDeleteLabel = "Delete",
	nodeSaveLabel = "Save node",
	onDeleteNode,
	onDeleteRelation,
	onSaveNode,
	onSaveRelation,
	onSelectItem,
	relationshipTypes = [],
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
						<strong class="multiline-text">{displayText(selectedNode.metadata)}</strong>
					</div>
				)}
				<NodeForm
					deleteLabel={nodeDeleteLabel}
					node={selectedNode}
					nodeTypes={nodeTypes}
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
						<strong class="multiline-text">{displayText(selectedRelation.metadata)}</strong>
					</div>
				)}
				<RelationForm
					deleteLabel={relationDeleteLabel}
					graph={graph}
					relation={selectedRelation}
					relationshipTypes={relationshipTypes}
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
