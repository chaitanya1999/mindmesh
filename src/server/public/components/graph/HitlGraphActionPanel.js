import { GraphActionButtons } from "./GraphActionButtons.js";
import { HitlOperationLegend } from "./HitlOperationLegend.js";

export function HitlGraphActionPanel({ isDraftMode, isDirty, onCreateNode, onCreateRelation }) {
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
