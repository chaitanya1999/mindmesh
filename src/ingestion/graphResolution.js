// Checks a normalized payload against the graph. normalizeGraphPayload() sees only the payload and the
// schema; this step knows which nodes already exist, so it enforces the rules that need the graph:
// - a relation never creates a node: each endpoint must have a node record in the payload or already
//   exist in the graph (and must not be deleted by the same payload);
// - an endpoint that already exists is only a reference and is never written;
// - NODE_CREATE for a node that already exists is applied as NODE_UPDATE and flagged for review;
// - a record that replaces the non-empty scope of an existing node is flagged for review (a blank scope keeps it);
// - with an ingest scope, a record that touches an existing node scoped outside it (a node record, or a
//   relation using it as an endpoint) is flagged for review.

import { formatScope, matchesScope, parseScope, scopeEnabled } from "../schema/scope.js";

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

// `scope`: the ingest scope of the extraction ("" when there is none, for example at approval time).
export async function resolveGraphPayload(graphPayload, graphStore, { scope = "" } = {}) {
	if (typeof graphStore?.getExistingNodeIds !== "function") {
		throw new Error("The configured graph store cannot check which nodes exist.");
	}

	const payloadNodeIds = new Set((graphPayload.nodes ?? []).map((node) => node.id));
	const deletedNodeIds = new Set((graphPayload.nodeDeletes ?? []).map((nodeDelete) => nodeDelete.id));
	const endpointIds = (graphPayload.relations ?? []).flatMap((relation) => [relation.sourceId, relation.targetId]);
	const lookupIds = [...new Set([...payloadNodeIds, ...endpointIds])].filter(Boolean);
	const existingNodeIds = new Set(lookupIds.length > 0 ? await graphStore.getExistingNodeIds(lookupIds) : []);
	// Stored node scopes are needed for the scope checks only when node scopes are in use.
	const ingestScope = scopeEnabled("node") ? formatScope(scope) : "";
	const checksScopes = scopeEnabled("node") && (Boolean(ingestScope) || (graphPayload.nodes ?? []).some((node) => parseScope(node.scope).length > 0));
	const existingIds = [...existingNodeIds];
	const storedScopes = new Map(checksScopes && existingIds.length > 0 && typeof graphStore.getNodesByIds === "function"
		? (await graphStore.getNodesByIds(existingIds)).map((node) => [node.id, formatScope(node.scope)])
		: []);
	// A stored scope that the ingest scope does not match (unscoped and common nodes always match).
	const outsideScope = (nodeId) => {
		const stored = storedScopes.get(nodeId);
		return Boolean(ingestScope && stored && !matchesScope(stored, ingestScope));
	};
	let changed = false;

	const nodes = (graphPayload.nodes ?? []).map((node) => {
		let next = node;
		if (node.operation === "create" && existingNodeIds.has(node.id)) {
			next = {
				...next,
				operation: "update",
				metadata: appendSignal(next.metadata, `AMBIGUITY: "${node.name}" already exists in the graph, so NODE_CREATE is applied as NODE_UPDATE. Confirm it is the same entity.`),
			};
		}
		const storedScope = storedScopes.get(node.id);
		const proposedScope = formatScope(node.scope);
		if (storedScope && proposedScope && storedScope !== proposedScope) {
			next = {
				...next,
				metadata: appendSignal(next.metadata, `AMBIGUITY: scope of "${node.name}" changes from ${storedScope} to ${proposedScope}. Confirm the new scope.`),
			};
		}
		if (outsideScope(node.id)) {
			next = {
				...next,
				metadata: appendSignal(next.metadata, `AMBIGUITY: "${node.name}" is scoped ${storedScope}, outside this input's scope ${ingestScope}. Confirm the change belongs to it.`),
			};
		}
		if (next !== node) {
			changed = true;
		}
		return next;
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
			const outside = [relation.sourceId, relation.targetId].filter(outsideScope);
			if (outside.length === 0) {
				return relation;
			}
			changed = true;
			const names = outside.map((id) => `"${graphNameFromId(id)}" (scoped ${storedScopes.get(id)})`).join(" and ");
			return {
				...relation,
				metadata: appendSignal(relation.metadata, `AMBIGUITY: this relation uses ${names}, outside this input's scope ${ingestScope}. Confirm it.`),
			};
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
