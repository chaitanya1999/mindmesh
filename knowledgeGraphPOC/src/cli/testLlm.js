import { getConfig, describeRuntime } from "../config.js";
import { parseArgs } from "../input/readInput.js";
import { createLlmProvider } from "../llm/providerFactory.js";
import { loadPrompts } from "../prompts/promptRegistry.js";
import { normalizeGraphPayload } from "../ingestion/graphPayload.js";

const SAMPLE_TEXT = "EKYC Screen uses PAN Verification API. PAN Verification API validates customer PAN details during onboarding.";

async function runCheck(name, check) {
	try {
		const result = await check();
		console.log(`[PASS] ${name}`);
		return result;
	} catch (error) {
		console.log(`[FAIL] ${name}`);
		console.log(`       ${error.message}`);
		process.exitCode = 1;
		return null;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const config = getConfig();
	const providerName = args.provider || config.llm.provider;
	const llmProvider = createLlmProvider(config, providerName);
	const prompts = loadPrompts(config);

	console.log("Knowledge Graph POC LLM provider test");
	console.log(JSON.stringify({
		...describeRuntime(config),
		llmProvider: providerName,
	}, null, 2));
	console.log("");

	const generation = await runCheck("LLM text generation", () =>
		llmProvider.generateText({
			systemPrompt: "You are a concise test assistant.",
			prompt: "Reply with exactly one short sentence confirming you are reachable.",
		}),
	);

	if (generation) {
		console.log(`       ${generation.trim().slice(0, 240)}`);
	}

	const extracted = await runCheck("LLM graph extraction", async () => {
		const graph = await llmProvider.extractGraph({
			text: args.textParts.join(" ").trim() || SAMPLE_TEXT,
			systemPrompt: prompts.extractionSystem,
		});
		return normalizeGraphPayload(graph, {
			schema: prompts.graphSchema,
			autoApplySuggestions: prompts.schemaAutoApplySuggestions,
		});
	});

	if (extracted) {
		console.log(`       nodes=${extracted.nodes.length}, relations=${extracted.relations.length}`);
		for (const node of extracted.nodes.slice(0, 5)) {
			console.log(`       node: ${node.id} | ${node.label} | ${node.name}`);
		}
		for (const relation of extracted.relations.slice(0, 5)) {
			console.log(`       relation: ${relation.sourceId} -[${relation.relation}]-> ${relation.targetId}`);
		}
	}
}

main().catch((error) => {
	console.error("Knowledge Graph POC LLM test failed.");
	console.error(error.message);
	process.exit(1);
});
