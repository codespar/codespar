/**
 * The wire shape of POST /sessions and GET /sessions/:id/connections
 * (oss-sdk#6).
 *
 * docs/test-mode.md states the invariant this file defends: "The wire shape and
 * error envelopes match the managed runtime exactly, so the same agent code
 * passes its tests against either endpoint." That makes "which side is wrong"
 * a question with an answer rather than a preference — and the answer is this
 * one, because @codespar/sdk is written against the managed shape and the
 * README points a reader at this runtime as a drop-in for it.
 *
 * Two concrete breaks, both silent:
 *
 *   1. The 201 returned only `{ id, status }`. The SDK builds its session from
 *      that body (`session.ts`: `createdAt: new Date(data.created_at)`), so
 *      `created_at` missing produced an Invalid Date on every session — not an
 *      error, a Date that formats as "Invalid Date" and compares false to
 *      everything. `user_id` and `servers` came back undefined the same way.
 *
 *   2. `/connections` returned `{ servers }` with no `tools` key, and each
 *      server carried only `{ id, connected }`. The SDK caches
 *      `payload.tools` into what `session.tools()` returns, and types each
 *      entry as `ServerConnection` (id, name, category, country, auth_type,
 *      connected).
 *
 * The assertions below are on VALUES the caller passed in, not just on
 * presence: a route echoing a constant would satisfy a key-existence check.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearSessionStore, registerSessionRoutes } from "../sessions.js";
import { TEST_API_TOKEN } from "../../__tests__/test-credential.js";

process.env.ENGINE_API_TOKEN = TEST_API_TOKEN;

function createTestApp() {
  const app = Fastify({ logger: false });
  const route = (
    method: "get" | "post" | "delete" | "patch",
    path: string,
    handler: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: mirrors registerSessionRoutes' signature
  ) => (app as any)[method](path, handler);
  registerSessionRoutes(route);
  return app;
}

let app: ReturnType<typeof createTestApp>;

beforeEach(() => {
  clearSessionStore();
  app = createTestApp();
});

afterEach(async () => {
  await app.close();
  clearSessionStore();
});

const auth = { authorization: `Bearer ${TEST_API_TOKEN}` };

async function create(payload: Record<string, unknown>) {
  const res = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload });
  expect(res.statusCode).toBe(201);
  return res.json() as Record<string, unknown>;
}

describe("POST /sessions — the created-session body", () => {
  it("control: the session is created and identified", async () => {
    // Without this, every assertion below could be satisfied by a route that
    // stopped creating sessions and started returning a canned object.
    const body = await create({ servers: [], user_id: "u-control" });
    expect(typeof body["id"]).toBe("string");
    expect(body["status"]).toBe("active");
    const fetched = await app.inject({
      method: "GET",
      url: `/sessions/${body["id"]}/connections`,
      headers: auth,
    });
    expect(fetched.statusCode).toBe(200);
  });

  it("echoes the user_id the caller sent", async () => {
    const body = await create({ servers: [], user_id: "u-echo" });
    expect(body["user_id"]).toBe("u-echo");
  });

  it("echoes the servers the caller declared", async () => {
    const body = await create({ servers: ["alpha", "beta"], user_id: "u" });
    expect(body["servers"]).toEqual(["alpha", "beta"]);
  });

  it("carries a created_at the SDK can turn into a real Date", async () => {
    const before = Date.now();
    const body = await create({ servers: [], user_id: "u" });
    // The SDK does exactly this, and `new Date(undefined)` is an Invalid Date
    // rather than a throw — which is why the break was silent.
    const createdAt = new Date(body["created_at"] as string);
    expect(Number.isNaN(createdAt.getTime())).toBe(false);
    expect(createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe("GET /sessions/:id/connections — the connections body", () => {
  it("carries a tools array", async () => {
    const body = await create({ servers: [], user_id: "u" });
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${body["id"]}/connections`,
      headers: auth,
    });
    const payload = res.json() as Record<string, unknown>;
    // The SDK assigns `payload.tools` straight into its tool cache. Undefined
    // there is not an empty catalogue, it is a cache that never fills.
    expect(Array.isArray(payload["tools"])).toBe(true);
  });

  it("gives every server the full ServerConnection shape", async () => {
    const body = await create({ servers: ["alpha"], user_id: "u" });
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${body["id"]}/connections`,
      headers: auth,
    });
    const payload = res.json() as { servers: Record<string, unknown>[] };
    expect(payload.servers).toHaveLength(1);
    const conn = payload.servers[0]!;
    expect(Object.keys(conn).sort()).toEqual([
      "auth_type",
      "category",
      "connected",
      "country",
      "id",
      "name",
    ]);
    expect(conn["connected"]).toBe(true);
    // `name` defaults to the server id, the same fallback the managed runtime
    // takes for a server its catalog does not know.
    expect(conn["name"]).toBe("alpha");
  });
});
