/**
 * OSSPolicyHook — deny-list enforcement tests.
 *
 * Verifies that OSSPolicyHook correctly denies the five non-overridable
 * tool categories, allows everything else, handles canonicalization edge
 * cases, and that the registry hardening (single-registration, sealing,
 * Object.freeze) behaves as specified.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { OSSPolicyHook } from "../oss-policy-hook.js";
import { canonicalizeToolName } from "../deny-list-constants.js";
import { PluginRegistry } from "../registry.js";
import { initOSSPolicies } from "../oss-init.js";

// ── Helper ───────────────────────────────────────────────────────────────────

const denied = { allowed: false, requiresApproval: true };

function expectDenied(toolName: string, cost?: number) {
  const hook = new OSSPolicyHook();
  const result = hook.evaluate("agent-test", toolName, cost);
  expect(result.allowed).toBe(false);
  expect(result.requiresApproval).toBe(true);
}

function expectAllowed(toolName: string, cost?: number) {
  const hook = new OSSPolicyHook();
  const result = hook.evaluate("agent-test", toolName, cost);
  expect(result.allowed).toBe(true);
}

// ── Category 1: Fund transfers ───────────────────────────────────────────────

describe("Category 1 — fund transfers", () => {
  const fundTransferTools = [
    "pix:send",
    "pix:transfer",
    "fund:transfer",
    "payment:send",
    "payment:execute",
    "wire:transfer",
    "remit:pay",
    "payout:send",
    "transfer:funds",
  ];

  it.each(fundTransferTools)("denies %s", (tool) => expectDenied(tool, 100));

  it("denies fund:transfer:v2 (versioned)", () => expectDenied("fund:transfer:v2", 50));

  it("denies pix:send with uppercase input", () => expectDenied("PIX:SEND", 10));

  it("denies pix_send with underscore separator", () => expectDenied("pix_send", 10));

  it("denies fund-transfer with hyphen separator", () => expectDenied("fund-transfer", 10));

  it("denies pix/send with slash separator", () => expectDenied("pix/send", 10));

  it("denies fund transfer when estimatedCost is undefined", () =>
    expectDenied("pix:send", undefined));

  it("denies fund transfer when estimatedCost is undefined (underscore form)", () =>
    expectDenied("fund_transfer", undefined));
});

// ── Category 2: Fiscal document issuance ────────────────────────────────────

describe("Category 2 — fiscal document issuance", () => {
  const fiscalTools = [
    "nfe:emit",
    "nfe:issue",
    "cfdi:stamp",
    "cfdi:issue",
    "factura:emit",
    "nota:issue",
    "invoice:issue",
    "danfe:generate",
    "sat:sign",
  ];

  it.each(fiscalTools)("denies %s", (tool) => expectDenied(tool));

  it("denies NFE:EMIT with uppercase input", () => expectDenied("NFE:EMIT"));

  it("denies nfe_emit with underscore separator", () => expectDenied("nfe_emit"));

  it("denies nfe:emit:v3 (versioned)", () => expectDenied("nfe:emit:v3"));
});

// ── Category 3: Wallet-policy overrides ─────────────────────────────────────

describe("Category 3 — wallet-policy overrides", () => {
  const overrideTools = [
    "wallet:override",
    "wallet:bypass",
    "policy:override",
    "spending:disable",
    "limit:reset",
    "cap:remove",
    "budget:delete",
  ];

  it.each(overrideTools)("denies %s", (tool) => expectDenied(tool));

  it("denies WALLET:OVERRIDE with uppercase input", () => expectDenied("WALLET:OVERRIDE"));

  it("denies wallet_override with underscore separator", () => expectDenied("wallet_override"));
});

// ── Category 4: Bulk outbound messaging ─────────────────────────────────────

describe("Category 4 — bulk outbound messaging", () => {
  const bulkTools = [
    "bulk:send",
    "broadcast:message",
    "campaign:send",
    "mass:notify",
    "bulk:push",
    "message:bulk",
    "messaging:broadcast",
    "notification:batch",
    "channel:mass",
  ];

  it.each(bulkTools)("denies %s", (tool) => expectDenied(tool));

  it("denies BULK:SEND with uppercase input", () => expectDenied("BULK:SEND"));

  it("denies bulk_send with underscore separator", () => expectDenied("bulk_send"));
});

// ── Category 5: Cross-tenant A2A commitments ────────────────────────────────

describe("Category 5 — cross-tenant A2A commitments", () => {
  const a2aTools = [
    "a2a:commit",
    "a2a:bind",
    "a2a:contract",
    "agent:sign",
    "agent:pledge",
    "agent:promise",
    "external:agree",
  ];

  it.each(a2aTools)("denies %s", (tool) => expectDenied(tool));

  it("denies A2A:COMMIT with uppercase input", () => expectDenied("A2A:COMMIT"));

  it("denies a2a_commit with underscore separator", () => expectDenied("a2a_commit"));

  it("denies a2a:commit:v2 (versioned)", () => expectDenied("a2a:commit:v2"));
});

// ── Allowed tools ────────────────────────────────────────────────────────────

describe("non-denied tools are allowed", () => {
  const allowedTools = [
    "codespar:list:tools",
    "execute",
    "status:get",
    "build:status",
    "pr:review",
    "deploy:staging",
    "logs:tail",
    "search:code",
  ];

  it.each(allowedTools)("allows %s", (tool) => expectAllowed(tool));

  it("allows fund:status (read-only, not a transfer)", () =>
    expectAllowed("fund:status", 0));

  it("allows payment:status (read-only)", () =>
    expectAllowed("payment:status"));

  it("allows nfe:read (read-only)", () =>
    expectAllowed("nfe:read"));
});

// ── canonicalizeToolName ─────────────────────────────────────────────────────

describe("canonicalizeToolName", () => {
  it("lowercases the input", () =>
    expect(canonicalizeToolName("PIX:SEND")).toBe("pix:send"));

  it("normalizes underscores to colons", () =>
    expect(canonicalizeToolName("fund_transfer")).toBe("fund:transfer"));

  it("normalizes hyphens to colons", () =>
    expect(canonicalizeToolName("fund-transfer")).toBe("fund:transfer"));

  it("normalizes slashes to colons", () =>
    expect(canonicalizeToolName("pix/send")).toBe("pix:send"));

  it("collapses consecutive colons", () =>
    expect(canonicalizeToolName("fund::transfer")).toBe("fund:transfer"));

  it("trims leading and trailing colons", () =>
    expect(canonicalizeToolName(":fund:transfer:")).toBe("fund:transfer"));

  it("handles mixed separators", () =>
    expect(canonicalizeToolName("Fund_Transfer:v2")).toBe("fund:transfer:v2"));

  it("strips combining diacritics, retaining the base character", () =>
    expect(canonicalizeToolName("píx:send")).toBe("pix:send"));

  it("strips non-ASCII characters", () =>
    expect(canonicalizeToolName("рix:send")).toBe("ix:send"));
});

// ── Registry hardening ───────────────────────────────────────────────────────

describe("PluginRegistry hardening", () => {
  let registry: PluginRegistry;

  beforeEach(() => {
    registry = new PluginRegistry();
  });

  it("allows the first registerPolicy call", () => {
    expect(() => registry.registerPolicy(new OSSPolicyHook())).not.toThrow();
  });

  it("throws on a second registerPolicy call before sealing", () => {
    registry.registerPolicy(new OSSPolicyHook());
    expect(() => registry.registerPolicy(new OSSPolicyHook())).toThrow(
      /already registered/,
    );
  });

  it("throws on registerPolicy after seal()", () => {
    registry.registerPolicy(new OSSPolicyHook());
    registry.seal();
    expect(() => registry.registerPolicy(new OSSPolicyHook())).toThrow(
      /sealed/,
    );
  });

  it("throws on registerPolicy on a sealed empty registry", () => {
    registry.seal();
    expect(() => registry.registerPolicy(new OSSPolicyHook())).toThrow(
      /sealed/,
    );
  });

  it("isSealed returns false before sealing", () => {
    expect(registry.isSealed()).toBe(false);
  });

  it("isSealed returns true after seal()", () => {
    registry.seal();
    expect(registry.isSealed()).toBe(true);
  });

  it("getStatus reflects sealed state", () => {
    registry.registerPolicy(new OSSPolicyHook());
    registry.seal();
    const status = registry.getStatus();
    expect(status.policy).toBe(true);
    expect(status.sealed).toBe(true);
  });

  it("registered hook is frozen — property assignment throws TypeError in strict mode", () => {
    const hook = new OSSPolicyHook();
    registry.registerPolicy(hook);
    // Object.freeze is applied to the hook at registration time. In strict
    // mode (ESM always runs strict), writing to a frozen object throws.
    expect(() => {
      (hook as unknown as Record<string, unknown>).evaluate = () => ({ allowed: true });
    }).toThrow(TypeError);
  });
});

// ── initOSSPolicies ──────────────────────────────────────────────────────────

describe("initOSSPolicies", () => {
  it("registers a policy and seals the registry", () => {
    const registry = new PluginRegistry();
    initOSSPolicies(registry);
    const status = registry.getStatus();
    expect(status.policy).toBe(true);
    expect(status.sealed).toBe(true);
  });

  it("the registered hook denies fund transfers", () => {
    const registry = new PluginRegistry();
    initOSSPolicies(registry);
    const result = registry.evaluatePolicy("agent", "pix:send", 100);
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("the registered hook allows non-denied tools", () => {
    const registry = new PluginRegistry();
    initOSSPolicies(registry);
    const result = registry.evaluatePolicy("agent", "build:status");
    expect(result.allowed).toBe(true);
  });

  it("prevents a second initOSSPolicies call on the same registry", () => {
    const registry = new PluginRegistry();
    initOSSPolicies(registry);
    expect(() => initOSSPolicies(registry)).toThrow(/sealed/);
  });
});
