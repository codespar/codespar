import { describe, it, expect } from "vitest";
import { RollbackDecisionEngine } from "../rollback-decision.js";
import type { RollbackContext } from "../rollback-decision.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeContext(overrides: Partial<RollbackContext> = {}): RollbackContext {
  return {
    projectId: "my-app",
    deployId: "deploy-1",
    deployTimestamp: Date.now(),
    currentErrorRate: 0.12,
    baselineErrorRate: 0.02,
    newErrors: [],
    resolvedErrors: [],
    totalRequests: 100,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("RollbackDecisionEngine", () => {
  const engine = new RollbackDecisionEngine();

  it("ignores when baseline was already high and no significant change", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.08, // 8% — above 5% threshold
      currentErrorRate: 0.09, // 9% — minor increase
      newErrors: [],
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("ignore");
    expect(decision.reason).toContain("existed before this deploy");
  });

  it("recommends rollback when new errors appeared", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.02,
      currentErrorRate: 0.15,
      newErrors: ["TypeError in auth.ts", "404 on /api/users"],
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("rollback");
    expect(decision).toHaveProperty("confidence");
    if (decision.action === "rollback") {
      expect(decision.reason).toContain("New error types introduced");
      expect(decision.reason).toContain("TypeError in auth.ts");
    }
  });

  it("recommends monitoring when same errors spike", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.02,
      currentErrorRate: 0.12,
      newErrors: [], // same error types, just more frequent
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("monitor");
    expect(decision.reason).toContain("same error patterns");
  });

  it("recommends monitoring for mixed results (resolved + new errors)", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.05,
      currentErrorRate: 0.08,
      newErrors: ["new ReferenceError"],
      resolvedErrors: ["old TypeError"],
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("monitor");
    expect(decision.reason).toContain("Mixed results");
    expect(decision.reason).toContain("fixed 1 error type(s)");
    expect(decision.reason).toContain("introduced 1 new one(s)");
  });

  it("forces rollback when too many users affected", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.08, // high baseline
      currentErrorRate: 0.09, // minor change
      newErrors: [],
      affectedUsers: 150, // above default threshold of 100
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("rollback");
    if (decision.action === "rollback") {
      expect(decision.confidence).toBe("high");
      expect(decision.reason).toContain("Too many users impacted");
    }
  });

  it("ignores when sample count is too low", () => {
    const ctx = makeContext({
      totalRequests: 3, // below default minSamples of 5
      currentErrorRate: 0.67,
      baselineErrorRate: 0,
      newErrors: ["some error"],
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("ignore");
    expect(decision.reason).toContain("Insufficient data");
  });

  it("rollbacks with high confidence on zero baseline with new errors (first deploy)", () => {
    const ctx = makeContext({
      baselineErrorRate: 0, // no errors before deploy
      currentErrorRate: 0.15,
      newErrors: ["TypeError: cannot read property"],
      totalRequests: 50,
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("rollback");
    if (decision.action === "rollback") {
      expect(decision.confidence).toBe("high");
    }
  });

  it("ignores when no significant error pattern change detected", () => {
    const ctx = makeContext({
      baselineErrorRate: 0.02,
      currentErrorRate: 0.02, // no change
      newErrors: [],
      resolvedErrors: [],
    });

    const decision = engine.decide(ctx);
    expect(decision.action).toBe("ignore");
    expect(decision.reason).toContain("No significant error pattern change");
  });

  it("respects custom config thresholds", () => {
    const customEngine = new RollbackDecisionEngine({
      minSamples: 10,
      affectedUsersThreshold: 50,
      highBaselineThreshold: 0.10,
      spikeRelativeThreshold: 1.0,
    });

    // 8 requests — below custom minSamples of 10
    const ctx1 = makeContext({ totalRequests: 8, newErrors: ["error"] });
    expect(customEngine.decide(ctx1).action).toBe("ignore");

    // 60 affected users — above custom threshold of 50
    const ctx2 = makeContext({ affectedUsers: 60, totalRequests: 100 });
    expect(customEngine.decide(ctx2).action).toBe("rollback");
  });

  describe("formatComparison", () => {
    it("includes error rate comparison", () => {
      const ctx = makeContext({
        currentErrorRate: 0.12,
        baselineErrorRate: 0.02,
        newErrors: ["TypeError in auth.ts"],
      });
      const decision = engine.decide(ctx);
      const formatted = engine.formatComparison(ctx, decision);

      expect(formatted).toContain("12.0%");
      expect(formatted).toContain("2.0%");
      expect(formatted).toContain("New errors: TypeError in auth.ts");
    });

    it("includes resolved errors", () => {
      const ctx = makeContext({
        newErrors: ["new error"],
        resolvedErrors: ["old error"],
      });
      const decision = engine.decide(ctx);
      const formatted = engine.formatComparison(ctx, decision);

      expect(formatted).toContain("Resolved: old error");
    });

    it("includes affected users", () => {
      const ctx = makeContext({ affectedUsers: 42 });
      const decision = engine.decide(ctx);
      const formatted = engine.formatComparison(ctx, decision);

      expect(formatted).toContain("Affected users: 42");
    });
  });
});
