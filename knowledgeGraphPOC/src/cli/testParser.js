import { extractCustomGraph, extractJsonObject, normalizeGraphPayload, parseGraphExtraction } from "../ingestion/graphPayload.js";

const rawJson = '{"nodes":[{"label":"EKYC Screen","name":"ekyc_screen","type":"screen","description":""}],"relations":[]}';
const fencedJson = '```json\n{"nodes":[],"relations":[{"sourceName":"EKYC Screen","targetName":"PAN API","relation":"uses"}]}\n```';
const customGraph = [
  "NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
  "NODE|pan_api|PAN API|api|API that verifies PAN details.",
  "RELATION|ekyc_screen|pan_api|uses|EKYC Screen uses PAN API.|Used during verification.",
].join("\n");
const customGraphWithSuggestion = [
  "NODE|ekyc_screen|EKYC Screen|screen|Screen that captures identity details.",
  "NODE|pan_api|PAN API|api|API that verifies PAN details.",
  "RELATION|ekyc_screen|pan_api|validates_with|EKYC Screen validates with PAN API.|Used during verification.",
  "RELATION_TYPE_SUGGESTION|validates_with|Source validates data using target.|More specific than uses.",
].join("\n");

const schema = {
  path: "",
  fallbacks: {
    nodeType: "concept",
    relationshipType: "relates_to",
  },
  nodeTypes: [
    { name: "concept", description: "Fallback." },
    { name: "screen", description: "UI screen." },
    { name: "api", description: "API." },
  ],
  relationshipTypes: [
    { name: "relates_to", description: "Fallback." },
    { name: "uses", description: "Uses target." },
  ],
  suggestions: {
    nodeTypes: [{ name: "journey_step", description: "Pending node suggestion." }],
    relationshipTypes: [{ name: "validates_with", description: "Pending relationship suggestion." }],
  },
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const rawPayload = normalizeGraphPayload(extractJsonObject(rawJson));
assert(rawPayload.nodes[0].id === "node:ekyc_screen", "Raw JSON parser failed.");

const fencedPayload = normalizeGraphPayload(extractJsonObject(fencedJson));
assert(fencedPayload.nodes.length === 2, "Fenced JSON parser or endpoint normalization failed.");
assert(fencedPayload.relations.length === 1, "Relation normalization failed.");

const customPayload = normalizeGraphPayload(extractCustomGraph(customGraph));
assert(customPayload.nodes.length === 2, "Custom graph parser failed.");
assert(customPayload.relations[0].relation === "uses", "Custom relation parser failed.");

const switchedPayload = normalizeGraphPayload(parseGraphExtraction(customGraph, { format: "custom" }));
assert(switchedPayload.nodes[0].id === "node:ekyc_screen", "Switchable parser failed.");

const suggestionPayload = extractCustomGraph(customGraphWithSuggestion);
assert(suggestionPayload.schemaSuggestions.relationshipTypes[0].name === "validates_with", "Custom schema suggestion parser failed.");

const strictPayload = normalizeGraphPayload(suggestionPayload, { schema, autoApplySuggestions: false });
assert(strictPayload.relations[0].relation === "relates_to", "Strict schema fallback failed.");
assert(strictPayload.schemaWarnings.length === 1, "Strict schema warning failed.");

const autoAppliedPayload = normalizeGraphPayload(suggestionPayload, { schema, autoApplySuggestions: true });
assert(autoAppliedPayload.relations[0].relation === "validates_with", "Auto-applied schema suggestion failed.");

const pendingSuggestionPayload = normalizeGraphPayload({
  nodes: [{ name: "search_step", label: "Search Step", type: "journey_step" }],
  relations: [],
}, { schema, autoApplySuggestions: true });
assert(pendingSuggestionPayload.nodes[0].type === "journey_step", "Auto-applied implicit node suggestion failed.");
assert(pendingSuggestionPayload.schemaSuggestions.nodeTypes[0].name === "journey_step", "Implicit node suggestion was not captured.");


let invalidFailed = false;
try {
  extractJsonObject("not json");
} catch {
  invalidFailed = true;
}
assert(invalidFailed, "Invalid extraction did not fail.");

console.log("[PASS] graph extraction parser smoke tests");
