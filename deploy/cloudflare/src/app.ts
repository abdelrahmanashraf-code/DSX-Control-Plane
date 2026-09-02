import legacyWorker from "./index";
import { listNodeHealthHistory } from "./healthHistory";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const historyMatch = url.pathname.match(
      /^\/v1\/admin\/nodes\/([0-9a-f-]+)\/health-history$/i,
    );

    if (request.method === "GET" && historyMatch) {
      return await listNodeHealthHistory(request, env, historyMatch[1]);
    }

    return await legacyWorker.fetch(request, env);
  },
};
