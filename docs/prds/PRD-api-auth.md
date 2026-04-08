---
status: Draft
problem: |
  The engine's REST API exposes 60+ endpoints under /api/* with zero
  authentication. Anyone who can reach the network port can create and
  delete agents, set autonomy to L5, list subscriber emails, configure
  integrations, and send messages to agents. CORS is set to allow all
  origins. Even a single-tenant self-hosted deployment needs basic auth
  if the engine listens on a network port.
goals: |
  Protect all /api/* routes with a bearer token, restrict CORS to
  configured origins, and log auth status at startup so operators know
  whether their deployment is exposed.
---

# PRD: Basic API Auth for Engine REST Endpoints

## Status

Draft

## Problem Statement

The engine's webhook server (`packages/core/src/server/webhook-server.ts`)
listens on `0.0.0.0:3000` by default and exposes 60+ REST endpoints with
no authentication. The `x-org-id` header is trusted without verification.
CORS is configured as `{ origin: true }`, allowing any origin.

High-risk endpoints that are completely open:

| Endpoint | Risk |
|----------|------|
| `POST /api/agents` | Create agents (resource exhaustion) |
| `DELETE /api/agents/:id` | Delete any agent (service disruption) |
| `POST /api/agents/:id/action` | Set autonomy to L5 on any agent |
| `POST /api/integrations/configure` | Store arbitrary integration tokens |
| `GET /api/newsletter/subscribers` | List subscriber emails (PII) |
| `POST /api/chat` | Send messages to agents (LLM cost abuse) |
| `GET /api/events` (SSE) | Real-time event stream |

Webhook endpoints (`/webhooks/*`) are not affected -- they have their own
HMAC signature verification (see S2: webhook strict mode).

This matters now because the engine is being prepared for self-hosted
deployment via the `spar` CLI. A self-hosted instance accessible on a
network port -- even on a private network -- should require a token.

## Goals

1. All `/api/*` routes require a valid bearer token when auth is configured
2. CORS origin is restricted to configured domains
3. Operators can see at startup whether their deployment is protected
4. Local development remains frictionless (auth is opt-in)

## User Stories

**As a self-hosted operator**, I want the engine to require a bearer token
on API routes so that only authorized clients (the dashboard, the spar CLI)
can manage agents and access data.

**As a developer running locally**, I want the engine to work without
configuring auth so that I can develop and test without generating tokens.

**As a security auditor**, I want to see at server startup whether API auth
is enabled so that I can verify a deployment's security posture without
reading code.

**As a dashboard developer**, I want CORS restricted to the dashboard origin
so that random websites can't make API calls to the engine from a user's
browser.

## Requirements

### Functional

**R1.** When `ENGINE_API_TOKEN` is set, all `/api/*` routes require
`Authorization: Bearer <token>`. Requests without a valid token receive
HTTP 401 with body `{ "error": "Unauthorized" }`.

**R2.** These paths are excluded from bearer token auth:
- `/webhooks/*` (have their own signature verification)
- `/health` and `/.well-known/agent.json` (public health and discovery)
- `/api/slack/install`, `/api/slack/callback` (OAuth browser redirects)
- `/api/discord/install` (OAuth browser redirect)
- `/api/github/install`, `/api/github/callback` (OAuth browser redirects)

**R3.** When `ENGINE_API_TOKEN` is not set, the engine accepts
unauthenticated requests on all routes (current behavior) and logs a
startup warning: `"ENGINE_API_TOKEN not set — API routes are unauthenticated"`.

**R4.** When `ENGINE_API_TOKEN` is set, the engine logs at startup:
`"API auth enabled — all /api/* routes require bearer token"`.

**R5.** When `CORS_ORIGIN` is set, CORS is restricted to that origin (or
comma-separated list of origins, trimmed of whitespace). When not set,
CORS defaults to `true` (current behavior) with a startup warning.

**R6.** Token comparison uses constant-time comparison to prevent timing
attacks.

### Non-Functional

**R7.** Auth check adds less than 1ms latency per request (it's a string
comparison in an `onRequest` hook).

**R8.** The auth hook runs before all route handlers, including rate
limiting, so unauthenticated requests are rejected early.

## Acceptance Criteria

- [ ] `/api/agents` returns 401 when `ENGINE_API_TOKEN` is set and no
  Authorization header is provided
- [ ] `/api/agents` returns 401 when Authorization header has wrong token
- [ ] `/api/agents` returns 401 with malformed Authorization header
  (e.g., `Bearer` with no token, `Basic` scheme, empty string)
- [ ] `/api/agents` succeeds with `Authorization: Bearer <correct-token>`
- [ ] `/api/events` (SSE) requires bearer token at connection time
- [ ] `/webhooks/github` is not affected by bearer token auth
- [ ] `/health` is not affected by bearer token auth
- [ ] `/api/slack/callback` is not affected by bearer token auth
- [ ] `/api/discord/install` is not affected by bearer token auth
- [ ] When `ENGINE_API_TOKEN` is unset, all routes work without auth
- [ ] Startup log indicates auth is enabled when token is set
- [ ] Startup log warns when token is not set
- [ ] CORS `Access-Control-Allow-Origin` header matches `CORS_ORIGIN` when set
- [ ] CORS allows all origins when `CORS_ORIGIN` is not set (with warning)
- [ ] Token comparison is constant-time (verified by code review:
  uses `timingSafeEqual`)

## Out of Scope

- **Multi-tenant JWT/Clerk verification** -- enterprise concern, not needed
  for single-tenant self-hosted
- **Per-user authorization** -- RBAC already exists at the agent/command
  level via IdentityResolver
- **x-org-id header validation** -- multi-tenant concern, separate from
  API auth
- **Token generation/rotation** -- operators generate their own token
  (e.g., `openssl rand -hex 32`) and set it as an env var
- **CLI token management** -- the `spar` CLI (Phase 3) will read the token
  from its config file; that's a CLI feature, not an engine feature
- **A2A endpoint auth** -- `/a2a/*` routes have their own authentication
  model (agent cards, not bearer tokens)

## Known Limitations

- **Single shared token** -- all clients use the same token. There's no
  per-client or per-role token. This is appropriate for a single-tenant
  deployment but won't scale to multi-tenant without JWT.
- **No token rotation without restart** -- the token is read from env at
  startup. Changing it requires restarting the engine.
- **OAuth callback exclusion is path-based** -- if new OAuth providers are
  added, their callback paths must be added to the exclusion list.

## Decisions and Trade-offs

**Auth is opt-in (not opt-out):** Defaulting to no auth (when
`ENGINE_API_TOKEN` is unset) avoids breaking existing deployments and keeps
local development frictionless. The startup warning nudges operators to
configure auth. This matches the approach taken for webhook strict mode
(S2). The alternative (default to a generated token) was rejected because
it would break all existing API clients and create a chicken-and-egg
problem where the operator needs the token to use the API but the API
generates the token.

**CORS via env var (not auto-detected):** CORS origin is configured via
`CORS_ORIGIN` rather than auto-detected from the dashboard URL. This gives
operators explicit control and avoids coupling the engine to the dashboard
deployment. Multiple origins are supported via comma-separated values.
