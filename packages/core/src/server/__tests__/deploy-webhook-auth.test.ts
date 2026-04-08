/**
 * Integration tests for deploy webhook HMAC-SHA256 authentication.
 *
 * Tests use the real WebhookServer with its actual webhook route registration,
 * not a recreated version. The inject() method delegates to Fastify's inject()
 * so we test the full request pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createHmac } from "node:crypto";
import { WebhookServer } from "../webhook-server.js";

const TEST_SECRET = "deploy-test-secret-abc123";
const DEPLOY_BODY = JSON.stringify({
  project: "api-gateway",
  status: "success",
  source: "github-actions",
  url: "https://example.com/deploy/123",
});

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

// ── With secret configured ──────────────────────────────────────────

describe("deploy webhook auth (real WebhookServer)", () => {
  describe("with DEPLOY_WEBHOOK_SECRET set", () => {
    let server: WebhookServer;

    beforeAll(() => {
      process.env.DEPLOY_WEBHOOK_SECRET = TEST_SECRET;
      server = new WebhookServer({ port: 0 });
    });

    afterAll(() => {
      delete process.env.DEPLOY_WEBHOOK_SECRET;
    });

    it("accepts request with valid signature", async () => {
      const sig = sign(DEPLOY_BODY, TEST_SECRET);
      const res = await server.inject({
        method: "POST",
        url: "/webhooks/deploy",
        payload: DEPLOY_BODY,
        headers: {
          "content-type": "application/json",
          "x-deploy-signature": sig,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.received).toBe(true);
    });

    it("rejects request with invalid signature", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/webhooks/deploy",
        payload: DEPLOY_BODY,
        headers: {
          "content-type": "application/json",
          "x-deploy-signature": "deadbeef",
        },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toContain("Invalid webhook signature");
    });

    it("rejects request with missing x-deploy-signature header", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/webhooks/deploy",
        payload: DEPLOY_BODY,
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toContain("Missing x-deploy-signature");
    });
  });

  // ── Without secret, non-strict mode ─────────────────────────────

  describe("without DEPLOY_WEBHOOK_SECRET (non-strict)", () => {
    let server: WebhookServer;

    beforeAll(() => {
      delete process.env.DEPLOY_WEBHOOK_SECRET;
      delete process.env.WEBHOOK_STRICT_MODE;
      server = new WebhookServer({ port: 0 });
    });

    it("accepts unsigned request with warning", async () => {
      const res = await server.inject({
        method: "POST",
        url: "/webhooks/deploy",
        payload: DEPLOY_BODY,
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.received).toBe(true);
    });
  });

  // ── Without secret, strict mode ─────────────────────────────────

  describe("without DEPLOY_WEBHOOK_SECRET (strict mode)", () => {
    it("rejects unsigned request when strict mode is enabled", async () => {
      // WEBHOOK_STRICT_MODE is read at module load time, so we need
      // vi.resetModules() to get a fresh import with the env var set.
      process.env.WEBHOOK_STRICT_MODE = "true";
      delete process.env.DEPLOY_WEBHOOK_SECRET;

      vi.resetModules();
      const { WebhookServer: FreshServer } = await import("../webhook-server.js");
      const server = new FreshServer({ port: 0 });

      const res = await server.inject({
        method: "POST",
        url: "/webhooks/deploy",
        payload: DEPLOY_BODY,
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body).error).toContain("not configured");

      delete process.env.WEBHOOK_STRICT_MODE;
    });
  });

  // ── Webhook URL instructions ────────────────────────────────────

  describe("GET /api/webhooks/url", () => {
    let server: WebhookServer;

    beforeAll(() => {
      delete process.env.ENGINE_API_TOKEN;
      server = new WebhookServer({ port: 0 });
    });

    it("includes deploy webhook signing instructions", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/webhooks/url",
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.instructions.deploy).toContain("DEPLOY_WEBHOOK_SECRET");
      expect(body.instructions.deploy).toContain("x-deploy-signature");
    });
  });
});
