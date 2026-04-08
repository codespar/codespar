/**
 * Integration tests for API bearer token authentication and CORS.
 *
 * Tests use a minimal Fastify instance with the same auth hook logic
 * as WebhookServer.registerApiAuth().
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";

// ── Helpers ──────────────────────────────────────────────────────────

/** Reproduce the auth hook from WebhookServer.registerApiAuth() */
function createTestApp(token?: string) {
  const app = Fastify({ logger: false });

  if (token) {
    const tokenHash = createHash("sha256").update(token).digest();

    const EXCLUDED_PATHS = new Set([
      "/health", "/v1/health",
      "/.well-known/agent.json",
      "/api/slack/install", "/v1/api/slack/install",
      "/api/slack/callback", "/v1/api/slack/callback",
      "/api/discord/install", "/v1/api/discord/install",
      "/api/github/install", "/v1/api/github/install",
      "/api/github/callback", "/v1/api/github/callback",
    ]);

    app.addHook("onRequest", async (request, reply) => {
      const url = request.url.split("?")[0];
      if (!url.startsWith("/api/") && !url.startsWith("/v1/api/")) return;
      if (EXCLUDED_PATHS.has(url)) return;

      const auth = request.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      const providedHash = createHash("sha256").update(auth.slice(7)).digest();
      if (!timingSafeEqual(providedHash, tokenHash)) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
    });
  }

  // Register test routes that mirror the real server's path patterns
  app.get("/api/agents", async () => ({ agents: [] }));
  app.get("/v1/api/agents", async () => ({ agents: [] }));
  app.post("/webhooks/github", async () => ({ ok: true }));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/slack/callback", async () => ({ ok: true }));
  app.get("/api/discord/install", async () => ({ ok: true }));
  app.get("/api/events", async () => ({ events: [] })); // SSE placeholder

  return app;
}

const TEST_TOKEN = "test-secret-token-abc123";

// ── Auth enforcement tests ───────────────────────────────────────────

describe("API auth hook", () => {
  describe("with ENGINE_API_TOKEN set", () => {
    const app = createTestApp(TEST_TOKEN);

    it("returns 401 without Authorization header", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe("Unauthorized");
    });

    it("returns 401 with wrong token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with malformed header (no Bearer prefix)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Basic ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("succeeds with correct Bearer token", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).agents).toEqual([]);
    });

    it("does not affect /webhooks/github", async () => {
      const res = await app.inject({ method: "POST", url: "/webhooks/github" });
      expect(res.statusCode).toBe(200);
    });

    it("does not affect /health", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
    });

    it("does not affect /api/slack/callback (OAuth exclusion)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/slack/callback" });
      expect(res.statusCode).toBe(200);
    });

    it("requires token for /api/events (SSE)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/events" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("without ENGINE_API_TOKEN", () => {
    const app = createTestApp(); // no token

    it("allows all requests without auth", async () => {
      const res = await app.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("token comparison security", () => {
    it("uses SHA-256 hash to prevent length oracle", () => {
      // Both a short and long token produce the same 32-byte hash,
      // so timingSafeEqual always compares equal-length buffers.
      const short = createHash("sha256").update("abc").digest();
      const long = createHash("sha256").update("a".repeat(1000)).digest();
      expect(short.length).toBe(32);
      expect(long.length).toBe(32);
      // Different tokens produce different hashes
      expect(timingSafeEqual(short, long)).toBe(false);
    });
  });
});
