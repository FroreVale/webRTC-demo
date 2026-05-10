# Web Voice Agent 3

A browser-based Wise transfer tracking demo built with:

- React
- Vite
- Tailwind CSS
- OpenAI Realtime over WebRTC
- a small server route for client secrets and scoped transcript routing

## What it does

- starts with one button click
- asks for microphone access
- streams speech to OpenAI Realtime with low-latency WebRTC
- transcribes user speech
- routes every completed transcript through a small server gate
- answers only the approved Wise transfer-tracking topics
- interrupts assistant speech when the user starts speaking again

## Environment

Create `.env` in the project root:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime-2
OPENAI_RESOLVER_MODEL=gpt-5.4-mini
```

Optional:

```env
PORT=3000
```

## Commands

```bash
pnpm dev
pnpm build
pnpm preview
```

## Hosting

This repo is set up to deploy on Vercel.

- the browser app is the Vite build
- `/api/realtime/client-secret` mints ephemeral Realtime credentials
- `/api/realtime/resolve` keeps the Wise scope gate on the server

## Notes

- Use headphones to avoid speaker feedback into the microphone.
- The assistant only covers Wise transfer-tracking questions.
- Unsupported Wise support questions are deflected to a human agent.
