import { handleRealtimeApiRequest } from "../../../server/realtime-api.js";

export default async function handler(request, response) {
  const body = await new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

  const result = await handleRealtimeApiRequest({
    method: request.method || "GET",
    pathname: "/api/realtime/resolve",
    body,
  });

  response.statusCode = result.status;
  for (const [headerName, headerValue] of Object.entries(result.headers)) {
    response.setHeader(headerName, headerValue);
  }
  response.end(result.body);
}
