import { describe, it, expect } from "vitest";
import { PluginRegistry } from "../plugins/registry.js";
import type { PolicyHook, PolicyDecision } from "../plugins/types.js";
import {
  canonicalizeToolName,
  FUND_TRANSFER_PATTERN,
  FISCAL_DOCUMENT_PATTERN,
  WALLET_POLICY_OVERRIDE_PATTERN,
  BULK_MESSAGING_PATTERN,
  CROSS_TENANT_A2A_PATTERN,
  DENY_LIST_PATTERNS,
} from "../plugins/deny-list-constants.js";

describe("PluginRegistry — no-op default", () => {
  it("returns { allowed: true } for any tool call when no policy is registered", () => {
    const registry = new PluginRegistry();
    expect(registry.evaluatePolicy("agent-1", "pix:send", 500)).toEqual({ allowed: true });
    expect(registry.evaluatePolicy("agent-1", "nfe:emit")).toEqual({ allowed: true });
    expect(registry.evaluatePolicy("agent-1", "a2a:commit")).toEqual({ allowed: true });
  });
});

describe("PluginRegistry — consumer-implemented PolicyHook", () => {
  it("enforces rules registered via registerPolicy()", () => {
    const registry = new PluginRegistry();

    class DenyAllFundTransfers implements PolicyHook {
      evaluate(agentId: string, toolName: string): PolicyDecision {
        const canonical = canonicalizeToolName(toolName);
        if (FUND_TRANSFER_PATTERN.test(canonical)) {
          return { allowed: false, requiresApproval: true };
        }
        return { allowed: true };
      }
    }

    registry.registerPolicy(new DenyAllFundTransfers());

    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).requiresApproval).toBe(true);
    expect(registry.evaluatePolicy("agent-1", "build:status").allowed).toBe(true);
  });

  it("enforces all five I-2 categories when a hook implements them", () => {
    const registry = new PluginRegistry();
    const patterns = [
      FUND_TRANSFER_PATTERN,
      FISCAL_DOCUMENT_PATTERN,
      WALLET_POLICY_OVERRIDE_PATTERN,
      BULK_MESSAGING_PATTERN,
      CROSS_TENANT_A2A_PATTERN,
    ];

    class NonOverridableHook implements PolicyHook {
      evaluate(_agentId: string, toolName: string): PolicyDecision {
        const canonical = canonicalizeToolName(toolName);
        for (const pattern of patterns) {
          if (pattern.test(canonical)) {
            return { allowed: false, requiresApproval: true };
          }
        }
        return { allowed: true };
      }
    }

    registry.registerPolicy(new NonOverridableHook());

    const denied = [
      "pix:send",        // fund transfer
      "nfe:emit",        // fiscal document
      "wallet:override", // wallet-policy override
      "bulk:send",       // bulk messaging
      "a2a:commit",      // cross-tenant A2A
    ];
    for (const toolName of denied) {
      const result = registry.evaluatePolicy("agent-1", toolName);
      expect(result.allowed, `expected ${toolName} to be denied`).toBe(false);
      expect(result.requiresApproval).toBe(true);
    }
  });
});

describe("PluginRegistry — deny-list hook: allowed without, denied with", () => {
  const sensitiveTools = [
    { toolName: "pix:send", category: "fund transfer" },
    { toolName: "nfe:emit", category: "fiscal document" },
    { toolName: "wallet:override", category: "wallet-policy override" },
    { toolName: "bulk:send", category: "bulk messaging" },
    { toolName: "a2a:commit", category: "cross-tenant A2A" },
  ];

  it("allows all five sensitive categories when no hook is registered", () => {
    const registry = new PluginRegistry();
    for (const { toolName, category } of sensitiveTools) {
      expect(registry.evaluatePolicy("agent-1", toolName).allowed, `${category} should be allowed without a hook`).toBe(true);
    }
    // fund transfer with no estimated cost — also allowed when no hook is registered
    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(true);
  });

  it("denies all five categories when a deny-list hook is registered", () => {
    const registry = new PluginRegistry();

    // Two-layer deny: reject fund transfers when the cost is unknown (amount cannot
    // be verified against any cap), then deny all five I-2 categories unconditionally.
    class DenyListHook implements PolicyHook {
      evaluate(_agentId: string, toolName: string, estimatedCost?: number): PolicyDecision {
        const canonical = canonicalizeToolName(toolName);
        if (estimatedCost === undefined && FUND_TRANSFER_PATTERN.test(canonical)) {
          return { allowed: false, requiresApproval: true };
        }
        for (const pattern of DENY_LIST_PATTERNS) {
          if (pattern.test(canonical)) {
            return { allowed: false, requiresApproval: true };
          }
        }
        return { allowed: true };
      }
    }

    registry.registerPolicy(new DenyListHook());

    for (const { toolName, category } of sensitiveTools) {
      const result = registry.evaluatePolicy("agent-1", toolName);
      expect(result.allowed, `${category} should be denied with the hook`).toBe(false);
      expect(result.requiresApproval).toBe(true);
    }
    // fund transfer with no estimated cost is denied — amount cannot be verified
    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(false);
  });
});

describe("PluginRegistry — PolicyHook interface is structural", () => {
  it("accepts any object with a conforming evaluate method", () => {
    const registry = new PluginRegistry();
    registry.registerPolicy({
      evaluate(_agentId: string, _toolName: string): PolicyDecision {
        return { allowed: false };
      },
    });
    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(false);
    expect(registry.getStatus().policy).toBe(true);
  });
});
