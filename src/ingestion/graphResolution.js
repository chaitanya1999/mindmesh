// Checks a normalized payload against the graph. normalizeGraphPayload() sees only the payload and the
// schema; this step knows which nodes already exist, so it enforces the rules that need the graph:
// - a relation never creates a node: each endpoint must have a node record in the payload or already
//   exist in the graph (and must not be deleted by the same payload);
// - an endpoint that already exists is only a reference and is never written;
// - NODE_CREATE for a node that already exists is applied as NODE_UPDATE and flagged for review.

function graphNameFromId(value) {
	return String(value ?? "").replace(/^node:/i, "");
}

function appendSignal(metadata, signal) {
	const text = String(metadata ?? "").trim();
	if (text.includes(signal)) {
		return text;
	}

	return text ? `${text}; ${signal}` : signal;
}

export async function resolveGraphPayload(graphPayload, graphStore) {
	if (typeof graphStore?.getExistingNodeIds !== "function") {
		throw new Error("The configured graph store cannot check which nodes exist.");
	}

	const payloadNodeIds = new Set((graphPayload.nodes ?? []).map((node) => node.id));
	const deletedNodeIds = new Set((graphPayload.nodeDeletes ?? []).map((nodeDelete) => nodeDelete.id));
	const endpointIds = (graphPayload.relations ?? []).flatMap((relation) => [relation.sourceId, relation.targetId]);
	const lookupIds = [...new Set([...payloadNodeIds, ...endpointIds])].filter(Boolean);
	const existingNodeIds = new Set(lookupIds.length > 0 ? await graphStore.getExistingNodeIds(lookupIds) : []);
	let changed = false;

	const nodes = (graphPayload.nodes ?? []).map((node) => {
		if (node.operation !== "create" || !existingNodeIds.has(node.id)) {
			return node;
		}

		changed = true;
		return {
			...node,
			operation: "update",
			metadata: appendSignal(node.metadata, `AMBIGUITY: "${node.name}" already exists in the graph, so NODE_CREATE is applied as NODE_UPDATE. Confirm it is the same entity.`),
		};
	});

	const violations = [];
	const relations = (graphPayload.relations ?? []).map((relation) => {
		const problems = [];
		for (const endpointId of [relation.sourceId, relation.targetId]) {
			const name = graphNameFromId(endpointId);
			if (deletedNodeIds.has(endpointId)) {
				problems.push(`node "${name}" is deleted by this proposal`);
			} else if (!payloadNodeIds.has(endpointId) && !existingNodeIds.has(endpointId)) {
				problems.push(`node "${name}" does not exist`);
			}
		}

		if (problems.length === 0) {
			return relation;
		}

		const sourceName = graphNameFromId(relation.sourceId);
		const targetName = graphNameFromId(relation.targetId);
		const message = `Relation "${sourceName}" -> "${targetName}": ${problems.join(" and ")}. Relations never create nodes; add a NODE_CREATE record or use an existing node name.`;
		violations.push({
			kind: "relationEndpoint",
			value: relation.id,
			message,
			record: { sourceName, targetName, relation: relation.relation },
		});
		changed = true;
		return {
			...relation,
			metadata: appendSignal(relation.metadata, `AMBIGUITY: ${problems.join(" and ")}.`),
		};
	});

	return {
		changed,
		graphPayload: {
			...graphPayload,
			nodes,
			relations,
			schemaViolations: [...(graphPayload.schemaViolations ?? []), ...violations],
			schemaWarnings: [...new Set([...(graphPayload.schemaWarnings ?? []), ...violations.map((violation) => violation.message)])],
		},
	};
}
