import { listOperationalAlerts } from "./alerts";
import { handleCleanupAdminRoute } from "./cleanup";
import { handleCleanupOperationRoute } from "./cleanupOperations";
import { listNodeHealthHistory } from "./healthHistory";
import legacyWorker from "./index";
import { handleNodeOperationRoute } from "./nodeOperations";
import { handleProvisioningAdminRoute } from "./provisioning";
import { handleProvisioningRetryRoute } from "./provisioningRetry";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
  NODE_OPERATION_LEASE_SECONDS?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/v1/admin/alerts") {
      return await listOperationalAlerts(request, env);
    }

    const historyMatch = url.pathname.match(
      /^\/v1\/admin\/nodes\/([0-9a-f-]+)\/health-history$/i,
    );
    if (request.method === "GET" && historyMatch) {
      return await listNodeHealthHistory(request, env, historyMatch[1]);
    }

    const cleanupOperationResponse = await handleCleanupOperationRoute(request, env);
    if (cleanupOperationResponse) return cleanupOperationResponse;

    const nodeOperationResponse = await handleNodeOperationRoute(request, env);
    if (nodeOperationResponse) return nodeOperationResponse;

    const cleanupAdminResponse = await handleCleanupAdminRoute(request, env);
    if (cleanupAdminResponse) return cleanupAdminResponse;

    const retryResponse = await handleProvisioningRetryRoute(request, env);
    if (retryResponse) return retryResponse;

    const provisioningResponse = await handleProvisioningAdminRoute(request, env);
    if (provisioningResponse) return provisioningResponse;

    return await legacyWorker.fetch(request, env);
  },
};
