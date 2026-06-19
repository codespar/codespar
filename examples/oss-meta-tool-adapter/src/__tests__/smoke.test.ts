/**
 * Fresh-install smoke for the example meta-tool adapter.
 *
 * Proves the registration seam accepts the example as a registrant and
 * dispatches it, and asserts the SSRF-hardening stance: the example
 * rejects any real url/merchant outright (it implements no input
 * validation, so refusal is the only safe behavior).
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
  SAMPLE_NON_PAYABLE_CODE,
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
    expect(hook?.id).toBe("oss-example");
  });

  it("is advertised through metaToolDefinitions after registration", () => {
    const registry = new PluginRegistry();
    registerExampleMetaTool(registry);
    const names = registry.metaToolDefinitions().map((d) => d.name);
    expect(names).toContain(EXAMPLE_TOOL_NAME);
  });

  it("dispatches a search through the registered hook", async () => {
    const registry = new PluginRegistry();
    registerExampleMetaTool(registry);
    const hook = registry.getMetaTool(EXAMPLE_TOOL_NAME)!;
    const result = await hook.execute(EXAMPLE_TOOL_NAME, { action: "search" }, ctx);
    expect(result.server_id).toBe("oss-example");
    const data = result.output as { products: { sku_id: string }[] };
    expect(data.products[0]?.sku_id).toBe("example-sku-001");
  });

  it("returns a non-payable sample code (mints nothing real)", async () => {
    const hook = createExampleMetaToolHook();
    const result = await hook.execute(EXAMPLE_TOOL_NAME, { action: "checkout_status" }, ctx);
    const output = result.output as { pix_copia_e_cola: string };
    expect(output.pix_copia_e_cola).toBe(SAMPLE_NON_PAYABLE_CODE);
    expect(output.pix_copia_e_cola).toContain("NON-PAYABLE");
  });
});

describe("example adapter — SSRF hardening", () => {
  it("rejects a real url outright (no validation, so no dereference)", async () => {
    const hook = createExampleMetaToolHook();
    await expect(
      hook.execute(EXAMPLE_TOOL_NAME, { action: "checkout", url: "http://169.254.169.254/" }, ctx),
    ).rejects.toThrow(/rejects real url\/merchant/);
  });

  it("rejects a real merchant outright", async () => {
    const hook = createExampleMetaToolHook();
    await expect(
      hook.execute(EXAMPLE_TOOL_NAME, { action: "search", merchant: "evil-store" }, ctx),
    ).rejects.toThrow(/rejects real url\/merchant/);
  });
});
