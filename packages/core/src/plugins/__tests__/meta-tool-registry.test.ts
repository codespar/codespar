/**
 * Meta-tool registration seam — registry-level unit tests.
 *
 * Covers the hardening the seam adds over registerIntegration:
 *   - register / getMetaTool round-trip
 *   - unregistered name returns null (permissive default)
 *   - seal-after-register throws (post-boot registration window closed)
 *   - name-override logs a warning carrying both registrant ids + the
 *     shadowed name (money-path shadows are observable, not silent)
 *   - metaToolDefinitions() aggregates and de-duplicates by name
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginRegistry } from "../registry.js";
import type { MetaToolHook, MetaToolResult } from "../types.js";

function makeHook(id: string, handles: string[], output: unknown = {}): MetaToolHook {
  return {
    id,
    handles,
    definitions: () =>
      handles.map((name) => ({
        name,
        description: `def for ${name}`,
        input_schema: { type: "object" as const, properties: {} },
      })),
    async execute(): Promise<MetaToolResult> {
      return { server_id: id, output, duration_ms: 1 };
    },
  };
}

describe("PluginRegistry meta-tool seam", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a hook and retrieves it by name", () => {
    const registry = new PluginRegistry();
    const hook = makeHook("oss-example", ["codespar_shop"]);
    registry.registerMetaTool(hook);
    expect(registry.getMetaTool("codespar_shop")).toBe(hook);
  });

  it("returns null for an unregistered name (permissive default)", () => {
    const registry = new PluginRegistry();
    expect(registry.getMetaTool("codespar_shop")).toBeNull();
  });

  it("throws when registering after the registry is sealed", () => {
    const registry = new PluginRegistry();
    registry.seal();
    expect(() => registry.registerMetaTool(makeHook("late", ["codespar_shop"]))).toThrow(
      /sealed/,
    );
  });

  it("logs a warning on a name-override carrying both ids and the shadowed name", () => {
    const registry = new PluginRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.registerMetaTool(makeHook("first", ["codespar_shop"]));
    registry.registerMetaTool(makeHook("second", ["codespar_shop"]));

    // The override is observable: a warning fired, naming both
    // registrant ids and the shadowed tool name.
    const warned = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(warned).toContain("first");
    expect(warned).toContain("second");
    expect(warned).toContain("codespar_shop");

    // Last-registrant-wins is retained as the override mechanism.
    expect(registry.getMetaTool("codespar_shop")?.id).toBe("second");
  });

  it("does not warn when the same registrant re-registers its own names", () => {
    const registry = new PluginRegistry();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hook = makeHook("same", ["codespar_shop"]);
    registry.registerMetaTool(hook);
    registry.registerMetaTool(hook);
    const warned = warnSpy.mock.calls
      .map((c) => c.join(" "))
      .filter((line) => line.includes("override"));
    expect(warned).toHaveLength(0);
  });

  it("aggregates and de-duplicates definitions across hooks", () => {
    const registry = new PluginRegistry();
    registry.registerMetaTool(makeHook("a", ["tool_a"]));
    registry.registerMetaTool(makeHook("b", ["tool_b"]));
    // override tool_a with a second registrant — definitions stay unique by name
    registry.registerMetaTool(makeHook("c", ["tool_a"]));

    const defs = registry.metaToolDefinitions();
    const names = defs.map((d) => d.name).sort();
    expect(names).toEqual(["tool_a", "tool_b"]);
  });

  it("surfaces registered meta-tool names in getStatus", () => {
    const registry = new PluginRegistry();
    registry.registerMetaTool(makeHook("x", ["codespar_shop"]));
    expect(registry.getStatus().metaTools).toContain("codespar_shop");
  });
});
