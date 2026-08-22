/**
 * Completeness: every registered route is either deliberately public or
 * refuses an anonymous caller. No third option.
 *
 * Why this file exists, and why it is not the same test as
 * anonymous-access.test.ts: authentication here is prefix matching over a
 * flat route table. A route is protected because its path happens to start
 * with `/api`, `/sessions` or `/a2a`, not because anything made it declare an
 * access level. So the default for a route registered anywhere else is OPEN,
 * and every hand-written test of specific paths can pass while a newly added
 * route sits unguarded next to them. That is fail-open by default, and it is
 * how BLOCKER oss-sdk#5 went unnoticed for as long as it did.
 *
 * This test enumerates what Fastify actually registered and drives each route
 * with no credential. A new route is then either covered by a guarded prefix,
 * or it has to be added to PUBLIC_ROUTES below with a reason, which is a line
 * a reviewer sees. Nothing can be added silently.
 *
 * It asserts behaviour, not the matcher: it sends real requests rather than
 * re-implementing the prefix logic, so a bug in the matcher fails this test
 * instead of being mirrored by it.
 *
 * The structural fix is per-subtree encapsulated hooks, where a route cannot
 * be registered outside a guard at all. That is a routing redesign and does
 * not belong in an emergency patch; this test holds the line until then.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookServer } from "../webhook-server.js";

/**
 * Routes that answer without a credential, on purpose.
 *
 * Each entry needs a reason that survives a reviewer asking "why is this one
 * open". The `/v1` mirrors are listed explicitly rather than derived, so that
 * adding a public route does not silently make its mirror public too.
 */
const PUBLIC_ROUTES = new Map<string, string>([
  // Container healthchecks and load balancers cannot present a bearer token.
  // docker-compose.yml probes this with a bare node http.get.
  ["GET /health", "container healthcheck, no way to send a credential"],
  ["GET /v1/health", "same, /v1 mirror"],

  // A2A discovery. Peers fetch this before any credential exists between
  // them; it advertises only this runtime's own name and address.
  ["GET /.well-known/agent.json", "A2A discovery, pre-credential by design"],

  // OAuth install/callback: a browser arrives here mid-redirect, and the
  // provider calls back with a code. Neither can attach a bearer token.
  ["GET /api/slack/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/slack/install", "same, /v1 mirror"],
  ["GET /api/slack/callback", "OAuth callback from the provider"],
  ["GET /v1/api/slack/callback", "same, /v1 mirror"],
  ["GET /api/discord/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/discord/install", "same, /v1 mirror"],
  ["GET /api/github/install", "OAuth redirect, browser cannot send a token"],
  ["GET /v1/api/github/install", "same, /v1 mirror"],
  ["GET /api/github/callback", "OAuth callback from the provider"],
  ["GET /v1/api/github/callback", "same, /v1 mirror"],

  // Provider webhooks authenticate by signature (webhook-auth.ts), which is
  // the only scheme GitHub, Vercel and Sentry can speak. A bearer token here
  // would mean handing the provider a credential it has nowhere to put.
  ["POST /webhooks/github", "provider signature auth, not bearer"],
  ["POST /v1/webhooks/github", "same, /v1 mirror"],
  ["POST /webhooks/vercel", "provider signature auth, not bearer"],
  ["POST /v1/webhooks/vercel", "same, /v1 mirror"],
  ["POST /webhooks/sentry", "provider signature auth, not bearer"],
  ["POST /v1/webhooks/sentry", "same, /v1 mirror"],
  ["POST /webhooks/deploy", "shared-secret signature auth, not bearer"],
  ["POST /v1/webhooks/deploy", "same, /v1 mirror"],
]);

/** Fastify never serves these itself; they are protocol plumbing. */
const IGNORED_METHODS = new Set(["HEAD", "OPTIONS"]);

/** Turn `/api/agents/:id` into something routable. */
function concreteUrl(url: string): string {
  return url.replace(/:[A-Za-z0-9_]+/g, "probe");
}

describe("route coverage: no route is accidentally anonymous", () => {
  let server: WebhookServer;
  let stateDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR"]) {
      saved[key] = process.env[key];
    }
    delete process.env.ENGINE_API_TOKEN;
    stateDir = mkdtempSync(join(tmpdir(), "codespar-route-coverage-"));
    process.env.CODESPAR_STATE_DIR = stateDir;
    server = new WebhookServer({ port: 0 });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("registered a route table to check at all", () => {
    // Guards the guard: if registeredRoutes ever came back empty, every
    // assertion below would vacuously pass and this file would be worthless.
    const routes = server.registeredRoutes.filter((r) => !IGNORED_METHODS.has(r.method));
    expect(routes.length).toBeGreaterThan(100);
  });

  it("refuses an anonymous caller on every route not listed as public", async () => {
    const routes = server.registeredRoutes.filter((r) => !IGNORED_METHODS.has(r.method));
    const leaked: string[] = [];

    for (const route of routes) {
      const key = `${route.method} ${route.url}`;
      if (PUBLIC_ROUTES.has(key)) continue;

      const res = await server.inject({
        method: route.method as "GET",
        url: concreteUrl(route.url),
        payload: route.method === "GET" || route.method === "DELETE" ? undefined : {},
        headers: { "content-type": "application/json" },
      });

      if (res.statusCode !== 401) leaked.push(`${key} -> ${res.statusCode}`);
    }

    expect(
      leaked,
      "these routes answered an anonymous caller and are not declared public:\n" +
        leaked.join("\n"),
    ).toEqual([]);
  });

  it("has no stale entries in the public list", async () => {
    // Keeps the allowlist honest in the other direction: an entry for a route
    // that no longer exists is a licence nobody is using, and it would hide
    // the day that path comes back for a different purpose.
    const registered = new Set(
      server.registeredRoutes
        .filter((r) => !IGNORED_METHODS.has(r.method))
        .map((r) => `${r.method} ${r.url}`),
    );
    const stale = [...PUBLIC_ROUTES.keys()].filter((key) => !registered.has(key));
    expect(stale, `public list names routes that are not registered:\n${stale.join("\n")}`).toEqual(
      [],
    );
  });

  it("keeps every public route genuinely reachable without a credential", async () => {
    // The other half of "deliberately public": if one of these started
    // answering 401, the healthcheck or an OAuth flow would be broken and the
    // entry above would have quietly become a lie.
    const blocked: string[] = [];
    for (const key of PUBLIC_ROUTES.keys()) {
      const [method, url] = key.split(" ");
      const res = await server.inject({
        method: method as "GET",
        url: concreteUrl(url),
        payload: method === "GET" ? undefined : {},
        headers: { "content-type": "application/json" },
      });
      if (res.statusCode === 401) blocked.push(key);
    }
    expect(blocked, `declared public but answering 401:\n${blocked.join("\n")}`).toEqual([]);
  });
});
