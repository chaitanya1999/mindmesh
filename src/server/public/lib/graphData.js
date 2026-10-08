
export function normalizeGraph(graph) {
	return {
		nodes: graph?.nodes ?? [],
		relations: graph?.relations ?? [],
		schema: graph?.schema ?? null,
	};
}
