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
import { RollbackDecisionEngine } from "./rollback-decision.js";
import type { RollbackContext, RollbackDecision } from "./rollback-decision.js";
import type { SentryClient } from "../integrations/sentry-client.js";

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
  /** Rollback decision context (populated when decision engine is active). */
  rollbackDecision?: RollbackDecision;
  /** Baseline error rate captured before deploy started. */
  baselineErrorRate?: number;
  /** Error messages that appeared after deploy but not before. */
  newErrors?: string[];
  /** Error messages that existed before deploy but are now gone. */
  resolvedErrors?: string[];
}

/** Snapshot of error state captured before a deploy, used for comparison. */
export interface BaselineSnapshot {
  errorRate: number;
  totalRequests: number;
  errorCount: number;
  errorMessages: Set<string>;
  capturedAt: number;
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
  baseline: BaselineSnapshot | null;
  currentErrorMessages: Set<string>;
}

// ── Monitor class ─────────────────────────────────────────────────────

export class DeployHealthMonitor {
  private monitors = new Map<string, ActiveMonitor>();
  private storage: StorageProvider | null;
  private decisionEngine: RollbackDecisionEngine;
  private sentryClient: SentryClient | null = null;
  /** Map of projectId → Sentry project slug for API queries. */
  private sentryProjectMap = new Map<string, string>();

  constructor(storage?: StorageProvider, decisionEngine?: RollbackDecisionEngine) {
    this.storage = storage ?? null;
    this.decisionEngine = decisionEngine ?? new RollbackDecisionEngine();
  }

  /**
   * Configure optional Sentry integration for direct API error count correlation.
   * When set, health checks will also query Sentry for error counts since deploy time,
   * providing faster and more accurate error detection than audit trail alone.
   */
  setSentryClient(client: SentryClient, projectMap?: Map<string, string>): void {
    this.sentryClient = client;
    if (projectMap) this.sentryProjectMap = projectMap;
    log.info("Sentry client configured for health monitoring");
  }

  /**
   * Capture baseline error state for a project by querying the last 5 minutes
   * of audit entries. Call this BEFORE starting monitoring for a deploy.
   */
  async captureBaseline(
    projectId: string,
    windowMs = 300_000,
  ): Promise<BaselineSnapshot> {
    const sinceMs = Date.now() - windowMs;
    const { totalRequests, errorCount, errorMessages } =
      await this.countRecentErrorsWithMessages(projectId, sinceMs);
    const errorRate =
      totalRequests > 0 ? errorCount / totalRequests : 0;

    const snapshot: BaselineSnapshot = {
      errorRate,
      totalRequests,
      errorCount,
      errorMessages: new Set(errorMessages),
      capturedAt: Date.now(),
    };

    log.info("Baseline captured", {
      projectId,
      errorRate: (errorRate * 100).toFixed(1) + "%",
      totalRequests,
      errorCount,
      uniqueErrors: errorMessages.length,
    });

    return snapshot;
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
    options?: {
      baseline?: BaselineSnapshot;
      onMonitorExtended?: (result: HealthCheckResult) => Promise<void>;
      onIgnored?: (result: HealthCheckResult) => Promise<void>;
    },
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
      baseline: options?.baseline ?? null,
      currentErrorMessages: new Set(),
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
        const { totalRequests, errorCount, errorMessages } =
          await this.countRecentErrorsWithMessages(projectId, monitor.startedAt);
        monitor.totalRequests = totalRequests;
        monitor.errorCount = errorCount;
        monitor.currentErrorMessages = new Set(errorMessages);

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

        // Two consecutive unhealthy checks → evaluate with decision engine
        if (monitor.consecutiveUnhealthy >= 2) {
          // Build rollback context for the decision engine
          const baseline = monitor.baseline;
          const newErrors = baseline
            ? errorMessages.filter((m) => !baseline.errorMessages.has(m))
            : errorMessages;
          const resolvedErrors = baseline
            ? [...baseline.errorMessages].filter(
                (m) => !monitor.currentErrorMessages.has(m),
              )
            : [];

          const ctx: RollbackContext = {
            projectId,
            deployId,
            deployTimestamp: monitor.startedAt,
            currentErrorRate: errorRate,
            baselineErrorRate: baseline?.errorRate ?? 0,
            newErrors,
            resolvedErrors,
            totalRequests,
          };

          const decision = this.decisionEngine.decide(ctx);
          const result = this.buildResult(monitor, false, errorRate);
          result.rollbackDecision = decision;
          result.baselineErrorRate = baseline?.errorRate ?? 0;
          result.newErrors = newErrors;
          result.resolvedErrors = resolvedErrors;

          if (decision.action === "rollback") {
            log.warn("Deploy unhealthy — rollback recommended", {
              deployId,
              errorRate,
              reason: decision.reason,
            });
            if (onUnhealthy) {
              try {
                await onUnhealthy(result);
              } catch (err) {
                log.error("onUnhealthy callback error", { error: String(err) });
              }
            }
            finish(result);
          } else if (decision.action === "monitor") {
            log.info("Deploy flagged — extending monitoring", {
              deployId,
              errorRate,
              reason: decision.reason,
            });
            // Reset consecutive counter so monitoring continues
            monitor.consecutiveUnhealthy = 0;
            if (options?.onMonitorExtended) {
              try {
                await options.onMonitorExtended(result);
              } catch (err) {
                log.error("onMonitorExtended callback error", { error: String(err) });
              }
            }
          } else {
            // "ignore" — false alarm, pre-existing errors
            log.info("Deploy flagged — ignoring (false alarm)", {
              deployId,
              errorRate,
              reason: decision.reason,
            });
            monitor.consecutiveUnhealthy = 0;
            if (options?.onIgnored) {
              try {
                await options.onIgnored(result);
              } catch (err) {
                log.error("onIgnored callback error", { error: String(err) });
              }
            }
          }
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
    const result = await this.countRecentErrorsWithMessages(projectId, sinceMs);
    return { totalRequests: result.totalRequests, errorCount: result.errorCount };
  }

  /**
   * Count recent errors and collect unique error messages for pattern comparison.
   */
  private async countRecentErrorsWithMessages(
    projectId: string,
    sinceMs: number,
  ): Promise<{ totalRequests: number; errorCount: number; errorMessages: string[] }> {
    if (!this.storage) {
      return { totalRequests: 0, errorCount: 0, errorMessages: [] };
    }

    try {
      const { entries } = await this.storage.queryAudit("", 200, 0);

      let totalRequests = 0;
      let errorCount = 0;
      const errorMessages: Set<string> = new Set();

      for (const entry of entries) {
        const entryTime =
          entry.timestamp instanceof Date
            ? entry.timestamp.getTime()
            : new Date(entry.timestamp).getTime();
        if (entryTime < sinceMs) continue;

        const meta = entry.metadata as Record<string, unknown> | undefined;
        const entryProject = String(meta?.project || "");
        if (entryProject !== projectId) continue;

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
          // Extract error message for pattern comparison
          const errorMsg =
            String(meta?.errorMessage || meta?.error || entry.action);
          errorMessages.add(errorMsg.slice(0, 200));
        } else if (isSuccess) {
          totalRequests++;
        }
      }

      // Supplement with Sentry API data if client is configured
      if (this.sentryClient) {
        try {
          const sentryProjectSlug = this.sentryProjectMap.get(projectId) || projectId;
          const sentryErrorCount = await this.sentryClient.getErrorCount(
            sentryProjectSlug,
            new Date(sinceMs),
          );
          if (sentryErrorCount > errorCount) {
            log.info("Sentry API reports higher error count than audit trail", {
              projectId,
              auditErrors: errorCount,
              sentryErrors: sentryErrorCount,
            });
            // Use the higher of the two counts — Sentry may catch errors
            // that haven't been forwarded via webhook yet
            const additional = sentryErrorCount - errorCount;
            errorCount += additional;
            totalRequests += additional;
          }
        } catch (err) {
          log.warn("Sentry API check failed during health monitoring, using audit data only", {
            projectId,
            error: String(err),
          });
        }
      }

      return { totalRequests, errorCount, errorMessages: [...errorMessages] };
    } catch (err) {
      log.error("Failed to query audit for health check", { error: String(err) });
      return { totalRequests: 0, errorCount: 0, errorMessages: [] };
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
