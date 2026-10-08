import { relationLabel } from "../../lib/utils.js";

export function TripletContent({ triplets }) {
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
