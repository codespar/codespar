/**
 * The guard and the router must agree on which path a request is for.
 *
 * Every bypass found in this fix has been the same bug wearing a different
 * hat: the guard matched one spelling of the request-target while Fastify
 * routed on another, so the hook returned early and the handler ran anyway.
 * Twice now, on code that had passing tests and green CI.
 *
 * These go over a REAL SOCKET, not through inject(). That is the whole point
 * of the file. inject() rewrites an absolute-form request-target into
 * origin-form before any hook runs, so the absolute-form bypass cannot even
 * be expressed through it: a test written with inject() would pass with the
 * defence removed. Nothing here can be satisfied by a mock, because the thing
 * under test is what arrives on the wire.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookServer } from "../webhook-server.js";
import { candidatePaths, routedPath } from "../api-auth.js";

/**
 * Send a request line verbatim and return the status code.
 *
 * Written by hand rather than with a client library because every HTTP
 * client normalises the request-target, which is exactly the normalisation
 * whose absence is the vulnerability.
 */
function rawRequest(port: number, requestLine: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`${requestLine}\r\nHost: anything.example\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("end", () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(buf);
      if (!match) return reject(new Error(`no status line in: ${buf.slice(0, 200)}`));
      resolve(Number(match[1]));
    });
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
  });
}

describe("request-target forms cannot walk past the auth guard", () => {
  let server: WebhookServer;
  let port: number;
  let stateDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR"]) {
      saved[key] = process.env[key];
    }
    delete process.env.ENGINE_API_TOKEN;
    stateDir = mkdtempSync(join(tmpdir(), "codespar-request-target-"));
    process.env.CODESPAR_STATE_DIR = stateDir;

    server = new WebhookServer({ port: 0, host: "127.0.0.1" });
    // Listening through the Fastify instance rather than WebhookServer.start(),
    // which also boots the event bus and probes Docker to warm a container
    // pool. None of that is under test here, and warming real containers in a
    // unit test would be slow and machine-dependent.
    await server.fastifyInstance.listen({ port: 0, host: "127.0.0.1" });
    const address = server.fastifyInstance.server.address();
    if (!address || typeof address === "string") throw new Error("no bound port");
    port = address.port;
  });

  afterAll(async () => {
    await server.fastifyInstance.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("refuses an absolute-form request-target (the proxy form)", async () => {
    // RFC 7230 5.3.2. Any HTTP proxy sends this, so it needs no special
    // client: `curl -x http://runtime http://anything/api/agents` produces it.
    // Fastify sets request.url to the whole URI, so `startsWith("/api")` was
    // false and the guard let it through while the router dispatched on the
    // path component.
    expect(await rawRequest(port, "GET http://anything.example/api/agents HTTP/1.1")).toBe(401);
  });

  it("refuses absolute-form on the destructive route that proved it", async () => {
    // This one returned 200 {"success":true,"message":"Audit log cleared"} to
    // an anonymous caller. The audit log is the tamper-evident record, so
    // this was not read-only exposure: anyone on the network could erase it.
    expect(await rawRequest(port, "DELETE http://anything.example/api/audit HTTP/1.1")).toBe(401);
  });

  it("refuses absolute-form for /sessions and /a2a, and for the /v1 mirrors", async () => {
    for (const line of [
      "POST http://anything.example/sessions HTTP/1.1",
      "POST http://anything.example/a2a/tasks HTTP/1.1",
      "GET http://anything.example/v1/api/agents HTTP/1.1",
      "GET http://anything.example/a2a/tasks HTTP/1.1",
    ]) {
      expect(await rawRequest(port, line), line).toBe(401);
    }
  });

  it("refuses absolute-form with an https scheme and a port", async () => {
    expect(
      await rawRequest(port, "GET https://anything.example:8443/api/agents HTTP/1.1"),
    ).toBe(401);
  });

  it("refuses an absolute-form target whose query starts before any path slash", async () => {
    // The fourth form, and the one that got past the fix for the third.
    //
    // `http://evil.example?/api/metrics` has no slash between the authority
    // and the `?`. That single detail split the two derivations the guard was
    // using, both away from what the router does:
    //
    //   raw.split("?")[0]        -> "http://evil.example"   (no /api)
    //   new URL(raw).pathname    -> "/"                     (no /api)
    //   find-my-way              -> "/api/metrics"          (dispatches!)
    //
    // find-my-way strips with /^https?:\/\/.*?\// — up to the FIRST slash —
    // and with no path slash present the first slash is the one after the
    // `?`. So the guard saw `/` and the router served /api/metrics.
    //
    // The lesson is in the shape, not the character: deriving the path with
    // `new URL()` was a SECOND implementation of routing, so a fifth form was
    // always going to exist. The guard now asks Fastify which route it
    // matched instead of re-deriving it.
    expect(await rawRequest(port, "GET http://evil.example?/api/metrics HTTP/1.1")).toBe(401);
  });

  it("refuses the query-before-slash form on the destructive route", async () => {
    // Reproduced end to end by review: this returned 200 and emptied the
    // tamper-evident audit log for an anonymous caller.
    expect(await rawRequest(port, "DELETE http://evil.example?/api/audit HTTP/1.1")).toBe(401);
  });

  it("refuses the query-before-slash form across the whole control surface", async () => {
    for (const line of [
      "POST http://evil.example?/a2a/tasks HTTP/1.1",
      "POST http://evil.example?/api/chat HTTP/1.1",
      "DELETE http://evil.example?/api/agents/probe HTTP/1.1",
      "GET http://evil.example?/v1/api/agents HTTP/1.1",
      "POST http://evil.example?/sessions HTTP/1.1",
    ]) {
      expect(await rawRequest(port, line), line).toBe(401);
    }
  });

  it("refuses the neighbouring authority shapes too", async () => {
    // Swept rather than assumed: userinfo, explicit port and IPv6 all change
    // where the first slash falls, which is precisely what the old derivation
    // was sensitive to.
    for (const line of [
      "GET http://user@evil.example?/api/metrics HTTP/1.1",
      "GET http://user:pw@evil.example?/api/metrics HTTP/1.1",
      "GET http://evil.example:80?/api/metrics HTTP/1.1",
      "GET http://[::1]?/api/metrics HTTP/1.1",
      "GET http://[::1]:3000?/api/metrics HTTP/1.1",
      "GET http://evil.example?//api/metrics HTTP/1.1",
      "GET https://evil.example?/api/metrics HTTP/1.1",
    ]) {
      const status = await rawRequest(port, line);
      // 401 (guard held) or 400/404 (never routed) are both safe. A 200 is not.
      expect([400, 401, 404], `${line} -> ${status}`).toContain(status);
    }
  });

  it("holds for EVERY registered protected route, not a chosen few", async () => {
    // The previous round of this file tested absolute-form on a handful of
    // paths and passed 17/17 while `http://host?/path` was wide open. A
    // hand-picked list only ever covers the forms someone thought of, on the
    // routes someone thought of.
    //
    // So this drives the dangerous form across every route the server
    // actually registered, mechanically. A route added later is covered the
    // day it is added, without anyone remembering to extend a list.
    const publicRoutes = new Set([
      "/health",
      "/v1/health",
      "/.well-known/agent.json",
      "/api/slack/install",
      "/v1/api/slack/install",
      "/api/slack/callback",
      "/v1/api/slack/callback",
      "/api/discord/install",
      "/v1/api/discord/install",
      "/api/github/install",
      "/v1/api/github/install",
      "/api/github/callback",
      "/v1/api/github/callback",
    ]);

    const routes = server.registeredRoutes.filter(
      (r) =>
        !["HEAD", "OPTIONS"].includes(r.method) &&
        !publicRoutes.has(r.url) &&
        !r.url.startsWith("/webhooks/") &&
        !r.url.startsWith("/v1/webhooks/"),
    );
    expect(routes.length, "no routes to sweep means this test proves nothing").toBeGreaterThan(50);

    const leaked: string[] = [];
    for (const route of routes) {
      const path = route.url.replace(/:[A-Za-z0-9_]+/g, "probe");
      const status = await rawRequest(
        port,
        `${route.method} http://evil.example?${path} HTTP/1.1`,
      );
      // 401 means the guard claimed it. 400/404 mean it never routed. A 2xx or
      // 3xx means a handler answered an anonymous caller.
      if (status < 400) leaked.push(`${route.method} ${route.url} -> ${status}`);
    }

    expect(
      leaked,
      `these routes answered an anonymous caller in query-before-slash form:\n${leaked.join("\n")}`,
    ).toEqual([]);
  });

  it("still answers the origin form the same way", async () => {
    // Sanity: the fix must not have made everything 401 by accident, which
    // would pass every assertion above for the wrong reason.
    expect(await rawRequest(port, "GET /api/agents HTTP/1.1")).toBe(401);
    expect(await rawRequest(port, "GET /health HTTP/1.1")).toBe(200);
  });

  it("still serves a public route sent in absolute form", async () => {
    // Deliberately public routes stay public whatever form they arrive in.
    expect(await rawRequest(port, "GET http://anything.example/health HTTP/1.1")).toBe(200);
  });
});

/**
 * Regression cases for forms that are NOT currently a bypass.
 *
 * These deserve tests precisely because they pass for a reason outside our
 * code: `find-my-way` does not resolve `..`, does not collapse `//`, does not
 * decode twice, and matches case-sensitively. That is a property of a
 * dependency, not a guarantee this repository makes. An upgrade that starts
 * normalising any of these would reopen the bypass with nothing failing, so
 * the router's behaviour is pinned here rather than assumed.
 */
describe("path forms that route nowhere today, pinned against router upgrades", () => {
  let server: WebhookServer;
  let port: number;
  let stateDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR"]) {
      saved[key] = process.env[key];
    }
    delete process.env.ENGINE_API_TOKEN;
    stateDir = mkdtempSync(join(tmpdir(), "codespar-path-forms-"));
    process.env.CODESPAR_STATE_DIR = stateDir;
    server = new WebhookServer({ port: 0, host: "127.0.0.1" });
    await server.fastifyInstance.listen({ port: 0, host: "127.0.0.1" });
    const address = server.fastifyInstance.server.address();
    if (!address || typeof address === "string") throw new Error("no bound port");
    port = address.port;
  });

  afterAll(async () => {
    await server.fastifyInstance.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("never lets any of them reach a handler", async () => {
    const forms = [
      "GET /xyz/../api/agents HTTP/1.1", // dot-segments, unresolved today
      "GET /xyz/%2e%2e/api/agents HTTP/1.1", // encoded dot-segments
      "GET //api/agents HTTP/1.1", // doubled slash
      "GET /./api/agents HTTP/1.1", // current-directory segment
      "GET /API/agents HTTP/1.1", // case
      "GET /%2561pi/agents HTTP/1.1", // double-encoded
      "GET /api%2Fagents HTTP/1.1", // encoded separator
    ];
    for (const line of forms) {
      const status = await rawRequest(port, line);
      // 401 means the guard claimed it; 404 means the router found nothing.
      // Either is safe. 200 would mean a handler answered anonymously.
      expect([401, 404], `${line} -> ${status}`).toContain(status);
    }
  });
});

/**
 * Unit-level pinning of the derivation itself, so a failure points at the
 * function rather than at an HTTP status three layers away.
 */
describe("candidatePaths / routedPath", () => {
  it("recovers the routed path from an absolute-form target", () => {
    expect(routedPath("http://anything.example/api/agents")).toBe("/api/agents");
    expect(candidatePaths("http://anything.example/api/agents")).toContain("/api/agents");
  });

  it("recovers the decoded path from a percent-encoded target", () => {
    expect(routedPath("/%61pi/agents")).toBe("/api/agents");
    expect(candidatePaths("/%61pi/agents")).toContain("/api/agents");
  });

  it("handles both at once", () => {
    expect(routedPath("http://anything.example/%61pi/agents")).toBe("/api/agents");
  });

  it("drops the query string", () => {
    expect(routedPath("/api/agents?orgId=x")).toBe("/api/agents");
    expect(candidatePaths("/api/agents?orgId=x")).toContain("/api/agents");
  });

  it("keeps the raw form as a candidate as well", () => {
    // Fail-closed: a spelling nobody anticipated has to defeat every
    // derivation at once, not just the one that happens to be checked.
    expect(candidatePaths("/api/agents")).toContain("/api/agents");
  });

  it("returns null when the target cannot be decoded", () => {
    expect(routedPath("/%zz/api/agents")).toBeNull();
    expect(candidatePaths("/%zz/api/agents")).toBeNull();
  });
});
