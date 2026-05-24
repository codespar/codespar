/**
 * HTTP-route tests for the hosted-test-mode mocks API.
 *
 * Two surfaces under test:
 *   - POST /sessions with optional `mocks` body field: the size cap,
 *     shape validation, and key/value rules. Failures emit the
 *     `mocks_invalid` / `mocks_payload_too_large` envelopes with the
 *     RFC 6901 field pointer.
 *   - POST /sessions/:id/execute with a mocked tool: single-shot
 *     return, stateful-array counter advance, exhaustion, and the
 *     strict-mode `tool_not_mocked` 422 envelope when mocks are
 *     declared but the called tool has no entry.
 *
 * Every assertion here exercises the flag-on path — the runtime gate
 * `CODESPAR_TEST_MODE_ENABLED` is set in `beforeEach`. The flag-off
 * surface (rejection envelope, dispatch passthrough) lives in
 * `sessions-mocks-flag.test.ts`.
 */

import Fastify from "fastify";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearSessionStore,
  registerSessionRoutes,
} from "../sessions.js";
import { clearMcpBridge } from "../../../mcp/index.js";

const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";
const originalTestMode = process.env[TEST_MODE_ENV_KEY];

function createTestApp() {
  const app = Fastify({ logger: false });
  const route = (
    method: "get" | "post" | "delete" | "patch",
    path: string,
    handler: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: route registration helper mirrors registerSessionRoutes signature
  ) => (app as any)[method](path, handler);
  registerSessionRoutes(route);
  return app;
}

async function createSession(
  app: ReturnType<typeof Fastify>,
  body: Record<string, unknown>,
): Promise<{ statusCode: number; json: () => Record<string, unknown> }> {
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: "Bearer test" },
    payload: body,
  });
  return res as unknown as { statusCode: number; json: () => Record<string, unknown> };
}

describe("POST /sessions with mocks", () => {
  beforeEach(async () => {
    process.env[TEST_MODE_ENV_KEY] = "true";
    clearSessionStore();
    await clearMcpBridge();
  });
  afterEach(async () => {
    if (originalTestMode === undefined) delete process.env[TEST_MODE_ENV_KEY];
    else process.env[TEST_MODE_ENV_KEY] = originalTestMode;
    await clearMcpBridge();
  });

  it("accepts a valid mocks payload and returns 201", async () => {
    const app = createTestApp();
    const res = await createSession(app, {
      servers: ["asaas"],
      user_id: "u",
      mocks: {
        "asaas/create_payment": { id: "pay_test", status: "PENDING" },
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it("rejects mocks with mocks_invalid + RFC 6901 field when key fails canonical form", async () => {
    const app = createTestApp();
    const res = await createSession(app, {
      servers: [],
      mocks: { "BAD/Tool": {} },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body).toMatchObject({
      code: "mocks_invalid",
      field: "/mocks/BAD~1Tool",
    });
  });

  it("rejects mocks with mocks_invalid when value is primitive", async () => {
    const app = createTestApp();
    const res = await createSession(app, {
      servers: [],
      mocks: { "asaas/foo": 42 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("mocks_invalid");
    expect(body.field).toBe("/mocks/asaas~1foo");
  });

  it("rejects mocks with mocks_invalid when a stateful array entry is null", async () => {
    const app = createTestApp();
    const res = await createSession(app, {
      servers: [],
      mocks: { "asaas/foo": [{ a: 1 }, null] },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("mocks_invalid");
    expect(body.field).toBe("/mocks/asaas~1foo/1");
  });

  it("rejects with mocks_payload_too_large when over 64 KiB", async () => {
    const app = createTestApp();
    const huge = { blob: "x".repeat(70_000) };
    const res = await createSession(app, {
      servers: [],
      mocks: { "asaas/foo": huge },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe("mocks_payload_too_large");
  });
});

describe("POST /sessions/:id/execute with mocks", () => {
  beforeEach(async () => {
    process.env[TEST_MODE_ENV_KEY] = "true";
    clearSessionStore();
    await clearMcpBridge();
  });
  afterEach(async () => {
    if (originalTestMode === undefined) delete process.env[TEST_MODE_ENV_KEY];
    else process.env[TEST_MODE_ENV_KEY] = originalTestMode;
    await clearMcpBridge();
  });

  it("returns the single-shot mocked output without touching the bridge", async () => {
    const app = createTestApp();
    const session = await createSession(app, {
      servers: ["asaas"],
      mocks: {
        "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
      },
    });
    const id = (session.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/create_payment", input: { value: 1000 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.server).toBe("mock");
    expect(body.tool).toBe("asaas/create_payment");
    expect(body.data).toEqual({ id: "pay_test_42", status: "PENDING" });
  });

  it("advances the counter on stateful array entries and surfaces mocks_exhausted at cap", async () => {
    const app = createTestApp();
    const created = await createSession(app, {
      servers: ["asaas"],
      mocks: {
        "asaas/get_payment": [
          { status: "PENDING" },
          { status: "CONFIRMED" },
        ],
      },
    });
    const id = (created.json() as { id: string }).id;
    const exec = (input: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/get_payment", input },
      });

    const r1 = await exec();
    expect(r1.statusCode).toBe(200);
    expect((r1.json() as { data: { status: string } }).data.status).toBe("PENDING");

    const r2 = await exec();
    expect(r2.statusCode).toBe(200);
    expect((r2.json() as { data: { status: string } }).data.status).toBe("CONFIRMED");

    const r3 = await exec();
    expect(r3.statusCode).toBe(422);
    const body3 = r3.json() as Record<string, unknown>;
    expect(body3.code).toBe("mocks_exhausted");
  });

  it("returns 422 tool_not_mocked when mocks declared but the tool is missing", async () => {
    const app = createTestApp();
    const created = await createSession(app, {
      servers: ["asaas"],
      mocks: { "asaas/known": { ok: true } },
    });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/unknown", input: {} },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as Record<string, unknown>;
    expect(body.code).toBe("tool_not_mocked");
    expect(body.tool_name).toBe("asaas/unknown");
  });

  it("returns 422 tool_not_mocked even when the server prefix isn't registered (strict-mode)", async () => {
    const app = createTestApp();
    const created = await createSession(app, {
      servers: [],
      mocks: { "asaas/known": { ok: true } },
    });
    const id = (created.json() as { id: string }).id;
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/unknown", input: {} },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { code: string }).code).toBe("tool_not_mocked");
  });
});
