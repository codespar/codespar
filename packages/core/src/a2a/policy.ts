/**
 * A2A Outbound Policy Enforcement — AgentGate governance for outbound A2A calls.
 *
 * Controls which external agents can be invoked, with what budget,
 * and requires approval for high-risk operations.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface A2AOutboundPolicy {
  /** Whether outbound A2A calls are enabled */
  enabled: boolean;

  /** Allowed external agent URLs (supports wildcards like "*.codespar.dev") */
  allowedAgents: string[];

  /** Allowed skill patterns (e.g., "messaging.*", "erp.create-invoice") */
  allowedSkills: string[];

  /** Blocked skill patterns (takes precedence over allowed) */
  blockedSkills: string[];

  /** Maximum autonomy level for A2A-initiated actions */
  maxAutonomy: string; // "L0" | "L1" | "L2" | "L3"

  /** Budget limits */
  budget: {
    perCallMax: number; // max cost per single A2A call
    perHourMax: number; // max spend per hour
    perDayMax: number; // max spend per day
  };

  /** When to require human approval */
  requireApproval: {
    riskAbove: string; // "low" | "medium" | "high" | "critical"
    costAbove: number; // dollar amount
    skillPatterns: string[]; // patterns that always need approval (e.g., "*.delete-*")
  };
}

export const DEFAULT_A2A_POLICY: A2AOutboundPolicy = {
  enabled: false, // disabled by default — opt-in
  allowedAgents: [],
  allowedSkills: ["*"],
  blockedSkills: [],
  maxAutonomy: "L2",
  budget: { perCallMax: 1.0, perHourMax: 10.0, perDayMax: 100.0 },
  requireApproval: {
    riskAbove: "high",
    costAbove: 5.0,
    skillPatterns: ["*.delete-*", "*.destroy-*"],
  },
};

export interface A2ACallContext {
  callerAgentType: string;
  targetAgentUrl: string;
  skill: string;
  estimatedCost?: number;
  risk?: "low" | "medium" | "high" | "critical";
}

export type A2APolicyResult =
  | { allowed: true }
  | { allowed: false; reason: string }
  | { allowed: "pending_approval"; reason: string };

// ---------------------------------------------------------------------------
// Wildcard matching helper
// ---------------------------------------------------------------------------

/**
 * Simple glob-style pattern matching.
 *
 * Supports:
 *  - `*` matches everything
 *  - `*.codespar.dev` matches `foo.codespar.dev`
 *  - `messaging.*` matches `messaging.send-whatsapp`
 *  - Exact match: `erp.create-invoice`
 *
 * Converts the pattern to a regex by escaping special chars and replacing
 * `*` with `[^]*` (match any characters including dots).
 */
export function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;

  // Replace `*` with a placeholder, escape regex special chars, then restore.
  const PLACEHOLDER = "\x00GLOB\x00";
  const withPlaceholders = pattern.replace(/\*/g, PLACEHOLDER);
  const escaped = withPlaceholders.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regexStr = "^" + escaped.replace(new RegExp(PLACEHOLDER, "g"), ".*") + "$";

  return new RegExp(regexStr).test(value);
}

/**
 * Check if a value matches any pattern in a list.
 */
function matchesAnyPattern(value: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(value, p));
}

// ---------------------------------------------------------------------------
// Risk level ordering (for comparison)
// ---------------------------------------------------------------------------

const RISK_LEVELS: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

function riskAtOrAbove(
  actual: string | undefined,
  threshold: string,
): boolean {
  if (!actual) return false;
  return (RISK_LEVELS[actual] ?? 0) >= (RISK_LEVELS[threshold] ?? 0);
}

// ---------------------------------------------------------------------------
// Spend tracker state
// ---------------------------------------------------------------------------

interface SpendTracker {
  hourly: number;
  daily: number;
  lastHourReset: number;
  lastDayReset: number;
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

export class A2APolicyEvaluator {
  private policy: A2AOutboundPolicy;
  private spendTracker: SpendTracker;

  constructor(policy?: Partial<A2AOutboundPolicy>) {
    this.policy = { ...DEFAULT_A2A_POLICY, ...policy };
    // Deep-merge nested objects that the spread won't handle
    if (policy?.budget) {
      this.policy.budget = { ...DEFAULT_A2A_POLICY.budget, ...policy.budget };
    }
    if (policy?.requireApproval) {
      this.policy.requireApproval = {
        ...DEFAULT_A2A_POLICY.requireApproval,
        ...policy.requireApproval,
      };
    }

    const now = Date.now();
    this.spendTracker = {
      hourly: 0,
      daily: 0,
      lastHourReset: now,
      lastDayReset: now,
    };
  }

  // ── Evaluation ──────────────────────────────────────────────

  evaluate(ctx: A2ACallContext): A2APolicyResult {
    // 1. Is A2A enabled?
    if (!this.policy.enabled) {
      return { allowed: false, reason: "A2A outbound calls are disabled" };
    }

    // 2. Is target agent in allowlist?
    if (!matchesAnyPattern(ctx.targetAgentUrl, this.policy.allowedAgents)) {
      return {
        allowed: false,
        reason: `Agent "${ctx.targetAgentUrl}" is not in the allowed agents list`,
      };
    }

    // 3. Is skill in allowedSkills and NOT in blockedSkills?
    if (matchesAnyPattern(ctx.skill, this.policy.blockedSkills)) {
      return {
        allowed: false,
        reason: `Skill "${ctx.skill}" is blocked by policy`,
      };
    }
    if (!matchesAnyPattern(ctx.skill, this.policy.allowedSkills)) {
      return {
        allowed: false,
        reason: `Skill "${ctx.skill}" is not in the allowed skills list`,
      };
    }

    // 4. Is estimatedCost within budget?
    if (ctx.estimatedCost !== undefined) {
      if (ctx.estimatedCost > this.policy.budget.perCallMax) {
        return {
          allowed: false,
          reason: `Estimated cost $${ctx.estimatedCost} exceeds per-call limit of $${this.policy.budget.perCallMax}`,
        };
      }

      // Reset spend windows if needed before checking
      this.resetSpendWindowsIfNeeded();

      if (
        this.spendTracker.hourly + ctx.estimatedCost >
        this.policy.budget.perHourMax
      ) {
        return {
          allowed: false,
          reason: `Hourly budget would be exceeded ($${this.spendTracker.hourly} + $${ctx.estimatedCost} > $${this.policy.budget.perHourMax})`,
        };
      }

      if (
        this.spendTracker.daily + ctx.estimatedCost >
        this.policy.budget.perDayMax
      ) {
        return {
          allowed: false,
          reason: `Daily budget would be exceeded ($${this.spendTracker.daily} + $${ctx.estimatedCost} > $${this.policy.budget.perDayMax})`,
        };
      }
    }

    // 5. Does this need approval? (check risk, cost, skill patterns)
    if (riskAtOrAbove(ctx.risk, this.policy.requireApproval.riskAbove)) {
      return {
        allowed: "pending_approval",
        reason: `Risk level "${ctx.risk}" requires approval (threshold: "${this.policy.requireApproval.riskAbove}")`,
      };
    }

    if (
      ctx.estimatedCost !== undefined &&
      ctx.estimatedCost > this.policy.requireApproval.costAbove
    ) {
      return {
        allowed: "pending_approval",
        reason: `Estimated cost $${ctx.estimatedCost} exceeds approval threshold of $${this.policy.requireApproval.costAbove}`,
      };
    }

    if (
      matchesAnyPattern(ctx.skill, this.policy.requireApproval.skillPatterns)
    ) {
      return {
        allowed: "pending_approval",
        reason: `Skill "${ctx.skill}" matches an approval-required pattern`,
      };
    }

    // 6. Allowed
    return { allowed: true };
  }

  // ── Spend tracking ──────────────────────────────────────────

  recordSpend(amount: number): void {
    this.resetSpendWindowsIfNeeded();
    this.spendTracker.hourly += amount;
    this.spendTracker.daily += amount;
  }

  getSpendSummary(): {
    hourly: number;
    daily: number;
    budgetRemaining: { hourly: number; daily: number };
  } {
    this.resetSpendWindowsIfNeeded();
    return {
      hourly: this.spendTracker.hourly,
      daily: this.spendTracker.daily,
      budgetRemaining: {
        hourly: Math.max(
          0,
          this.policy.budget.perHourMax - this.spendTracker.hourly,
        ),
        daily: Math.max(
          0,
          this.policy.budget.perDayMax - this.spendTracker.daily,
        ),
      },
    };
  }

  // ── Policy update ───────────────────────────────────────────

  updatePolicy(updates: Partial<A2AOutboundPolicy>): void {
    if (updates.budget) {
      this.policy.budget = { ...this.policy.budget, ...updates.budget };
    }
    if (updates.requireApproval) {
      this.policy.requireApproval = {
        ...this.policy.requireApproval,
        ...updates.requireApproval,
      };
    }
    // Apply top-level fields (excluding nested objects already handled)
    const { budget: _b, requireApproval: _r, ...topLevel } = updates;
    Object.assign(this.policy, topLevel);
  }

  // ── Internal ────────────────────────────────────────────────

  private resetSpendWindowsIfNeeded(): void {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    const ONE_DAY = 24 * 60 * 60 * 1000;

    if (now - this.spendTracker.lastHourReset >= ONE_HOUR) {
      this.spendTracker.hourly = 0;
      this.spendTracker.lastHourReset = now;
    }

    if (now - this.spendTracker.lastDayReset >= ONE_DAY) {
      this.spendTracker.daily = 0;
      this.spendTracker.lastDayReset = now;
    }
  }
}
