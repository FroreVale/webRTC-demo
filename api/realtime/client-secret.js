import { handleRealtimeApiRequest } from "../../server/realtime-api.js";

export default async function handler(request, response) {
  const result = await handleRealtimeApiRequest({
    method: request.method || "GET",
    pathname: "/api/realtime/client-secret",
    body: "",
  });

  response.statusCode = result.status;
  for (const [headerName, headerValue] of Object.entries(result.headers)) {
    response.setHeader(headerName, headerValue);
  }
  response.end(result.body);
}
