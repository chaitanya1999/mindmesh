export function formatGraphContext(graph, prompts = {}) {
	const nodes = graph?.nodes ?? [];
	const relations = graph?.relations ?? [];
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const nodeLines = nodes.map((node) =>
		`- ${node.label || node.name || node.id} (${node.id}) | name: ${node.name} | type: ${node.type} | description: ${node.description || ""} | metadata: ${node.metadata || ""}`,
	);
	const relationLines = relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);
		const sourceLabel = source?.label || source?.name || relation.sourceId;
		const targetLabel = target?.label || target?.name || relation.targetId;

		return `- ${relation.id} | ${sourceLabel} (${relation.sourceId}) -[${relation.relation}]-> ${targetLabel} (${relation.targetId}) | information: ${relation.information || ""} | description: ${relation.description || ""} | metadata: ${relation.metadata || ""}`;
	});

	return [
		prompts.contextFormat || "Format graph context as compact node and relation lists.",
		"",
		"Nodes:",
		nodeLines.length > 0 ? nodeLines.join("\n") : "- No nodes found.",
		"",
		"Relations:",
		relationLines.length > 0 ? relationLines.join("\n") : "- No relations found.",
	].join("\n");
}

function relationPhrase(relation) {
	return String(relation ?? "relates_to").replaceAll("_", " ");
}

function nodeReference(node, fallbackId) {
	const id = node?.id || fallbackId;
	const label = node?.label || node?.name || id;
	return `[${id}] ${label}`;
}

function compact(value) {
	return String(value ?? "").trim();
}

function sentence(value) {
	const text = compact(value);
	if (!text) {
		return "";
	}

	return /[.!?]$/.test(text) ? text : `${text}.`;
}

export function formatExtractionGraphContext(graph) {
	const nodes = graph?.nodes ?? [];
	const relations = graph?.relations ?? [];
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const nodeLines = nodes.map((node) => {
		const details = [`type: ${node.type || "concept"}`, `name: ${node.name || node.id}`];
		const description = compact(node.description);
		return `- ${nodeReference(node, node.id)} (${details.join(", ")}).${description ? ` Detail: ${sentence(description)}` : ""}`;
	});
	const relationLines = relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);
		const information = compact(relation.information);
		const description = compact(relation.description);
		return [
			`- ${nodeReference(source, relation.sourceId)} ${relationPhrase(relation.relation)} ${nodeReference(target, relation.targetId)}.`,
			information ? `Extra: ${sentence(information)}` : "",
			description ? `Details: ${sentence(description)}` : "",
		].filter(Boolean).join(" ");
	});

	return [
		"Use this existing graph context only for identity resolution, node reuse, and disambiguation.",
		"Node IDs are shown in square brackets and must be reused exactly when the new input refers to the same real-world entity.",
		"",
		"Existing nodes:",
		nodeLines.length > 0 ? nodeLines.join("\n") : "- No existing nodes found.",
		"",
		"Existing facts:",
		relationLines.length > 0 ? relationLines.join("\n") : "- No existing relations found.",
	].join("\n");
}
