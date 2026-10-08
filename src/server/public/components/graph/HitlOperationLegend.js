import { HITL_CONTEXT_NODE_COLOR, HITL_OPERATION_COLORS } from "./graphStyle.js";

export function HitlOperationLegend() {
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
