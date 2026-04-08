/**
 * Shared webhook signature verification and enforcement.
 *
 * Used by all webhook handlers (GitHub, Vercel, Sentry) for consistent
 * HMAC verification and strict mode enforcement.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../observability/logger.js";

/** Whether to reject webhooks when no secret is configured. */
const STRICT_MODE = process.env.WEBHOOK_STRICT_MODE === "true";

export type WebhookAlgorithm = "sha256" | "sha1";

/**
 * Verify an HMAC webhook signature using constant-time comparison.
 * Works for GitHub (SHA256 with "sha256=" prefix), Vercel (SHA1), and Sentry (SHA256).
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  algorithm: WebhookAlgorithm,
  prefix?: string,
): boolean {
  const digest = createHmac(algorithm, secret).update(payload).digest("hex");
  const expected = prefix ? prefix + digest : digest;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

interface ReplyLike {
  status(code: number): { send(body: unknown): void };
}

/**
 * Enforce webhook secret configuration. Returns true if the handler should
 * proceed to signature verification (secret exists). Returns false if the
 * request was already handled (rejected in strict mode, or allowed without
 * secret in non-strict mode).
 */
export function enforceWebhookSecret(
  secret: string | undefined,
  provider: string,
  reply: ReplyLike,
  log: Logger,
): boolean {
  if (secret) return true;

  if (STRICT_MODE) {
    log.warn(`${provider} webhook rejected: no secret configured (strict mode)`);
    reply.status(401).send({
      error: `${provider} webhook secret not configured. Set the secret or disable WEBHOOK_STRICT_MODE.`,
    });
    return false;
  }

  log.warn(`${provider} webhook secret not configured — skipping signature verification`);
  return false;
}
