import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

const FAQ_PATH = path.resolve(process.cwd(), "data", "wiseFaq.json");
const CACHE_PATH = path.resolve(process.cwd(), "data", "wiseFaq.index.json");

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDINGS_MODEL || "text-embedding-3-small";
const ANSWER_MODEL = process.env.OPENAI_ANSWER_MODEL || process.env.OPENAI_RESOLVER_MODEL || "gpt-5.4-mini";

const FAQ_SOURCE = JSON.parse(fs.readFileSync(FAQ_PATH, "utf8"));

const TITLE_TO_INTENT = new Map([
  ["how do i check my transfer's status?", "check_transfer_status"],
  ["when will my money arrive?", "money_arrival_time"],
  ["why does it say my transfer's complete when the money hasn't arrived yet?", "complete_but_not_arrived"],
  ["why is my transfer taking longer than the estimate?", "transfer_delayed"],
  ["what is a proof of payment?", "proof_of_payment"],
  ["what's a banking partner reference number?", "banking_partner_reference"],
]);

const WISE_CUES = [
  "wise",
  "transfer",
  "money",
  "recipient",
  "bank",
  "payment",
  "payment proof",
  "proof of payment",
  "banking partner",
  "reference number",
  "status",
  "arrive",
  "complete",
  "estimate",
  "cancel",
  "refund",
  "fee",
  "fees",
  "verification",
  "account",
  "utr",
  "unique transaction reference",
  "transaction reference",
  "banking partner reference",
  "transfer receipt",
  "transfer confirmation",
];

let knowledgeBasePromise = null;

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  return new OpenAI({ apiKey });
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("\u2019", "'")
    .replaceAll("\u2018", "'")
    .replaceAll("\u201C", '"')
    .replaceAll("\u201D", '"')
    .replaceAll("\u2014", "-")
    .replaceAll("\u2013", "-")
    .replace(/\s+/g, " ")
    .trim();
}

function formatBlock(block) {
  if (block.type === "paragraph" && block.text) {
    return String(block.text).trim();
  }

  if ((block.type === "unordered_list" || block.type === "ordered_list") && Array.isArray(block.items)) {
    return block.items.map((item) => `- ${item}`).join("\n");
  }

  if (block.type === "table" && Array.isArray(block.headers) && Array.isArray(block.rows)) {
    const rows = [`Table: ${block.headers.join(" | ")}`];
    for (const row of block.rows) {
      rows.push(`- ${row.join(" | ")}`);
    }
    return rows.join("\n");
  }

  if (block.type === "heading" && block.text) {
    return `Heading: ${String(block.text).trim()}`;
  }

  return "";
}

function buildChunksForArticle(article) {
  const chunks = [];
  let currentHeading = "Introduction";
  let currentParts = [];
  let chunkIndex = 0;

  function flush() {
    const text = currentParts.join("\n").trim();
    if (!text) {
      return;
    }

    const sectionTitle = currentHeading || "Introduction";
    const retrievalText = [
      `Article: ${article.title}`,
      `Section: ${sectionTitle}`,
      text,
    ].join("\n").trim();

    chunks.push({
      chunkId: `${normalizeText(article.title).replace(/[^a-z0-9]+/g, "-")}-${chunkIndex += 1}`,
      articleTitle: article.title,
      articleUrl: article.url,
      sectionTitle,
      text,
      retrievalText,
    });
    currentParts = [];
  }

  for (const block of article.contentBlocks) {
    if (block.type === "heading" && block.text) {
      flush();
      currentHeading = String(block.text).trim();
      currentParts = [];
      continue;
    }

    const formatted = formatBlock(block);
    if (!formatted) {
      continue;
    }

    currentParts.push(formatted);
  }

  flush();

  return chunks;
}

function deriveKnowledgeChunks() {
  const articles = FAQ_SOURCE.articles.map((article) => {
    const title = String(article.title || "").trim();

    return {
      intent: TITLE_TO_INTENT.get(normalizeText(title)) || null,
      title,
      url: article.url,
      chunks: buildChunksForArticle(article),
    };
  });

  const chunks = [];

  for (const article of articles) {
    for (const chunk of article.chunks) {
      chunks.push({
        ...chunk,
        intent: article.intent,
      });
    }
  }

  return { articles, chunks };
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];

    dot += left * right;
    magnitudeA += left * left;
    magnitudeB += right * right;
  }

  if (!magnitudeA || !magnitudeB) {
    return 0;
  }

  return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
}

function hasWiseSignals(userQuestion) {
  const normalized = normalizeText(userQuestion);

  return WISE_CUES.some((cue) => normalized.includes(cue));
}

function detectConversationalType(userQuestion) {
  const normalized = normalizeText(userQuestion);

  if (!normalized) {
    return "clarify_request";
  }

  if (/^(hi|hello|hey|hiya|yo)\b/.test(normalized) || /\b(how are you|good morning|good afternoon|good evening)\b/.test(normalized)) {
    return "greeting";
  }

  if (/\b(thanks|thank you|appreciate it)\b/.test(normalized)) {
    return "thanks";
  }

  if (/\b(bye|goodbye|see you|later)\b/.test(normalized)) {
    return "goodbye";
  }

  if (/\b(what can you help with|who are you|what do you do|what are you)\b/.test(normalized)) {
    return "capability_question";
  }

  if (/\b(can you repeat|say that again|repeat that|again please)\b/.test(normalized)) {
    return "repeat_request";
  }

  if (/\b(what do you mean|can you clarify|i do not understand|i don't understand)\b/.test(normalized)) {
    return "clarify_request";
  }

  if (/\b(no that's wrong|not what i said|i meant|you misunderstood|that's not right)\b/.test(normalized)) {
    return "frustration_or_correction";
  }

  return "none";
}

function conversationResult(conversationalType, rationale) {
  const replies = {
    greeting: "Hello. How can I help with your Wise transfer?",
    thanks: "You're welcome.",
    goodbye: "Goodbye.",
    capability_question:
      "I help only with Wise transfer tracking questions, like transfer status, arrival time, proof of payment, and banking partner reference numbers.",
    repeat_request: "Please ask your Wise transfer tracking question again, and I will help.",
    clarify_request: "Could you tell me your Wise transfer tracking question?",
    frustration_or_correction:
      "Understood. Please restate your Wise transfer tracking question, and I will help with that.",
  };

  return {
    category: "conversational",
    intent: null,
    conversationalType,
    responseText: replies[conversationalType] || replies.clarify_request,
    sourceTitle: null,
    sourceUrl: null,
    shouldEndCall: conversationalType === "goodbye",
    rationale,
  };
}

async function loadKnowledgeBaseFromCache() {
  if (!fs.existsSync(CACHE_PATH)) {
    return null;
  }

  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));

    if (!cached || cached.embeddingModel !== EMBEDDING_MODEL || !Array.isArray(cached.chunks)) {
      return null;
    }

    return cached;
  } catch {
    return null;
  }
}

async function buildKnowledgeBase() {
  const cached = await loadKnowledgeBaseFromCache();
  if (cached) {
    return cached;
  }

  const { articles, chunks } = deriveKnowledgeChunks();
  const openai = getOpenAIClient();
  const embeddingResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: chunks.map((chunk) => chunk.retrievalText),
    encoding_format: "float",
  });

  const indexedChunks = chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddingResponse.data[index].embedding,
  }));

  const knowledgeBase = {
    embeddingModel: EMBEDDING_MODEL,
    articles,
    chunks: indexedChunks,
  };

  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(knowledgeBase, null, 2));
  } catch {
    // Ignore cache write failures on read-only filesystems.
  }

  return knowledgeBase;
}

async function getKnowledgeBase() {
  knowledgeBasePromise ??= buildKnowledgeBase();
  return knowledgeBasePromise;
}

async function searchKnowledgeBase(userQuestion) {
  const knowledgeBase = await getKnowledgeBase();
  const openai = getOpenAIClient();
  const queryResponse = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: userQuestion,
    encoding_format: "float",
  });

  const queryEmbedding = queryResponse.data[0].embedding;
  const scored = knowledgeBase.chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((left, right) => right.score - left.score);

  const bestByArticle = new Map();

  for (const item of scored) {
    const current = bestByArticle.get(item.chunk.articleUrl);
    if (!current || item.score > current.score) {
      bestByArticle.set(item.chunk.articleUrl, item);
    }
  }

  return {
    scoredChunks: scored,
    articleMatches: Array.from(bestByArticle.values()).sort((left, right) => right.score - left.score),
  };
}

function buildDebugInfo(userQuestion, searchResult) {
  const topChunks = searchResult.scoredChunks.slice(0, 5).map((item) => ({
    articleTitle: item.chunk.articleTitle,
    sectionTitle: item.chunk.sectionTitle,
    score: Number(item.score.toFixed(4)),
  }));

  return {
    userQuestion,
    topChunks,
  };
}

function buildAnswerPrompt(userQuestion, articleTitle, articleUrl, chunks) {
  const chunkSections = chunks
    .map((chunk, index) => {
      return [
        `Chunk ${index + 1}`,
        `Section: ${chunk.sectionTitle}`,
        `Text: ${chunk.text}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are a Wise transfer-tracking assistant.",
    "Answer only from the source chunks below.",
    "Do not use outside knowledge.",
    "If the source chunks do not fully answer the question, say that you are not sure and ask the user to rephrase their Wise transfer question.",
    "Keep the response concise and spoken-friendly.",
    "",
    `User question: ${userQuestion}`,
    `Source article title: ${articleTitle}`,
    `Source article URL: ${articleUrl}`,
    "",
    "Source chunks:",
    chunkSections,
  ].join("\n");
}

async function answerFromChunks({ userQuestion, articleTitle, articleUrl, chunks }) {
  const openai = getOpenAIClient();
  const response = await openai.responses.create({
    model: ANSWER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildAnswerPrompt(userQuestion, articleTitle, articleUrl, chunks),
          },
        ],
      },
    ],
    max_output_tokens: 220,
  });

  return String(response.output_text || "").trim();
}

export async function resolveTranscript(userQuestion) {
  const conversationalType = detectConversationalType(userQuestion);
  if (conversationalType !== "none") {
    return {
      ...conversationResult(conversationalType, "The utterance was classified as conversational."),
      debug: {
        route: "conversational",
        topScore: 0,
        topChunks: [],
      },
    };
  }

  const searchResult = await searchKnowledgeBase(userQuestion);
  const { articleMatches, scoredChunks } = searchResult;
  const bestArticle = articleMatches[0] || null;
  const topScore = bestArticle?.score ?? 0;
  const isWiseRelated = hasWiseSignals(userQuestion);

  const strongMatchThreshold = 0.78;
  const weakMatchThreshold = 0.58;
  const debugInfo = buildDebugInfo(userQuestion, searchResult);

  if (!bestArticle || topScore < weakMatchThreshold) {
    return {
      category: isWiseRelated ? "wise_unsupported" : "off_topic",
      intent: null,
      conversationalType: null,
      responseText: isWiseRelated
        ? "I can only help with Wise transfer tracking questions. For this issue, a human support agent is needed."
        : "I only help with Wise transfer tracking questions. If you have a transfer tracking question, please ask it.",
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: false,
      rationale: `No strong semantic match was found. Top score: ${topScore.toFixed(3)}.`,
      debug: {
        route: isWiseRelated ? "wise_unsupported" : "off_topic",
        topScore,
        topChunks: debugInfo.topChunks,
      },
    };
  }

  if (topScore < strongMatchThreshold && !isWiseRelated) {
    return {
      category: "off_topic",
      intent: null,
      conversationalType: null,
      responseText: "I only help with Wise transfer tracking questions. If you have a transfer tracking question, please ask it.",
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: false,
      rationale: `The question did not look like a Wise transfer issue. Top score: ${topScore.toFixed(3)}.`,
      debug: {
        route: "off_topic",
        topScore,
        topChunks: debugInfo.topChunks,
      },
    };
  }

  const relevantChunks = scoredChunks
    .filter((item) => item.chunk.articleUrl === bestArticle.chunk.articleUrl)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((item) => item.chunk);

  const article = relevantChunks[0] || bestArticle.chunk;
  const responseText = await answerFromChunks({
    userQuestion,
    articleTitle: article.articleTitle,
    articleUrl: article.articleUrl,
    chunks: relevantChunks.length ? relevantChunks : [article],
  });

  return {
    category: "supported_faq",
    intent: article.intent || null,
    conversationalType: null,
    responseText: responseText || "Could you tell me your Wise transfer tracking question?",
    sourceTitle: article.articleTitle,
    sourceUrl: article.articleUrl,
    shouldEndCall: false,
    rationale: `Top semantic match: ${article.articleTitle} (${topScore.toFixed(3)}).`,
    debug: {
      route: "supported_faq",
      topScore,
      topChunks: debugInfo.topChunks,
    },
  };
}
