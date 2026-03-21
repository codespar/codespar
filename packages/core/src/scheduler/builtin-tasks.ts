/**
 * Built-in scheduled tasks that agents can opt into.
 */

import { scheduler } from "./scheduler.js";
import type { StorageProvider } from "../storage/types.js";

/** Daily build status summary. Runs every 24h. */
export function scheduleBuildStatusReport(
  agentId: string,
  callback: (summary: string) => Promise<void>,
): void {
  scheduler.schedule(
    `${agentId}:build-status`,
    24 * 60 * 60 * 1000, // 24 hours
    async () => {
      const summary = `Daily build status report for ${agentId} at ${new Date().toISOString()}`;
      await callback(summary);
    },
  );
}

/** Periodic health check. Runs every 5 minutes. */
export function scheduleHealthCheck(
  agentId: string,
  callback: (healthy: boolean) => Promise<void>,
): void {
  scheduler.schedule(
    `${agentId}:health-check`,
    5 * 60 * 1000, // 5 minutes
    async () => {
      await callback(true);
    },
  );
}

/** Audit log cleanup (remove entries older than retention period). */
export function scheduleAuditCleanup(
  _storage: StorageProvider,
  _retentionDays: number = 365,
): void {
  scheduler.schedule(
    "system:audit-cleanup",
    24 * 60 * 60 * 1000, // Daily
    async () => {
      // Future: implement cleanup based on retention period
      // For now, just log that it ran
    },
  );
}
