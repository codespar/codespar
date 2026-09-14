/**
 * Completeness: every registered route is either deliberately public or
 * refuses an anonymous caller. No third option.
 *
 * Why this file exists, and why it is not the same test as
 * anonymous-access.test.ts: anonymous-access.test.ts names the paths it
 * checks, so it can pass in full while a newly added route sits unguarded
 * next to them. That is how BLOCKER oss-sdk#5 went unnoticed for as long as
 * it did. This file enumerates what Fastify actually registered and drives
 * every one of those routes with no credential.
 *
 * What it proves changed shape with oss#137. The guard used to protect three
 * path prefixes, so an unclassified route was OPEN and this test was the only
 * thing that turned that into a failing build — it was a net under a
 * fail-open default. The default is now closed: PUBLIC_ROUTES in api-auth.ts
 * is the single list the guard consults, an unlisted route needs the
 * credential, and this file drives the wire to check that the list is wired
 * to the behaviour and holds in both directions:
 *
 *   - nothing outside the list answers anonymously (the guard is actually
 *     consulted, on every registered route, not just on the ones someone
 *     remembered);
 *   - everything inside it still answers (a healthcheck or an OAuth redirect
 *     that started 401ing would be an outage, and an entry that lies is worse
 *     than no entry);
 *   - the list has no entry for a route that is not registered, which would
 *     be a licence nobody is using and would hide the day that path comes
 *     back for something else.
 *
 * It imports the list rather than restating it, because two copies of the
 * same allowlist drift and the divergence is invisible until it is a hole. It
 * still asserts behaviour, not the rule: it sends real requests instead of
 * re-implementing the lookup, so a bug in the guard fails this test rather
 * than being mirrored by it.
 *
 * The structural fix is per-subtree encapsulated hooks, where a route cannot
 * be registered outside a guard at all. That is a routing redesign; this file
 * plus a closed default holds the line until then.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookServer } from "../webhook-server.js";
import { PUBLIC_ROUTES } from "../api-auth.js";

/**
 * Not swept here. OPTIONS is answered by @fastify/cors before this guard
 * runs, and HEAD is auto-registered by Fastify from each GET route, pointing
 * at the same handler: sweeping it would test the same handler twice while
 * hiding that its access class is inherited. That inheritance is the part
 * worth pinning, so `HEAD /health` is asserted directly in
 * route-default-closed.test.ts instead.
 */
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
