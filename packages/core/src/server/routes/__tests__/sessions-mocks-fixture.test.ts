/**
 * Cross-runtime parity test: the canonical fixture used by the SDK +
 * managed runtime (`tests/fixtures/mocks_canonical.json`) must round-
 * trip through the OSS create + execute flow byte-for-byte.
 *
 * Keeps the wire-shape contract visible at a glance whenever someone
 * touches the validator or the dispatcher.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { clearSessionStore, registerSessionRoutes } from "../sessions.js";
import { clearMcpBridge } from "../../../mcp/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "tests", "fixtures", "mocks_canonical.json");

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

const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";
const originalTestMode = process.env[TEST_MODE_ENV_KEY];

describe("canonical mocks fixture round-trip", () => {
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

  it("creates a session and walks both mock entries (single-shot + array)", async () => {
    const app = createTestApp();
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8")) as {
      servers: string[];
      user_id: string;
      mocks: Record<string, unknown>;
    };
    const created = await app.inject({
      method: "POST",
      url: "/sessions",
      headers: { authorization: "Bearer test" },
      payload: fixture,
    });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as { id: string }).id;

    const r1 = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/create_payment", input: { value: 1000 } },
    });
    expect(r1.statusCode).toBe(200);
    expect((r1.json() as { data: Record<string, unknown> }).data).toEqual({
      id: "pay_test_42",
      status: "PENDING",
    });

    const r2 = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/get_payment", input: {} },
    });
    expect((r2.json() as { data: { status: string } }).data.status).toBe("PENDING");

    const r3 = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/get_payment", input: {} },
    });
    expect((r3.json() as { data: { status: string } }).data.status).toBe("CONFIRMED");

    const r4 = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "asaas/get_payment", input: {} },
    });
    expect(r4.statusCode).toBe(422);
    expect((r4.json() as { code: string }).code).toBe("mocks_exhausted");
  });
});
