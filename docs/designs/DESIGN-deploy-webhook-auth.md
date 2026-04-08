---
status: Proposed
upstream: docs/prds/PRD-deploy-webhook-auth.md
problem: |
  The generic deploy webhook handler (POST /webhooks/deploy) accepts arbitrary
  requests with no HMAC verification. The other three webhook handlers all use
  the shared webhook-auth module for signature verification and strict mode
  enforcement. The deploy handler is the only one left unprotected.
decision: |
  Add the same org-scoped secret resolution and HMAC-SHA256 verification block
  to the deploy handler, following the exact pattern used by the Sentry and
  Vercel handlers. Use x-deploy-signature as the header and DEPLOY_WEBHOOK_SECRET
  as the env var fallback. Update the webhook URL endpoint with setup instructions.
rationale: |
  The infrastructure is already built (webhook-auth.ts from S2). The Sentry and
  Vercel handlers established the pattern: org storage lookup, env var fallback,
  enforceWebhookSecret(), then verifyWebhookSignature(). Reusing the same pattern
  keeps the codebase consistent and the change minimal. SHA-256 is chosen over
  SHA-1 because new endpoints should use the stronger algorithm.
---

# DESIGN: Deploy Webhook Authentication

## Status

Proposed

## Context and Problem Statement

The webhook surface in CodeSpar has four handlers: GitHub, Vercel, Sentry, and
a generic deploy endpoint. The S2 security hardening work (PR #89) introduced
a shared `webhook-auth.ts` module and wired HMAC verification into the first
three handlers. The deploy handler was not included because it had no
pre-existing signature convention to formalize.

The deploy endpoint (`POST /webhooks/deploy`) currently accepts any JSON body
from any caller. The `orgId` is supplied via query parameter or header with no
validation. This allows an attacker to inject fabricated deploy events into the
audit trail, trigger agent investigations for non-existent incidents, and poison
observability dashboards.

The technical problem is straightforward: add the same verification block that
the other three handlers already use. The shared infrastructure exists; the
deploy handler just needs to call it.

## Decision Drivers

- **Consistency**: all four webhook handlers should follow the same verification
  pattern -- org storage lookup, env var fallback, shared verification functions
- **Non-breaking**: existing deployments without a configured secret must continue
  working (backward compatibility with non-strict mode)
- **DRY**: no new verification code -- reuse `verifyWebhookSignature()` and
  `enforceWebhookSecret()` from `webhook-auth.ts`
- **Minimal change surface**: the deploy handler already works correctly for its
  business logic; only the authentication preamble needs to be added

## Considered Options

### Decision 1: Verification Pattern

The deploy handler needs HMAC verification. The question is whether to use the
same inline verification block as the other handlers or to extract a shared
middleware.

#### Chosen: Inline verification block (same as Sentry/Vercel)

Add the same code block to the deploy handler that the Sentry and Vercel handlers
already use:

1. Resolve secret from org channel config storage (key: `"deploy"`)
2. Fall back to `DEPLOY_WEBHOOK_SECRET` env var
3. Call `enforceWebhookSecret()` -- if it returns false and sent a response, stop
4. Check for `x-deploy-signature` header -- reject if missing
5. Serialize request body to string
6. Call `verifyWebhookSignature(rawBody, signature, secret, "sha256")` -- reject
   if false

This is the exact same structure as lines 452-480 of `webhooks.ts` (Sentry handler)
and lines 142-168 (Vercel handler). The only differences are the env var name, the
header name, and the algorithm (SHA-256 for deploy, matching Sentry; SHA-1 for
Vercel which is a legacy choice).

#### Alternatives Considered

**Shared middleware function**: Extract a `verifyWebhook(request, reply, provider, headerName, algorithm)` helper that all four handlers call. Rejected because the current inline pattern is only 15 lines per handler and extracting it would create a function with many parameters that obscures the flow. The repetition is minimal and each handler's verification is visible in its own route. This refactor could happen later if more handlers are added.

**Fastify preHandler hook per route**: Register a hook on the `/webhooks/deploy` route that runs verification before the handler. Rejected because the secret resolution requires `orgId` from the request (query param or header), which means the hook would need the same request parsing the handler does. This splits logic across two places without reducing complexity.

### Decision 2: Signature Algorithm

#### Chosen: SHA-256

New endpoints should use SHA-256. It matches the GitHub and Sentry handlers.
Vercel uses SHA-1 only because their webhook API predates SHA-256 adoption --
we don't need to carry that forward.

#### Alternatives Considered

**SHA-1**: Would match Vercel's convention. Rejected because SHA-1 is deprecated
for cryptographic use. While HMAC-SHA1 isn't vulnerable to the same collision
attacks as bare SHA-1 hashing, using SHA-256 for new endpoints avoids security
review questions and aligns with industry direction.

## Decision Outcome

**Chosen: Inline verification block + SHA-256**

### Summary

The deploy webhook handler gets a verification preamble identical to the Sentry
handler's. On each request, the handler resolves the signing secret by checking
org-scoped channel config storage (under key `"deploy"`) first, then falling
back to the `DEPLOY_WEBHOOK_SECRET` environment variable. If no secret is found,
`enforceWebhookSecret()` either rejects the request (strict mode) or logs a
warning and lets it through (non-strict mode, preserving backward compatibility).

When a secret is configured, the handler reads the `x-deploy-signature` header.
If the header is missing, the request is rejected with 401. If present, the
handler serializes the request body to a string and calls
`verifyWebhookSignature(rawBody, signature, secret, "sha256")`. Invalid
signatures get a 401. Valid signatures proceed to the existing business logic
unchanged.

The `GET /api/webhooks/url` response is updated to include setup instructions
for the deploy webhook secret -- both the header convention and the env var name.

Tests cover: valid signature accepted, invalid signature rejected, missing
signature rejected, no-secret non-strict mode passes through, no-secret strict
mode rejects. These mirror the test patterns from the S2 webhook auth test suite.

### Rationale

The inline block approach keeps all four webhook handlers visually consistent.
A reader opening `webhooks.ts` sees the same verification pattern at the top of
each handler. The shared logic lives in `webhook-auth.ts` (the functions
themselves), while the wiring is handler-specific (which header, which env var,
which algorithm). This separation works well because the wiring is where the
handlers genuinely differ.

## Solution Architecture

### Components Modified

**`packages/core/src/server/routes/webhooks.ts`** -- the deploy handler route.
Add the verification preamble before the existing business logic. No changes to
the business logic itself.

**`packages/core/src/server/routes/webhooks.ts`** -- the `GET /api/webhooks/url`
route. Add `secretEnvVar` and `signatureHeader` fields to the deploy entry in
the response, plus instructions text.

### Data Flow

```
CI/CD pipeline
  |
  | POST /webhooks/deploy
  | Headers: x-deploy-signature: <hmac-sha256-hex>
  | Body: { project, status, message, ... }
  |
  v
Deploy webhook handler
  |
  |-- 1. Resolve secret: org storage ("deploy" channel config) → DEPLOY_WEBHOOK_SECRET env
  |-- 2. enforceWebhookSecret(secret, "Deploy", reply, log)
  |       |-- No secret + strict mode → 401
  |       |-- No secret + non-strict → warn, skip verification
  |       |-- Secret exists → continue
  |-- 3. Read x-deploy-signature header → 401 if missing
  |-- 4. verifyWebhookSignature(body, signature, secret, "sha256") → 401 if invalid
  |
  v
Existing business logic (audit, broadcast, alert handler)
```

### Interface

Callers sign requests by computing HMAC-SHA256 of the raw JSON body using the
shared secret, then sending the hex digest in the `x-deploy-signature` header.

Example (bash):
```bash
SECRET="your-deploy-webhook-secret"
BODY='{"project":"api","status":"success","source":"github-actions"}'
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)
curl -X POST "https://engine.example.com/webhooks/deploy?orgId=default" \
  -H "Content-Type: application/json" \
  -H "x-deploy-signature: $SIG" \
  -d "$BODY"
```

## Implementation Approach

### Phase 1: Add verification to deploy handler (single commit)

1. Add the HMAC verification preamble to the deploy handler in `webhooks.ts`,
   following the Sentry pattern exactly
2. Update the `GET /api/webhooks/url` response with deploy secret instructions
3. Add tests covering all verification paths
4. Update the webhook monitoring docs with deploy secret configuration

This is a single-phase change. The verification block is ~15 lines added before
the existing handler logic, plus test file additions and a docs update.

## Security Considerations

### Authentication

This design directly addresses an authentication gap. After implementation, all
four webhook endpoints verify caller identity via HMAC signatures when secrets
are configured.

### Timing attacks

The shared `verifyWebhookSignature()` function uses `timingSafeEqual()` for
constant-time comparison. The deploy handler inherits this protection.

### Secret storage

Secrets are resolved from org-scoped storage or environment variables -- the same
mechanism used by the other three handlers. No new secret storage pattern is
introduced.

### Backward compatibility

Non-strict mode (the default) accepts unsigned requests with a warning log. This
prevents breaking existing CI/CD integrations that don't sign requests. Operators
who want full enforcement enable `WEBHOOK_STRICT_MODE=true`.

### Body serialization

The handler uses `typeof request.body === "string" ? request.body : JSON.stringify(request.body)`
to get the raw body for signature computation. This matches the Sentry and Vercel
handlers. Fastify parses JSON by default, so `JSON.stringify` reproduces the
original body. For verification to work, the caller must sign the exact JSON
string they send.

## Consequences

### Positive

- **Complete webhook surface coverage**: all four handlers now verify signatures,
  closing the last authentication gap
- **Consistent pattern**: the deploy handler follows the same structure as the
  other handlers, reducing cognitive load for maintainers
- **No new dependencies**: reuses existing `webhook-auth.ts` functions

### Negative

- **CI/CD pipeline reconfiguration**: teams with existing unsigned deploy webhooks
  will need to add signing when they enable strict mode or configure a secret.
  Mitigated by non-strict default -- no immediate breakage.
- **15 lines of repeated verification code**: the inline pattern is duplicated
  across four handlers. Acceptable because each handler's wiring is slightly
  different (header name, env var, algorithm) and the shared logic is already
  extracted into `webhook-auth.ts`.
