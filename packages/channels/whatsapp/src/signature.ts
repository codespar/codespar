/**
 * Evolution API webhook signature verification (F10.M3 / #364).
 *
 * Evolution API's current release forwards the configured webhook
 * secret on every callback as a static header (`apikey` by default).
 * We treat that header as a bearer secret and compare constant-time
 * against `EVOLUTION_WEBHOOK_SECRET`. When Evolution gains true HMAC
 * support upstream, the verification swaps in here without touching
 * the route.
 *
 * Strict mode (`WHATSAPP_WEBHOOK_STRICT_MODE`) controls behaviour when
 * the secret is unset:
 *   - true  → reject every request with 401 (production failsafe).
 *   - false → accept with a one-time WARN log on first invocation
 *             (local dev failsafe).
 */

import { timingSafeEqual } from "node:crypto";

/** Header Evolution API uses for the shared secret. Constant kept here
 *  so the verifier + the test mocks agree without magic strings. */
export const EVOLUTION_SIGNATURE_HEADER = "apikey";

/** Discriminated outcome of the signature check at the route boundary. */
export type SignatureVerdict =
  | { ok: true; reason: "secret_match" | "no_secret_relaxed" }
  | { ok: false; reason: "missing_header" | "header_mismatch" | "no_secret_strict" };

/**
 * Constant-time compare of two strings without leaking length via the
 * early-exit branch. Throws-free; returns false on any anomaly.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export interface VerifyInputs {
  /** Value of the configured Evolution signature header on the request. */
  providedHeader: string | undefined;
  /** Value of `EVOLUTION_WEBHOOK_SECRET` at request time. */
  secret: string | undefined;
  /** Resolved `WHATSAPP_WEBHOOK_STRICT_MODE` flag. */
  strict: boolean;
}

export function verifyEvolutionSignature(inputs: VerifyInputs): SignatureVerdict {
  const { providedHeader, secret, strict } = inputs;

  if (secret && secret.length > 0) {
    if (!providedHeader) {
      return { ok: false, reason: "missing_header" };
    }
    if (!constantTimeEqual(providedHeader, secret)) {
      return { ok: false, reason: "header_mismatch" };
    }
    return { ok: true, reason: "secret_match" };
  }

  // No secret configured.
  if (strict) {
    return { ok: false, reason: "no_secret_strict" };
  }
  return { ok: true, reason: "no_secret_relaxed" };
}

/** Parse the truthy strict-mode env value. Accepts "true" / "1" / "yes". */
export function isStrictMode(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}
