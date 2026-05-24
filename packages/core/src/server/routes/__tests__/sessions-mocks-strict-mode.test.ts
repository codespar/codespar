/**
 * Per-deployment strict-mode tests for session mocks.
 *
 * After the semantic refactor:
 *   - CODESPAR_TEST_MODE_ENABLED is a runtime mode switch, not a
 *     per-session opt-in. When the flag is on, ALL external tool
 *     dispatches require a matching mock entry.
 *   - A session without a `mocks` field (or with an empty `{}` map)
 *     can no longer dispatch external tools — every call returns
 *     `tool_not_mocked` instead of falling through to the bridge.
 *   - Built-in tools (the documented `BUILT_IN_TOOLS` allow-list)
 *     bypass the gate. They are metadata-only operations with no
 *     external side effects. Today the allow-list contains a single
 *     entry: `codespar_list_tools`.
 *
 * Three surfaces under test:
 *   1. `POST /sessions/:id/execute` against an external tool on a
 *      session with no mocks — returns 422 `tool_not_mocked`.
 *   2. Dispatch seam (`tryMockedDispatch`) — returns a
 *      tool_not_mocked envelope on flag-on + no-mocks instead of
 *      passthrough (null).
 *   3. Built-in dispatch (`codespar_list_tools`) — succeeds without a
 *      mock entry even when the flag is on and the session has no
 *      mocks declared.
 *
 * The flag-off behavior (short-circuit to passthrough, mocks engine
 * never consulted) is unchanged and covered in
 * `sessions-mocks-flag.test.ts`.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMcpBridge } from "../../../mcp/index.js";
import { tryMockedDispatch } from "../../../sessions/mock-dispatch.js";
import type { Session } from "../../../storage/types.js";
import { clearSessionStore, registerSessionRoutes } from "../sessions.js";

const ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";

function createTestApp() {
  const app = Fastify({ logger: false });
  const route = (
    method: "get" | "post" | "delete" | "patch",
    path: string,
    handler: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: route registration helper
  ) => (app as any)[method](path, handler);
  registerSessionRoutes(route);
  return app;
}

function buildSessionWithoutMocks(): Session {
  return {
    id: "sess-no-mocks",
    orgId: "org",
    projectId: "proj",
    channelType: "http",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers: ["asaas"] },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Session for seam test
  } as any;
}

function buildSessionWithEmptyMocks(): Session {
  return {
    id: "sess-empty-mocks",
    orgId: "org",
    projectId: "proj",
    channelType: "http",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers: ["asaas"] },
    mocks: {},
    // biome-ignore lint/suspicious/noExplicitAny: minimal Session for seam test
  } as any;
}

describe("session mocks: per-deployment strict mode (flag-on requires mock match)", () => {
  const originalEnv = process.env[ENV_KEY];

  beforeEach(async () => {
    process.env[ENV_KEY] = "true";
    clearSessionStore();
    await clearMcpBridge();
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    await clearMcpBridge();
  });

  describe("POST /sessions/:id/execute on session without mocks", () => {
    it("returns 422 tool_not_mocked when the session never declared mocks", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: ["asaas"], user_id: "u" },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/create_payment", input: { value: 1000 } },
      });

      expect(exec.statusCode).toBe(422);
      const body = exec.json() as Record<string, unknown>;
      expect(body.code).toBe("tool_not_mocked");
      expect(body.tool_name).toBe("asaas/create_payment");
    });

    it("returns 422 tool_not_mocked when the session declared an empty {} mocks map", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: ["asaas"], user_id: "u", mocks: {} },
      });
      expect(created.statusCode).toBe(201);
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/create_payment", input: { value: 1000 } },
      });

      expect(exec.statusCode).toBe(422);
      expect((exec.json() as { code: string }).code).toBe("tool_not_mocked");
    });

    it("returns 422 tool_not_mocked for an unregistered server prefix on a session without mocks", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: [], user_id: "u" },
      });
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/unknown", input: {} },
      });

      expect(exec.statusCode).toBe(422);
      const body = exec.json() as Record<string, unknown>;
      expect(body.code).toBe("tool_not_mocked");
      expect(body.tool_name).toBe("asaas/unknown");
    });
  });

  describe("dispatch seam on session without mocks", () => {
    it("returns tool_not_mocked envelope from tryMockedDispatch (no mocks declared)", async () => {
      const session = buildSessionWithoutMocks();
      const out = await tryMockedDispatch(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
      );
      expect(out).not.toBeNull();
      expect(out?.outcome.kind).toBe("tool_not_mocked");
      expect(out?.result.success).toBe(false);
      expect(out?.result.error).toBe("tool_not_mocked");
      const envelope = out?.result.data as { code: string; tool_name: string };
      expect(envelope.code).toBe("tool_not_mocked");
      expect(envelope.tool_name).toBe("asaas/create_payment");
    });

    it("returns tool_not_mocked envelope from tryMockedDispatch (empty {} mocks)", async () => {
      const session = buildSessionWithEmptyMocks();
      const out = await tryMockedDispatch(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
      );
      expect(out).not.toBeNull();
      expect(out?.outcome.kind).toBe("tool_not_mocked");
    });

    it("returns tool_not_mocked envelope from tryMockedDispatch (chat-loop entry, no mocks declared)", async () => {
      const session = buildSessionWithoutMocks();
      const out = await tryMockedDispatch(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
      );
      expect(out).not.toBeNull();
      expect(out?.outcome.kind).toBe("tool_not_mocked");
    });
  });

  describe("built-in tools bypass the gate (allow-list spec)", () => {
    // Per the test-mode contract: external tool dispatches are gated;
    // metadata-only built-ins are not. Today the documented allow-list
    // contains a single entry — `codespar_list_tools`. A future
    // built-in that reaches external state must NOT join this set; it
    // must be declared in session.mocks like any other dispatch. See
    // README + docs/test-mode.md for the spec.
    it("codespar_list_tools succeeds without a mock entry on a session without mocks", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: [], user_id: "u" },
      });
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "codespar_list_tools", input: {} },
      });

      expect(exec.statusCode).toBe(200);
      const body = exec.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.server).toBe("oss-runtime");
      expect(body.tool).toBe("codespar_list_tools");
    });

    it("codespar_list_tools succeeds without a mock entry on a session with mocks declared (built-in bypasses regardless of session state)", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: {
          servers: ["asaas"],
          user_id: "u",
          mocks: {
            "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
          },
        },
      });
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "codespar_list_tools", input: {} },
      });

      expect(exec.statusCode).toBe(200);
      expect((exec.json() as { success: boolean }).success).toBe(true);
    });
  });

  describe("happy path preserved: mocked tools still dispatch correctly", () => {
    it("declared mock entry still returns its scripted output", async () => {
      const app = createTestApp();
      const created = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: {
          servers: ["asaas"],
          mocks: {
            "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
          },
        },
      });
      const id = (created.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/create_payment", input: {} },
      });

      expect(exec.statusCode).toBe(200);
      const body = exec.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.server).toBe("mock");
      expect(body.data).toEqual({ id: "pay_test_42", status: "PENDING" });
    });
  });
});
