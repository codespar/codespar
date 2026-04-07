---
status: Accepted
problem: |
  The webhook handlers for GitHub, Vercel, and Sentry all implement HMAC
  signature verification, but when no secret is configured verification is
  silently skipped. An unconfigured deployment accepts forged webhook events
  from anyone. The three handlers also use inconsistent patterns: Vercel
  uses non-constant-time comparison and has no warning log when skipping.
decision: |
  Extract a shared verifyWebhookSignature helper and a checkWebhookSecret
  gate function. Add WEBHOOK_STRICT_MODE env var (default false) that rejects
  with 401 when no secret is configured. When off, log a per-request warning.
  Fix Vercel to use timingSafeEqual. Consolidate the duplicate
  verifyGitHubSignature into the shared helper.
rationale: |
  Defaulting strict mode to false avoids breaking existing deployments and
  local development. The per-request warning is loud enough to drive
  configuration without blocking adoption. Extracting a shared helper
  eliminates the inconsistency between handlers and the duplicate function,
  making the verification logic auditable in one place.
---

# DESIGN: Enforce Webhook Signature Verification

## Status

Proposed

## Context and Problem Statement

CodeSpar receives webhook events from GitHub, Vercel, and Sentry at three
endpoints in `packages/core/src/server/routes/webhooks.ts`. Each handler
implements HMAC signature verification, but the behavior when no webhook
secret is configured varies:

| Handler | Algorithm | Timing-safe | No-secret behavior |
|---------|-----------|-------------|-------------------|
| GitHub | SHA256 | Yes (`timingSafeEqual`) | Warns, allows |
| Vercel | SHA1 | **No** (uses `!==`) | **Silently allows** |
| Sentry | SHA256 | Yes (`timingSafeEqual`) | Warns, allows |

All three share the same secret resolution chain: org storage, then
org-specific env var, then global env var. When none are set, verification
is skipped entirely.

There is also a duplicate `verifyGitHubSignature` function in
`webhook-server.ts:132` that is identical to the one in `webhooks.ts:15`.

### What can go wrong

An attacker who knows the webhook endpoint URL can send forged events:
- Fake a CI failure to trigger an incident investigation
- Fake a deploy success to skip health checks
- Fake a Sentry alert to trigger agent actions
- Trigger agent work that consumes LLM tokens

In a self-hosted deployment on a private network, the risk is lower. On a
public-facing deployment, anyone who discovers the URL can inject events.

## Decision Drivers

- **Non-breaking** -- must not break existing deployments or local dev setups
- **Secure by default when opted in** -- strict mode should be a clear, safe posture
- **Consistent** -- all three handlers must use the same verification pattern
- **DRY** -- eliminate duplicate verification code
- **Observable** -- skipped verification must be visible in logs, not silent
- **Testable** -- enforcement behavior must be covered by integration tests

## Considered Options

### Decision 1: Default for WEBHOOK_STRICT_MODE

#### Chosen: Default to false (non-breaking)

Default `WEBHOOK_STRICT_MODE=false`. When off, log a warning on every
request where verification is skipped. When on, reject with 401. Operators
opt in to strict mode explicitly.

This preserves the current behavior for all existing deployments. The
per-request warning is the nudge to configure secrets. Setting
`WEBHOOK_STRICT_MODE=true` is a one-line change when ready.

#### Alternatives considered

**Default to true (secure by default):**
Rejected because it would break every existing deployment and local dev
setup that hasn't configured webhook secrets. Developers running locally
typically don't set up webhook signature verification. The codespar.dev
production deployment would need its env updated before deploying, creating
a coordination requirement.

**No toggle (always reject):**
Rejected for the same reason as above, plus it removes the ability to run
in development without secrets.

### Decision 2: Enforcement implementation pattern

#### Chosen: Extract shared helper functions

Create two functions in a new file
`packages/core/src/server/webhook-auth.ts`:

1. `verifyWebhookSignature(payload, signature, secret, algorithm)` --
   unified HMAC verification with `timingSafeEqual` for all handlers
2. `enforceWebhookSecret(secret, provider, reply, log)` -- the gate
   function that checks strict mode and handles the no-secret case

All three handlers call `enforceWebhookSecret` at the same point. If it
returns `false`, the handler returns early (request rejected or allowed
without secret). If it returns `true`, the handler proceeds to signature
verification using `verifyWebhookSignature`.

The duplicate `verifyGitHubSignature` in `webhook-server.ts` is replaced
with an import from the new module.

#### Alternatives considered

**Inline fix in each handler:**
Rejected because it perpetuates the three-way duplication. Each handler
would need its own strict mode check, warning log, and 401 response. A
bug fix in one handler might not be applied to the others.

**Fastify middleware/hook:**
Rejected because the three handlers use different signature headers and
algorithms. A generic middleware would need per-route configuration,
adding complexity without reducing code.

### Decision 3: Testing approach

#### Chosen: Focused integration tests (12 tests)

Test the shared helper functions directly and the HTTP-level behavior
through Fastify inject. Uses the same patterns as `a2a.test.ts` and
`chat-guard.test.ts`.

File: `packages/core/src/server/__tests__/webhook-auth.test.ts`

| Category | Tests |
|----------|-------|
| `verifyWebhookSignature` | Valid SHA256, valid SHA1, invalid signature, wrong algorithm |
| `enforceWebhookSecret` strict on | No secret returns 401, with secret passes |
| `enforceWebhookSecret` strict off | No secret logs warning and allows, with secret passes |
| HTTP integration | GitHub webhook rejected without secret (strict), GitHub webhook allowed without secret (non-strict), Vercel uses timing-safe comparison |

## Decision Outcome

The three decisions compose cleanly:

1. **D1** (default false) determines the *policy*
2. **D2** (shared helpers) determines the *implementation pattern*
3. **D3** (focused tests) determines *verification*

The enforcement gate runs at the same point in all three handlers — after
secret resolution, before signature verification. The shared helper
centralizes the strict mode logic so it's configured once and applied
uniformly.

## Solution Architecture

### New file: `packages/core/src/server/webhook-auth.ts`

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Logger } from "../observability/logger.js";

/** Whether to reject webhooks when no secret is configured. */
const STRICT_MODE = process.env.WEBHOOK_STRICT_MODE === "true";

type WebhookAlgorithm = "sha256" | "sha1";

/**
 * Verify an HMAC webhook signature using constant-time comparison.
 * Works for GitHub (SHA256), Vercel (SHA1), and Sentry (SHA256).
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  algorithm: WebhookAlgorithm,
  prefix?: string, // e.g., "sha256=" for GitHub
): boolean {
  const digest = createHmac(algorithm, secret).update(payload).digest("hex");
  const expected = prefix ? prefix + digest : digest;
  if (expected.length !== signature.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * Enforce webhook secret configuration. Returns true if the handler should
 * proceed to signature verification. Returns false if the request was
 * already handled (rejected or allowed without secret).
 *
 * When strict mode is on and no secret: rejects with 401.
 * When strict mode is off and no secret: logs warning, allows.
 */
export function enforceWebhookSecret(
  secret: string | undefined,
  provider: string,
  reply: { status: (code: number) => { send: (body: unknown) => void }; code: (code: number) => { send: (body: unknown) => void } },
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
  return false; // allow the request to proceed without verification
}
```

### Modified file: `packages/core/src/server/routes/webhooks.ts`

Each handler's verification block changes from:

```typescript
// Before:
if (webhookSecret) {
  // verify signature
} else {
  log.warn("...");
}
```

To:

```typescript
// After:
if (enforceWebhookSecret(webhookSecret, "GitHub", reply, log)) {
  // verify signature using verifyWebhookSignature()
}
```

When `enforceWebhookSecret` returns `false`:
- Strict mode on: reply already sent (401), handler returns early
- Strict mode off: warning logged, handler continues without verification

The `if (enforceWebhookSecret(...))` block only runs when a secret exists.
When no secret and non-strict, the handler falls through to process the
webhook without verification — same as current behavior, but with a
per-request warning.

**Vercel fix:** Replace the inline `signature !== expected` with
`verifyWebhookSignature(rawBody, signature, vercelSecret, "sha1")`.

### Modified file: `packages/core/src/server/webhook-server.ts`

Delete the duplicate `verifyGitHubSignature` function (line 132). Replace
its single call site with an import from `webhook-auth.ts`.

### Data flow

```
Webhook request arrives
  |
  v
Handler resolves secret (org storage -> env vars)
  |
  v
enforceWebhookSecret(secret, provider, reply, log)
  |
  +-- secret exists? --> return true --> verify signature
  |                                        |
  |                                        +-- valid? --> process event
  |                                        +-- invalid? --> 401
  |
  +-- no secret + strict mode? --> 401, return false
  |
  +-- no secret + non-strict? --> warn, return false --> process event (unverified)
```

## Implementation Approach

### Phase 1: Extract shared helpers

Create `packages/core/src/server/webhook-auth.ts` with
`verifyWebhookSignature` and `enforceWebhookSecret`. Export from
`@codespar/core` index.

### Phase 2: Rewire handlers

Update all three webhook handlers in `webhooks.ts` to use the shared
helpers. Fix Vercel to use `verifyWebhookSignature` with `"sha1"` and
constant-time comparison. Remove the duplicate in `webhook-server.ts`.

### Phase 3: Tests

Write the integration test suite at
`packages/core/src/server/__tests__/webhook-auth.test.ts`.

### Phase 4: Documentation

Update `apps/docs/content/docs/guides/webhook-monitoring.mdx` to document
`WEBHOOK_STRICT_MODE` and the verification behavior.

## Security Considerations

### Timing attack fix

The Vercel handler currently uses `signature !== expected` for signature
comparison. This is vulnerable to timing attacks where an attacker can
determine the correct signature byte-by-byte by measuring response times.
This design fixes it by routing all handlers through `verifyWebhookSignature`
which uses `timingSafeEqual`.

### Strict mode as opt-in

Defaulting strict mode to false means a fresh deployment without secrets
configured is vulnerable to forged webhooks. This is a deliberate tradeoff
for adoption -- the per-request warning ensures operators are aware. The
documentation must clearly state that `WEBHOOK_STRICT_MODE=true` is
recommended for any deployment accessible from the internet.

### Error message information leakage

The 401 response in strict mode includes the provider name and a hint to
configure secrets. This is acceptable because the provider is already
implicit in the URL path (`/webhooks/github`), and the configuration hint
helps operators diagnose the issue.

### Raw body reconstruction (pre-existing)

All three handlers use `JSON.stringify(request.body)` as a fallback when
the body is already parsed by Fastify. The re-serialized bytes may differ
from the original request body (whitespace, key order, Unicode escaping),
causing HMAC mismatches. This is a pre-existing bug that this design
carries forward into the shared helper. The correct fix is to capture the
raw request body before parsing (via Fastify's `addContentTypeParser` or
a `preParsing` hook). This is tracked separately -- it affects all three
handlers regardless of strict mode.

### No replay protection

HMAC verification proves the webhook came from the expected sender but
does not prevent replay attacks. An attacker who captures a valid signed
webhook can re-send it. This is inherent to GitHub, Vercel, and Sentry's
webhook protocols -- CodeSpar cannot unilaterally add replay protection.
A future mitigation could deduplicate using delivery IDs
(`X-GitHub-Delivery` header, Sentry's event ID).

### No secret rotation support

This design does not add secret rotation. Operators must restart the server
to pick up new env var values. Secret rotation is a separate concern.

## Testing

### Test file: `packages/core/src/server/__tests__/webhook-auth.test.ts`

**`verifyWebhookSignature` (4 tests):**

| # | Test | Verifies |
|---|------|----------|
| 1 | Valid SHA256 signature passes | GitHub/Sentry verification works |
| 2 | Valid SHA1 signature passes | Vercel verification works |
| 3 | Invalid signature is rejected | Tampered payloads caught |
| 4 | SHA256 with "sha256=" prefix passes | GitHub's prefixed format handled |

**`enforceWebhookSecret` strict mode on (3 tests):**

| # | Test | Verifies |
|---|------|----------|
| 5 | No secret sends 401 | Strict mode rejects unsigned requests |
| 6 | 401 response includes provider name | Error message is informative |
| 7 | With secret returns true | Verification proceeds normally |

**`enforceWebhookSecret` strict mode off (3 tests):**

| # | Test | Verifies |
|---|------|----------|
| 8 | No secret returns false (allows request) | Non-strict skips verification |
| 9 | Warning logged on every skipped verification | Observable behavior |
| 10 | With secret returns true | Verification proceeds normally |

**HTTP integration (2 tests):**

| # | Test | Verifies |
|---|------|----------|
| 11 | GitHub webhook with valid signature succeeds | End-to-end verification |
| 12 | Vercel signature uses constant-time comparison | Timing attack fix verified |

**Total: 12 tests in 1 file.**

## Consequences

### Positive

- All three handlers use the same enforcement pattern — auditable in one place
- Vercel timing attack vulnerability fixed
- Duplicate `verifyGitHubSignature` eliminated
- Per-request warnings make misconfiguration visible
- Strict mode available for security-conscious deployments
- Non-breaking for existing deployments

### Negative

- Default false means fresh deployments are still permissive until configured
- `WEBHOOK_STRICT_MODE` is global — no per-handler or per-org control
- The `enforceWebhookSecret` return value pattern requires callers to handle
  two meanings of `false` (rejected in strict, allowed in non-strict)

### Mitigations

- Documentation emphasizes strict mode for internet-facing deployments
- Per-handler strict mode can be added later without API changes
- The `enforceWebhookSecret` function is self-contained — the caller pattern
  is a simple `if (...) { verify }` that reads naturally
