/**
 * Rollback Decision Engine — intelligent rollback logic that compares
 * before/after deploy error patterns instead of using a simple threshold.
 *
 * Factors considered:
 * - Baseline error rate (pre-deploy) vs current error rate
 * - New error types that didn't exist before the deploy
 * - Errors that were resolved by the deploy
 * - Number of affected users
 * - Sample size sufficiency
 */

import { createLogger } from "./logger.js";

const log = createLogger("rollback-decision");

// ── Types ────────────────────────────────────────────────────────────

export interface RollbackContext {
  projectId: string;
  deployId: string;
  deployTimestamp: number;
  currentErrorRate: number;
  baselineErrorRate: number;
  newErrors: string[];
  resolvedErrors: string[];
  totalRequests: number;
  affectedUsers?: number;
}

export type RollbackDecision =
  | { action: "rollback"; reason: string; confidence: "high" | "medium" | "low" }
  | { action: "monitor"; reason: string }
  | { action: "ignore"; reason: string };

// ── Config ───────────────────────────────────────────────────────────

export interface RollbackDecisionConfig {
  /** Minimum requests before decisions are meaningful (default 5). */
  minSamples: number;
  /** Baseline error rate above which pre-existing errors are considered (default 0.05 = 5%). */
  highBaselineThreshold: number;
  /** Maximum error rate increase (relative) before it's considered a spike (default 0.50 = 50% increase). */
  spikeRelativeThreshold: number;
  /** Maximum affected users before forcing rollback regardless (default 100). */
  affectedUsersThreshold: number;
}

const DEFAULT_CONFIG: RollbackDecisionConfig = {
  minSamples: 5,
  highBaselineThreshold: 0.05,
  spikeRelativeThreshold: 0.50,
  affectedUsersThreshold: 100,
};

// ── Engine ───────────────────────────────────────────────────────────

export class RollbackDecisionEngine {
  private config: RollbackDecisionConfig;

  constructor(config?: Partial<RollbackDecisionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Analyze the deploy context and decide whether to rollback, keep monitoring,
   * or ignore the alert.
   */
  decide(ctx: RollbackContext): RollbackDecision {
    log.info("Evaluating rollback decision", {
      projectId: ctx.projectId,
      deployId: ctx.deployId,
      currentErrorRate: ctx.currentErrorRate,
      baselineErrorRate: ctx.baselineErrorRate,
      newErrors: ctx.newErrors.length,
      resolvedErrors: ctx.resolvedErrors.length,
      totalRequests: ctx.totalRequests,
      affectedUsers: ctx.affectedUsers,
    });

    // Rule 6: Insufficient data — not enough requests to be meaningful
    if (ctx.totalRequests < this.config.minSamples) {
      const decision: RollbackDecision = {
        action: "ignore",
        reason: `Insufficient data — only ${ctx.totalRequests} requests (need ${this.config.minSamples})`,
      };
      log.info("Decision: ignore (insufficient data)", { deployId: ctx.deployId });
      return decision;
    }

    // Rule 5: Too many affected users — rollback regardless of other factors
    if (
      ctx.affectedUsers !== undefined &&
      ctx.affectedUsers >= this.config.affectedUsersThreshold
    ) {
      const decision: RollbackDecision = {
        action: "rollback",
        reason: `Too many users impacted — ${ctx.affectedUsers} affected (threshold: ${this.config.affectedUsersThreshold})`,
        confidence: "high",
      };
      log.warn("Decision: rollback (high user impact)", {
        deployId: ctx.deployId,
        affectedUsers: ctx.affectedUsers,
      });
      return decision;
    }

    // Rule 1: High baseline with no significant change — pre-existing errors
    const hasHighBaseline =
      ctx.baselineErrorRate > this.config.highBaselineThreshold;
    const errorRateDelta = ctx.currentErrorRate - ctx.baselineErrorRate;
    const relativeIncrease =
      ctx.baselineErrorRate > 0
        ? errorRateDelta / ctx.baselineErrorRate
        : errorRateDelta > 0
          ? Infinity
          : 0;
    const isSignificantIncrease =
      relativeIncrease > this.config.spikeRelativeThreshold;

    if (hasHighBaseline && !isSignificantIncrease && ctx.newErrors.length === 0) {
      const decision: RollbackDecision = {
        action: "ignore",
        reason: `Errors existed before this deploy — baseline ${(ctx.baselineErrorRate * 100).toFixed(1)}%, current ${(ctx.currentErrorRate * 100).toFixed(1)}%, no new error types`,
      };
      log.info("Decision: ignore (pre-existing errors)", { deployId: ctx.deployId });
      return decision;
    }

    // Rule 4: Mixed results — deploy fixed some errors but introduced new ones
    if (ctx.resolvedErrors.length > 0 && ctx.newErrors.length > 0) {
      const decision: RollbackDecision = {
        action: "monitor",
        reason: `Mixed results — deploy fixed ${ctx.resolvedErrors.length} error type(s) but introduced ${ctx.newErrors.length} new one(s)`,
      };
      log.info("Decision: monitor (mixed results)", {
        deployId: ctx.deployId,
        resolved: ctx.resolvedErrors.length,
        introduced: ctx.newErrors.length,
      });
      return decision;
    }

    // Rule 2: New error types appeared that didn't exist before the deploy
    if (ctx.newErrors.length > 0) {
      const decision: RollbackDecision = {
        action: "rollback",
        reason: `New error types introduced by this deploy: ${ctx.newErrors.slice(0, 3).join("; ")}${ctx.newErrors.length > 3 ? ` (+${ctx.newErrors.length - 3} more)` : ""}`,
        confidence: ctx.baselineErrorRate === 0 ? "high" : "medium",
      };
      log.warn("Decision: rollback (new errors)", {
        deployId: ctx.deployId,
        newErrors: ctx.newErrors,
      });
      return decision;
    }

    // Rule 3: Error rate spiked but no new error types — might be transient
    if (isSignificantIncrease) {
      const decision: RollbackDecision = {
        action: "monitor",
        reason: `Error rate increased ${(ctx.baselineErrorRate * 100).toFixed(1)}% → ${(ctx.currentErrorRate * 100).toFixed(1)}% but same error patterns — may be transient`,
      };
      log.info("Decision: monitor (rate spike, same patterns)", {
        deployId: ctx.deployId,
      });
      return decision;
    }

    // Default: no concerning signals
    const decision: RollbackDecision = {
      action: "ignore",
      reason: `No significant error pattern change detected`,
    };
    log.info("Decision: ignore (no change)", { deployId: ctx.deployId });
    return decision;
  }

  /**
   * Format a human-readable comparison message for channel notifications.
   */
  formatComparison(ctx: RollbackContext, decision: RollbackDecision): string {
    const lines: string[] = [];

    // Error rate comparison
    lines.push(
      `Error rate: ${(ctx.currentErrorRate * 100).toFixed(1)}% (was ${(ctx.baselineErrorRate * 100).toFixed(1)}% before deploy)`,
    );

    // New error types
    if (ctx.newErrors.length > 0) {
      lines.push(
        `New errors: ${ctx.newErrors.slice(0, 5).join(", ")}${ctx.newErrors.length > 5 ? ` (+${ctx.newErrors.length - 5} more)` : ""}`,
      );
    }

    // Resolved errors
    if (ctx.resolvedErrors.length > 0) {
      lines.push(
        `Resolved: ${ctx.resolvedErrors.slice(0, 5).join(", ")}${ctx.resolvedErrors.length > 5 ? ` (+${ctx.resolvedErrors.length - 5} more)` : ""}`,
      );
    }

    // Affected users
    if (ctx.affectedUsers !== undefined) {
      lines.push(`Affected users: ${ctx.affectedUsers}`);
    }

    // Decision reasoning
    const actionLabel =
      decision.action === "rollback"
        ? `Rollback recommended (${"confidence" in decision ? decision.confidence : ""} confidence)`
        : decision.action === "monitor"
          ? "Continuing to monitor"
          : "False alarm";
    lines.push(`${actionLabel}: ${decision.reason}`);

    return lines.join("\n  ");
  }
}
