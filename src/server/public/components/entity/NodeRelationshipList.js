import { relationLabel } from "../../lib/utils.js";

function nodeLabelById(graph, nodeId) {
	return graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

export function NodeRelationshipList({ graph, nodeId, onSelectItem }) {
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
