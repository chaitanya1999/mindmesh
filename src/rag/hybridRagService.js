import { formatGraphContext } from "./graphContext.js";
import { createDebugLogger } from "../logging/debugLogger.js";

function formatConversationHistory(messages) {
  return messages
    .map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.content}`)
    .join("\n");
}

function buildRetrievalQuery({ query, memoryMessages }) {
  if (!memoryMessages.length) {
    return query;
  }

  const conversation = formatConversationHistory(memoryMessages.slice(-6));
  return `Conversation so far:\n${conversation}\n\nCurrent question:\n${query}`;
}

// Query rewriting is not required for the current POC. Keep this reference here
// in case we want to re-enable standalone follow-up rewriting later.
// function buildQueryRewritePrompt({ conversation, query }) {
//   return [
//     "Rewrite the current question into a standalone question for knowledge graph retrieval.",
//     "Use the conversation only to resolve references like it, they, this, that, he, she, or the previous topic.",
//     "Do not answer the question.",
//     "Return only the rewritten question. If no rewrite is needed, return the original question.",
//     "",
//     `Conversation so far:\n${conversation}`,
//     "",
//     `Current question: ${query}`,
//     "",
//     "Standalone question:",
//   ].join("\n");
// }
//
// function cleanRewrittenQuery(value, fallback) {
//   const text = String(value ?? "").trim();
//   if (!text) {
//     return fallback;
//   }
//
//   const firstLine = text
//     .split(/\r?\n/)
//     .map((line) => line.trim())
//     .find(Boolean);
//
//   return String(firstLine ?? fallback)
//     .replace(/^standalone question:\s*/i, "")
//     .replace(/^rewritten question:\s*/i, "")
//     .replace(/^question:\s*/i, "")
//     .replace(/^["']|["']$/g, "")
//     .trim() || fallback;
// }

function normalizeMemoryMessages(messages, { maxMessages = 12, maxMessageChars = 2000 } = {}) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((message) => {
      const content = String(message?.content ?? message?.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!content) {
        return null;
      }

      return {
        role: message?.role === "assistant" ? "assistant" : "user",
        content: content.length > maxMessageChars
          ? `${content.slice(0, maxMessageChars - 3)}...`
          : content,
      };
    })
    .filter(Boolean)
    .slice(-maxMessages);
}


function formatUnverifiedKnowledgeContext(notes = []) {
  if (!notes.length) {
    return "";
  }

  return notes.map((note, index) => {
    const metadata = note.metadata ?? {};
    const suggestedBy = metadata.userName || "unknown";
    const status = metadata.status || "pending";

    return [
      `Unverified note ${index + 1}:`,
      `Suggested by: ${suggestedBy}`,
      `Status: ${status} verification`,
      `Note id: ${note.id}`,
      "",
      String(note.document),
    ].join("\n");
  }).join("\n\n");
}

function buildAnswerPrompt({ context, conversation, query, unverifiedContext = "" }) {
  const conversationSection = conversation
    ? `Current chat session context:\n${conversation}\n\n`
    : "";
  const unverifiedSection = unverifiedContext
    ? [
      "Unverified knowledge context:",
      "The following pending HITL/fleeting notes are not verified graph truth. Use them only if they are relevant to the question, and keep them separate from verified knowledge.",
      "",
      unverifiedContext,
    ].join("\n")
    : "";

  return [
    `Verified graph context:\n${context}`,
    unverifiedSection,
    `${conversationSection}Current question: ${query}`,
    "Use the current chat session context only to resolve follow-up references, not as a source of truth. Use verified graph context as the factual source for verified claims. If unverified knowledge context is supplied and relevant, include it only under a separate unverified heading. Cite node IDs and relation IDs for graph-backed claims.",
    "Answer:",
  ].filter(Boolean).join("\n\n");
}

function previewText(value, maxLength = 180) {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function logAsk(debugLogger, message) {
	console.log(message);
	debugLogger.log(message);
}

function errorDetails(error) {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			status: error.status,
			code: error.code,
			cause: error.cause ? errorDetails(error.cause) : undefined,
		};
	}
	
	return {
		name: typeof error,
		message: String(error),
		value: error,
	};
}

export class HybridRagService {
  constructor({
    llmProvider,
    graphStore,
    vectorStore,
    prompts,
    topK,
    depth,
    logging = null,
    memoryEnabled = true,
    memoryMaxMessages = 12,
    memoryMaxMessageChars = 2000,
    rewriteQueryWithMemory = true,
  }) {
    this.llmProvider = llmProvider;
    this.graphStore = graphStore;
    this.vectorStore = vectorStore;
    this.prompts = prompts;
    this.topK = topK;
    this.depth = depth;
    this.logging = logging;
    this.memoryEnabled = memoryEnabled;
    this.memoryMaxMessages = memoryMaxMessages;
    this.memoryMaxMessageChars = memoryMaxMessageChars;
    this.rewriteQueryWithMemory = rewriteQueryWithMemory;
  }

  async buildStandaloneRetrievalQuery({ query, conversation, memoryMessages, debugLogger }) {
    const retrievalQuery = buildRetrievalQuery({ query, memoryMessages });
    if (conversation && retrievalQuery !== query) {
      logAsk(debugLogger, "[ask] Query rewrite disabled for POC; using current chat session context directly for retrieval.");
    }
    return retrievalQuery;

    /*
    if (!this.rewriteQueryWithMemory || !conversation) {
      return buildRetrievalQuery({ query, memoryMessages });
    }

    const rewritePrompt = buildQueryRewritePrompt({ conversation, query });
    debugLogger.section("Query Rewrite Prompt", rewritePrompt);
    logAsk(debugLogger, "[ask] Rewriting question with current chat session context for retrieval...");

    try {
      const rewrittenQuery = await this.llmProvider.generateAnswer({
        systemPrompt: "You rewrite follow-up questions into standalone retrieval questions.",
        query,
        prompt: rewritePrompt,
        debugLogger,
      });
      const rewrittenRetrievalQuery = cleanRewrittenQuery(rewrittenQuery, query);
      logAsk(debugLogger, `[ask] Retrieval query: ${previewText(rewrittenRetrievalQuery)}`);
      debugLogger.section("Rewritten Retrieval Query", rewrittenRetrievalQuery);
      return rewrittenRetrievalQuery;
    } catch (error) {
      logAsk(debugLogger, `[ask] Query rewrite failed; using conversation-augmented retrieval query. ${error?.message ?? String(error)}`);
      debugLogger.json("Query Rewrite Exception", errorDetails(error));
      return buildRetrievalQuery({ query, memoryMessages });
    }
    */
  }

  async answer({
    query,
    source,
    sessionId,
    memoryMessages: incomingMemoryMessages = [],
    includeUnverifiedKnowledge = false,
  }) {
    const startedAt = Date.now();
    const debugLogger = createDebugLogger({
      ...this.logging,
      name: "ask",
    });

    try {
      const memoryMessages = this.memoryEnabled
        ? normalizeMemoryMessages(incomingMemoryMessages, {
          maxMessages: this.memoryMaxMessages,
          maxMessageChars: this.memoryMaxMessageChars,
        })
        : [];
      const conversation = formatConversationHistory(memoryMessages);

      logAsk(debugLogger, `[ask] Started answer flow${source ? ` from ${source}` : ""}.`);
      logAsk(debugLogger, `[ask] Query: ${previewText(query)}`);
      if (sessionId) {
        logAsk(debugLogger, `[ask] Session: ${sessionId}`);
      }
      logAsk(debugLogger, `[ask] Loaded ${memoryMessages.length} browser session message(s).`);
      logAsk(debugLogger, `[ask] Retrieval settings: topK=${this.topK}, depth=${this.depth}`);

      debugLogger.section("Runtime", {
        source,
        sessionId,
        topK: this.topK,
        depth: this.depth,
        memoryMessages: memoryMessages.length,
        includeUnverifiedKnowledge,
      });
      debugLogger.section("User Query", query);
      if (conversation) {
        debugLogger.section("Current Chat Session Context", conversation);
      }

      const retrievalQuery = await this.buildStandaloneRetrievalQuery({
        query,
        conversation,
        memoryMessages,
        debugLogger,
      });
      if (retrievalQuery !== query) {
        debugLogger.section("Retrieval Query", retrievalQuery);
      }

      logAsk(debugLogger, "[ask] Querying vector store for entry nodes...");
      const entryNodes = await this.vectorStore.queryNodes(retrievalQuery, this.topK);
      const nodeIds = [...new Set(entryNodes.map((node) => node.id).filter(Boolean))];
      debugLogger.json("Vector Entry Nodes", entryNodes);
      logAsk(debugLogger, `[ask] Vector search returned ${entryNodes.length} result(s), ${nodeIds.length} unique node id(s).`);

      let unverifiedNotes = [];
      if (includeUnverifiedKnowledge) {
        if (typeof this.vectorStore.queryHitlNotes === "function") {
          logAsk(debugLogger, "[ask] Querying pending HITL notes for unverified knowledge...");
          unverifiedNotes = await this.vectorStore.queryHitlNotes(retrievalQuery, this.topK);
          debugLogger.json("Unverified HITL Notes", unverifiedNotes);
          logAsk(debugLogger, `[ask] Unverified knowledge search returned ${unverifiedNotes.length} pending note(s).`);
        } else {
          logAsk(debugLogger, "[ask] Vector store does not support pending HITL note search; skipping unverified knowledge.");
        }
      }

      logAsk(debugLogger, nodeIds.length > 0
        ? `[ask] Expanding graph from entry nodes: ${nodeIds.join(", ")}`
        : "[ask] No vector entry nodes found; using empty graph context.");
      const graph = nodeIds.length > 0
        ? await this.graphStore.expandFromNodes(nodeIds, this.depth)
        : { nodes: [], relations: [] };
      debugLogger.json("Expanded Graph Summary", {
        entryNodeIds: nodeIds,
        nodes: graph.nodes.length,
        relations: graph.relations.length,
      });
      logAsk(debugLogger, `[ask] Expanded graph contains ${graph.nodes.length} node(s) and ${graph.relations.length} relation(s).`);

      const context = formatGraphContext(graph, this.prompts);
      const unverifiedContext = formatUnverifiedKnowledgeContext(unverifiedNotes);
      const answerPrompt = buildAnswerPrompt({
        context,
        conversation,
        query,
        unverifiedContext,
      });
      debugLogger.section("Graph Context", context);
      if (unverifiedContext) {
        debugLogger.section("Unverified Knowledge Context", unverifiedContext);
      }
      debugLogger.section("Rendered Answer Prompt", answerPrompt);

      logAsk(debugLogger, "[ask] Sending answer prompt to LLM...");
      const answer = await this.llmProvider.generateAnswer({
        systemPrompt: this.prompts.answerSystem,
        context,
        query,
        prompt: answerPrompt,
        debugLogger,
      });
      logAsk(debugLogger, `[ask] LLM answer received in ${Date.now() - startedAt} ms.`);

      if (debugLogger.enabled) {
        logAsk(debugLogger, `Ask debug log written to ${debugLogger.path}`);
      }

      return {
        answer,
        entryNodes,
        graph,
        context,
        depth: this.depth,
        sessionId,
      };
    } catch (error) {
      logAsk(debugLogger, `[ask] Failed after ${Date.now() - startedAt} ms: ${error?.message ?? String(error)}`);
      debugLogger.json("Exception", errorDetails(error));

      if (debugLogger.enabled) {
        logAsk(debugLogger, `Ask debug log written to ${debugLogger.path}`);
      }

      throw error;
    }
  }
}
