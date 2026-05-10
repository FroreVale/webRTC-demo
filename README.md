# Wise Transfer Voice Assistant

A browser-based voice assistant for Wise transfer tracking questions.

The app:

- listens through the microphone in the browser
- sends speech to OpenAI Realtime over WebRTC
- routes each completed transcript through a server-side Wise FAQ gate
- answers supported Wise transfer-tracking questions from a local FAQ corpus
- deflects unsupported or unrelated questions

## Stack

- React
- Vite
- TypeScript
- OpenAI Realtime
- OpenAI embeddings and response models
- Node-based server routes

## Project Structure

- `src/` - browser UI, microphone flow, and realtime session handling
- `server/` - API routes and FAQ routing logic
- `data/` - Wise FAQ source data and generated search index
- `public/` - static assets
- `vercel.json` - deployment routing for the SPA and API routes

## Core Files

- [`src/App.tsx`](./src/App.tsx) - main browser app, session state, transcript handling, and debug logs
- [`server/realtime-api.js`](./server/realtime-api.js) - API handler for client secrets and transcript resolution
- [`server/wise-knowledge.js`](./server/wise-knowledge.js) - turn classification, retrieval, scoring, and answer generation
- [`data/wiseFaq.json`](./data/wiseFaq.json) - source Wise help content
- [`data/wiseFaq.index.json`](./data/wiseFaq.index.json) - generated retrieval cache

## How It Works

1. The browser starts a Realtime session.
2. Speech is transcribed by OpenAI Realtime.
3. The completed transcript is sent to the server resolver.
4. The server classifies the turn:
   - conversational
   - contextual follow-up
   - supported FAQ
   - Wise-related but unsupported
   - off-topic
5. If the turn is FAQ-like, the resolver searches the Wise knowledge base and generates a spoken-friendly answer.

## Local Development

### Requirements

- Node.js
- an `OPENAI_API_KEY`

### Environment Variables

Create a `.env` file in the project root:

```env
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime-mini
OPENAI_ROUTER_MODEL=gpt-5.4-mini
OPENAI_ANSWER_MODEL=gpt-5.4-mini
OPENAI_RESOLVER_MODEL=gpt-5.4-mini
PORT=3000
```

### Run Locally

```bash
pnpm install
pnpm dev
```

### Build

```bash
pnpm build
```

### Preview

```bash
pnpm preview
```

## Deployment

This repo is ready for Vercel.

Recommended flow:

1. Push the repository to GitHub.
2. Import the repo into Vercel.
3. Set the environment variables in the Vercel project settings.
4. Deploy a preview first.
5. Share the preview URL with testers.
6. Promote the deployment to production when ready.

The `vercel.json` file routes:

- `/api/*` to serverless routes
- everything else to the Vite SPA

## Notes

- The FAQ cache in `data/wiseFaq.index.json` is generated from the source FAQ content.
- The resolver uses embeddings plus lightweight lexical signals to rank candidate articles.
- Contextual follow-ups are handled through conversation state, not keyword-only matching.
- Unsupported Wise support questions are deflected to a human agent.

## Troubleshooting

- If the assistant refuses all questions, confirm `OPENAI_API_KEY` is set in your local `.env` and in Vercel.
- If deployment works locally but not on Vercel, check the Function logs for `/api/realtime/client-secret` and `/api/realtime/resolve`.
- If answers feel too strict, inspect the threshold logic in `server/wise-knowledge.js`.
