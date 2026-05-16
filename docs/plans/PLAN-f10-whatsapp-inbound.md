# PLAN — F10 WhatsApp Inbound (M1–M4)

**Repository:** `codespar/codespar` (this repo — public, MIT).
**Tracking issues:** `codespar/codespar-web#362`, `#363`, `#364`, `#365`, `#366` (issues live in `codespar-web` for product tracking; the code lands here).
**Status:** draft, awaiting coordinator greenlight for `/work-on`.
**Branch model:** single feature branch (`feature/f10-whatsapp-inbound`), one PR at the end, squash-merge.
**Sub-milestone ordering (pre-approved by coordinator):**

| Order | ID | Issue(s) | Theme |
|------|----|----------|-------|
| 1 | M1 | #365, #363 | Foundations — pairing preservation + webhook URL config |
| 2 | M2 | #362 | Bridge & tenant resolution (design-bearing) |
| 3 | M3 | #364 | Security — Evolution API webhook signature verification |
| 4 | M4 | #366 | Resilience — idempotency, attachments, QR rendering |

The sub-decisions for #362 (tenant mapping, session lifecycle, bridge mechanism, legacy coexistence) are pre-approved in `wip/decision_f10_362_subdecisions_report.md` and re-stated in [Design notes](#design-notes) for reviewer convenience.

---

## Design notes

All four verdicts come from the approved decision report. The plan encodes them; it does not re-litigate them.

### Tenant mapping — storage-backed `channel_links` binding, auto-create-on-first-contact

- Lookup contract is `getChannelLink(channelType, channelId)` on `StorageProvider` (already in tree at `packages/core/src/storage/types.ts:182-189`, implemented in `file-storage.ts:425-461` and `pg-storage.ts:630-714`, table at `packages/core/drizzle/0002_projects.sql:155-168`).
- When no binding exists for an inbound `(channelType, channelId)`, the bridge falls back to the org's default project via `getOrCreateDefaultProject(orgId)` (matches the `resolveProjectId` precedent at `webhook-server.ts:294-321`) and **writes the binding eagerly** so the next message hits the fast path.
- `channelId` is constructed by the adapter — for WhatsApp it is `remoteJid` today; the path stays open for `${instance}:${remoteJid}` later without schema churn.
- Zero new schema for the binding itself. The migration in this milestone is for sessions (see [Schema migration](#schema-migration)), not for `channel_links`.

### Session lifecycle — durable, per-(project_id, channelType, channelUserId), TTL deferred

- Sessioned on `channelUserId` (not `remoteJid`) so per-person threads stay distinct inside a WhatsApp group. The adapter already distinguishes them at `adapter.ts:358-359`.
- Lazy reification: lookup by `(projectId, channelType, channelUserId)`; create-if-absent; persist via `StorageProvider`.
- **TTL is intentionally deferred to M4** (`#366` — resilience). M2 ships durable-forever sessions; M4 adds eviction and idle cleanup. M2 plan must NOT add TTL semantics.

### Bridge mechanism — in-process function call into a shared session-core module

- New module: **`packages/core/src/sessions/core.ts`** (chosen path; see W1 below).
- `sessions.ts` HTTP handlers thin out and call the same core functions. One source of truth for tenancy + session reification.
- WhatsApp inbound webhook handler imports the core directly — no loopback HTTP, no token bootstrap.
- The contract test (`packages/core/src/__tests__/contract-oss.test.ts`) keeps exercising the same code via the HTTP wrappers.

### Legacy coexistence — WhatsApp adapter is bespoke; supervisor stays for non-WhatsApp adapters

- WhatsApp adapter is **NOT added to `AgentSupervisor`** in `start.mjs`. The legacy line at `start.mjs:119` (`supervisor.addAdapter(new WhatsAppAdapter())`) is removed in M2.
- `start.mjs` constructs the WhatsApp adapter, registers the bridge handler with `adapter.onMessage(...)`, and calls `await adapter.connect()` directly.
- Slack / Telegram / Discord / CLI continue to flow through `AgentSupervisor.start` → `parseIntent` → `MessageRouter.route` (`supervisor.ts:62-130`). They are not migrated here.
- `webhookServer.setChatHandler(...)` for the `/api/chat` web bridge stays untouched.
- The eventual deletion of `AgentSupervisor` + `MessageRouter` + `parseIntent` is **out of scope** for F10 and lives in a follow-up cleanup PR (CLAUDE.md "Legacy Surfaces").

---

## M1 — Foundations: pairing preservation + webhook URL configurable

**Issues:** #365 (pairing preservation across shutdowns), #363 (webhook URL configurable + compose hostname).
**Theme:** lowest-risk plumbing first, derisks the rest of the branch.

### M1.A — #365 Pairing preservation

#### Acceptance criteria

- After `node server/start.mjs` exits (SIGTERM / SIGINT) and is restarted with `ENABLE_WHATSAPP=true`, the Evolution API instance state is `open` (paired) without re-scanning a QR code, **provided** the Evolution API container has not been deleted.
- `WhatsAppAdapter.disconnect()` no longer issues `DELETE /instance/logout/:instance` (`adapter.ts:131-134` removed); the adapter only closes its own webhook Fastify server.
- A new lifecycle method (or change in `disconnect`) is documented with a one-line code comment explaining "preserve pairing" rationale.
- `docker-compose.whatsapp.yml` keeps the `evolution_data` named volume; `README.md` / `.env.example` get a one-liner: "Pairing is preserved across restarts. Delete the `evolution_data` volume to force re-pairing."

#### Files touched (anticipated)

- `packages/channels/whatsapp/src/adapter.ts` — remove the `/instance/logout/` call from `disconnect()`. Optionally rename `disconnect` to `stopWebhook` to make intent obvious (decision: keep the name to avoid `ChannelAdapter` interface ripples — comment the behaviour instead).
- `packages/channels/whatsapp/src/__tests__/adapter.test.ts` — assert disconnect does not call `/instance/logout/...`.
- `README.md` — one-line note on pairing persistence.
- `.env.example` — no change (env shape unchanged).

#### Tests added

- **Unit (adapter.test.ts):** mock `fetch`; call `disconnect()`; assert no call to `/instance/logout/`. Assert the Fastify webhook server is closed.

#### Dependencies on prior sub-milestones

- None.

#### Risk + rollback

- **Risk:** an operator who relied on logout-on-shutdown to reset pairing must now delete the `evolution_data` volume explicitly. Documented.
- **Rollback:** revert the `disconnect` change. No data migration involved.

### M1.B — #363 Webhook URL configurable + compose hostname

#### Acceptance criteria

- New env var `WHATSAPP_WEBHOOK_URL` overrides the hard-coded `http://host.docker.internal:${port}/webhook` in `adapter.ts:381`.
- When `WHATSAPP_WEBHOOK_URL` is unset, a default is derived from a single host source: `WHATSAPP_WEBHOOK_HOST` (default `host.docker.internal` for local dev; explicit value when running inside Docker Compose).
- `docker-compose.whatsapp.yml` sets `WHATSAPP_WEBHOOK_HOST=core` so the Evolution API container reaches the runtime over the compose network using the service name, not `host.docker.internal`.
- `.env.example` documents `WHATSAPP_WEBHOOK_URL` and `WHATSAPP_WEBHOOK_HOST`.

#### Files touched (anticipated)

- `packages/channels/whatsapp/src/adapter.ts` — replace the hard-coded URL with `process.env.WHATSAPP_WEBHOOK_URL ?? \`http://${process.env.WHATSAPP_WEBHOOK_HOST ?? "host.docker.internal"}:${this.webhookPort}/webhook\``.
- `docker-compose.whatsapp.yml` — add `WHATSAPP_WEBHOOK_HOST: core` under the `core` service environment.
- `.env.example` — document the two new variables.
- `packages/channels/whatsapp/src/__tests__/adapter.test.ts` — table-driven test for the three URL paths (full URL, host override, default).

#### Tests added

- **Unit (adapter.test.ts):** stub `fetch`; verify the `POST /webhook/set/...` body contains the expected `url` for each of the three configurations.

#### Dependencies on prior sub-milestones

- None.

#### Risk + rollback

- **Risk:** misconfigured `WHATSAPP_WEBHOOK_HOST` in a non-Docker deploy points Evolution at an unreachable URL. Mitigated by keeping `host.docker.internal` as the default and logging the resolved URL on startup.
- **Rollback:** revert; the previous hard-coded value still works for the local-dev case (Evolution running in Docker, runtime on the host).

---

## M2 — Bridge & tenant resolution (#362)

**Theme:** the design-bearing piece — reshapes the webhook handler boundary so M3 (security) and M4 (resilience) wrap a single bridge entry, not the legacy adapter.

### Acceptance criteria

1. An inbound Evolution API webhook arriving at `WhatsAppAdapter.startWebhookServer()` (`adapter.ts:282-369`) is processed by a new handler that resolves `(orgId, projectId)` via `channel_links` and reifies a durable session before any AI/agent code runs.
2. The new `packages/core/src/sessions/core.ts` module exports at minimum:
   - `findOrCreateSession({ orgId, projectId, channelType, channelUserId }): Promise<Session>`
   - `sendInboundMessage({ session, message }): Promise<SendResult>`
   - `closeSession(session)`
   - `getSessionById(sessionId)` (used by the HTTP route)
   - `createSessionForHttp({ orgId, projectId, userId, servers })` (used by the HTTP route)
3. `packages/core/src/server/routes/sessions.ts` route handlers shrink to thin Fastify wrappers that call the same core functions. The contract test (`packages/core/src/__tests__/contract-oss.test.ts`) still passes unchanged.
4. **HTTP `/sessions` route tenancy headers land in M2** (the recommended W2 verdict): `registerSessionRoutes` accepts a context with `resolveOrgAndProject(request)` (mirrors the `resolveProjectId` shape at `webhook-server.ts:294-321`). When `x-org-id` / `x-codespar-project` headers are absent, the route falls back to org `"default"` + default project (same self-heal as today). Existing contract-test traffic with no tenancy headers continues to pass.
5. `start.mjs` no longer calls `supervisor.addAdapter(new WhatsAppAdapter())`. Instead it constructs the adapter, calls `adapter.onMessage(handler)` where `handler` is the new bridge entry point, then calls `await adapter.connect()` directly.
6. Every write path stamps `project_id` (CLAUDE.md invariant). No session row exists with NULL `projectId`.
7. The new `messages` (or `session_messages`) persistence is **NOT** in M2 scope — sessions get a `lastActivityAt` timestamp on `setSession`, but message history persistence is out of scope for the milestone. The agent response logic (whatever `generateSmartResponse` returns today via `sessions.ts:202`) is the M2 baseline.

### Files touched (anticipated)

- **NEW** `packages/core/src/sessions/core.ts` — the shared module.
- **NEW** `packages/core/src/sessions/index.ts` — re-exports for `@codespar/core`.
- `packages/core/src/index.ts` — export the new `sessions/*` surface.
- `packages/core/src/server/routes/sessions.ts` — handlers shrink; the in-memory `Map` moves into `core.ts`.
- `packages/core/src/server/routes/types.ts` — `RouteFn` may need to forward a `ctx` (or we pass `ctx` as a `registerSessionRoutes` parameter — preferred, smaller diff).
- `packages/core/src/server/webhook-server.ts` — pass `ctx` (with `resolveOrgAndProject`) into `registerSessionRoutes` at line 688.
- `packages/core/src/storage/types.ts` — add the four new methods on `StorageProvider` (see [Schema migration](#schema-migration)).
- `packages/core/src/storage/file-storage.ts` — implement the four methods over JSON files (sessions dir per org).
- `packages/core/src/storage/pg-storage.ts` — implement the four methods over the new `sessions` table.
- **NEW** `packages/core/drizzle/0003_sessions.sql` — the migration (idempotent, see below).
- `packages/core/drizzle/meta/_journal.json` + `packages/core/drizzle/meta/0003_snapshot.json` — generated by `npm run db:generate` (M2 commits both).
- `packages/channels/whatsapp/src/adapter.ts` — the webhook handler delegates to the new bridge entry point. The adapter exposes `onMessage(handler)` unchanged; `start.mjs` injects the bridge handler.
- `server/start.mjs` — remove `supervisor.addAdapter(new WhatsAppAdapter())`; construct adapter, wire `adapter.onMessage(bridgeHandler)`, call `adapter.connect()` directly. Also: do not import `parseIntent` / `MessageRouter.route` for the WhatsApp path (they keep working for other adapters).

### Tests added

- **Unit (sessions/core.test.ts, NEW):** with a mock `StorageProvider`, assert:
  - `findOrCreateSession` returns an existing session when one matches; otherwise persists and returns a new one with non-null `projectId`.
  - `findOrCreateSession` for a never-seen `(channelType, channelId)` triggers `getOrCreateDefaultProject` and writes a `channel_links` row.
  - The session key is `(projectId, channelType, channelUserId)` — two participants in the same WhatsApp group produce two sessions.
- **Integration (sessions/core.integration.test.ts, NEW):** with a real PG via Testcontainers + `0003_sessions.sql` applied, assert persistence + lookup round-trips.
- **Unit (whatsapp adapter bridge wiring, NEW or extends adapter.test.ts):** assert that when the adapter's webhook receives a valid `messages.upsert`, the registered `onMessage` handler is invoked with the normalized message; assert it is NOT routed through `MessageRouter.route` (that's the supervisor path).
- **Unit (start.mjs wiring, indirect — see W5 below):** add a test in `packages/core/src/__tests__/` that constructs a `WhatsAppAdapter` and `AgentSupervisor`, calls only `adapter.onMessage(bridgeFn)` + `supervisor.start()` (without `addAdapter`), and asserts the adapter's `messageHandler` is `bridgeFn`, not the supervisor's closure. This codifies W5 ("exclusive wiring").
- **Integration (contract-oss):** the existing `contract-oss.test.ts` continues to pass unchanged. Add one assertion via an additional test that POST `/v1/sessions` followed by an inbound WhatsApp message in the same process can independently address sessions without collision.

### Dependencies on prior sub-milestones

- Depends on M1 (pairing preserved across restarts so manual QA can re-test multiple times without re-pairing).
- Does NOT depend on M1.B (#363) functionally, but M1 lands first as the lowest-risk warm-up.

### Risk + rollback

- **Risk:** the HTTP `/sessions` routes' new tenancy-aware signature could break SDK consumers that send no tenancy headers. Mitigated by self-heal default (same as `webhook-server.ts:285-287`).
- **Risk:** wiring race in `start.mjs` (W5) — if both the supervisor path and the bridge path call `adapter.onMessage(...)`, last-write-wins. Mitigated by the explicit unit test above and by NOT adding the WhatsApp adapter to the supervisor.
- **Risk:** the new `sessions` table grows unbounded without TTL. Bounded by `users × projects`; acceptable for M2. M4 adds eviction.
- **Rollback:** revert M2. The migration `0003_sessions.sql` is idempotent and additive — leaving the table in place is harmless. If the revert must also drop the table, a one-line `DROP TABLE IF EXISTS sessions` in a follow-up rollback migration is sufficient (no data loss because the table is new).

---

## M3 — Security: Evolution API webhook signature verification (#364)

**Theme:** wrap the M2-reshaped handler boundary with signature verification at the route entry. Landing AFTER M2 means we verify around the new bridge, not the legacy adapter.

### Acceptance criteria

1. When `EVOLUTION_WEBHOOK_SECRET` is set, every inbound POST to the WhatsApp adapter's `/webhook` route validates an HMAC signature header (Evolution API's `apikey` header today is not cryptographic; the milestone introduces a signed-payload scheme — see "Signature scheme" below).
2. When `EVOLUTION_WEBHOOK_SECRET` is unset, behaviour depends on `WHATSAPP_WEBHOOK_STRICT_MODE`:
   - `WHATSAPP_WEBHOOK_STRICT_MODE=true` → reject every request with `401`. (Production posture.)
   - `WHATSAPP_WEBHOOK_STRICT_MODE` unset or `false` → accept unsigned requests, log a one-time warning per process. (Local dev posture, matches the `ENGINE_API_TOKEN` precedent at `sessions.ts:49-56`.)
3. Signature verification runs **before** any payload parsing or before the bridge handler executes.
4. No alternate auth shortcut exists — there is no "trusted internal" header that bypasses signature verification when the secret is set. (W4 binding.)
5. `.env.example` documents both env vars.
6. `docker-compose.whatsapp.yml` exposes `EVOLUTION_WEBHOOK_SECRET` to both `evolution-api` (the signer) and `core` (the verifier); compose generates a default for dev.

### Signature scheme (proposed; finalised during M3 implementation against Evolution API docs)

- Evolution API supports configuring a webhook secret per instance. The adapter sets it via `POST /webhook/set/:instance` with `webhook_by_events: false` and `webhook.headers` carrying the shared secret on every callback.
- If Evolution API's current release does not sign payloads (only forwards a static `apikey` header), the fallback is **constant-time equality of the configured header against `EVOLUTION_WEBHOOK_SECRET`**. The doc-string in the verifier MUST note that this is bearer-secret style, not HMAC, and that upgrading to HMAC requires Evolution API support.
- M3 implementation MUST verify the current Evolution API version's actual capability (read their docs at the time of implementation) and pick the strongest scheme available. Either way, the route boundary is the chokepoint.

### Files touched (anticipated)

- `packages/channels/whatsapp/src/adapter.ts` — `startWebhookServer()` gains a `preHandler` (Fastify) that runs signature verification before `messages.upsert` parsing. New helper `verifyEvolutionSignature(request, secret)` lives in the same file or a sibling `signature.ts`.
- `packages/channels/whatsapp/src/__tests__/adapter.test.ts` — table-driven tests for: (a) valid signature → 200, (b) invalid signature → 401, (c) missing signature with strict mode on → 401, (d) missing signature with strict mode off → 200 + log assertion.
- `.env.example` — document `EVOLUTION_WEBHOOK_SECRET`, `WHATSAPP_WEBHOOK_STRICT_MODE`.
- `docker-compose.whatsapp.yml` — share the secret between services.
- README / `docs/API.md` — short note on the strict-mode behaviour and where the secret lives.

### Tests added

- **Unit (adapter.test.ts):** four-row table — valid / invalid / missing-strict / missing-relaxed — asserting status + handler invocation count.
- **Unit (signature verifier):** constant-time compare; reject empty / undefined / wrong-length headers.

### Dependencies on prior sub-milestones

- Depends on M2 (the bridge handler boundary is what M3 wraps).
- Does not depend on M1.

### Risk + rollback

- **Risk:** an operator deploying production without setting `EVOLUTION_WEBHOOK_SECRET` AND without setting `WHATSAPP_WEBHOOK_STRICT_MODE=true` ships an unauthenticated webhook. Mitigated by a startup log emitting `WARN [whatsapp] EVOLUTION_WEBHOOK_SECRET not set — webhook accepts unsigned requests. Set WHATSAPP_WEBHOOK_STRICT_MODE=true to reject in production.` and README guidance recommending strict mode.
- **Rollback:** revert the `preHandler`. Pre-M3 traffic flow is restored.

---

## M4 — Resilience: idempotency, attachments, QR rendering (#366)

**Theme:** the inbound edge-case fold-in. Touches the M2-reshaped bridge entry.

### Acceptance criteria

1. **Idempotency.** Evolution API may redeliver `messages.upsert` events. The bridge dedupes by `(channelType, eventId)` (Evolution's `data.key.id`) using an in-memory LRU (default), with optional Redis escalation when `REDIS_URL` is set. Duplicate events return `{ ok: true }` without invoking the agent.
2. **Attachments.** The bridge passes `attachments` through to the session, but does NOT eagerly download remote URLs and does NOT process binary content in M4. The existing extraction in `adapter.ts:307-339` is preserved; the agent receives the text caption (or empty string for caption-less media). Every non-text attachment emits a one-line `WARN [whatsapp] attachment received but not retrieved` log with `{ messageId, type, mimeType }` so operators know an inbound message had media the runtime ignored. (Full attachment handling is a later milestone.)
3. **QR rendering.** When `printQRCode` (`adapter.ts:242-274`) receives a raw QR string (not a data URI), it renders the QR as ASCII in the terminal using `qrcode-terminal` (or similar dep — choice deferred to implementation). Base64 data-URI handling is unchanged.
4. **Session TTL.** Adds idle-cleanup for the durable sessions M2 ships. Default: close sessions with `lastActivityAt > 30 days`; configurable via `WHATSAPP_SESSION_IDLE_TTL_DAYS`. Closure is lazy — checked on next `findOrCreateSession` for the same key, no sweeper process. M4 also adds a `closeStaleSessions(olderThanIso)` helper for an optional cron sweeper, used by tests and not wired in the OSS path.
5. **Reconnect.** If the WhatsApp instance disconnects (Evolution API returns state ≠ `open`), the adapter logs a recovery hint and the next inbound message after reconnect still resolves to the original session (because the session key is project + channel-user, not Evolution instance state).

### Files touched (anticipated)

- `packages/core/src/sessions/core.ts` — `findOrCreateSession` honours TTL (lazy close); new `closeStaleSessions` helper.
- `packages/channels/whatsapp/src/adapter.ts` — `printQRCode` renders ASCII; webhook handler short-circuits on duplicate `(eventId)`.
- **NEW** `packages/channels/whatsapp/src/dedupe.ts` — in-memory LRU + optional Redis client (Redis usage gated on `REDIS_URL`).
- `packages/channels/whatsapp/package.json` — add `qrcode-terminal` (or chosen ASCII-QR dep); add `lru-cache` if not already a transitive dep.
- `packages/channels/whatsapp/src/__tests__/adapter.test.ts` — duplicate-event tests, QR-ASCII tests, attachment-pass-through tests.
- `packages/core/src/sessions/__tests__/core.test.ts` — TTL semantics + `closeStaleSessions`.
- `.env.example` — `WHATSAPP_SESSION_IDLE_TTL_DAYS` (default 30).

### Tests added

- **Unit (dedupe):** insert, insert-duplicate, eviction past capacity.
- **Unit (TTL):** session with `lastActivityAt` older than TTL → next `findOrCreateSession` for the same key produces a NEW session id; older sessions are marked closed.
- **Unit (QR rendering):** stub `qrcode-terminal`; assert called with the raw code string for the non-data-URI path; assert not called for the data-URI path.
- **Unit (attachments — warn-log + drop):** webhook with an image / audio / document message produces a normalized message that reaches the bridge with `attachments[0].type === "image|audio|document"`, agent receives the text caption (or empty string), and the logger records `WARN [whatsapp] attachment received but not retrieved` with the expected metadata. Caption-only text messages produce no warn log.

### Dependencies on prior sub-milestones

- Depends on M2 (TTL targets the session shape M2 introduces; idempotency wraps the bridge entry M2 establishes).
- Does not depend on M1 or M3 functionally; ordering M4 last keeps the diff stack additive.

### Risk + rollback

- **Risk:** TTL too aggressive closes a live commerce conversation prematurely. Mitigated by the 30-day default and env-configurable override; logs every lazy-close at info level so operators can audit.
- **Risk:** Redis-backed dedupe diverges from in-memory dedupe in failure modes. Mitigated by treating Redis unavailability as fallback-to-in-memory with a one-time warning (no hard failure).
- **Rollback:** revert M4. TTL semantics and dedupe vanish; M2's durable-forever sessions and best-effort delivery resume.

---

## Schema migration

### Migration file: `packages/core/migrations/0003_sessions.sql`

**Convention note:** the CLAUDE.md doc says `packages/core/migrations/` but the actual tree uses `packages/core/drizzle/` (see `packages/core/drizzle/0002_projects.sql`). The migration MUST land at **`packages/core/drizzle/0003_sessions.sql`** and be registered in `packages/core/drizzle/meta/_journal.json` (the runner hashes content for drift detection — CLAUDE.md "NEVER skip migrations by editing already-applied SQL").

### Shape

```sql
-- 0003_sessions.sql
-- Durable inbound sessions for the channel → session bridge (F10.M2).
--
-- Scope:
--   * One row per (project_id, channel_type, channel_user_id) durable
--     session reified by the bridge (or by /sessions HTTP route).
--   * id is a UUID; the HTTP contract surfaces it as `id` (matches
--     the SDK SessionBase shape).
--   * status: "active" | "closed" | "error".
--   * lastActivityAt drives M4 lazy-TTL eviction (M2 ships durable,
--     M4 adds the bound).
--
-- Non-destructive + idempotent.

CREATE TABLE IF NOT EXISTS sessions (
  id               text PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       text NOT NULL REFERENCES projects(id)     ON DELETE CASCADE,
  channel_type     text NOT NULL,
  channel_user_id  text NOT NULL,
  instance_id      text,
  status           text NOT NULL DEFAULT 'active',
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  updated_at       timestamp with time zone NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (status IN ('active', 'closed', 'error'))
);
--> statement-breakpoint

-- Fast lookup by (project, channelType, channelUserId) for active sessions.
-- Partial index keeps it small; closed sessions don't compete for the slot.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_lookup
  ON sessions (project_id, channel_type, channel_user_id)
  WHERE status = 'active';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sessions_org_idx     ON sessions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions (updated_at);
--> statement-breakpoint
```

### New `StorageProvider` methods

Added to `packages/core/src/storage/types.ts` (interface) + `file-storage.ts` + `pg-storage.ts`:

| Method | Signature | Behaviour |
|--------|-----------|-----------|
| `getSession` | `(id: string) => Promise<Session \| null>` | Lookup by primary key. Returns `null` when absent. |
| `findSessionByChannelUser` | `(projectId: string, channelType: string, channelUserId: string) => Promise<Session \| null>` | Lookup the active session for the tuple. Returns `null` when absent or only closed sessions exist. |
| `setSession` | `(session: Omit<Session, "id" \| "createdAt"> & Partial<Pick<Session, "id" \| "createdAt">>) => Promise<Session>` | Insert or update. `id` generated when not provided. Bumps `updated_at`. |
| `closeSession` | `(id: string) => Promise<boolean>` | Marks the row `status = 'closed'`. Returns `true` when a row transitioned. |

New TypeScript shape on `storage/types.ts`:

```ts
export interface Session {
  id: string;
  orgId: string;
  projectId: string;
  channelType: string;
  channelUserId: string;
  instanceId?: string;
  status: "active" | "closed" | "error";
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}
```

`FileStorage` stores sessions in `.codespar/orgs/<orgId>/sessions.json` (mirrors the existing per-org file layout). `PgStorage` uses the new `sessions` table.

---

## Security boundary (W4)

### Where inbound auth lives

- **HTTP `/sessions` routes** — Bearer auth (`sessions.ts:43-57`) is the only externally-reachable auth surface. Unchanged in M2; M2 only adds tenancy-aware ctx in front of it.
- **Inbound WhatsApp webhook (Evolution API → adapter)** — Evolution API webhook signature (M3) is the only auth surface. Not a Bearer; not a JWT; not a "trusted internal" header. M3 binds the signature scheme to the route entry; M4 dedupe runs AFTER signature verification.
- **In-process bridge call (adapter → session-core)** — no auth boundary. The caller is the runtime itself. The session-core module is a private module of `@codespar/core`, not an exported routable surface.

### What gets rejected at the route boundary

- M2 (no security change yet): same as today — `messages.upsert` is processed if it parses; everything else returns `{ ok: true }` (`adapter.ts:288`).
- M3 (with `EVOLUTION_WEBHOOK_SECRET` set): requests without a valid signature header return `401`. The bridge handler is never invoked.
- M3 (with `EVOLUTION_WEBHOOK_SECRET` unset and `WHATSAPP_WEBHOOK_STRICT_MODE=true`): every request returns `401`. (Production failsafe — refuse to run unauthenticated.)
- M3 (with `EVOLUTION_WEBHOOK_SECRET` unset and strict mode off): requests are accepted, a one-time WARN is logged on process start. (Local dev failsafe — explicit opt-in to unauthenticated mode.)
- M4 (after signature verification): duplicate `(channelType, eventId)` short-circuits with `{ ok: true }` — the agent is NOT invoked, no auth bypass implication.

### Hard constraints (binding for the milestone)

- No code path bypasses signature verification when `EVOLUTION_WEBHOOK_SECRET` is set. (W4.)
- No "internal" header (e.g. `x-codespar-internal: true`) bypasses signature verification. The route never trusts a header it controls neither end of.
- The session-core module does NOT export an HTTP-callable surface. Any future "agents call sessions" path goes through the same in-process function, not a new HTTP route.

### `WHATSAPP_WEBHOOK_STRICT_MODE` behaviour summary

| Env state | `STRICT_MODE` | Inbound webhook |
|---|---|---|
| `EVOLUTION_WEBHOOK_SECRET` set | any | Signature required; invalid → 401 |
| `EVOLUTION_WEBHOOK_SECRET` unset | `true` | 401 on every request |
| `EVOLUTION_WEBHOOK_SECRET` unset | `false` / unset | Accepted with WARN log on startup |

---

## OSS contract preservation checklist

The F10 theme binding: nothing in this milestone bakes managed-tier assumptions. Reviewer should be able to confirm each row at PR-review time.

| Concern | Status in this plan | Where to verify |
|---|---|---|
| **Secrets are env-first** (no managed vault required) | ✓ — `EVOLUTION_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`, etc. live in env. No code path requires `codespar-enterprise` for secret retrieval. | M3 acceptance criteria; `SecretsHook` is the seam if enterprise wants to override. |
| **Bridge target is configurable** (M1.B) | ✓ — `WHATSAPP_WEBHOOK_URL` / `WHATSAPP_WEBHOOK_HOST` parameterise where Evolution reaches the runtime. No hard-coded managed-tier URL. | M1.B acceptance criteria. |
| **StorageProvider abstraction, not a managed API** | ✓ — sessions persist via `getSession` / `setSession` on `StorageProvider`. `FileStorage` is the single-tenant default; `PgStorage` covers self-hosted Postgres. No managed-tier RPC. | `packages/core/src/storage/types.ts` diff. |
| **Idempotency is in-memory-first; Redis is optional escalation** (M4) | ✓ — default is the in-memory LRU; Redis is gated on `REDIS_URL`. Self-hosters without Redis lose only the cross-process dedupe property. | M4 acceptance criteria + `dedupe.ts`. |
| **Terminal QR + optional generic notification webhook** (M4) | ✓ — QR rendering is ASCII-in-terminal; no managed-tier "scan via dashboard" path is required. The base64 data-URI path stays for the rare case Evolution returns it that way. | M4 acceptance criteria. |
| **`@codespar/core` does not import enterprise packages** | ✓ — the entire milestone stays inside `core` + `channels/whatsapp`. Plugin hooks (`PolicyHook`, `ObservabilityHook`, `SecretsHook`) are the seam for managed-tier additions later. | `packages/core/src/index.ts` + dependency arrow. |
| **Five-point MIT commitment** (CLAUDE.md, VISION §Premise 1a) | ✓ — every file in this plan stays MIT in `codespar/codespar`. No new MCP server, no SDK package licence change, no usage-based gate. | Repo licence headers; new files inherit the repo licence. |

---

## Shared-code-path collision map

The five issues touch overlapping files. The sub-milestone ordering above is chosen so each sub-PR rebuilds on top of the previous diff cleanly. This table is the explicit map for reviewer convenience.

| File / module | M1.A #365 | M1.B #363 | M2 #362 | M3 #364 | M4 #366 | Collision note |
|---|---|---|---|---|---|---|
| `packages/channels/whatsapp/src/adapter.ts` | edits `disconnect()` | edits `setWebhook` URL build | swaps `onMessage` consumer wiring; webhook handler delegates to bridge | adds `preHandler` signature verifier | adds dedupe check + ASCII QR + attachment warn-log | **Hottest file in the milestone.** M1.A + M1.B touch disjoint regions (`disconnect` vs `setWebhook`). M2 reshapes the inbound branch but leaves `disconnect`/`setWebhook` alone. M3 wraps the inbound branch; M4 adds short-circuits and call-sites inside that branch. Order-of-application is what keeps the diffs additive. |
| `packages/channels/whatsapp/src/__tests__/adapter.test.ts` | new disconnect-no-logout test | new URL-build table test | new bridge-wiring assertion | new four-row signature table | new dedupe / QR / attachment warn-log tests | All sub-milestones extend the same test file. Append-only — no shared mocks rewritten. |
| `server/start.mjs` | — | — | removes `supervisor.addAdapter(new WhatsAppAdapter())`; wires `adapter.onMessage(bridgeHandler)` + `await adapter.connect()` bespoke | — | — | M2 owns this file exclusively. No other sub-milestone needs to touch it (env-driven config is read inside adapter / dedupe modules, not bootstrap). |
| `docker-compose.whatsapp.yml` | — | sets `WHATSAPP_WEBHOOK_HOST=core` on `core` service | — | shares `EVOLUTION_WEBHOOK_SECRET` between `evolution-api` and `core` | — | M1.B + M3 each add one env-block entry. Disjoint keys; safe to interleave. |
| `.env.example` | — | documents `WHATSAPP_WEBHOOK_URL` + `WHATSAPP_WEBHOOK_HOST` | — | documents `EVOLUTION_WEBHOOK_SECRET` + `WHATSAPP_WEBHOOK_STRICT_MODE` | documents `WHATSAPP_SESSION_IDLE_TTL_DAYS` | Append-only across sub-milestones. |
| `packages/core/src/server/routes/sessions.ts` | — | — | handlers shrink; logic moves to `sessions/core.ts`; route gains tenancy-aware ctx | — | — | M2 owns this file exclusively. |
| **NEW** `packages/core/src/sessions/core.ts` | — | — | created | — | TTL semantics + `closeStaleSessions` helper added on top | M2 creates; M4 extends. M3 does NOT touch (signature check lives at the channel webhook route boundary, before the core is called). |
| `packages/core/src/storage/types.ts` | — | — | adds `getSession` / `findSessionByChannelUser` / `setSession` / `closeSession` to `StorageProvider` interface | — | — | M2 only. |
| `packages/core/src/storage/file-storage.ts` + `pg-storage.ts` | — | — | implement the four new methods | — | — | M2 only. |
| **NEW** `packages/core/drizzle/0003_sessions.sql` + `meta/_journal.json` + `meta/0003_snapshot.json` | — | — | created | — | — | M2 only. Idempotent + additive. |
| `packages/core/src/server/webhook-server.ts` | — | — | passes `ctx` (with `resolveOrgAndProject`) into `registerSessionRoutes` at line 688 | — | — | M2 only. |
| **NEW** `packages/channels/whatsapp/src/dedupe.ts` | — | — | — | — | created (in-memory LRU + optional Redis client) | M4 only. |
| `packages/channels/whatsapp/package.json` | — | — | — | — | adds `qrcode-terminal` (and `lru-cache` if not transitive) | M4 only. |
| `README.md` | one-line pairing note | — | — | strict-mode note | — | Two sub-milestones, two disjoint paragraphs. |

**The legacy supervisor stack** (`packages/agents/supervisor/src/supervisor.ts`, `packages/core/src/router/message-router.ts`, `packages/core/src/router/intent.ts`) is **deliberately untouched** by all five sub-milestones. The only edit near it is `start.mjs` removing the WhatsApp adapter from `supervisor.addAdapter(...)` — supervisor itself, `MessageRouter.route`, and `parseIntent` keep running for Slack / Telegram / Discord / CLI / `/api/chat`. Their existing tests stay green untouched. The eventual removal is a follow-up cleanup PR (CLAUDE.md "Legacy Surfaces" — explicit out-of-scope here).

---

## Branch / PR mechanics

- Branch: `feature/f10-whatsapp-inbound` off `main` at the time of `/work-on`.
- Commits land in order: M1 commits → M2 commits → M3 commits → M4 commits. No squashing pre-PR; PR squash-merges at the end.
- After each sub-milestone, run `npm run build && npm run typecheck && npx vitest run` and commit only when green.
- Final PR description references this plan file and lists which issues each sub-milestone closes.

---

## Open questions / W-list status

| W | Status in this plan | Detail |
|---|---|---|
| W1 (session-core location) | **Resolved:** `packages/core/src/sessions/core.ts`. | Sits adjacent to `src/server/routes/sessions.ts` via the index re-export. |
| W2 (HTTP route tenancy in M2 or M3) | **Resolved:** lands in M2. | M2 makes the core tenancy-aware and gives the HTTP route the same ctx so both call sites share the model from day one. |
| W3 (storage interface + migration) | **In plan** — see [Schema migration](#schema-migration). | Migration `0003_sessions.sql`, four new methods. |
| W4 (inbound security bypass) | **In plan** — see [Security boundary](#security-boundary-w4). | M3 binds signature at the route entry; no header-trust escape hatches. |
| W5 (exclusive wiring) | **In plan** — see M2 acceptance + tests. | `start.mjs` wires bridge handler before `adapter.connect()`; WhatsApp adapter is NOT added to `AgentSupervisor`. Unit test asserts the final handler identity. |

---

## What this PR is NOT

- Not the cleanup of `AgentSupervisor` / `MessageRouter` / `parseIntent`. That is a separate follow-up after F10 ships and the new path proves out.
- Not the ADR for the sub-decisions. Verdicts are captured in [Design notes](#design-notes); coordinator decides separately whether a stand-alone ADR is warranted.
- Not new GitHub issues. The five existing issues (#362, #363, #364, #365, #366) ARE the milestone.
- Not the introduction of message history persistence. Sessions persist; per-turn message logs are out of scope and live in a later milestone.
- Not multi-instance WhatsApp support. `channelId = remoteJid` for the OSS default; the path stays open for `${instance}:${remoteJid}` later without schema changes.
