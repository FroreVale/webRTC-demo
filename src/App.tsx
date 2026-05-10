import { useEffect, useRef, useState } from "react";

type SessionState = "idle" | "starting" | "connected" | "stopping" | "error";

type ResolveResult = {
  category: "conversational" | "supported_faq" | "wise_unsupported" | "off_topic" | "unclear";
  intent: string | null;
  conversationalType: string | null;
  responseText: string;
  sourceTitle: string | null;
  sourceUrl: string | null;
  shouldEndCall: boolean;
  rationale: string;
  debug?: {
    route: string;
    topScore: number;
    topChunks: Array<{
      articleTitle: string;
      sectionTitle: string;
      score: number;
      cosine: number;
      lexical: number;
    }>;
  };
};

type ResolvePayload = {
  ok: boolean;
  result: ResolveResult;
};

type ResolveContext = {
  lastCategory: ResolveResult["category"] | null;
  lastSourceTitle: string | null;
  lastSourceUrl: string | null;
  lastUserQuestion: string | null;
  lastAssistantText: string | null;
};

type RealtimeMessage = {
  type?: string;
  transcript?: string;
  error?: unknown;
};

const SAMPLE_PROMPTS = [
  "How do I check my transfer's status?",
  "When will my money arrive?",
  "What is a proof of payment?",
  "Can you teach me cooking?",
];

function extractErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong.";
}

function App() {
  const [sessionState, setSessionState] = useState<SessionState>("idle");
  const [statusText, setStatusText] = useState("Press Start and allow microphone access.");
  const [routeText, setRouteText] = useState("Waiting");
  const [transcript, setTranscript] = useState("");
  const [assistantText, setAssistantText] = useState("");
  const [sourceTitle, setSourceTitle] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>(["Ready."]);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const isAssistantSpeakingRef = useRef(false);
  const isHandlingTurnRef = useRef(false);
  const queuedTranscriptRef = useRef<{ transcript: string; generation: number } | null>(null);
  const turnGenerationRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);
  const lastResolveContextRef = useRef<ResolveContext>({
    lastCategory: null,
    lastSourceTitle: null,
    lastSourceUrl: null,
    lastUserQuestion: null,
    lastAssistantText: null,
  });

  useEffect(() => {
    return () => {
      if (stopTimerRef.current) {
        window.clearTimeout(stopTimerRef.current);
      }
      cleanupSession();
    };
  }, []);

  function appendLog(line: string) {
    const timestamp = new Date().toLocaleTimeString();
    setLogLines((current) => [...current, `[${timestamp}] ${line}`]);
  }

  function cleanupSession() {
    isAssistantSpeakingRef.current = false;
    isHandlingTurnRef.current = false;
    queuedTranscriptRef.current = null;
    turnGenerationRef.current = 0;
    lastResolveContextRef.current = {
      lastCategory: null,
      lastSourceTitle: null,
      lastSourceUrl: null,
      lastUserQuestion: null,
      lastAssistantText: null,
    };

    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }

    if (dataChannelRef.current) {
      try {
        dataChannelRef.current.close();
      } catch {
        // ignore
      }
      dataChannelRef.current = null;
    }

    if (peerConnectionRef.current) {
      try {
        peerConnectionRef.current.close();
      } catch {
        // ignore
      }
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
    }
  }

  function sendRealtimeEvent(payload: Record<string, unknown>) {
    const dataChannel = dataChannelRef.current;
    if (!dataChannel || dataChannel.readyState !== "open") {
      throw new Error("Realtime data channel is not open.");
    }

    dataChannel.send(JSON.stringify(payload));
  }

  function interruptAssistantSpeech() {
    const dataChannel = dataChannelRef.current;
    if (!dataChannel || dataChannel.readyState !== "open") {
      return;
    }

    try {
      sendRealtimeEvent({ type: "response.cancel" });
    } catch {
      // ignore
    }

    try {
      sendRealtimeEvent({ type: "output_audio_buffer.clear" });
    } catch {
      // ignore
    }

    isAssistantSpeakingRef.current = false;
    appendLog("Interrupted assistant speech.");
  }

  function requestSpeech(text: string, metadata?: Record<string, string | boolean>) {
    isAssistantSpeakingRef.current = true;
    setAssistantText(text);

    sendRealtimeEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text,
          },
        ],
      },
    });

    sendRealtimeEvent({
      type: "response.create",
      response: {
        instructions:
          "Speak the assistant message that was just added to the conversation. Do not add extra facts or rephrase the message.",
        metadata,
      },
    });
  }

  async function resolveAndSpeak(userQuestion: string, generation: number) {
    appendLog("Sending transcript to the server route gate.");

    const resolveResponse = await fetch("/api/realtime/resolve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        userQuestion,
        context: lastResolveContextRef.current,
      }),
    });

    if (!resolveResponse.ok) {
      throw new Error(`Resolver failed: ${await resolveResponse.text()}`);
    }

    const payload = (await resolveResponse.json()) as ResolvePayload;

    if (generation !== turnGenerationRef.current) {
      appendLog("Ignored a stale transcript after newer speech started.");
      return;
    }

    const result = payload.result;
    setRouteText(result.category);
    setAssistantText(result.responseText);
    setSourceTitle(result.sourceTitle);
    setSourceUrl(result.sourceUrl);
    lastResolveContextRef.current = {
      lastCategory: result.category,
      lastSourceTitle: result.sourceTitle,
      lastSourceUrl: result.sourceUrl,
      lastUserQuestion: userQuestion,
      lastAssistantText: result.responseText,
    };

    if (result.debug) {
      const matchPercent = Math.round(Math.min(1, Math.max(0, result.debug.topScore || 0)) * 100);
      appendLog(`Retriever route: ${result.debug.route}.`);
      appendLog(`Top match score: ${matchPercent}%`);
      for (const [index, item] of result.debug.topChunks.slice(0, 3).entries()) {
        appendLog(
          `Match ${index + 1}: ${item.score.toFixed(3)} total | ${item.cosine.toFixed(3)} semantic | ${item.lexical.toFixed(3)} lexical | ${item.articleTitle} | ${item.sectionTitle}`
        );
      }
    }

    requestSpeech(result.responseText, {
      route_category: result.category,
      should_end_call: String(result.shouldEndCall),
    });

    appendLog(`Route selected: ${result.category}.`);

    if (result.shouldEndCall) {
      if (stopTimerRef.current) {
        window.clearTimeout(stopTimerRef.current);
      }

      stopTimerRef.current = window.setTimeout(() => {
        void stopSession();
      }, 1800);
    }
  }

  async function processTranscript(userQuestion: string, generation: number) {
    isHandlingTurnRef.current = true;

    try {
      await resolveAndSpeak(userQuestion, generation);
    } finally {
      isHandlingTurnRef.current = false;

      const queuedTranscript = queuedTranscriptRef.current;
      if (queuedTranscript) {
        queuedTranscriptRef.current = null;
        appendLog("Processing queued caller speech.");
        void processTranscript(queuedTranscript.transcript, queuedTranscript.generation).catch((error) => {
          appendLog(extractErrorMessage(error));
        });
      }
    }
  }

  async function handleRealtimeMessage(rawData: string) {
    let message: RealtimeMessage;

    try {
      message = JSON.parse(rawData) as RealtimeMessage;
    } catch {
      return;
    }

    if (message.type === "input_audio_buffer.speech_started") {
      turnGenerationRef.current += 1;

      if (isAssistantSpeakingRef.current) {
        interruptAssistantSpeech();
      }

      return;
    }

    if (message.type === "conversation.item.input_audio_transcription.completed" && message.transcript) {
      const transcriptText = message.transcript.trim();
      setTranscript(transcriptText);
      appendLog(`You: ${transcriptText}`);

      turnGenerationRef.current += 1;
      const generation = turnGenerationRef.current;

      if (isHandlingTurnRef.current) {
        queuedTranscriptRef.current = { transcript: transcriptText, generation };
        appendLog("Queued overlapping speech while the last turn is still resolving.");
        return;
      }

      await processTranscript(transcriptText, generation);
      return;
    }

    if (message.type === "response.output_audio_transcript.done" && message.transcript) {
      appendLog(`Assistant: ${message.transcript}`);
      return;
    }

    if (message.type === "response.done") {
      isAssistantSpeakingRef.current = false;
      return;
    }

    if (message.type === "output_audio_buffer.cleared") {
      isAssistantSpeakingRef.current = false;
      return;
    }

    if (message.type === "error") {
      const error = message.error;
      const errorCode =
        error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : null;

      if (errorCode === "response_cancel_not_active") {
        return;
      }

      appendLog(`Realtime error: ${JSON.stringify(error ?? message)}`);
    }
  }

  async function startSession() {
    if (sessionState === "starting" || sessionState === "connected") {
      return;
    }

    setSessionState("starting");
    setStatusText("Requesting microphone access.");
    setRouteText("Waiting");
    setTranscript("");
    setAssistantText("");
    setSourceTitle(null);
    setSourceUrl(null);
    setLogLines(["Preparing voice session."]);

    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;
      appendLog("Microphone granted.");

      const clientSecretResponse = await fetch("/api/realtime/client-secret", {
        method: "POST",
      });

      if (!clientSecretResponse.ok) {
        throw new Error(`Client secret request failed: ${await clientSecretResponse.text()}`);
      }

      const clientSecretPayload = await clientSecretResponse.json();

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      peerConnection.ontrack = (event) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = event.streams[0];
        }
      };

      peerConnection.onconnectionstatechange = () => {
        if (peerConnection.connectionState === "connected") {
          setSessionState("connected");
          setStatusText("Connected. Speak naturally.");
          appendLog("Peer connection connected.");
        }

        if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "disconnected") {
          setSessionState("error");
          setStatusText("Connection lost.");
          appendLog(`Peer connection state: ${peerConnection.connectionState}.`);
        }
      };

      for (const track of localStream.getTracks()) {
        peerConnection.addTrack(track, localStream);
      }

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.onmessage = (event) => {
        void handleRealtimeMessage(String(event.data)).catch((error) => {
          appendLog(extractErrorMessage(error));
        });
      };

      dataChannel.onopen = () => {
        appendLog("Realtime data channel opened.");
      };

      dataChannel.onerror = () => {
        appendLog("Realtime data channel error.");
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const localSdp = peerConnection.localDescription?.sdp || offer.sdp || "";
      if (!localSdp) {
        throw new Error("Could not create a valid SDP offer.");
      }

      appendLog(`SDP offer created (${localSdp.length} chars).`);
      setStatusText("Connecting to OpenAI Realtime.");

      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${clientSecretPayload.clientSecret}`,
          "content-type": "application/sdp",
        },
        body: localSdp,
      });

      if (!sdpResponse.ok) {
        throw new Error(`Realtime call failed: ${await sdpResponse.text()}`);
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await sdpResponse.text(),
      });

      appendLog("Realtime session established.");
      setSessionState("connected");
      setStatusText("Listening. Speak freely.");
    } catch (error) {
      cleanupSession();
      setSessionState("error");
      setStatusText("Failed to start the session.");
      appendLog(extractErrorMessage(error));
    }
  }

  function stopSession() {
    cleanupSession();
    setSessionState("idle");
    setStatusText("Stopped. Press Start to begin again.");
    setRouteText("Waiting");
    setSourceTitle(null);
    setSourceUrl(null);
    appendLog("Session stopped.");
  }

  const isLive = sessionState === "starting" || sessionState === "connected";

  return (
    <main className="min-h-screen overflow-hidden bg-[#f4efe7] text-stone-950">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(22,101,52,0.16),_transparent_42%),radial-gradient(circle_at_right,_rgba(180,83,9,0.12),_transparent_28%),linear-gradient(180deg,_rgba(255,255,255,0.8),_rgba(255,255,255,0.5))]" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col px-5 py-6 sm:px-8 sm:py-8">
        <header className="flex flex-col gap-5 border-b border-stone-900/10 pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-emerald-800">
              Browser voice demo
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.06em] text-balance sm:text-6xl">
              Wise transfer tracking in the browser
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-stone-700 sm:text-lg">
              One click to start, then speak naturally. The assistant only answers the approved
              Wise transfer-tracking topics and interrupts cleanly when you barge in.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void startSession()}
              disabled={isLive}
              className="rounded-full bg-stone-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Start voice session
            </button>
            <button
              type="button"
              onClick={stopSession}
              disabled={!isLive}
              className="rounded-full border border-stone-900/15 bg-white/80 px-5 py-3 text-sm font-medium text-stone-950 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Stop
            </button>
          </div>
        </header>

        <section className="mt-6 grid flex-1 gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[2rem] border border-stone-900/10 bg-white/70 p-5 shadow-[0_20px_80px_rgba(23,23,23,0.08)] backdrop-blur-xl sm:p-7">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-[1.5rem] border border-stone-900/10 bg-stone-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Status</p>
                <p className="mt-3 text-base font-medium">{statusText}</p>
              </div>
              <div className="rounded-[1.5rem] border border-stone-900/10 bg-stone-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Route</p>
                <p className="mt-3 text-base font-medium">{routeText}</p>
              </div>
              <div className="rounded-[1.5rem] border border-stone-900/10 bg-stone-50 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Mode</p>
                <p className="mt-3 text-base font-medium">
                  {sessionState === "connected" ? "Live audio" : sessionState}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-[1.5rem] border border-stone-900/10 bg-[#122018] p-5 text-white">
                <p className="text-xs uppercase tracking-[0.2em] text-emerald-200">Transcript</p>
                <p className="mt-3 min-h-28 whitespace-pre-wrap text-base leading-7 text-stone-100">
                  {transcript || "Your speech will appear here after transcription."}
                </p>
              </div>

              <div className="rounded-[1.5rem] border border-stone-900/10 bg-[#1b1711] p-5 text-white">
                <p className="text-xs uppercase tracking-[0.2em] text-amber-200">Assistant reply</p>
                <p className="mt-3 min-h-28 whitespace-pre-wrap text-base leading-7 text-stone-100">
                  {assistantText || "The assistant reply appears here before it is spoken."}
                </p>
                {sourceTitle && sourceUrl ? (
                  <a
                    href={sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-4 inline-flex rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-stone-100 underline-offset-4 transition hover:bg-white/10 hover:underline"
                  >
                    {sourceTitle}
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-5 rounded-[1.5rem] border border-dashed border-stone-900/15 bg-stone-50 p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Try asking</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {SAMPLE_PROMPTS.map((prompt) => (
                  <span
                    key={prompt}
                    className="rounded-full border border-stone-900/10 bg-white px-3 py-1 text-sm text-stone-700"
                  >
                    {prompt}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <aside className="rounded-[2rem] border border-stone-900/10 bg-white/70 p-5 shadow-[0_20px_80px_rgba(23,23,23,0.08)] backdrop-blur-xl sm:p-7">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-stone-500">Session log</p>
                <h2 className="mt-2 text-xl font-semibold">What the demo is doing</h2>
              </div>
              <span className="rounded-full border border-stone-900/10 bg-stone-50 px-3 py-1 text-xs font-medium text-stone-600">
                OpenAI Realtime WebRTC
              </span>
            </div>

            <div className="mt-5 max-h-[28rem] overflow-auto rounded-[1.5rem] border border-stone-900/10 bg-[#111111] p-4 font-mono text-sm leading-6 text-stone-100">
              {logLines.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>

            <div className="mt-5 space-y-3 text-sm leading-6 text-stone-700">
              <p>Low latency comes from WebRTC audio, server VAD, and short fixed replies.</p>
              <p>Scope stays narrow because the backend routes every transcript before speaking.</p>
              <p>Interruption works because new speech cancels the current response immediately.</p>
            </div>
          </aside>
        </section>
      </div>

      <audio ref={remoteAudioRef} autoPlay playsInline />
    </main>
  );
}

export default App;
