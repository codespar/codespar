/**
 * OSS startup policy contract tests.
 *
 * Verifies that the singleton pluginRegistry is correctly wired after
 * initOSSPolicies is called — the state the server must be in before
 * accepting any requests.
 *
 * Each test gets a fresh module scope via vi.resetModules() so the singleton
 * starts unregistered. This mirrors a clean process start and prevents
 * state leaking between tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

describe("OSS startup contract — singleton pluginRegistry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("is sealed after initOSSPolicies", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    expect(pluginRegistry.isSealed()).toBe(true);
  });

  it("has a policy registered after initOSSPolicies", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    expect(pluginRegistry.getStatus().policy).toBe(true);
  });

  it("denies fund transfers on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "pix:send", 100);
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("denies fiscal document issuance on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "nfe:emit");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("denies wallet-policy overrides on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "wallet:override");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("denies bulk messaging on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "bulk:send");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("denies cross-tenant A2A commitments on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "a2a:commit");
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("allows non-denied tools on the singleton", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    const result = pluginRegistry.evaluatePolicy("agent", "build:status");
    expect(result.allowed).toBe(true);
  });

  it("throws on a second initOSSPolicies call on the same registry", async () => {
    const { pluginRegistry, initOSSPolicies } = await import("@codespar/core");
    initOSSPolicies(pluginRegistry);
    expect(() => initOSSPolicies(pluginRegistry)).toThrow(/sealed/);
  });

  it("singleton has no policy before initOSSPolicies", async () => {
    const { pluginRegistry } = await import("@codespar/core");
    expect(pluginRegistry.getStatus().policy).toBe(false);
    expect(pluginRegistry.isSealed()).toBe(false);
  });

  it("singleton allows all tools before initOSSPolicies (no hook registered)", async () => {
    const { pluginRegistry } = await import("@codespar/core");
    const result = pluginRegistry.evaluatePolicy("agent", "pix:send", 100);
    expect(result.allowed).toBe(true);
  });
});
