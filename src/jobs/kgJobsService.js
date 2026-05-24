const JOB_TYPES = new Set(["scanner", "nugget"]);

function jobLabel(jobType) {
	return jobType === "scanner" ? "Graph scanner" : "Knowledge nugget";
}

function errorWithStatus(message, status) {
	const error = new Error(message);
	error.status = status;
	return error;
}

function graphStats(graph) {
	return `${graph.nodes?.length ?? 0} node(s), ${graph.relations?.length ?? 0} relation(s)`;
}

function relationPhrase(relation) {
	return String(relation ?? "relates_to").replaceAll("_", " ");
}

function sentence(value) {
	const text = String(value ?? "").trim();
	if (!text) {
		return "";
	}

	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function formatJobGraphContext(graph) {
	const nodes = graph.nodes ?? [];
	const relations = graph.relations ?? [];
	const nodeById = new Map(nodes.map((node) => [node.id, node]));
	const nodeLines = nodes.map((node) => [
		`- ${node.id}: ${node.label || node.name || node.id}`,
		`type=${node.type || "concept"}`,
		`name=${node.name || ""}`,
		node.description ? `description=${sentence(node.description)}` : "",
		node.metadata ? `metadata=${node.metadata}` : "",
	].filter(Boolean).join(" | "));
	const relationLines = relations.map((relation) => {
		const source = nodeById.get(relation.sourceId);
		const target = nodeById.get(relation.targetId);
		return [
			`- ${relation.id}: ${source?.label || relation.sourceId} (${relation.sourceId}) ${relationPhrase(relation.relation)} ${target?.label || relation.targetId} (${relation.targetId}).`,
			relation.information ? `Information: ${sentence(relation.information)}` : "",
			relation.description ? `Description: ${sentence(relation.description)}` : "",
			relation.metadata ? `Metadata: ${relation.metadata}` : "",
		].filter(Boolean).join(" ");
	});

	return [
		"Nodes:",
		nodeLines.length > 0 ? nodeLines.join("\n") : "- No nodes found.",
		"",
		"Relations:",
		relationLines.length > 0 ? relationLines.join("\n") : "- No relations found.",
	].join("\n");
}

function buildJobPrompt({ anchorNode, depth, graph, jobType }) {
	const graphContext = formatJobGraphContext(graph);
	return [
		`Job: ${jobLabel(jobType)}`,
		`Anchor node: ${anchorNode.label || anchorNode.name || anchorNode.id} (${anchorNode.id})`,
		`Neighborhood depth: ${depth}`,
		`Neighborhood size: ${graphStats(graph)}`,
		"",
		"Graph neighborhood:",
		graphContext,
		"",
		"Produce the requested job output now.",
	].join("\n");
}

function fallbackSystemPrompt(jobType) {
	if (jobType === "scanner") {
		return "Inspect the graph neighborhood for knowledge graph quality risks. Cite node and relation IDs.";
	}

	return "Write one concise daily knowledge nugget from the supplied graph neighborhood. Cite node and relation IDs where helpful.";
}

export class KgJobsService {
	constructor({ graphStore, llmProvider, prompts = {} }) {
		this.graphStore = graphStore;
		this.llmProvider = llmProvider;
		this.prompts = prompts;
	}

	async getAnchorNode(nodeId) {
		if (nodeId) {
			const node = await this.graphStore.getNode(nodeId);
			if (!node) {
				throw errorWithStatus(`Node ${nodeId} was not found.`, 404);
			}

			return node;
		}

		if (typeof this.graphStore.getRandomNode !== "function") {
			throw errorWithStatus("Graph store does not support random node selection.", 501);
		}

		const node = await this.graphStore.getRandomNode();
		if (!node) {
			throw errorWithStatus("The graph does not contain any active nodes to inspect.", 404);
		}

		return node;
	}

	systemPromptFor(jobType) {
		if (jobType === "scanner") {
			return this.prompts.jobScannerSystem || fallbackSystemPrompt(jobType);
		}

		return this.prompts.jobNuggetSystem || fallbackSystemPrompt(jobType);
	}

	async runJob({ jobType, depth = 2, nodeId = "" } = {}) {
		if (!JOB_TYPES.has(jobType)) {
			throw errorWithStatus(`Unsupported job type: ${jobType}.`, 400);
		}

		const startedAt = new Date().toISOString();
		const anchorNode = await this.getAnchorNode(String(nodeId ?? "").trim());
		const graph = await this.graphStore.expandFromNodes([anchorNode.id], depth);
		const outputMarkdown = await this.llmProvider.generateAnswer({
			systemPrompt: this.systemPromptFor(jobType),
			prompt: buildJobPrompt({
				anchorNode,
				depth,
				graph,
				jobType,
			}),
		});
		const completedAt = new Date().toISOString();

		return {
			jobType,
			anchorNode,
			depth,
			graph,
			outputMarkdown: String(outputMarkdown ?? "").trim(),
			startedAt,
			completedAt,
		};
	}
}
