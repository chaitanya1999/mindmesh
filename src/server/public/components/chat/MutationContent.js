import { relationLabel, displayText, displayNameFromIdentifier } from "../../lib/utils.js";

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

export function MutationContent({ mutation }) {
	const nodes = mutation?.nodes ?? [];
	const relations = mutation?.relations ?? [];
	const nodeDeletes = mutation?.nodeDeletes ?? [];
	const relationDeletes = mutation?.relationDeletes ?? [];
	const triplets = mutation?.triplets ?? [];
	const schemaViolations = mutation?.schemaViolations ?? [];
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
			{schemaViolations.length > 0 && (
				<div class="triplet-list">
					{schemaViolations.map((violation, index) => (
						<div class="triplet" key={`schema-violation-${index}`}>
							<strong>Schema review required</strong>
							<div>{violation.message || String(violation)}</div>
						</div>
					))}
				</div>
			)}
			{totalMutations > 0 && (
				<div class="triplet-list">
					{nodes.map((node, index) => (
						<div class="triplet" key={`node-${node.id ?? node.name}-${index}`}>
							<strong>{operationVerb(node.operation)} node</strong>
							{`: ${node.label || displayNameFromIdentifier(node.name || node.id)}`}
							{node.description && <div class="multiline-text">{displayText(node.description)}</div>}
							{node.metadata && <div class="multiline-text">{displayText(node.metadata)}</div>}
						</div>
					))}
					{nodeDeletes.map((node, index) => (
						<div class="triplet" key={`node-delete-${node.id ?? node.name}-${index}`}>
							<strong>Deleted node</strong>
							{`: ${nodeLabel(node.name || node.id)}`}
							{node.metadata && <div class="multiline-text">{displayText(node.metadata)}</div>}
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
								{relation.information && <div class="multiline-text">{displayText(relation.information)}</div>}
								{relation.description && <div class="multiline-text">{displayText(relation.description)}</div>}
								{relation.metadata && <div class="multiline-text">{displayText(relation.metadata)}</div>}
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
