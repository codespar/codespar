/**
 * Non-overridable deny-list patterns for the OSS policy hook.
 *
 * These five categories are defined in the platform's core safety contract
 * and must be enforced identically in both self-hosted and managed deployments.
 * Any PolicyHook implementation — OSS or enterprise — must deny these tool names.
 *
 * Pattern matching operates on the canonicalized tool name (see
 * canonicalizeToolName below). Patterns intentionally include a trailing
 * optional-version group `(:[a-z0-9]+)*` so that versioned tool names like
 * `fund:transfer:v2` are not treated differently from `fund:transfer`.
 */

/** Normalize a tool name before deny-list comparison.
 *
 * Steps:
 *  1. NFKD decomposition — handles compatibility characters
 *  2. Strip combining marks (diacritics)
 *  3. Strip remaining non-ASCII — eliminates Unicode lookalikes
 *  4. Lowercase
 *  5. Normalize word separators (_  -  /  \  .  space) → single colon
 *  6. Collapse consecutive colons
 *  7. Trim leading/trailing colons
 */
export function canonicalizeToolName(toolName: string): string {
  return toolName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7F]/g, '')
    .toLowerCase()
    .replace(/[_\-\\/. ]+/g, ':')
    .replace(/:+/g, ':')
    .replace(/^:|:$/g, '');
}

/**
 * Category 1 — Fund transfers above cap.
 *
 * Covers Pix, wire transfers, wallet payouts, and generic payment-send
 * actions. When estimatedCost is undefined on a matching tool name the hook
 * also denies (see OSSPolicyHook), because the amount cannot be verified
 * against the configured cap.
 */
export const FUND_TRANSFER_PATTERN =
  /^(pix|fund|payment|wire|remit|payout|transfer):(send|transfer|execute|process|initiate|pay|funds)(:[a-z0-9]+)*$/;

/**
 * Category 2 — Fiscal document issuance for contested carts.
 *
 * Covers Brazilian NF-e, Mexican CFDI and Factura, and generic invoice
 * emission operations. Issuing a fiscal document against a contested cart
 * creates an irreversible legal record and always requires human approval.
 */
export const FISCAL_DOCUMENT_PATTERN =
  /^(nfe|cfdi|factura|nota|invoice|danfe|sat):(emit|issue|stamp|sign|generate|create|cancel)(:[a-z0-9]+)*$/;

/**
 * Category 3 — Wallet-policy overrides.
 *
 * Any tool that modifies, bypasses, or disables an active spending limit or
 * wallet policy rule is non-overridable. This includes budget-cap resets
 * and per-tenant limit changes.
 */
export const WALLET_POLICY_OVERRIDE_PATTERN =
  /^(wallet|policy|spending|limit|cap|budget):(override|bypass|disable|remove|delete|reset)(:[a-z0-9]+)*$/;

/**
 * Category 4 — Bulk outbound messaging above threshold.
 *
 * Mass messaging campaigns (WhatsApp, SMS, email blast) must not be sent
 * autonomously above the configured per-tenant threshold. Both
 * `bulk:send` and `message:bulk` naming conventions are covered.
 */
export const BULK_MESSAGING_PATTERN =
  /^((bulk|broadcast|campaign|mass):(send|message|notify|push|dispatch)|(message|messaging|notification|channel):(bulk|broadcast|mass|campaign|batch))(:[a-z0-9]+)*$/;

/**
 * Category 5 — Cross-tenant agent-to-agent commitments.
 *
 * An agent committing on behalf of a tenant to another tenant's agent
 * (purchasing, contracting, pledging) always requires explicit human approval
 * because it creates binding obligations across tenant boundaries.
 */
export const CROSS_TENANT_A2A_PATTERN =
  /^(a2a|agent|external):(commit|bind|contract|sign|pledge|promise|agree)(:[a-z0-9]+)*$/;

/** All five non-overridable deny-list patterns in declaration order. */
export const DENY_LIST_PATTERNS = [
  FUND_TRANSFER_PATTERN,
  FISCAL_DOCUMENT_PATTERN,
  WALLET_POLICY_OVERRIDE_PATTERN,
  BULK_MESSAGING_PATTERN,
  CROSS_TENANT_A2A_PATTERN,
] as const;
