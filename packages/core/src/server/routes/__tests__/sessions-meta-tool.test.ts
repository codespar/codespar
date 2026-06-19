/**
 * Meta-tool dispatch tests for POST /sessions/:id/execute.
 *
 * Verifies the seam wiring in the execute route:
 *   - a registered meta-tool name dispatches through the hook and returns
 *     the normal success envelope built from MetaToolResult
 *   - an unregistered name still returns "Tool not registered" (the seam
 *     is byte-for-byte today's behavior with no registrant)
 *   - codespar_list_tools advertises registered meta-tools
 *   - a hook that throws surfaces as a failure envelope (no raw leak)
 *
 * The registry is a process-wide singleton, so each test registers on a
 * fresh PluginRegistry is not possible here — instead the suite clears the
 * relevant tool name between tests by re-registering / relying on the
 * singleton's state, and asserts only on names it owns.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerSessionRoutes, clearSessionStore } from "../sessions.js";
import { pluginRegistry, PluginRegistry } from "../../../plugins/index.js";
import type { MetaToolHook, MetaToolResult } from "../../../plugins/index.js";

function createTestApp() {
  const app = Fastify({ logger: false });
  const route = (method: "get" | "post" | "delete" | "patch", path: string, handler: any) => {
    app[method](path, handler);
  };
  registerSessionRoutes(route);
  return app;
}

async function createSession(app: ReturnType<typeof Fastify>): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: "Bearer test" },
    payload: { servers: [], user_id: "u" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function execute(
  app: ReturnType<typeof Fastify>,
  sessionId: string,
  tool: string,
  input: Record<string, unknown> = {},
) {
  const res = await app.inject({
    method: "POST",
    url: `/sessions/${sessionId}/execute`,
    headers: { authorization: "Bearer test" },
    payload: { tool, input },
  });
  return res.json();
}

/**
 * Reset the singleton registry's meta-tool map between tests by swapping
 * in a fresh PluginRegistry's internals. The route imports the singleton,
 * so we mutate its private map via a typed escape hatch kept local to the
 * test. Simpler and more honest than leaking a public reset into prod.
 */
function clearMetaTools(): void {
  // The map is private; cast through unknown to reach it for test cleanup.
  (pluginRegistry as unknown as { metaTools: Map<string, MetaToolHook> }).metaTools =
    new Map();
  (pluginRegistry as unknown as { sealed: boolean }).sealed = false;
}

function makeHook(
  id: string,
  name: string,
  impl?: () => Promise<MetaToolResult>,
): MetaToolHook {
  return {
    id,
    handles: [name],
    definitions: () => [
      { name, description: `def for ${name}`, input_schema: { type: "object", properties: {} } },
    ],
    execute:
      impl ??
      (async () => ({ server_id: id, output: { ok: true, echoed: name }, duration_ms: 2 })),
  };
}

describe("sessions meta-tool dispatch", () => {
  beforeEach(() => {
    clearMetaTools();
  });

  afterEach(() => {
    clearMetaTools();
    clearSessionStore();
  });

  it("dispatches a registered meta-tool and returns a success envelope", async () => {
    pluginRegistry.registerMetaTool(makeHook("oss-example", "codespar_shop"));
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, "codespar_shop", { action: "search" });
    expect(result.success).toBe(true);
    expect(result.server).toBe("oss-example");
    expect(result.data).toEqual({ ok: true, echoed: "codespar_shop" });
    expect(result.error).toBe("");
    await app.close();
  });

  it("falls through to 'Tool not registered' for an unregistered name", async () => {
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, "codespar_shop", { action: "search" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Tool not registered: codespar_shop");
    expect(result.server).toBe("oss-runtime");
    await app.close();
  });

  it("advertises registered meta-tools through codespar_list_tools", async () => {
    pluginRegistry.registerMetaTool(makeHook("oss-example", "codespar_shop"));
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, "codespar_list_tools");
    expect(result.success).toBe(true);
    const tools = (result.data as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === "codespar_shop")).toBe(true);
    await app.close();
  });

  it("surfaces a thrown hook as a failure envelope without leaking a raw error", async () => {
    pluginRegistry.registerMetaTool(
      makeHook("oss-example", "codespar_shop", async () => {
        throw new Error("provider unavailable");
      }),
    );
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, "codespar_shop");
    expect(result.success).toBe(false);
    expect(result.error).toBe("provider unavailable");
    expect(result.server).toBe("oss-example");
    await app.close();
  });
});

// Sanity: the imported PluginRegistry class is the type the singleton is an
// instance of, keeping the test honest if the export shape changes.
describe("registry export", () => {
  it("singleton is a PluginRegistry", () => {
    expect(pluginRegistry).toBeInstanceOf(PluginRegistry);
  });
});
