import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";

const DEFAULT_PROMPT = "Explain how AI works in a few words";
const CONFIG_PATH = new URL("./config.json", import.meta.url);

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

async function main() {
  const config = loadConfig();
  const apiKey = config.apiKey;

  if (!apiKey) {
    console.error("Missing apiKey in config.json.");
    process.exit(1);
  }

  const model = config.model;
  const prompt = process.argv.slice(2).join(" ") || DEFAULT_PROMPT;

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: prompt,
  });

  console.log(response.text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
