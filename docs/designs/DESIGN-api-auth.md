---
status: Proposed
upstream: docs/prds/PRD-api-auth.md
problem: |
  The engine's 60+ REST API endpoints have zero authentication. Anyone who
  can reach the network port can manage agents, access PII, and abuse LLM
  costs. CORS allows all origins.
decision: |
  Add a Fastify onRequest hook that validates Authorization: Bearer <token>
  on /api/* routes when ENGINE_API_TOKEN is set. Exclude webhooks, health,
  and OAuth callbacks. Restrict CORS via CORS_ORIGIN env var. Both default
  to permissive (non-breaking).
rationale: |
  A single onRequest hook is the simplest enforcement point — it runs before
  all route handlers, can't be bypassed by new routes, and follows the same
  pattern as the existing rate limiting hook. Path-based exclusion matches
  the rate limiter's pattern. Opt-in auth avoids breaking existing setups.
---

# DESIGN: Basic API Auth for Engine REST Endpoints

## Status

Proposed

## Context and Problem Statement

The engine's webhook server (`packages/core/src/server/webhook-server.ts`)
registers hooks and routes in this order:

```
constructor()
  1. Fastify instance + CORS plugin (origin: true)
  2. registerRequestTracking()   — onRequest: stash start time
  3. registerVersionHeader()     — onSend: add X-API-Version
  4. registerRateLimiting()      — onRequest: 30/min webhooks, 100/min API
  5. registerRoutes()            — all route handlers
```

Fastify `onRequest` hooks run in registration order. The auth hook must
be registered between step 2 (tracking) and step 4 (rate limiting) so that
unauthenticated requests are rejected before consuming rate limit budget.

The route helper registers every path twice (`/path` and `/v1/path`), so
the auth hook must handle both prefixes.

## Decision Drivers

- **Non-breaking** — must not affect existing deployments or local dev
- **Bypass-proof** — new routes added later must automatically require auth
- **Simple** — one hook, one env var, one token
- **Consistent** — follow the same patterns as rate limiting and webhook auth

## Considered Options

### Decision 1: Auth enforcement mechanism

#### Chosen: Fastify onRequest hook with path exclusion

Register a `registerApiAuth()` method on the WebhookServer class, called
between `registerRequestTracking()` and `registerRateLimiting()` in the
constructor. The hook checks `request.url` against an exclusion list and
validates the bearer token on all other `/api/*` paths.

This mirrors the rate limiting hook's pattern exactly — same registration
point, same URL prefix matching, same early return for excluded paths.
New routes automatically require auth without any per-route configuration.

#### Alternatives considered

**Per-route middleware decorator:**
Rejected because every new route would need to explicitly opt in to auth.
A developer adding a new `/api/foo` endpoint could forget the decorator
and ship an unprotected route. The onRequest hook is deny-by-default for
`/api/*`.

**Fastify plugin with route-level auth:**
Rejected as over-engineered for a single bearer token. Plugins add
registration complexity and make the auth flow harder to trace.

### Decision 2: CORS restriction approach

#### Chosen: CORS_ORIGIN env var passed to @fastify/cors

Read `CORS_ORIGIN` at server construction and pass it to the cors plugin.
When set to a single origin, pass as a string. When comma-separated, parse
into an array. When unset, keep `origin: true` (current behavior).

This is a one-line change in the constructor. The `@fastify/cors` plugin
already supports string, array, and boolean origins.

### Decision 3: Testing approach

#### Chosen: Fastify inject() tests (10 tests)

Test the auth hook via Fastify's `inject()` method against the real
WebhookServer instance. No mocking of the hook — test the actual HTTP
behavior.

## Decision Outcome

The three decisions are independent:
1. Auth hook registered in the constructor, path-based exclusion
2. CORS origin from env var, passed to plugin
3. 10 integration tests via inject()

## Solution Architecture

### New method: `registerApiAuth()`

```typescript
private registerApiAuth(): void {
  const token = process.env.ENGINE_API_TOKEN;
  if (!token) {
    log.warn("ENGINE_API_TOKEN not set — API routes are unauthenticated");
    return; // no hook registered, all requests pass through
  }

  log.info("API auth enabled — all /api/* routes require bearer token");
  // Hash the token so timingSafeEqual always compares fixed-length buffers,
  // preventing a length oracle (leaking token length via timing).
  const tokenHash = createHash("sha256").update(token).digest();

  const EXCLUDED_PREFIXES = ["/webhooks/", "/v1/webhooks/"];
  const EXCLUDED_PATHS = new Set([
    "/health", "/v1/health",
    "/.well-known/agent.json",
    "/api/slack/install", "/v1/api/slack/install",
    "/api/slack/callback", "/v1/api/slack/callback",
    "/api/discord/install", "/v1/api/discord/install",
    "/api/github/install", "/v1/api/github/install",
    "/api/github/callback", "/v1/api/github/callback",
  ]);

  this.app.addHook("onRequest", async (request, reply) => {
    const url = request.url.split("?")[0]; // strip query params

    // Skip non-API routes, excluded paths, and webhook routes
    if (!url.startsWith("/api/") && !url.startsWith("/v1/api/")) return;
    if (EXCLUDED_PATHS.has(url)) return;
    for (const prefix of EXCLUDED_PREFIXES) {
      if (url.startsWith(prefix)) return;
    }

    // Validate bearer token
    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Unauthorized" });
    }

    const providedHash = createHash("sha256").update(auth.slice(7)).digest();
    if (!timingSafeEqual(providedHash, tokenHash)) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });
}
```

### Modified constructor

```typescript
constructor(config?: WebhookServerConfig) {
  this.port = config?.port ?? parseInt(process.env["PORT"] ?? "3000", 10);
  this.host = config?.host ?? "0.0.0.0";
  this.startedAt = new Date();

  this.app = Fastify({ logger: false });

  // CORS: restrict to CORS_ORIGIN when set, allow all when unset
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    const origins = corsOrigin.split(",").map(o => o.trim()).filter(Boolean);
    this.app.register(cors, { origin: origins.length === 1 ? origins[0] : origins });
  } else {
    log.warn("CORS_ORIGIN not set — allowing all origins");
    this.app.register(cors, { origin: true });
  }

  registerAllAgentMetadata();
  this.registerRequestTracking();
  this.registerApiAuth();        // NEW — before rate limiting
  this.registerVersionHeader();
  this.registerRateLimiting();
  this.registerRoutes();
}
```

### Data flow

```
Request arrives
  |
  v
onRequest: request tracking (metrics)
  |
  v
onRequest: API auth [NEW]
  |
  +-- not /api/* or /v1/api/*? --> skip (webhooks, health, agent card)
  +-- excluded path? --> skip (OAuth callbacks)
  +-- no/bad token? --> 401
  +-- valid token --> continue
  |
  v
onSend: version header
  |
  v
onRequest: rate limiting
  |
  v
Route handler
```

## Implementation Approach

### Phase 1: Auth hook + CORS

Add `registerApiAuth()` to WebhookServer. Update the constructor to read
`CORS_ORIGIN` and register the auth hook before rate limiting. Import
`timingSafeEqual` from `node:crypto` (already used in webhook-auth.ts).

Deliverables:
- `packages/core/src/server/webhook-server.ts` — new method + constructor changes

### Phase 2: Tests

Write integration tests using Fastify inject().

Deliverables:
- `packages/core/src/server/__tests__/api-auth.test.ts`

### Phase 3: Documentation

Update configuration docs to cover `ENGINE_API_TOKEN` and `CORS_ORIGIN`.

Deliverables:
- `apps/docs/content/docs/configuration/security.mdx` or equivalent

## Testing

### Test file: `packages/core/src/server/__tests__/api-auth.test.ts`

Tests create a WebhookServer instance with `ENGINE_API_TOKEN` set in the
environment, then use Fastify inject() to verify behavior.

| # | Test | Verifies |
|---|------|----------|
| 1 | /api/agents returns 401 without Authorization header | Auth required |
| 2 | /api/agents returns 401 with wrong token | Invalid token rejected |
| 3 | /api/agents returns 401 with malformed header (no Bearer prefix) | Malformed rejected |
| 4 | /api/agents succeeds with correct Bearer token | Valid token accepted |
| 5 | /webhooks/github not affected by auth | Webhook exclusion |
| 6 | /health not affected by auth | Health exclusion |
| 7 | /api/slack/callback not affected by auth | OAuth exclusion |
| 8 | /api/events (SSE) requires token | SSE protected |
| 9 | Auth disabled when ENGINE_API_TOKEN unset | Opt-in behavior |
| 10 | Token comparison is constant-time (Buffer length check) | Timing safety |

**Total: 10 tests in 1 file.**

## Security Considerations

### Token in environment variable

The token lives in an env var, which is standard for secrets in container
deployments. It's not logged (Pino's secret redaction covers
`authorization` headers). The startup log confirms auth is enabled without
revealing the token value.

### Constant-time comparison without length oracle

Both the stored token and the provided token are SHA-256 hashed before
comparison. This ensures `timingSafeEqual` always compares 32-byte
buffers regardless of input length, preventing a length oracle that could
leak the token length via timing.

### Path exclusion is deny-by-default

The hook checks whether the URL starts with `/api/` or `/v1/api/`. Any
new API route automatically requires auth. Only explicitly listed paths
are excluded. This is safer than an allow-list approach where new routes
could be forgotten.

### SSE connections

The `/api/events` SSE endpoint is a long-lived connection. The token is
validated at connection time (the onRequest hook runs before the handler).
No re-validation during the connection lifetime — if the token is rotated,
existing SSE connections continue until they disconnect. Operators should
be aware of this when rotating tokens.

### CORS origin validation

`CORS_ORIGIN` values are split on commas and trimmed of whitespace, but
not validated as well-formed URLs. A typo (e.g., `htps://example.com`)
passes through to `@fastify/cors` silently. Origins must not contain
commas.

## Consequences

### Positive

- All `/api/*` routes protected when auth is configured
- Deny-by-default — new routes are automatically protected
- CORS restricted when configured
- Non-breaking — existing deployments unaffected
- Follows established patterns (same hook style as rate limiter)

### Negative

- Single shared token — no per-client or per-role differentiation
- Token rotation requires server restart
- Path-based exclusion list must be maintained as OAuth providers are added

### Mitigations

- Per-client tokens are an enterprise feature (JWT/Clerk)
- Token rotation can be improved later with a SIGHUP handler
- OAuth exclusion paths are stable and rarely change
