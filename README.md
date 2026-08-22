<p align="center">
  <strong>code&lt;spar&gt;</strong>
</p>

<p align="center">
  <em>MIT-licensed runtime for commerce AI agents.</em>
</p>

<p align="center">
  <a href="https://github.com/codespar/codespar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://pypi.org/project/codespar/"><img src="https://img.shields.io/pypi/v/codespar.svg?label=pip%20install%20codespar" alt="PyPI" /></a>
</p>

---

## What this is

The open-source, self-hostable agent runtime + channel adapters behind
the [CodeSpar](https://codespar.dev) platform. Channel-agnostic: agents
run just as well against WhatsApp, Slack, Discord, Telegram, the web,
or plain HTTP as they do against a terminal. A managed tier (private,
commercial) registers commerce-governance capabilities against the
plugin hooks exposed here.

CodeSpar's thesis: it is the agentic operating system for **money
movement in LATAM**. Commerce is the wedge, money movement is the
platform. The MIT layer stays MIT forever - no rate limits, no feature
gates, no telemetry walls. Revenue lives above it in managed hosting +
commerce governance, not on `npm install`.

## Use it for

- **Agents that transact on LATAM rails** — Pix, PSPs, NF-e, shipping,
  WhatsApp Business — without rebuilding the plumbing every team.
- **Any commerce/ops agent on any channel** — pair the runtime with
  one of the MCP catalogs and you ship in an afternoon.
- **Self-hosting** — no phone-home, fully operable without codespar
  infrastructure. Docker Compose included. Set `WEBHOOK_BASE_URL` to your
  runtime's public URL (and `DASHBOARD_URL` if you run your own dashboard):
  the runtime writes GitHub webhooks and OAuth callbacks only to what you
  configure there, never to a host guessed from a request header. Without
  `WEBHOOK_BASE_URL`, creating a project still works and the webhook is
  skipped (`webhookSkipped: "base_url_not_configured"` in the response);
  `/api/github/install`, which has nothing to redirect to, answers `412`.
  Both variables are in `.env.example` and in the compose `environment:`
  block. `.env` is read by Docker Compose, not by the runtime process, so
  pass the variables through compose or your process manager. The A2A card at
  `/.well-known/agent.json` announces `AGENT_CARD_NAME`, not our name.

## Quick start

Install the SDK (pip or npm) and create a session:

```bash
pip install codespar
```

```python
from codespar import CodeSpar

cs = CodeSpar(api_key="csk_live_...")
session = cs.create("user_123", preset="brazilian")
print(session.send("Charge R$500 via Pix").message)
```

Or self-host the runtime:

```bash
git clone https://github.com/codespar/codespar
cd codespar
docker compose up          # Postgres + Redis + core
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up   # + WhatsApp
```

### Calling the API

`/api/*`, `/sessions/*` and `/a2a/*` require a bearer token. There is no
unauthenticated mode: `/sessions` accepts a command and the runtime spawns
it, so an unverified caller on that path is a remote shell.

Nothing is asked of you to make that work. On first boot the runtime
generates a token, stores it in its state directory with mode `0600`, and
reuses it on every restart, so an unattended install keeps running. Read it
back and use it:

```bash
export TOKEN=$(docker compose exec -T core cat /app/.codespar/api-token)
# running outside a container:
export TOKEN=$(cat .codespar/api-token)

curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents
```

To manage the credential yourself instead (rotation, a secret manager,
several replicas sharing one token), set `ENGINE_API_TOKEN`. When it is set
nothing is generated and nothing is written to disk.

`/health` stays open so container healthchecks and load balancers work, as do
the OAuth install and callback routes, which a browser reaches mid-redirect
with no way to present a token. Provider webhooks (`/webhooks/*`) authenticate
by signature instead, which is the only scheme GitHub, Vercel and Sentry speak.

A `401` says which mistake was made and how to fix it, so a client can recover
without a human reading the server log:

```json
{
  "error": "Unauthorized",
  "code": "api_token_required",
  "remediation": "Send an Authorization header of the form 'Bearer <token>'. ..."
}
```

`api_token_required` means no usable header was sent; `api_token_invalid`
means the token does not match, and is the one to watch for after the state
directory has been reset, since the credential is regenerated then.

Two consequences worth knowing before you upgrade. `GET /api/events` is
Server-Sent Events, and a browser `EventSource` cannot send headers, so a
browser client needs a `fetch`-based reader or a proxy that adds the header —
passing the token in the query string is not supported on purpose, because
URLs end up in logs. And `POST /api/newsletter/subscribe` is behind the
credential like everything else under `/api`, so a public signup form has to
post to your own backend rather than straight at the runtime.

Docs: [docs.codespar.dev](https://docs.codespar.dev). This repo does not ship a docs site of its own.

## MCP bridge

`POST /sessions/:id/execute` routes tool calls whose name contains a `/`
(e.g. `asaas/charge`) to a spawned stdio MCP server process, instead of
returning `Tool not registered`. The spawn command for a given prefix
comes from one of three configuration surfaces, checked in this order:

1. **Inline session specs (preferred for SDK callers).** Pass
   `server_specs` in the `POST /sessions` body — a map from server id
   to `{ command, env?, transport: "stdio" }`. The session is self-
   contained; no file on disk, no env var. The session ids get added to
   `servers` automatically so the prefix validation passes.

   ```bash
   curl -X POST http://localhost:3000/sessions \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "user_id": "u",
       "server_specs": {
         "asaas": { "command": ["npx", "@codespar/mcp-asaas"], "transport": "stdio" }
       }
     }'
   ```

2. **`CODESPAR_MCP_SERVERS_PATH` env var.** Point the runtime at a
   config file anywhere on disk; useful when the process runs under
   systemd or in a container with a fixed `WorkingDirectory`.

   ```bash
   CODESPAR_MCP_SERVERS_PATH=/etc/codespar/mcp-servers.json npm run start:server
   ```

3. **`mcp-servers.json` in the runtime's working directory.** Fallback
   for ad-hoc local runs. Copy [`examples/mcp-servers.json`](./examples/mcp-servers.json)
   to your project root and edit; the file is not tracked by this repo,
   so updates are yours to manage.

If none of the three are set, the registry is empty and every
`prefix/tool` call returns `Tool not registered`. The runtime does not
crash and built-in tools (`codespar_list_tools`) keep working.

### Integration check

The canonical end-to-end check is `scripts/validate-bridge.sh`. It
creates a session, calls one tool, deletes the session, and fails if the
response contains `Tool not registered`. It assumes at least one
`@codespar/mcp-*` package is installable via `npx` on the runtime host.

```bash
# Option A — env-var override (no copy)
CODESPAR_MCP_SERVERS_PATH=examples/mcp-servers.json npm run start:server &
bash scripts/validate-bridge.sh

# Option B — copy the template to cwd
cp examples/mcp-servers.json ./mcp-servers.json
npm run start:server &
bash scripts/validate-bridge.sh
```

The bridge source itself has no env-var branching — every code path
serves OSS demos, CI integration, and production identically.

## Session mocks (test mode)

`CODESPAR_TEST_MODE_ENABLED` is the deployment's mode switch. When
the flag is on (`true` or `1`, case-insensitive), the runtime is in
**test mode**: every external tool dispatch requires a matching mock
entry, and the bridge is never reached for an external call without
one. When the flag is off — the default — the mocks feature is
inactive end-to-end and every dispatch goes to the real bridge as if
the feature weren't shipped. There is no in-between state: a runtime
is either in test mode or it is not.

Concretely, with the flag off:

- `POST /sessions` rejects any request that carries `mocks` with
  HTTP 501 and a `mocks_not_permitted` envelope.
- The dispatch path refuses to honour mocks even if a session
  already holds them — every external call falls through to the
  bridge.

With the flag on:

- `POST /sessions` accepts the optional `mocks` field. The field
  declares what's available to the session.
- Every external tool dispatch consults the mocks engine. A matching
  entry returns its scripted output; no match returns HTTP 422
  `tool_not_mocked` — regardless of whether the session declared
  `mocks` at all. A session created without `mocks` (or with an
  empty `{}` map) cannot dispatch external tools in test mode; it
  can only dispatch built-ins (see below).

Enable the feature for a self-hosted runtime by exporting the env
var before starting the server:

```bash
export CODESPAR_TEST_MODE_ENABLED=true
npm run start:server
```

The wire shape, error envelopes, and counter semantics match the
managed runtime byte-for-byte, so the same agent code runs unchanged
in either place.

**Storage shape.** OSS holds mocks and the per-tool consume counter
in process-local memory. A restart loses every session and every
declared mock — fine for CI (one process per job) and local dev (one
process per developer), and the only documented use cases. There is
no database column for `sessions.mocks` and no per-session counter
table; the OSS schema is the same with or without the feature
enabled. For test-mode state that needs to outlive a single process
or be shared across replicas, use the managed runtime.

### Declaring mocks

Two value shapes, keyed by canonical `server/tool` form:

```bash
curl -X POST http://localhost:3000/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "user_id": "u",
    "servers": ["asaas"],
    "mocks": {
      "asaas/create_payment": { "id": "pay_test_42", "status": "PENDING" },
      "asaas/get_payment": [
        { "id": "pay_test_42", "status": "PENDING" },
        { "id": "pay_test_42", "status": "CONFIRMED" }
      ]
    }
  }'
```

- A non-null **object** is a single-shot mock — every matching call
  returns the same payload.
- An **array of objects** is a stateful sequence — call N returns
  entry N, the counter advances on success only, and the (N+1)th call
  past the array length returns `mocks_exhausted`.

### Built-in tools bypass the gate (allow-list)

In test mode, **every external tool dispatch requires a matching
mock**. Runtime built-ins — metadata-only operations with no external
side effects — bypass this gate because gating them would break the
agent's ability to introspect the runtime in test mode without buying
nothing for the safety principle. The current built-in allow-list is:

- `codespar_list_tools` — list the registered agent skills

If a future built-in performs an external dispatch (i.e. could leak
to a real provider), it must NOT join this allow-list. It must be
declared in `mocks` like any other external dispatch. The allow-list
is the spec, not an implementation accident.

### Error envelopes

| Code | When | HTTP status |
|------|------|-------------|
| `mocks_not_permitted` | `mocks` sent on `POST /sessions` while `CODESPAR_TEST_MODE_ENABLED` is not truthy. Gate runs before size and shape. | 501 |
| `mocks_invalid` | `mocks` field fails shape validation at create. Carries an RFC 6901 `field` pointer. | 400 |
| `mocks_payload_too_large` | Stringified `mocks` exceeds 64 KiB. | 413 |
| `tool_not_mocked` | Flag on, external tool dispatched, no matching mock entry. Returned for missing entries, missing sessions-`mocks` field entirely, and unknown server prefixes — every external dispatch in test mode must match a mock. | 422 |
| `mocks_exhausted` | Stateful array counter already at the cap. | 422 |

See [`docs/test-mode.md`](./docs/test-mode.md) for the longer write-up
(storage model, dispatcher seam, chat-loop integration, how to write
tests). A runnable end-to-end script lives at
[`examples/session-mocks.sh`](./examples/session-mocks.sh).

## What's in the box

- **Runtime**: agent supervisor, message router, task queue, vector
  memory, audit log with hash-chain integrity.
- **Channel adapters**: WhatsApp (Evolution API), Slack (Bolt), Telegram
  (grammy), Discord (discord.js), CLI REPL.
- **Identity + RBAC**: cross-channel user mapping, 6 roles, ABAC
  policies, approval quorum.
- **Storage**: PostgreSQL (Drizzle) + Redis, with a file-storage fallback
  for single-tenant installs.
- **Plugin hooks**: `PolicyHook`, `ObservabilityHook`, `SecretsHook`,
  `IntegrationHook`, and `MetaToolHook` — the managed tier's governance
  layer and meta-tool implementations plug in here; public core never
  imports managed-tier packages. `MetaToolHook` is the meta-tool
  registration seam: register a named higher-level tool with
  `pluginRegistry.registerMetaTool(...)` and the runtime dispatches it by
  name through the standard execute path. A self-hoster, a community
  plugin, or the managed runtime can each register their own. See
  [`examples/meta-tool-adapter`](examples/meta-tool-adapter) — a complete,
  end-to-end-tested custom meta-tool. It's the canonical pattern to copy
  when registering your own: its integration test mounts the real
  `registerSessionRoutes` in a Fastify app and dispatches the example
  through the real `POST /sessions/:id/execute` route, so copying it gives
  you a registrant proven against the actual seam, not a sketch.
- **Tenancy**: Organization → Project, mirroring the managed-tier
  contract. `x-codespar-project` header on every `/v1` route; optional
  on inbound channel messages via `channel_links` bindings. See
  [`docs/projects-roadmap.md`](docs/projects-roadmap.md) for port status.

## Channel support

| Channel | Status |
|---------|--------|
| WhatsApp (Evolution API v2.3.7) | ✅ Working — primary channel for Brazilian commerce |
| HTTP / Web chat (streaming SSE) | ✅ Working |
| CLI REPL (stdin/stdout) | ✅ Working |
| Slack / Telegram / Discord | Legacy adapters present — see Legacy Surfaces below |
| Email / Voice / SMS | Planned |

Channels are composable capabilities — no single channel is a
prerequisite. An agent that speaks only HTTP is a first-class citizen.
WhatsApp is the deepest integration because Brazilian commerce
concentrates there (~78% of businesses, 6× web-e-commerce conversion).

WhatsApp pairing is preserved across restarts. Delete the
`evolution_data` Docker volume to force a re-pair. The Evolution API
callback URL is set via `WHATSAPP_WEBHOOK_URL` (full URL override) or
`WHATSAPP_WEBHOOK_HOST` + `WHATSAPP_WEBHOOK_PORT` (default
`host.docker.internal:3001` for local dev; in compose set HOST to the
runtime service name). When `EVOLUTION_WEBHOOK_SECRET` is set the
inbound webhook validates it on every request; set
`WHATSAPP_WEBHOOK_STRICT_MODE=true` in production so unsigned requests
are rejected even when the secret is unset.

## What's not in OSS yet

The OSS runtime is a complete framework for self-hosting an agent that
transacts on LATAM rails — the runtime, channel adapters, SDK, plugin
hooks (including the `MetaToolHook` registration seam), and an example
registrant. Higher-level meta-tools are dispatched through the seam: a
self-hoster registers their own implementation, pulls in a community
plugin, or points at the managed runtime. The following surfaces are
not yet in OSS and are on the roadmap:

- **MCP server catalog API** (`/v1/servers`). In OSS today, providers
  are registered manually via SDK config.
- **Connections vault** (`/v1/connections`, `/v1/auth-configs`). In OSS
  today, credentials live in environment variables.
- **Programmable wallet + policy engine.**
- **Commerce-specific observability + fiscal-compliance
  certifications.** The OSS runtime exposes the plugin hooks these
  register against (`PolicyHook`, `ObservabilityHook`, `SecretsHook`).

The five-point MIT commitment binds every shipped feature to land in
this repo MIT-first. The dependency arrow stays managed → MIT.

## Legacy Surfaces

This repo originated as a coding-agent platform; the thesis pivoted to
LATAM commerce in April 2026. Some pre-pivot surfaces still ship in the
tree (Slack/Telegram/Discord adapters, coding-agent types, `@mention`
intent parser). They are not part of the post-pivot product surface and
are scheduled for removal as the catalog/connections OSS work lands.
Don't extend them.

## Managed tier

If you don't want to self-host the runtime, the managed tier hosts it
for you, with programmable wallet + policy engine + commerce-specific
observability + fiscal-compliance certifications on top, all shipped
and running in production today. Sign up at
[codespar.dev](https://codespar.dev).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The `.codespar-ready` MCP
servers in [mcp-dev-latam](https://github.com/codespar/mcp-dev-latam)
are a good place to add provider coverage without touching runtime
internals.

## License

MIT — see [LICENSE](./LICENSE). The five-point MIT commitment is
non-negotiable: no phone-home, no feature gates on the MIT layer, no
telemetry that restricts functionality.
