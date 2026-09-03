import { listOperationalAlerts } from "./alerts";
import { handleBackupAdminRoute } from "./backups";
import { handleBackupOperationRoute } from "./backupOperations";
import { handleBackupUploadOperationRoute } from "./backupUploadOperations";
import { handleCleanupAdminRoute } from "./cleanup";
import { handleCleanupOperationRoute } from "./cleanupOperations";
import { listNodeHealthHistory } from "./healthHistory";
import legacyWorker from "./index";
import { handleNodeOperationRoute } from "./nodeOperations";
import { handleProvisioningAdminRoute } from "./provisioning";
import { handleProvisioningRetryRoute } from "./provisioningRetry";
import { handleRestoreOperationRoute } from "./restoreOperations";
import { handleRestoreAdminRoute } from "./restores";
import { handleTrialCleanupOperationRoute } from "./trialCleanupOperations";
import { reconcileExpiredTrials } from "./trialExpiration";
import { handleTrialAdminRoute } from "./trials";

interface Env {
  DB: D1Database;
  ADMIN_API_TOKEN: string;
  NODE_STALE_SECONDS?: string;
  NODE_OFFLINE_SECONDS?: string;
  NODE_OPERATION_LEASE_SECONDS?: string;
  TRIAL_BASE_DOMAIN?: string;
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

    const operationResultMatch = url.pathname.match(
      /^\/v1\/nodes\/([0-9a-f-]+)\/operations\/([0-9a-f-]+)\/result$/i,
    );
    let restoreOwnsResult = false;
    if (request.method === "POST" && operationResultMatch) {
      const restoreJob = await env.DB.prepare(`SELECT id FROM restore_jobs WHERE id = ?`)
        .bind(operationResultMatch[2]).first<{ id: string }>();
      restoreOwnsResult = Boolean(restoreJob);
    }

    if (!operationResultMatch || restoreOwnsResult) {
      const restoreOperationResponse = await handleRestoreOperationRoute(request, env);
      if (restoreOperationResponse) return restoreOperationResponse;
    }

    const backupUploadOperationResponse = await handleBackupUploadOperationRoute(request, env);
    if (backupUploadOperationResponse) return backupUploadOperationResponse;

    const backupOperationResponse = await handleBackupOperationRoute(request, env);
    if (backupOperationResponse) return backupOperationResponse;

    const trialCleanupOperationResponse = await handleTrialCleanupOperationRoute(request, env);
    if (trialCleanupOperationResponse) return trialCleanupOperationResponse;

    const cleanupOperationResponse = await handleCleanupOperationRoute(request, env);
    if (cleanupOperationResponse) return cleanupOperationResponse;

    const nodeOperationResponse = await handleNodeOperationRoute(request, env);
    if (nodeOperationResponse) return nodeOperationResponse;

    const restoreAdminResponse = await handleRestoreAdminRoute(request, env);
    if (restoreAdminResponse) return restoreAdminResponse;

    const backupAdminResponse = await handleBackupAdminRoute(request, env);
    if (backupAdminResponse) return backupAdminResponse;

    const cleanupAdminResponse = await handleCleanupAdminRoute(request, env);
    if (cleanupAdminResponse) return cleanupAdminResponse;

    const retryResponse = await handleProvisioningRetryRoute(request, env);
    if (retryResponse) return retryResponse;

    const trialResponse = await handleTrialAdminRoute(request, env);
    if (trialResponse) return trialResponse;

    const provisioningResponse = await handleProvisioningAdminRoute(request, env);
    if (provisioningResponse) return provisioningResponse;

    return await legacyWorker.fetch(request, env);
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reconcileExpiredTrials(env);
  },
};
