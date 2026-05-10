import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";

function loadLocalEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile(path.resolve(process.cwd(), ".env"));
loadLocalEnvFile(path.resolve(process.cwd(), ".env.local"));

const DEFAULT_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const DEFAULT_ROUTER_MODEL = process.env.OPENAI_ROUTER_MODEL || process.env.OPENAI_RESOLVER_MODEL || "gpt-5.4-mini";
const DEFAULT_ANSWER_MODEL = process.env.OPENAI_ANSWER_MODEL || DEFAULT_ROUTER_MODEL;

const FAQ_PATH = path.resolve(process.cwd(), "data", "wiseFaq.json");
const FAQ_SOURCE = JSON.parse(fs.readFileSync(FAQ_PATH, "utf8"));

const TITLE_TO_INTENT = new Map([
  ["how do i check my transfer's status?", "check_transfer_status"],
  ["when will my money arrive?", "money_arrival_time"],
  ["why does it say my transfer's complete when the money hasn't arrived yet?", "complete_but_not_arrived"],
  ["why is my transfer taking longer than the estimate?", "transfer_delayed"],
  ["what is a proof of payment?", "proof_of_payment"],
  ["what's a banking partner reference number?", "banking_partner_reference"],
]);

const ROUTE_SCHEMA = {
  type: "json_schema",
  name: "wise_transfer_route",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      category: {
        type: "string",
        enum: ["conversational", "supported_faq", "wise_unsupported", "off_topic", "unclear"],
      },
      intent: {
        type: "string",
        enum: [
          "check_transfer_status",
          "money_arrival_time",
          "complete_but_not_arrived",
          "transfer_delayed",
          "proof_of_payment",
          "banking_partner_reference",
          "none",
        ],
      },
      conversationalType: {
        type: "string",
        enum: [
          "greeting",
          "thanks",
          "goodbye",
          "capability_question",
          "repeat_request",
          "clarify_request",
          "frustration_or_correction",
          "none",
        ],
      },
      rationale: {
        type: "string",
      },
    },
    required: ["category", "intent", "conversationalType", "rationale"],
  },
};

const CONVERSATIONAL_REPLIES = {
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

function buildArticleContext(contentBlocks) {
  const lines = [];

  for (const block of contentBlocks) {
    if (block.type === "heading" && block.text) {
      lines.push(`Heading: ${block.text}`);
      continue;
    }

    if (block.type === "paragraph" && block.text) {
      lines.push(block.text);
      continue;
    }

    if ((block.type === "unordered_list" || block.type === "ordered_list") && Array.isArray(block.items)) {
      for (const item of block.items) {
        lines.push(`- ${item}`);
      }
      continue;
    }

    if (block.type === "table" && Array.isArray(block.headers) && Array.isArray(block.rows)) {
      lines.push(`Table: ${block.headers.join(" | ")}`);
      for (const row of block.rows) {
        lines.push(`- ${row.join(" | ")}`);
      }
    }
  }

  return lines.join("\n").trim();
}

function deriveArticles() {
  return FAQ_SOURCE.articles.map((article) => {
    const title = String(article.title || "").trim();
    const intent = TITLE_TO_INTENT.get(normalizeText(title)) || null;

    return {
      intent,
      title,
      url: article.url,
      contentBlocks: article.contentBlocks,
      sourceContext: buildArticleContext(article.contentBlocks),
    };
  });
}

const SUPPORTED_ARTICLES = deriveArticles().filter((article) => article.intent);

function getScopeSection() {
  const section = FAQ_SOURCE.topicPage.sections.find(
    (entry) => normalizeText(entry.title) === "where is my money?"
  );

  return {
    title: String(section?.title || "Where is my money?"),
    items:
      section?.items?.map((item) => ({
        title: String(item.title || "").trim(),
        url: String(item.url || ""),
      })) || [],
  };
}

function getSupportedIntentCatalog() {
  return SUPPORTED_ARTICLES.map((article) => ({
    intent: article.intent,
    title: article.title,
  }));
}

function normalizeRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== "object") {
    return null;
  }

  const category = typeof rawRoute.category === "string" ? rawRoute.category : null;
  const intent = typeof rawRoute.intent === "string" ? rawRoute.intent : "none";
  const conversationalType =
    typeof rawRoute.conversationalType === "string" ? rawRoute.conversationalType : "none";
  const rationale = typeof rawRoute.rationale === "string" ? rawRoute.rationale : "No rationale provided.";

  if (!category) {
    return null;
  }

  return { category, intent, conversationalType, rationale };
}

function buildRoutePrompt(userQuestion) {
  const scopeSection = getScopeSection();
  const supportedIntentCatalog = getSupportedIntentCatalog();

  return [
    "You are an intent router for a Wise transfer-tracking browser demo.",
    "Classify the user's utterance by intent, not by keywords.",
    "Use supported_faq only when the user is asking about one of the approved Wise 'Where is my money?' topics.",
    "Use wise_unsupported for Wise-related support requests outside the approved topics, such as refunds, cancellations, fees, recipient edits, app/account issues, verification, cards, loans, investing, or other Wise help topics.",
    "Use off_topic for unrelated subjects or general knowledge.",
    "Use conversational for greetings, thanks, goodbye, repeat requests, capability questions, clarifications, or direct corrections.",
    "Return only the schema fields.",
    "",
    `Scope section: ${scopeSection.title}`,
    "Approved topics:",
    ...supportedIntentCatalog.map((item) => `- ${item.intent}: ${item.title}`),
    "",
    "Examples:",
    'User: "Hi there" -> category conversational, conversationalType greeting.',
    'User: "What can you help with?" -> category conversational, conversationalType capability_question.',
    'User: "When will my money arrive?" -> category supported_faq, intent money_arrival_time.',
    'User: "I want to cancel my transfer" -> category wise_unsupported.',
    'User: "Can you teach me cooking?" -> category off_topic.',
    "",
    `User utterance: ${userQuestion}`,
  ].join("\n");
}

async function classifyRoute(userQuestion) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model: DEFAULT_ROUTER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildRoutePrompt(userQuestion),
          },
        ],
      },
    ],
    text: {
      format: ROUTE_SCHEMA,
    },
    max_output_tokens: 180,
  });

  try {
    return normalizeRoute(JSON.parse(response.output_text));
  } catch {
    return null;
  }
}

async function answerFromSource({ userQuestion, article }) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model: DEFAULT_ANSWER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You are a Wise transfer-tracking assistant. Answer only from the provided source article text. " +
              "Do not use outside knowledge. If the source does not support the answer, say you are not sure and ask the user to rephrase their Wise transfer question. " +
              "Keep the response concise and spoken-friendly.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              `User question: ${userQuestion}\n\n` +
              `Source article title: ${article.title}\n` +
              `Source article URL: ${article.url}\n\n` +
              `Source article text:\n${article.sourceContext}`,
          },
        ],
      },
    ],
    max_output_tokens: 220,
  });

  return String(response.output_text || "").trim();
}

function buildResolutionResultBase(route) {
  if (!route) {
    return {
      category: "unclear",
      intent: null,
      conversationalType: null,
      responseText: "Could you tell me your Wise transfer tracking question?",
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: false,
      rationale: "The request could not be classified.",
    };
  }

  if (route.category === "conversational") {
    const conversationalType = route.conversationalType === "none" ? "clarify_request" : route.conversationalType;

    return {
      category: "conversational",
      intent: null,
      conversationalType,
      responseText: CONVERSATIONAL_REPLIES[conversationalType] || CONVERSATIONAL_REPLIES.clarify_request,
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: conversationalType === "goodbye",
      rationale: route.rationale,
    };
  }

  if (route.category === "wise_unsupported") {
    return {
      category: "wise_unsupported",
      intent: null,
      conversationalType: null,
      responseText: "I can only help with Wise transfer tracking questions. For this issue, a human support agent is needed.",
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: true,
      rationale: route.rationale,
    };
  }

  if (route.category === "off_topic") {
    return {
      category: "off_topic",
      intent: null,
      conversationalType: null,
      responseText: "I only help with Wise transfer tracking questions. If you have a transfer tracking question, please ask it.",
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: false,
      rationale: route.rationale,
    };
  }

  return null;
}

export function buildSessionConfig() {
  return {
    type: "realtime",
    model: DEFAULT_REALTIME_MODEL,
    instructions:
      "You are a concise Wise transfer tracking voice assistant. " +
      "Only respond when explicitly asked to speak. " +
      "Keep replies short and spoken-friendly. " +
      "Do not answer questions outside Wise transfer tracking.",
    reasoning: {
      effort: "low",
    },
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.65,
          prefix_padding_ms: 250,
          silence_duration_ms: 650,
          create_response: false,
          interrupt_response: true,
        },
      },
      output: {
        voice: "marin",
      },
    },
  };
}

export async function createRealtimeClientSecret() {
  const openai = getOpenAIClient();
  const clientSecret = await openai.realtime.clientSecrets.create({
    expires_after: {
      anchor: "created_at",
      seconds: 600,
    },
    session: buildSessionConfig(),
  });

  return {
    clientSecret: clientSecret.value,
    expiresAt: clientSecret.expires_at,
    session: clientSecret.session,
  };
}

export async function resolveTranscript(userQuestion) {
  const route = await classifyRoute(userQuestion);
  const baseResult = buildResolutionResultBase(route);

  if (baseResult) {
    return baseResult;
  }

  if (route?.category === "supported_faq" && route.intent && route.intent !== "none") {
    const article = SUPPORTED_ARTICLES.find((item) => item.intent === route.intent);

    if (!article) {
      return {
        category: "unclear",
        intent: null,
        conversationalType: null,
        responseText: "Could you tell me your Wise transfer tracking question?",
        sourceTitle: null,
        sourceUrl: null,
        shouldEndCall: false,
        rationale: "No matching article was found for the classified intent.",
      };
    }

    const responseText = await answerFromSource({
      userQuestion,
      article,
    });

    return {
      category: "supported_faq",
      intent: article.intent,
      conversationalType: null,
      responseText: responseText || "Could you tell me your Wise transfer tracking question?",
      sourceTitle: article.title,
      sourceUrl: article.url,
      shouldEndCall: false,
      rationale: route.rationale,
    };
  }

  return {
    category: "unclear",
    intent: null,
    conversationalType: null,
    responseText: "Could you tell me your Wise transfer tracking question?",
    sourceTitle: null,
    sourceUrl: null,
    shouldEndCall: false,
    rationale: route?.rationale || "The request could not be classified.",
  };
}

function jsonResponse(status, payload) {
  return {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

export async function handleRealtimeApiRequest({ method, pathname, body }) {
  if (method === "POST" && pathname === "/api/realtime/client-secret") {
    try {
      return jsonResponse(200, await createRealtimeClientSecret());
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : "Failed to create client secret.",
      });
    }
  }

  if (method === "POST" && pathname === "/api/realtime/resolve") {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const userQuestion = typeof parsed?.userQuestion === "string" ? parsed.userQuestion.trim() : "";

      if (!userQuestion) {
        return jsonResponse(400, { error: "userQuestion is required." });
      }

      return jsonResponse(200, {
        ok: true,
        result: await resolveTranscript(userQuestion),
      });
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : "Failed to resolve transcript.",
      });
    }
  }

  return jsonResponse(404, { error: "Not found." });
}
