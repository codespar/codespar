import { describe, it, expect } from "vitest";
import { PluginRegistry } from "../plugins/registry.js";
import type { PolicyHook, PolicyDecision } from "../plugins/types.js";

// Example patterns — illustrative only. Self-hosters define their own based on
// the MCP tool names exposed by the servers they deploy.
const PIX_SEND = /^pix:(send|transfer|execute)(:[a-z0-9]+)*$/;
const NFE_EMIT = /^nfe:(emit|issue|sign)(:[a-z0-9]+)*$/;

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

    class RequireApprovalForPixSend implements PolicyHook {
      evaluate(_agentId: string, toolName: string): PolicyDecision {
        if (PIX_SEND.test(toolName)) {
          return { allowed: false, requiresApproval: true };
        }
        return { allowed: true };
      }
    }

    registry.registerPolicy(new RequireApprovalForPixSend());

    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).requiresApproval).toBe(true);
    expect(registry.evaluatePolicy("agent-1", "build:status").allowed).toBe(true);
  });

  it("can cover multiple tool categories", () => {
    const registry = new PluginRegistry();
    const patterns = [PIX_SEND, NFE_EMIT];

    class MultiCategoryHook implements PolicyHook {
      evaluate(_agentId: string, toolName: string): PolicyDecision {
        for (const pattern of patterns) {
          if (pattern.test(toolName)) {
            return { allowed: false, requiresApproval: true };
          }
        }
        return { allowed: true };
      }
    }

    registry.registerPolicy(new MultiCategoryHook());

    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "nfe:emit").allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "build:status").allowed).toBe(true);
  });
});

describe("PluginRegistry — deny-list hook: allowed without, denied with", () => {
  it("allows pix:send when no hook is registered", () => {
    const registry = new PluginRegistry();
    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(true);
    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).allowed).toBe(true);
  });

  it("denies pix:send when a hook is registered, including when cost is unknown", () => {
    const registry = new PluginRegistry();

    // Two-layer deny: reject when the cost is unknown (amount cannot be verified),
    // then deny the operation unconditionally when cost is known.
    class PixSendHook implements PolicyHook {
      evaluate(_agentId: string, toolName: string, estimatedCost?: number): PolicyDecision {
        if (!PIX_SEND.test(toolName)) return { allowed: true };
        if (estimatedCost === undefined) return { allowed: false, requiresApproval: true };
        return { allowed: false, requiresApproval: true };
      }
    }

    registry.registerPolicy(new PixSendHook());

    expect(registry.evaluatePolicy("agent-1", "pix:send").allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "pix:send", 500).allowed).toBe(false);
    expect(registry.evaluatePolicy("agent-1", "build:status").allowed).toBe(true);
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
