---
status: In Progress
problem: |
  The generic deploy webhook endpoint (POST /webhooks/deploy) accepts arbitrary
  JSON from any caller with no authentication. An attacker who discovers the URL
  can inject fake deploy events into the audit trail, trigger agent investigations
  for non-existent incidents, and disrupt operations. The other three webhook
  handlers (GitHub, Vercel, Sentry) already verify HMAC signatures via the shared
  webhook-auth module -- the deploy endpoint is the only one left unprotected.
goals: |
  Bring the deploy webhook to parity with the other webhook handlers: HMAC-SHA256
  signature verification, strict mode enforcement, and clear setup instructions
  so CI/CD pipelines can sign their requests.
---

# PRD: Deploy Webhook Authentication

## Status

In Progress

## Problem Statement

CodeSpar's generic deploy webhook (`POST /webhooks/deploy`) is the only webhook
endpoint with no authentication. GitHub, Vercel, and Sentry handlers all verify
HMAC signatures when a secret is configured and reject unsigned requests when
`WEBHOOK_STRICT_MODE=true`. The deploy endpoint does none of this.

The endpoint accepts a JSON body with `project`, `status`, `environment`,
`commitSha`, and `url` fields. The `orgId` is caller-supplied via query parameter
or header with no validation. Anyone who knows the URL can:

- Inject fake deploy-failure events into an org's audit trail
- Trigger agents to investigate fabricated incidents and create fix PRs
- Flood the system with fake deploy events, disrupting operations
- Poison observability dashboards with false deployment data

This is the highest-severity remaining security gap in the webhook surface. The
shared verification infrastructure (`webhook-auth.ts`) already exists from the S2
work -- the deploy handler just needs to use it.

## Goals

1. Deploy webhook requests are authenticated via HMAC-SHA256 signature verification
2. The verification follows the same pattern as GitHub, Vercel, and Sentry handlers
3. Existing deployments without a secret configured continue to work (non-breaking)
4. CI/CD pipeline operators have clear instructions for configuring signed webhooks

## User Stories

- **As a DevOps engineer configuring CI/CD webhooks**, I want the deploy webhook
  to verify signatures so that only my pipeline can send deploy events to CodeSpar.

- **As a platform operator running CodeSpar with WEBHOOK_STRICT_MODE enabled**, I
  want unsigned deploy requests rejected so that no unauthenticated webhook
  endpoint exists on my instance.

- **As a developer setting up CodeSpar for the first time**, I want the webhook URL
  endpoint to tell me how to configure the signing secret so that I don't have to
  dig through documentation.

- **As an incident responder**, I want confidence that deploy events in the audit
  trail are authentic so that I don't waste time investigating fabricated failures.

## Requirements

### Functional

**R1.** The deploy webhook handler must verify HMAC-SHA256 signatures using the
shared `verifyWebhookSignature()` function from `webhook-auth.ts`.

**R2.** The signature must be sent in the `x-deploy-signature` request header.

**R3.** Secret resolution must follow the existing org-scoped pattern: check org
channel config storage first, fall back to a `DEPLOY_WEBHOOK_SECRET` environment
variable.

**R4.** When no secret is configured and `WEBHOOK_STRICT_MODE=true`, the handler
must reject the request with HTTP 401 using `enforceWebhookSecret()`.

**R5.** When no secret is configured and strict mode is off, the handler must log
a warning and accept the request (preserving backward compatibility).

**R6.** The `GET /api/webhooks/url` response must include instructions for
configuring the deploy webhook secret (both the header convention and the env var).

### Non-functional

**R7.** Signature verification must use constant-time comparison (already provided
by the shared module).

**R8.** The change must not break existing deployments that send unsigned deploy
events when no secret is configured.

## Acceptance Criteria

- [ ] `POST /webhooks/deploy` with a valid HMAC-SHA256 signature returns 200
- [ ] `POST /webhooks/deploy` with an invalid signature returns 401
- [ ] `POST /webhooks/deploy` without a signature, when a secret is configured, returns 401
- [ ] `POST /webhooks/deploy` without a signature, when no secret is configured and strict mode is off, returns 200
- [ ] `POST /webhooks/deploy` without a signature, when no secret is configured and strict mode is on, returns 401
- [ ] Signature verification uses the shared `verifyWebhookSignature()` function (DRY)
- [ ] `GET /api/webhooks/url` includes deploy webhook secret configuration guidance
- [ ] Tests confirm forged deploy events are rejected
- [ ] Tests confirm valid signed deploy events are accepted

## Out of Scope

- **Org-scoped secret management UI**: configuring secrets through a dashboard is
  a separate concern. Secrets are set via storage API or environment variable.
- **IP allowlisting**: network-level restrictions are an infrastructure concern
  outside the application layer.
- **Rate limiting for webhooks**: tracked separately in the roadmap.
- **Vercel/GitHub/Sentry handler changes**: those handlers already have signature
  verification from the S2 work.

## Decisions and Trade-offs

### Header name convention

**Decision:** Use `x-deploy-signature` as the header name.

**Alternatives:** `x-hub-signature-256` (GitHub convention), `x-webhook-signature`
(generic), `authorization` (bearer token).

**Rationale:** The `x-deploy-` prefix makes it clear this is specific to the deploy
webhook. Using `authorization` would conflict with the API auth layer. GitHub and
Vercel have their own header conventions for their handlers -- the deploy endpoint
should have its own.

### Secret resolution order

**Decision:** Org channel config first, then `DEPLOY_WEBHOOK_SECRET` env var.

**Alternatives:** Env var only (simpler), per-project secrets (more granular).

**Rationale:** Matches the pattern used by Vercel and Sentry handlers. Org-scoped
storage allows multi-tenant deployments to have different secrets per org. The env
var fallback keeps single-tenant setups simple.
