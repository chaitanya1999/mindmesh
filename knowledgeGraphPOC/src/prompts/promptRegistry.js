import fs from "node:fs";

function readPrompt(filePath, fallback) {
  if (!filePath || !fs.existsSync(filePath)) {
    return fallback;
  }

  return fs.readFileSync(filePath, "utf8").trim();
}

export function loadPrompts(config) {
  return {
    extractionSystem: readPrompt(
      config.prompts.extractionSystemPath,
      "Extract graph nodes and relations as strict JSON.",
    ),
    answerSystem: readPrompt(
      config.prompts.answerSystemPath,
      "Answer using only the supplied graph context.",
    ),
    contextFormat: readPrompt(
      config.prompts.contextFormatPath,
      "Format graph context compactly.",
    ),
  };
}
