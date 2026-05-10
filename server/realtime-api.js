import OpenAI from "openai";

const DEFAULT_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2";
const DEFAULT_RESOLVER_MODEL = process.env.OPENAI_RESOLVER_MODEL || "gpt-5.4-mini";

const QUESTIONS = {
  check_transfer_status: {
    title: "How do I check my transfer's status?",
    url: "https://wise.com/help/articles/2452305/how-do-i-check-my-transfers-status",
    answer:
      "Log in to your Wise account, go to Home, and select the transfer you want to track. The tracker shows the current stage, such as being processed, money received, or transfer sent.",
  },
  money_arrival_time: {
    title: "When will my money arrive?",
    url: "https://wise.com/help/articles/2941900/when-will-my-money-arrive",
    answer:
      "Wise shows an estimate for arrival time. If it says due today, it usually means the money should already be there, but bank processing, weekends, holidays, or incorrect details can delay it.",
  },
  complete_but_not_arrived: {
    title: "Why does it say my transfer's complete when the money hasn't arrived yet?",
    url: "https://wise.com/help/articles/2977950/why-does-it-say-my-transfers-complete-when-the-money-hasnt-arrived-yet",
    answer:
      "Complete means Wise has sent the money to the recipient bank. The bank may still be processing it, or the recipient may need to check the sender name, reference number, currency, and amount. A receipt can help.",
  },
  transfer_delayed: {
    title: "Why is my transfer taking longer than the estimate?",
    url: "https://wise.com/help/articles/2977951/why-is-my-transfer-taking-longer-than-the-estimate",
    answer:
      "Delays can happen because Wise is still waiting for the money, a security check is running, the recipient bank is slow, or the recipient details are wrong. Weekends and public holidays can also slow things down.",
  },
  proof_of_payment: {
    title: "What is a proof of payment?",
    url: "https://wise.com/help/articles/2932689/what-is-a-proof-of-payment",
    answer:
      "A proof of payment is a document that shows you sent money from your bank account, such as a bank statement or screenshot. It should show your name, bank name, Wise details, date, amount, currency, and reference.",
  },
  banking_partner_reference: {
    title: "What's a banking partner reference number?",
    url: "https://wise.com/help/articles/2977938/whats-a-banking-partner-reference-number",
    answer:
      "A banking partner reference number helps your recipient's bank find the payment after the transfer is complete. Give it to your recipient if Wise provides one.",
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

const CONVERSATIONAL_PATTERNS = [
  { type: "thanks", patterns: ["thank you", "thanks", "thx", "appreciate it"] },
  { type: "goodbye", patterns: ["goodbye", "bye", "see you", "talk later"] },
  { type: "greeting", patterns: ["hello", "hi", "hey", "good morning", "good afternoon", "good evening"] },
  {
    type: "capability_question",
    patterns: ["what can you do", "what do you do", "help me with", "are you able to", "can you help"],
  },
  { type: "repeat_request", patterns: ["repeat that", "say that again", "again please", "can you repeat"] },
  { type: "clarify_request", patterns: ["huh", "sorry?", "pardon?", "can you clarify"] },
  { type: "frustration_or_correction", patterns: ["no, ", "that's wrong", "you are wrong", "not what i meant", "i said", "that's not"] },
];

const SUPPORT_PATTERNS = [
  {
    intent: "check_transfer_status",
    patterns: [
      "transfer status",
      "check status",
      "track my transfer",
      "how do i check",
      "where is my transfer",
      "where is my money",
      "tracker",
    ],
  },
  {
    intent: "money_arrival_time",
    patterns: [
      "when will my money arrive",
      "when does it land",
      "due today",
      "how long until it arrives",
      "estimated arrival",
      "delivery estimate",
    ],
  },
  {
    intent: "complete_but_not_arrived",
    patterns: [
      "transfer complete",
      "money hasn't arrived",
      "money has not arrived",
      "not arrived yet",
      "hasn't arrived",
      "has not arrived",
      "recipient hasn't received",
      "recipient has not received",
    ],
  },
  {
    intent: "transfer_delayed",
    patterns: [
      "taking longer than the estimate",
      "transfer delayed",
      "still processing",
      "pending too long",
      "not moving",
      "why is my transfer taking longer",
    ],
  },
  {
    intent: "proof_of_payment",
    patterns: ["proof of payment", "proof of transfer", "payment proof", "bank statement"],
  },
  {
    intent: "banking_partner_reference",
    patterns: ["banking partner reference", "partner reference", "utr"],
  },
];

const UNSUPPORTED_PATTERNS = [
  "cancel",
  "refund",
  "fee",
  "fees",
  "charge",
  "card",
  "account",
  "login",
  "password",
  "verification",
  "verify",
  "recipient edit",
  "change recipient",
  "app issue",
  "stocks",
  "investing",
  "interest",
  "loan",
  "loan payment",
  "cash advance",
  "crypto",
  "kyc",
];

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

function includesAny(text, patterns) {
  return patterns.some((pattern) => text.includes(pattern));
}

function classifyLocally(question) {
  const text = normalizeText(question);

  if (!text) {
    return null;
  }

  if (text.length <= 3) {
    return {
      category: "conversational",
      conversationalType: "clarify_request",
      rationale: "The request was too short to classify confidently.",
    };
  }

  for (const item of CONVERSATIONAL_PATTERNS) {
    if (includesAny(text, item.patterns)) {
      return {
        category: "conversational",
        conversationalType: item.type,
        rationale: `Matched local conversational pattern: ${item.type}.`,
      };
    }
  }

  for (const item of SUPPORT_PATTERNS) {
    if (includesAny(text, item.patterns)) {
      return {
        category: "supported_faq",
        intent: item.intent,
        rationale: `Matched local support pattern: ${item.intent}.`,
      };
    }
  }

  if (includesAny(text, UNSUPPORTED_PATTERNS) && includesAny(text, ["wise", "transfer", "money"])) {
    return {
      category: "wise_unsupported",
      rationale: "Matched local Wise support exclusion pattern.",
    };
  }

  if (includesAny(text, ["wise", "transfer", "money", "recipient", "sender", "bank"])) {
    return {
      category: "unclear",
      rationale: "Mentions Wise transfer context but did not match a supported intent.",
    };
  }

  return {
    category: "off_topic",
    rationale: "No Wise transfer context detected.",
  };
}

async function classifyWithModel(question) {
  const openai = getOpenAIClient();

  const response = await openai.responses.create({
    model: DEFAULT_RESOLVER_MODEL,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You classify user speech for a Wise transfer-tracking browser demo. " +
              "Return only strict JSON with keys category, intent, conversationalType, and rationale. " +
              "category must be one of conversational, supported_faq, wise_unsupported, off_topic, or unclear. " +
              "If category is conversational, conversationalType must be one of greeting, thanks, goodbye, capability_question, repeat_request, clarify_request, or frustration_or_correction. " +
              "If category is supported_faq, intent must be one of check_transfer_status, money_arrival_time, complete_but_not_arrived, transfer_delayed, proof_of_payment, or banking_partner_reference. " +
              "If category is not supported_faq, intent must be null.",
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "Supported Wise transfer topics:\n" +
              Object.entries(QUESTIONS)
                .map(([intent, item]) => `- ${intent}: ${item.title}`)
                .join("\n") +
              `\n\nUser speech: ${question}`,
          },
        ],
      },
    ],
    max_output_tokens: 140,
  });

  try {
    return JSON.parse(response.output_text);
  } catch {
    return null;
  }
}

function normalizeModelRoute(rawRoute) {
  if (!rawRoute || typeof rawRoute !== "object") {
    return null;
  }

  const category = typeof rawRoute.category === "string" ? rawRoute.category : null;
  const intent = typeof rawRoute.intent === "string" ? rawRoute.intent : null;
  const conversationalType =
    typeof rawRoute.conversationalType === "string" ? rawRoute.conversationalType : null;
  const rationale = typeof rawRoute.rationale === "string" ? rawRoute.rationale : "No rationale provided.";

  if (!category) {
    return null;
  }

  return { category, intent, conversationalType, rationale };
}

function buildFinalResult(route) {
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
    const type = route.conversationalType || "clarify_request";
    return {
      category: "conversational",
      intent: null,
      conversationalType: type,
      responseText: CONVERSATIONAL_REPLIES[type] || CONVERSATIONAL_REPLIES.clarify_request,
      sourceTitle: null,
      sourceUrl: null,
      shouldEndCall: type === "goodbye",
      rationale: route.rationale,
    };
  }

  if (route.category === "supported_faq" && route.intent && QUESTIONS[route.intent]) {
    const item = QUESTIONS[route.intent];
    return {
      category: "supported_faq",
      intent: route.intent,
      conversationalType: null,
      responseText: item.answer,
      sourceTitle: item.title,
      sourceUrl: item.url,
      shouldEndCall: false,
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

  return {
    category: "unclear",
    intent: null,
    conversationalType: null,
    responseText: "Could you tell me your Wise transfer tracking question?",
    sourceTitle: null,
    sourceUrl: null,
    shouldEndCall: false,
    rationale: route.rationale,
  };
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
  const localRoute = classifyLocally(userQuestion);
  const route =
    localRoute?.category === "supported_faq" ||
    localRoute?.category === "conversational" ||
    localRoute?.category === "wise_unsupported" ||
    localRoute?.category === "off_topic"
      ? localRoute
      : normalizeModelRoute(await classifyWithModel(userQuestion)) || localRoute;

  return buildFinalResult(route);
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
