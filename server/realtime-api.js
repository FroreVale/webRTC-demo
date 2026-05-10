import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { resolveTranscript as resolveWiseTranscript } from "./wise-knowledge.js";

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

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  return new OpenAI({ apiKey });
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
  return resolveWiseTranscript(userQuestion);
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
