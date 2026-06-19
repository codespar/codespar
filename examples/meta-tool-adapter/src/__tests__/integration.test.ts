/**
 * End-to-end integration for the example meta-tool adapter.
 *
 * Where smoke.test.ts exercises the example in-process (registry +
 * hook.execute), this test dispatches the REAL example through the REAL
 * execute route: a Fastify app mounts `registerSessionRoutes` from
 * `@codespar/core`, the example registers on the `pluginRegistry`
 * singleton the route consults, and each action is driven over HTTP via
 * `POST /sessions/:id/execute`.
 *
 * This is the canonical "add your own meta-tool" proof: if the
 * registration seam or the example drifts, this test fails. It depends
 * only on the published `@codespar/core` surface (the route registrar +
 * the singleton + PluginRegistry), mirroring what a self-hoster gets from
 * a fresh `npm install`.
 *
 * The registry is a process-wide singleton, so the suite clears its
 * meta-tool map (and unseals it) in `afterEach`, following the pattern in
 * the core runtime's own sessions-meta-tool route tests.
 */

import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import {
  registerSessionRoutes,
  clearSessionStore,
  pluginRegistry,
} from "@codespar/core";
import type { RouteFn, MetaToolHook } from "@codespar/core";
import { registerExampleMetaTool, EXAMPLE_TOOL_NAME } from "../index.js";

function createTestApp() {
  const app = Fastify({ logger: false });
  const route: RouteFn = (method, path, handler) => {
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
 * Reset the singleton registry between tests by swapping in fresh
 * internals. The route imports the singleton, so the example's
 * registration leaks across tests unless cleared. Mirrors the cleanup in
 * the core runtime's sessions-meta-tool route tests.
 */
function clearMetaTools(): void {
  (pluginRegistry as unknown as { metaTools: Map<string, MetaToolHook> }).metaTools =
    new Map();
  (pluginRegistry as unknown as { sealed: boolean }).sealed = false;
}

describe("example adapter — end-to-end through the execute route", () => {
  afterEach(() => {
    clearMetaTools();
    clearSessionStore();
  });

  it("dispatches action echo and returns { message } through the HTTP envelope", async () => {
    registerExampleMetaTool(pluginRegistry);
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, EXAMPLE_TOOL_NAME, {
      action: "echo",
      message: "hi",
    });

    expect(result.success).toBe(true);
    expect(result.server).toBe("example");
    expect(result.data).toEqual({ message: "hi" });
    expect(result.error).toBe("");
    await app.close();
  });

  it("dispatches action uppercase and returns the upper-cased message", async () => {
    registerExampleMetaTool(pluginRegistry);
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, EXAMPLE_TOOL_NAME, {
      action: "uppercase",
      message: "hi",
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ message: "HI" });
    await app.close();
  });

  it("dispatches action ping and returns { pong: true }", async () => {
    registerExampleMetaTool(pluginRegistry);
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, EXAMPLE_TOOL_NAME, { action: "ping" });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ pong: true });
    await app.close();
  });

  it("advertises example_echo through codespar_list_tools after registration", async () => {
    registerExampleMetaTool(pluginRegistry);
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, "codespar_list_tools");

    expect(result.success).toBe(true);
    const tools = (result.data as { tools: { name: string }[] }).tools;
    expect(tools.some((t) => t.name === EXAMPLE_TOOL_NAME)).toBe(true);
    await app.close();
  });

  it("returns 'Tool not registered' for an unregistered name", async () => {
    // No registerExampleMetaTool call: the example is absent this run.
    const app = createTestApp();
    const id = await createSession(app);

    const result = await execute(app, id, EXAMPLE_TOOL_NAME, { action: "echo" });

    expect(result.success).toBe(false);
    expect(result.error).toBe(`Tool not registered: ${EXAMPLE_TOOL_NAME}`);
    await app.close();
  });
});
