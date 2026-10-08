
export function GraphActionButtons({ onCreateNode, onCreateRelation }) {
	return (
		<div class="graph-action-bar" aria-label="Create graph items">
			<button type="button" class="primary" onClick={onCreateNode}>{"⊕"} Node</button>
			<button type="button" onClick={onCreateRelation}>{"↔"} Relation</button>
		</div>
	);
}
