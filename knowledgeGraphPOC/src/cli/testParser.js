import { extractJsonObject, normalizeGraphPayload } from "../ingestion/graphPayload.js";

const rawJson = '{"nodes":[{"label":"EKYC Screen","name":"ekyc_screen","type":"screen","description":""}],"relations":[]}';
const fencedJson = '```json\n{"nodes":[],"relations":[{"sourceName":"EKYC Screen","targetName":"PAN API","relation":"uses"}]}\n```';

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

let invalidFailed = false;
try {
  extractJsonObject("not json");
} catch {
  invalidFailed = true;
}
assert(invalidFailed, "Invalid extraction did not fail.");

console.log("[PASS] graph extraction parser smoke tests");
