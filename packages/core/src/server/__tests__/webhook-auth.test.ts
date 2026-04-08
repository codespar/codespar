/**
 * Integration tests for webhook signature verification and strict mode.
 *
 * Tests use real HMAC computation (no mocking of crypto) to verify
 * the shared helpers produce correct results.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature, enforceWebhookSecret } from "../webhook-auth.js";

// ── Helpers ──────────────────────────────────────────────────────────

function sign(payload: string, secret: string, algorithm: "sha256" | "sha1", prefix = ""): string {
  return prefix + createHmac(algorithm, secret).update(payload).digest("hex");
}

function createMockReply() {
  const sent = { code: 0, body: null as unknown };
  return {
    reply: {
      status(code: number) {
        sent.code = code;
        return {
          send(body: unknown) {
            sent.body = body;
          },
        };
      },
    },
    sent,
  };
}

function createMockLogger() {
  return {
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as any;
}

// ── verifyWebhookSignature ───────────────────────────────────────────

describe("verifyWebhookSignature", () => {
  const payload = '{"action":"completed"}';
  const secret = "test-secret-123";

  it("validates correct SHA256 signature", () => {
    const sig = sign(payload, secret, "sha256");
    expect(verifyWebhookSignature(payload, sig, secret, "sha256")).toBe(true);
  });

  it("validates correct SHA1 signature", () => {
    const sig = sign(payload, secret, "sha1");
    expect(verifyWebhookSignature(payload, sig, secret, "sha1")).toBe(true);
  });

  it("rejects invalid signature", () => {
    expect(verifyWebhookSignature(payload, "deadbeef", secret, "sha256")).toBe(false);
  });

  it("handles SHA256 with sha256= prefix (GitHub format)", () => {
    const sig = sign(payload, secret, "sha256", "sha256=");
    expect(verifyWebhookSignature(payload, sig, secret, "sha256", "sha256=")).toBe(true);
  });
});

// ── enforceWebhookSecret (strict mode) ───────────────────────────────

describe("enforceWebhookSecret", () => {
  describe("strict mode on (via module re-import)", () => {
    async function importStrictEnforce() {
      // STRICT_MODE is captured at module load time. To test the strict
      // path, reset vitest's module registry and re-import with the env
      // var set so the top-level const re-evaluates.
      vi.resetModules();
      process.env.WEBHOOK_STRICT_MODE = "true";
      const mod = await import("../webhook-auth.js");
      return mod.enforceWebhookSecret;
    }

    afterEach(() => {
      delete process.env.WEBHOOK_STRICT_MODE;
      vi.resetModules();
    });

    it("rejects with 401 when no secret is configured", async () => {
      const enforce = await importStrictEnforce();
      const { reply, sent } = createMockReply();
      const log = createMockLogger();
      const result = enforce(undefined, "GitHub", reply, log);
      expect(result).toBe(false);
      expect(sent.code).toBe(401);
      expect((sent.body as any).error).toContain("GitHub webhook secret not configured");
    });

    it("includes provider name in 401 response", async () => {
      const enforce = await importStrictEnforce();
      const { reply, sent } = createMockReply();
      const log = createMockLogger();
      enforce(undefined, "Sentry", reply, log);
      expect((sent.body as any).error).toContain("Sentry");
    });

    it("logs rejection warning with strict mode label", async () => {
      const enforce = await importStrictEnforce();
      const { reply } = createMockReply();
      const log = createMockLogger();
      enforce(undefined, "Vercel", reply, log);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("strict mode"),
      );
    });
  });

  describe("with secret present", () => {
    it("returns true when secret is provided", () => {
      const { reply } = createMockReply();
      const log = createMockLogger();
      expect(enforceWebhookSecret("my-secret", "GitHub", reply, log)).toBe(true);
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe("without secret (non-strict mode)", () => {
    it("returns false when no secret (allows request to proceed unverified)", () => {
      const { reply } = createMockReply();
      const log = createMockLogger();
      const result = enforceWebhookSecret(undefined, "GitHub", reply, log);
      expect(result).toBe(false);
    });

    it("logs warning on every skipped verification", () => {
      const { reply } = createMockReply();
      const log = createMockLogger();
      enforceWebhookSecret(undefined, "Vercel", reply, log);
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Vercel webhook secret not configured"),
      );
    });

    it("does not send a 401 response", () => {
      const { reply, sent } = createMockReply();
      const log = createMockLogger();
      enforceWebhookSecret(undefined, "Sentry", reply, log);
      expect(sent.code).toBe(0); // status() never called
    });
  });
});

// ── HTTP integration ─────────────────────────────────────────────────

describe("webhook verification integration", () => {
  it("GitHub: valid SHA256 signature with prefix passes end-to-end", () => {
    const payload = '{"ref":"refs/heads/main"}';
    const secret = "gh-secret";
    const sig = sign(payload, secret, "sha256", "sha256=");

    // Simulate what the handler does: enforceWebhookSecret + verifyWebhookSignature
    const { reply } = createMockReply();
    const log = createMockLogger();
    const hasSecret = enforceWebhookSecret(secret, "GitHub", reply, log);
    expect(hasSecret).toBe(true);
    expect(verifyWebhookSignature(payload, sig, secret, "sha256", "sha256=")).toBe(true);
  });

  it("Vercel: SHA1 verification uses constant-time comparison", () => {
    // This test exists to document that Vercel now uses the shared
    // verifyWebhookSignature which internally uses timingSafeEqual,
    // replacing the previous !== comparison
    const payload = '{"type":"deployment.succeeded"}';
    const secret = "vercel-secret";
    const sig = sign(payload, secret, "sha1");
    expect(verifyWebhookSignature(payload, sig, secret, "sha1")).toBe(true);

    // Tampered signature is rejected
    const tampered = sig.slice(0, -1) + "0";
    expect(verifyWebhookSignature(payload, tampered, secret, "sha1")).toBe(false);
  });
});
