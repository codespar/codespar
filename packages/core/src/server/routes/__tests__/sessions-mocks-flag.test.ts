/**
 * Env-var gate tests for the session-mocks feature.
 *
 * The mocks API is gated behind `CODESPAR_TEST_MODE_ENABLED`. When the
 * env var is off (the default) an OSS deployment refuses to accept
 * `mocks` on `POST /sessions` and the dispatch seam refuses to honour
 * any mocks that may already sit on a session.
 *
 * Three behaviours under test:
 *   1. Flag off — `POST /sessions` with `mocks` returns 501
 *      `mocks_not_permitted` and never creates the session.
 *   2. Flag off — a session that already carries mocks (e.g. created
 *      while the flag was on, then the operator flipped it off) does
 *      NOT short-circuit on the dispatch seam; the call falls through
 *      to the bridge as if mocks were absent.
 *   3. Flag on — the existing happy path still works end-to-end.
 *
 * The flag is read on every gated call (matching the repo's
 * per-request env-read pattern in `checkBearerAuth`), so tests can
 * flip the env var inside `beforeEach` without re-importing modules.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMcpBridge } from "../../../mcp/index.js";
import {
  tryMockedDispatch,
  tryMockedDispatchWithStorage,
} from "../../../sessions/mock-dispatch.js";
import type { Session } from "../../../storage/types.js";
import { clearSessionStore, registerSessionRoutes } from "../sessions.js";

const ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";

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

function buildSessionWithMocks(): Session {
  return {
    id: "sess-flag-off",
    orgId: "org",
    projectId: "proj",
    channelType: "http",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers: ["asaas"] },
    mocks: {
      "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal Session for seam test
  } as any;
}

describe("session mocks: CODESPAR_TEST_MODE_ENABLED gate", () => {
  const originalEnv = process.env[ENV_KEY];

  beforeEach(async () => {
    clearSessionStore();
    await clearMcpBridge();
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalEnv;
    await clearMcpBridge();
  });

  describe("flag off (default)", () => {
    beforeEach(() => {
      delete process.env[ENV_KEY];
    });

    it("rejects POST /sessions with mocks: 501 mocks_not_permitted", async () => {
      const app = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: {
          servers: ["asaas"],
          mocks: {
            "asaas/create_payment": { id: "pay", status: "PENDING" },
          },
        },
      });

      expect(res.statusCode).toBe(501);
      const body = res.json() as Record<string, unknown>;
      expect(body.code).toBe("mocks_not_permitted");
      expect(typeof body.message).toBe("string");
      expect(body.message as string).toContain("CODESPAR_TEST_MODE_ENABLED");
    });

    it("env-flag gate runs before size cap (oversized mocks still get 501)", async () => {
      const app = createTestApp();
      const huge = { blob: "x".repeat(70_000) };
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: [], mocks: { "asaas/foo": huge } },
      });
      expect(res.statusCode).toBe(501);
      expect((res.json() as { code: string }).code).toBe("mocks_not_permitted");
    });

    it("env-flag gate runs before shape validation (malformed mocks still get 501)", async () => {
      const app = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: [], mocks: { "BAD/Tool": {} } },
      });
      expect(res.statusCode).toBe(501);
      expect((res.json() as { code: string }).code).toBe("mocks_not_permitted");
    });

    it("accepts POST /sessions without mocks: 201 (sessions without mocks still work)", async () => {
      const app = createTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/sessions",
        headers: { authorization: "Bearer test" },
        payload: { servers: ["asaas"], user_id: "u" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("dispatch seam short-circuits to passthrough when flag is off, even for a session that already has mocks", async () => {
      const session = buildSessionWithMocks();

      const out = await tryMockedDispatchWithStorage(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
        null,
      );
      expect(out).toBeNull();

      const out2 = await tryMockedDispatch(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
      );
      expect(out2).toBeNull();
    });
  });

  describe("flag on", () => {
    beforeEach(() => {
      process.env[ENV_KEY] = "true";
    });

    it("accepts a valid mocks payload and returns 201 (happy path preserved)", async () => {
      const app = createTestApp();

      const create = await app.inject({
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
      expect(create.statusCode).toBe(201);
      const id = (create.json() as { id: string }).id;

      const exec = await app.inject({
        method: "POST",
        url: `/sessions/${id}/execute`,
        headers: { authorization: "Bearer test" },
        payload: { tool: "asaas/create_payment", input: { value: 1000 } },
      });
      expect(exec.statusCode).toBe(200);
      const body = exec.json() as Record<string, unknown>;
      expect(body.success).toBe(true);
      expect(body.server).toBe("mock");
      expect(body.data).toEqual({ id: "pay_test_42", status: "PENDING" });
    });

    it("dispatch seam honours mocks when flag is on", async () => {
      const session = buildSessionWithMocks();
      const out = await tryMockedDispatchWithStorage(
        session,
        "asaas",
        "create_payment",
        { value: 1 },
        null,
      );
      expect(out).not.toBeNull();
      expect(out?.outcome.kind).toBe("consumed");
      expect(out?.result.success).toBe(true);
      expect(out?.result.data).toEqual({
        id: "pay_test_42",
        status: "PENDING",
      });
    });

    it("accepts truthy variants (CODESPAR_TEST_MODE_ENABLED=1, TRUE, True)", async () => {
      for (const v of ["1", "TRUE", "True"]) {
        process.env[ENV_KEY] = v;
        const app = createTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/sessions",
          headers: { authorization: "Bearer test" },
          payload: {
            servers: [],
            mocks: { "asaas/foo": { ok: true } },
          },
        });
        expect(res.statusCode, `value ${v}`).toBe(201);
        clearSessionStore();
      }
    });

    it("rejects non-truthy variants (CODESPAR_TEST_MODE_ENABLED=0, false, yes, '')", async () => {
      for (const v of ["0", "false", "yes", ""]) {
        process.env[ENV_KEY] = v;
        const app = createTestApp();
        const res = await app.inject({
          method: "POST",
          url: "/sessions",
          headers: { authorization: "Bearer test" },
          payload: {
            servers: [],
            mocks: { "asaas/foo": { ok: true } },
          },
        });
        expect(res.statusCode, `value ${JSON.stringify(v)}`).toBe(501);
        expect((res.json() as { code: string }).code).toBe(
          "mocks_not_permitted",
        );
      }
    });
  });
});
