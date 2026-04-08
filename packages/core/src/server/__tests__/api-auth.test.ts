/**
 * Integration tests for API bearer token authentication.
 *
 * Tests use the real WebhookServer with its actual registerApiAuth() hook,
 * not a recreated version. The inject() method delegates to Fastify's
 * inject() so we test the full request pipeline.
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebhookServer } from "../webhook-server.js";

const TEST_TOKEN = "test-secret-token-abc123";

// ── Auth enabled tests ───────────────────────────────────────────────

describe("API auth hook (real WebhookServer)", () => {
  describe("with ENGINE_API_TOKEN set", () => {
    let server: WebhookServer;

    beforeAll(() => {
      process.env.ENGINE_API_TOKEN = TEST_TOKEN;
      server = new WebhookServer({ port: 0 });
    });

    afterAll(() => {
      delete process.env.ENGINE_API_TOKEN;
    });

    it("returns 401 without Authorization header", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toBe("Unauthorized");
    });

    it("returns 401 with wrong token", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: "Bearer wrong-token" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 with malformed header (no Bearer prefix)", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Basic ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("succeeds with correct Bearer token", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/agents",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("does not affect /webhooks/github", async () => {
      // Webhook routes have their own auth (signature verification).
      // Without a valid payload this will fail at the handler level, not at auth.
      const res = await server.inject({
        method: "POST",
        url: "/webhooks/github",
        payload: {},
        headers: { "content-type": "application/json" },
      });
      // Any status other than 401 means the auth hook didn't block it.
      // The handler may return 200 or 400 depending on payload — both are fine.
      expect(res.statusCode).not.toBe(401);
    });

    it("does not affect /health", async () => {
      const res = await server.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).not.toBe(401);
    });

    it("does not affect /api/slack/callback (OAuth exclusion)", async () => {
      const res = await server.inject({ method: "GET", url: "/api/slack/callback" });
      // OAuth callback may redirect or return an error — just verify no 401 from auth hook
      expect(res.statusCode).not.toBe(401);
    });

    it("requires token for /api/events (SSE)", async () => {
      const res = await server.inject({ method: "GET", url: "/api/events" });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("without ENGINE_API_TOKEN", () => {
    let server: WebhookServer;

    beforeAll(() => {
      delete process.env.ENGINE_API_TOKEN;
      server = new WebhookServer({ port: 0 });
    });

    it("allows requests without auth", async () => {
      const res = await server.inject({ method: "GET", url: "/api/agents" });
      // Should not be 401 — auth hook is not registered when token is unset
      expect(res.statusCode).not.toBe(401);
    });
  });

  describe("token comparison security", () => {
    it("SHA-256 hash produces fixed-length buffers (prevents length oracle)", () => {
      const short = createHash("sha256").update("abc").digest();
      const long = createHash("sha256").update("a".repeat(1000)).digest();
      expect(short.length).toBe(32);
      expect(long.length).toBe(32);
      expect(timingSafeEqual(short, long)).toBe(false);
    });
  });
});
