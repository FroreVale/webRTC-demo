export type RealtimeApiRequest = {
  method: string;
  pathname: string;
  body: string;
};

export type RealtimeApiResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export function handleRealtimeApiRequest(
  request: RealtimeApiRequest,
): Promise<RealtimeApiResponse>;
