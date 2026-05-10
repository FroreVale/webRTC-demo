import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { handleRealtimeApiRequest } from "./server/realtime-api.js";

async function readRequestBody(request: import("http").IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "realtime-api-dev",
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const method = request.method || "GET";
          const url = new URL(request.url || "/", "http://localhost");

          if (!url.pathname.startsWith("/api/realtime/")) {
            next();
            return;
          }

          const body = method === "POST" ? await readRequestBody(request) : "";
          const result = await handleRealtimeApiRequest({
            method,
            pathname: url.pathname,
            body,
          });

          response.statusCode = result.status;
          for (const [headerName, headerValue] of Object.entries(result.headers as Record<string, string>)) {
            response.setHeader(headerName, headerValue);
          }
          response.end(result.body);
        });
      },
    },
  ],
});
