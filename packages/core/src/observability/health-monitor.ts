/**
 * Post-deploy health monitor — watches error rate after a deploy succeeds.
 *
 * Polls the audit trail (or Sentry via audit events) at a configurable interval.
 * If the error rate exceeds a threshold for 2 consecutive checks, fires the
 * onUnhealthy callback (which can trigger rollback / channel alerts).
 * After the monitoring window ends, fires onComplete with final stats.
 *
 * Uses setInterval with unref() so monitoring does not block process exit.
 */

import { createLogger } from "./logger.js";
import type { StorageProvider } from "../storage/types.js";

const log = createLogger("health-monitor");

// ── Config ────────────────────────────────────────────────────────────

export interface HealthCheckConfig {
  /** Interval between health checks (default 30 s). */
  checkIntervalMs: number;
  /** Total monitoring window after deploy (default 5 min). */
  monitorDurationMs: number;
  /** Error rate threshold — fraction 0-1 (default 0.10 = 10%). */
  errorThreshold: number;
  /** Minimum requests before the error rate is considered meaningful (default 5). */
  minSamples: number;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  checkIntervalMs: 30_000,
  monitorDurationMs: 300_000,
  errorThreshold: 0.10,
  minSamples: 5,
};

// ── Result ────────────────────────────────────────────────────────────

export interface HealthCheckResult {
  healthy: boolean;
  errorRate: number;
  totalRequests: number;
  errorCount: number;
  checkCount: number;
  duration: string;
}

// ── Internal state per active monitor ─────────────────────────────────

interface ActiveMonitor {
  deployId: string;
  projectId: string;
  startedAt: number;
  timer: ReturnType<typeof setInterval>;
  timeout: ReturnType<typeof setTimeout>;
  checkCount: number;
  consecutiveUnhealthy: number;
  totalRequests: number;
  errorCount: number;
  cancelled: boolean;
}

// ── Monitor class ─────────────────────────────────────────────────────

export class DeployHealthMonitor {
  private monitors = new Map<string, ActiveMonitor>();
  private storage: StorageProvider | null;

  constructor(storage?: StorageProvider) {
    this.storage = storage ?? null;
  }

  /**
   * Start monitoring a deploy. Resolves when monitoring completes or the
   * deploy is deemed unhealthy (whichever comes first).
   */
  async monitor(
    projectId: string,
    deployId: string,
    config?: Partial<HealthCheckConfig>,
    onUnhealthy?: (result: HealthCheckResult) => Promise<void>,
    onComplete?: (result: HealthCheckResult) => void,
  ): Promise<HealthCheckResult> {
    const cfg: HealthCheckConfig = { ...DEFAULT_CONFIG, ...config };

    // Prevent duplicate monitors for the same deploy
    if (this.monitors.has(deployId)) {
      log.warn("Monitor already active for deploy", { deployId });
      this.cancel(deployId);
    }

    const monitor: ActiveMonitor = {
      deployId,
      projectId,
      startedAt: Date.now(),
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      timeout: undefined as unknown as ReturnType<typeof setTimeout>,
      checkCount: 0,
      consecutiveUnhealthy: 0,
      totalRequests: 0,
      errorCount: 0,
      cancelled: false,
    };

    this.monitors.set(deployId, monitor);

    return new Promise<HealthCheckResult>((resolve) => {
      const finish = (result: HealthCheckResult) => {
        if (monitor.cancelled) return;
        monitor.cancelled = true;
        clearInterval(monitor.timer);
        clearTimeout(monitor.timeout);
        this.monitors.delete(deployId);
        resolve(result);
      };

      // ── Periodic check ───────────────────────────────────────────
      const runCheck = async () => {
        if (monitor.cancelled) return;

        monitor.checkCount++;
        const { totalRequests, errorCount } = await this.countRecentErrors(
          projectId,
          monitor.startedAt,
        );
        monitor.totalRequests = totalRequests;
        monitor.errorCount = errorCount;

        const errorRate =
          totalRequests >= cfg.minSamples ? errorCount / totalRequests : 0;

        log.info("Health check", {
          deployId,
          check: monitor.checkCount,
          totalRequests,
          errorCount,
          errorRate: (errorRate * 100).toFixed(1) + "%",
        });

        if (totalRequests >= cfg.minSamples && errorRate > cfg.errorThreshold) {
          monitor.consecutiveUnhealthy++;
        } else {
          monitor.consecutiveUnhealthy = 0;
        }

        // Two consecutive unhealthy checks → fire onUnhealthy and stop
        if (monitor.consecutiveUnhealthy >= 2) {
          const result = this.buildResult(monitor, false, errorRate);
          log.warn("Deploy unhealthy — triggering callback", { deployId, errorRate });
          if (onUnhealthy) {
            try {
              await onUnhealthy(result);
            } catch (err) {
              log.error("onUnhealthy callback error", { error: String(err) });
            }
          }
          finish(result);
        }
      };

      // Start the interval — unref() so it doesn't keep the process alive
      monitor.timer = setInterval(runCheck, cfg.checkIntervalMs);
      if (typeof monitor.timer.unref === "function") {
        monitor.timer.unref();
      }

      // ── Overall timeout ──────────────────────────────────────────
      monitor.timeout = setTimeout(() => {
        if (monitor.cancelled) return;
        const errorRate =
          monitor.totalRequests >= cfg.minSamples
            ? monitor.errorCount / monitor.totalRequests
            : 0;
        const result = this.buildResult(monitor, true, errorRate);
        log.info("Monitoring complete — deploy healthy", { deployId });
        if (onComplete) {
          try {
            onComplete(result);
          } catch (err) {
            log.error("onComplete callback error", { error: String(err) });
          }
        }
        finish(result);
      }, cfg.monitorDurationMs);

      if (typeof monitor.timeout.unref === "function") {
        monitor.timeout.unref();
      }
    });
  }

  /** Cancel an active monitor for a deploy. */
  cancel(deployId: string): void {
    const m = this.monitors.get(deployId);
    if (!m) return;
    m.cancelled = true;
    clearInterval(m.timer);
    clearTimeout(m.timeout);
    this.monitors.delete(deployId);
    log.info("Monitor cancelled", { deployId });
  }

  /** List all currently active monitors. */
  getActive(): Array<{ deployId: string; projectId: string; startedAt: number }> {
    return Array.from(this.monitors.values()).map((m) => ({
      deployId: m.deployId,
      projectId: m.projectId,
      startedAt: m.startedAt,
    }));
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Count recent error events from the audit trail since `sinceMs`.
   * Looks for Sentry error events and deploy error events for the project.
   */
  private async countRecentErrors(
    projectId: string,
    sinceMs: number,
  ): Promise<{ totalRequests: number; errorCount: number }> {
    if (!this.storage) {
      return { totalRequests: 0, errorCount: 0 };
    }

    try {
      // Fetch recent audit entries (broad query — empty agent ID returns all)
      const { entries } = await this.storage.queryAudit("", 200, 0);

      let totalRequests = 0;
      let errorCount = 0;

      for (const entry of entries) {
        // Only count entries since monitoring started
        const entryTime =
          entry.timestamp instanceof Date
            ? entry.timestamp.getTime()
            : new Date(entry.timestamp).getTime();
        if (entryTime < sinceMs) continue;

        // Match entries related to this project
        const meta = entry.metadata as Record<string, unknown> | undefined;
        const entryProject = String(meta?.project || "");
        if (entryProject !== projectId) continue;

        // Count Sentry errors and deploy errors
        const isSentryError =
          entry.actorId === "sentry" && entry.result === "error";
        const isDeployError =
          entry.action.startsWith("deploy.") && entry.result === "error";
        const isSuccess =
          entry.result === "success" ||
          entry.action.startsWith("deploy.READY") ||
          entry.action.startsWith("deploy.succeeded");

        if (isSentryError || isDeployError) {
          totalRequests++;
          errorCount++;
        } else if (isSuccess) {
          totalRequests++;
        }
      }

      return { totalRequests, errorCount };
    } catch (err) {
      log.error("Failed to query audit for health check", { error: String(err) });
      return { totalRequests: 0, errorCount: 0 };
    }
  }

  private buildResult(
    monitor: ActiveMonitor,
    healthy: boolean,
    errorRate: number,
  ): HealthCheckResult {
    const durationMs = Date.now() - monitor.startedAt;
    const durationSec = Math.round(durationMs / 1000);
    const minutes = Math.floor(durationSec / 60);
    const seconds = durationSec % 60;
    const duration =
      minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

    return {
      healthy,
      errorRate,
      totalRequests: monitor.totalRequests,
      errorCount: monitor.errorCount,
      checkCount: monitor.checkCount,
      duration,
    };
  }
}
