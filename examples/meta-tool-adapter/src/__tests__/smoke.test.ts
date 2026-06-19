/**
 * Fresh-install smoke for the example meta-tool adapter.
 *
 * Proves the registration seam accepts the example as a registrant, lists
 * it through its advertised definitions, and dispatches it by name.
 *
 * This is the example's own smoke — it depends only on the published
 * `@codespar/core` seam surface (PluginRegistry + the MetaToolHook type),
 * mirroring what a self-hoster gets from a fresh `npm install`. The full
 * route-level dispatch (POST /sessions/:id/execute → the hook) is covered
 * in the core runtime's own test suite.
 */

import { describe, expect, it } from "vitest";
import { PluginRegistry } from "@codespar/core";
import type { MetaToolExecutionContext } from "@codespar/core";
import {
  createExampleMetaToolHook,
  registerExampleMetaTool,
  EXAMPLE_TOOL_NAME,
} from "../index.js";

const ctx: MetaToolExecutionContext = {
  orgId: "org-1",
  projectId: "proj-1",
  sessionId: "sess-1",
  environment: "test",
};

describe("example adapter — registration + dispatch", () => {
  it("registers cleanly on a fresh PluginRegistry and is retrievable by name", () => {
    const registry = new PluginRegistry();
    registerExampleMetaTool(registry);
    const hook = registry.getMetaTool(EXAMPLE_TOOL_NAME);
    expect(hook?.id).toBe("example");
  });

  it("is advertised through metaToolDefinitions after registration", () => {
    const registry = new PluginRegistry();
    registerExampleMetaTool(registry);
    const names = registry.metaToolDefinitions().map((d) => d.name);
    expect(names).toContain(EXAMPLE_TOOL_NAME);
  });

  it("echoes the message through the registered hook", async () => {
    const registry = new PluginRegistry();
    registerExampleMetaTool(registry);
    const hook = registry.getMetaTool(EXAMPLE_TOOL_NAME)!;
    const result = await hook.execute(EXAMPLE_TOOL_NAME, { action: "echo", message: "hi" }, ctx);
    expect(result.server_id).toBe("example");
    const data = result.output as { message: string };
    expect(data.message).toBe("hi");
  });

  it("upper-cases the message for action uppercase", async () => {
    const hook = createExampleMetaToolHook();
    const result = await hook.execute(EXAMPLE_TOOL_NAME, { action: "uppercase", message: "hi" }, ctx);
    const output = result.output as { message: string };
    expect(output.message).toBe("HI");
  });

  it("returns a fixed pong for action ping", async () => {
    const hook = createExampleMetaToolHook();
    const result = await hook.execute(EXAMPLE_TOOL_NAME, { action: "ping" }, ctx);
    const output = result.output as { pong: boolean };
    expect(output.pong).toBe(true);
  });
});
