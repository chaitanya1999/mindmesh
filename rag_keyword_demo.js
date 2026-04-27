import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";

const CONFIG_PATH = new URL("./config.json", import.meta.url);
const DEFAULT_QUESTION = "How does the refund policy work?";
const TOP_K = 3;

const documents = [
  {
    id: "policy-refunds",
    title: "Refund Policy",
    text:
      "Customers can request a full refund within 30 days of purchase. Refunds are processed back to the original payment method within 5 to 7 business days.",
  },
  {
    id: "policy-shipping",
    title: "Shipping Policy",
    text:
      "Standard shipping usually takes 3 to 5 business days. Express shipping takes 1 to 2 business days and includes tracking.",
  },
  {
    id: "product-solar-charger",
    title: "Solar Charger",
    text:
      "The portable solar charger includes a 20,000 mAh battery, two USB-C ports, and a foldable panel for outdoor use.",
  },
  {
    id: "support-password",
    title: "Password Reset",
    text:
      "Users can reset their password from the account login page. A reset link expires after 15 minutes for security.",
  },
  {
    id: "support-warranty",
    title: "Warranty Support",
    text:
      "All electronics include a one-year limited warranty. Warranty support covers manufacturing defects but not accidental damage.",
  },
];

const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "can",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "to",
  "what",
  "with",
]);

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !stopWords.has(word));
}

function scoreDocument(queryTerms, document) {
  const documentTerms = tokenize(`${document.title} ${document.text}`);
  const termFrequency = new Map();

  for (const term of documentTerms) {
    termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
  }

  return queryTerms.reduce((score, term) => score + (termFrequency.get(term) ?? 0), 0);
}

function retrieve(question, topK = TOP_K) {
  const queryTerms = tokenize(question);

  return documents
    .map((document) => ({
      ...document,
      score: scoreDocument(queryTerms, document),
    }))
    .filter((document) => document.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
}

function buildPrompt(question, retrievedDocuments) {
  const context = retrievedDocuments
    .map((document, index) => `[${index + 1}] ${document.title}: ${document.text}`)
    .join("\n");

  return `Answer the question using only the context below. If the context does not contain the answer, say you do not know.

Context:
${context}

Question: ${question}

Answer:`;
}

function generateLocalAnswer(question, retrievedDocuments) {
  if (retrievedDocuments.length === 0) {
    return `I do not know based on the dummy documents. No keyword matches were found for: "${question}".`;
  }

  const best = retrievedDocuments[0];

  return `${best.text}\n\nSource: [1] ${best.title}`;
}

async function generateWithGemini(prompt) {
  const config = loadConfig();
  const apiKey = config.apiKey;

  if (!apiKey) {
    throw new Error("Missing apiKey in config.json.");
  }

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: config.model,
    contents: prompt,
  });

  return response.text;
}

async function main() {
  const args = process.argv.slice(2);
  const useLlm = args.includes("--llm");
  const question = args.filter((arg) => arg !== "--llm").join(" ") || DEFAULT_QUESTION;
  const retrievedDocuments = retrieve(question);
  const prompt = buildPrompt(question, retrievedDocuments);
  const answer = useLlm ? await generateWithGemini(prompt) : generateLocalAnswer(question, retrievedDocuments);

  console.log(`Question: ${question}\n`);
  console.log("Retrieved context:");

  if (retrievedDocuments.length === 0) {
    console.log("- No matching documents found.");
  } else {
    for (const [index, document] of retrievedDocuments.entries()) {
      console.log(`- [${index + 1}] ${document.title} (${document.id}, score: ${document.score})`);
    }
  }

  console.log("\nRAG prompt:");
  console.log(prompt);
  console.log("\nAnswer:");
  console.log(answer);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
