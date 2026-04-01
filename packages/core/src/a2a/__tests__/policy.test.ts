import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  A2APolicyEvaluator,
  DEFAULT_A2A_POLICY,
  matchesPattern,
} from "../policy.js";
import type { A2ACallContext } from "../policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a basic enabled policy evaluator with sensible defaults for testing. */
function createEvaluator(overrides: Parameters<typeof A2APolicyEvaluator.prototype.updatePolicy>[0] = {}) {
  const evaluator = new A2APolicyEvaluator({
    enabled: true,
    allowedAgents: ["*.example.dev", "trusted.codespar.dev"],
    allowedSkills: ["*"],
    blockedSkills: [],
    ...overrides,
  });
  return evaluator;
}

const baseCtx: A2ACallContext = {
  callerAgentType: "project",
  targetAgentUrl: "foo.example.dev",
  skill: "messaging.send-email",
};

// ---------------------------------------------------------------------------
// matchesPattern unit tests
// ---------------------------------------------------------------------------

describe("matchesPattern", () => {
  it("matches everything with *", () => {
    expect(matchesPattern("anything", "*")).toBe(true);
    expect(matchesPattern("foo.bar.baz", "*")).toBe(true);
  });

  it("matches exact string", () => {
    expect(matchesPattern("erp.create-invoice", "erp.create-invoice")).toBe(true);
    expect(matchesPattern("erp.create-invoice", "erp.delete-invoice")).toBe(false);
  });

  it("matches leading wildcard (*.example.dev)", () => {
    expect(matchesPattern("foo.example.dev", "*.example.dev")).toBe(true);
    expect(matchesPattern("bar.example.dev", "*.example.dev")).toBe(true);
    expect(matchesPattern("example.dev", "*.example.dev")).toBe(false);
    expect(matchesPattern("foo.other.dev", "*.example.dev")).toBe(false);
  });

  it("matches trailing wildcard (messaging.*)", () => {
    expect(matchesPattern("messaging.send-whatsapp", "messaging.*")).toBe(true);
    expect(matchesPattern("messaging.send-email", "messaging.*")).toBe(true);
    expect(matchesPattern("erp.send-email", "messaging.*")).toBe(false);
  });

  it("matches middle wildcard (*.delete-*)", () => {
    expect(matchesPattern("erp.delete-invoice", "*.delete-*")).toBe(true);
    expect(matchesPattern("crm.delete-contact", "*.delete-*")).toBe(true);
    expect(matchesPattern("erp.create-invoice", "*.delete-*")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A2APolicyEvaluator
// ---------------------------------------------------------------------------

describe("A2APolicyEvaluator", () => {
  // ── Default policy (disabled) ───────────────────────────────

  it("denies all calls when using default policy (disabled)", () => {
    const evaluator = new A2APolicyEvaluator(); // defaults
    const result = evaluator.evaluate(baseCtx);
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("disabled");
    }
  });

  // ── Enabled with empty allowlist ────────────────────────────

  it("denies when enabled but allowedAgents is empty", () => {
    const evaluator = new A2APolicyEvaluator({
      enabled: true,
      allowedAgents: [],
    });
    const result = evaluator.evaluate(baseCtx);
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("not in the allowed agents");
    }
  });

  // ── Allowed agent + allowed skill ──────────────────────────

  it("allows call when agent and skill are permitted", () => {
    const evaluator = createEvaluator();
    const result = evaluator.evaluate(baseCtx);
    expect(result.allowed).toBe(true);
  });

  // ── Blocked agent ──────────────────────────────────────────

  it("denies call when target agent is not in allowlist", () => {
    const evaluator = createEvaluator();
    const result = evaluator.evaluate({
      ...baseCtx,
      targetAgentUrl: "evil.hacker.io",
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("not in the allowed agents");
    }
  });

  // ── Blocked skill ─────────────────────────────────────────

  it("denies call when skill is in blockedSkills", () => {
    const evaluator = createEvaluator({
      blockedSkills: ["messaging.send-spam"],
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      skill: "messaging.send-spam",
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("blocked");
    }
  });

  it("denies call when skill is not in allowedSkills", () => {
    const evaluator = createEvaluator({
      allowedSkills: ["messaging.*"],
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      skill: "erp.create-invoice",
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("not in the allowed skills");
    }
  });

  // ── Wildcard matching in policy ────────────────────────────

  it("allows agent matching wildcard pattern (*.example.dev)", () => {
    const evaluator = createEvaluator();
    const result = evaluator.evaluate({
      ...baseCtx,
      targetAgentUrl: "bar.example.dev",
    });
    expect(result.allowed).toBe(true);
  });

  it("allows skill matching wildcard pattern (messaging.*)", () => {
    const evaluator = createEvaluator({
      allowedSkills: ["messaging.*"],
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      skill: "messaging.send-whatsapp",
    });
    expect(result.allowed).toBe(true);
  });

  // ── Budget enforcement ─────────────────────────────────────

  it("denies call when estimatedCost exceeds perCallMax", () => {
    const evaluator = createEvaluator({
      budget: { perCallMax: 0.5, perHourMax: 10, perDayMax: 100 },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      estimatedCost: 0.75,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("per-call limit");
    }
  });

  it("denies call when hourly budget would be exceeded", () => {
    const evaluator = createEvaluator({
      budget: { perCallMax: 5, perHourMax: 3, perDayMax: 100 },
    });
    evaluator.recordSpend(2.5);
    const result = evaluator.evaluate({
      ...baseCtx,
      estimatedCost: 1.0,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("Hourly budget");
    }
  });

  it("denies call when daily budget would be exceeded", () => {
    const evaluator = createEvaluator({
      budget: { perCallMax: 100, perHourMax: 200, perDayMax: 5 },
    });
    evaluator.recordSpend(4.5);
    const result = evaluator.evaluate({
      ...baseCtx,
      estimatedCost: 1.0,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("Daily budget");
    }
  });

  // ── Approval required: risk ────────────────────────────────

  it("returns pending_approval when risk exceeds threshold", () => {
    const evaluator = createEvaluator({
      requireApproval: { riskAbove: "high", costAbove: 100, skillPatterns: [] },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      risk: "high",
    });
    expect(result.allowed).toBe("pending_approval");
    if (result.allowed === "pending_approval") {
      expect(result.reason).toContain("Risk level");
    }
  });

  it("returns pending_approval when risk is critical (above high threshold)", () => {
    const evaluator = createEvaluator({
      requireApproval: { riskAbove: "high", costAbove: 100, skillPatterns: [] },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      risk: "critical",
    });
    expect(result.allowed).toBe("pending_approval");
  });

  it("allows call when risk is below threshold", () => {
    const evaluator = createEvaluator({
      requireApproval: { riskAbove: "high", costAbove: 100, skillPatterns: [] },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      risk: "medium",
    });
    expect(result.allowed).toBe(true);
  });

  // ── Approval required: cost ────────────────────────────────

  it("returns pending_approval when cost exceeds approval threshold", () => {
    const evaluator = createEvaluator({
      budget: { perCallMax: 10, perHourMax: 100, perDayMax: 1000 },
      requireApproval: { riskAbove: "critical", costAbove: 2.0, skillPatterns: [] },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      estimatedCost: 3.0,
    });
    expect(result.allowed).toBe("pending_approval");
    if (result.allowed === "pending_approval") {
      expect(result.reason).toContain("approval threshold");
    }
  });

  // ── Approval required: skill pattern ───────────────────────

  it("returns pending_approval when skill matches approval-required pattern (*.delete-*)", () => {
    const evaluator = createEvaluator({
      requireApproval: {
        riskAbove: "critical",
        costAbove: 100,
        skillPatterns: ["*.delete-*", "*.destroy-*"],
      },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      skill: "erp.delete-invoice",
    });
    expect(result.allowed).toBe("pending_approval");
    if (result.allowed === "pending_approval") {
      expect(result.reason).toContain("approval-required pattern");
    }
  });

  it("returns pending_approval for destroy pattern", () => {
    const evaluator = createEvaluator({
      requireApproval: {
        riskAbove: "critical",
        costAbove: 100,
        skillPatterns: ["*.delete-*", "*.destroy-*"],
      },
    });
    const result = evaluator.evaluate({
      ...baseCtx,
      skill: "infra.destroy-cluster",
    });
    expect(result.allowed).toBe("pending_approval");
  });

  // ── Spend tracking ─────────────────────────────────────────

  it("tracks spend correctly via recordSpend + getSpendSummary", () => {
    const evaluator = createEvaluator();
    evaluator.recordSpend(2.5);
    evaluator.recordSpend(1.0);

    const summary = evaluator.getSpendSummary();
    expect(summary.hourly).toBe(3.5);
    expect(summary.daily).toBe(3.5);
    expect(summary.budgetRemaining.hourly).toBe(
      DEFAULT_A2A_POLICY.budget.perHourMax - 3.5,
    );
    expect(summary.budgetRemaining.daily).toBe(
      DEFAULT_A2A_POLICY.budget.perDayMax - 3.5,
    );
  });

  // ── Spend window reset ─────────────────────────────────────

  describe("spend window reset", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("resets hourly spend after 1 hour", () => {
      const evaluator = createEvaluator();
      evaluator.recordSpend(5.0);
      expect(evaluator.getSpendSummary().hourly).toBe(5.0);

      // Advance 61 minutes
      vi.advanceTimersByTime(61 * 60 * 1000);

      const summary = evaluator.getSpendSummary();
      expect(summary.hourly).toBe(0);
      // Daily should still have the spend (less than 24h)
      expect(summary.daily).toBe(5.0);
    });

    it("resets daily spend after 24 hours", () => {
      const evaluator = createEvaluator();
      evaluator.recordSpend(5.0);
      expect(evaluator.getSpendSummary().daily).toBe(5.0);

      // Advance 25 hours
      vi.advanceTimersByTime(25 * 60 * 60 * 1000);

      const summary = evaluator.getSpendSummary();
      expect(summary.hourly).toBe(0);
      expect(summary.daily).toBe(0);
    });

    it("allows calls again after budget window resets", () => {
      const evaluator = createEvaluator({
        budget: { perCallMax: 5, perHourMax: 3, perDayMax: 100 },
      });

      // Fill hourly budget
      evaluator.recordSpend(2.5);
      const denied = evaluator.evaluate({ ...baseCtx, estimatedCost: 1.0 });
      expect(denied.allowed).toBe(false);

      // Advance past the hour
      vi.advanceTimersByTime(61 * 60 * 1000);

      const allowed = evaluator.evaluate({ ...baseCtx, estimatedCost: 1.0 });
      expect(allowed.allowed).toBe(true);
    });
  });

  // ── updatePolicy ───────────────────────────────────────────

  it("updates policy at runtime", () => {
    const evaluator = new A2APolicyEvaluator(); // default: disabled
    const denied = evaluator.evaluate(baseCtx);
    expect(denied.allowed).toBe(false);

    evaluator.updatePolicy({
      enabled: true,
      allowedAgents: ["foo.example.dev"],
    });

    const allowed = evaluator.evaluate(baseCtx);
    expect(allowed.allowed).toBe(true);
  });

  // ── Blocked skill takes precedence over allowed ────────────

  it("blockedSkills takes precedence over allowedSkills", () => {
    const evaluator = createEvaluator({
      allowedSkills: ["messaging.*"],
      blockedSkills: ["messaging.send-spam"],
    });

    // Allowed messaging skill
    expect(evaluator.evaluate({ ...baseCtx, skill: "messaging.send-email" }).allowed).toBe(true);

    // Blocked even though it matches allowedSkills pattern
    const result = evaluator.evaluate({ ...baseCtx, skill: "messaging.send-spam" });
    expect(result.allowed).toBe(false);
    if (result.allowed === false) {
      expect(result.reason).toContain("blocked");
    }
  });
});
