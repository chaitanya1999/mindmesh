import crypto from "node:crypto";

export function toSnakeCase(value) {
  return String(value ?? "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function labelFromName(name) {
  return name
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function stableHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

export function normalizeGraphPayload(payload) {
  const nodeMap = new Map();

  for (const rawNode of payload.nodes ?? []) {
    const name = toSnakeCase(rawNode.name || rawNode.label);
    if (!name) {
      continue;
    }

    nodeMap.set(name, {
      id: rawNode.id || `node:${name}`,
      label: rawNode.label || labelFromName(name),
      name,
      type: toSnakeCase(rawNode.type || "concept") || "concept",
      description: rawNode.description || "",
    });
  }

  const relations = [];

  for (const rawRelation of payload.relations ?? []) {
    const sourceName = toSnakeCase(rawRelation.sourceName || rawRelation.source || rawRelation.sourceId);
    const targetName = toSnakeCase(rawRelation.targetName || rawRelation.target || rawRelation.targetId);
    const relation = toSnakeCase(rawRelation.relation || "relates_to") || "relates_to";

    if (!sourceName || !targetName) {
      continue;
    }

    if (!nodeMap.has(sourceName)) {
      nodeMap.set(sourceName, {
        id: `node:${sourceName}`,
        label: labelFromName(sourceName),
        name: sourceName,
        type: "concept",
        description: "",
      });
    }

    if (!nodeMap.has(targetName)) {
      nodeMap.set(targetName, {
        id: `node:${targetName}`,
        label: labelFromName(targetName),
        name: targetName,
        type: "concept",
        description: "",
      });
    }

    const sourceId = nodeMap.get(sourceName).id;
    const targetId = nodeMap.get(targetName).id;
    const relationId = rawRelation.id || `rel:${stableHash(`${sourceId}:${relation}:${targetId}`)}`;

    relations.push({
      id: relationId,
      sourceId,
      targetId,
      relation,
      information: rawRelation.information || `${nodeMap.get(sourceName).label} ${relation.replaceAll("_", " ")} ${nodeMap.get(targetName).label}.`,
      description: rawRelation.description || "",
    });
  }

  return {
    nodes: [...nodeMap.values()],
    relations,
  };
}

export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start >= 0 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }

    throw new Error("LLM response did not contain valid graph JSON.");
  }
}
