# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.5.0] - 2026-08-21

### Security

> **Update immediately.** Every release before this one allowed **anonymous remote code execution, as root**, in the default install as documented in the README. No API key, no tenant, no certificate was required: anyone who could reach the runtime's port could run commands inside it, in a process holding `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` and `DATABASE_URL`. If you have ever exposed this runtime to a network you do not fully control, treat those credentials as compromised and rotate them.

- **Authentication is now required on `/api/*`, `/sessions/*` and `/a2a/*`, always.** Previously the auth hook was registered only when `ENGINE_API_TOKEN` was set, and `.env.example` never mentioned that variable, so `docker compose up` — the documented path — served the control surfaces to anyone who could reach port 3000. The execution path was `POST /sessions`: `server_specs.<id>.command` is an argv that the MCP bridge hands to `child_process.spawn` with the runtime's own environment. `/a2a/tasks` had no credential check of any kind, and the session routes accepted any non-empty string behind `Bearer ` — `examples/session-mocks.sh` shipped `test` as that value, so there was no secret to guess. The `/v1` mirror of every route is covered too. ([#134](https://github.com/codespar/codespar/issues/134))
- **Closing this does not cost an install its autonomy.** No operator has to invent or paste a token for the service to come back up. When `ENGINE_API_TOKEN` is unset the runtime generates a credential on first boot, writes it to `<state dir>/api-token` with mode `0600`, and reuses it on every restart; a client on the same host reads it from there. `docker-compose.yml` mounts a `codespar_state` volume so the credential survives `docker compose down && up`. Set `ENGINE_API_TOKEN` to manage the credential yourself, in which case nothing is generated or written.
- **The guard resolves the request-target the same way the router does.** Access is decided on the decoded path and on the path component of an absolute-form request-target (RFC 7230 5.3.2, the form every HTTP proxy sends), not on the raw request line. Deciding on the raw string alone lets `GET /%61pi/agents` and `DELETE http://any-host/api/audit` reach handlers while the guard sees something that does not begin with a protected prefix. A target that cannot be parsed or decoded is treated as protected.
- **The generated credential is only adopted if it looks like the runtime wrote it.** An existing `api-token` file is used only when it is a regular file (checked with `lstat`, so a symlink is refused rather than followed), owned by the runtime's own uid, with no permission bits for group or other; anything else is ignored, reported, and replaced. The search also never includes a world-writable temp directory: on Linux `os.tmpdir()` is `/tmp`, where any local user could otherwise pre-create the file and choose the credential, which would also get them past the check on `/sessions` and therefore to command execution as the service account.
- **The container no longer runs as root.** The Dockerfile adds `USER node`.
- `/health` and the OAuth install/callback routes remain open, because container healthchecks and a browser mid-redirect cannot present a bearer token.
- **Two replicas sharing a state directory no longer disagree in silence.** Both would find no credential, both generate one, and both write; the rename is atomic, so one won the file and the other kept serving `401` to every caller while logging a normal boot. The generated credential is now read back after writing, and an instance that lost the race adopts the stored value. The window is not fully closed — set `ENGINE_API_TOKEN` to give every replica the same credential explicitly — but it fails loudly instead of silently.
- Refusals now carry a stable `code` (`api_token_required` or `api_token_invalid`) and a `remediation` string, alongside the existing `error` field, so a client that hits a 401 can recover without a human reading the log. The session routes previously answered this condition with a different JSON shape; both now use one envelope. Neither response contains the token, any fragment of it, its length, or the resolved state-directory path.

**Upgrading.** The runtime keeps starting on its own and needs no new configuration. Two things do change for callers:

- **Requests must now carry `Authorization: Bearer <token>`.** Anything that previously worked without a credential gets `401`. Read the token as shown in the README.
- **`GET /api/events` (SSE) now requires the header too.** A browser `EventSource` cannot send headers, so a browser client that consumed this endpoint directly has to move to a `fetch`-based reader or sit behind a proxy that adds the header. A token in a query parameter was deliberately not added, because URLs end up in access logs and referrers.
- **`POST /api/newsletter/subscribe` is behind the credential** like the rest of `/api`. A public signup form posting to it directly will stop working; put it behind your own backend.

**If you already have a `/app/.codespar` volume created by an older release running as root,** the container now runs as `node` and cannot write to it. With `DATABASE_URL` unset that directory *is* the datastore, so the runtime stops at startup with an explicit message rather than failing later with a stack trace. Give the volume to the runtime user once:

```
docker compose run --rm --user root core chown -R node:node /app/.codespar
```

Images published to `ghcr.io` before this release carry the vulnerability. Repull `:main`, or `:latest` once `v0.5.0` is tagged.

**Not fixed here, and worth knowing before you expose this runtime.** The provider webhook routes (`/webhooks/github`, `/webhooks/vercel`, `/webhooks/sentry`, `/webhooks/deploy`) are not covered by the bearer credential, and with no provider secret configured — the state of a fresh install — they **accept payloads without verifying them**. An accepted payload is written to the audit log, broadcast over SSE, and dispatched to the event handlers the agents act on. `WEBHOOK_STRICT_MODE=true` rejects unsigned requests, and is now documented in `.env.example` along with the per-provider secrets; it is still off by default because the webhook this runtime creates for you is registered at GitHub without a secret, so turning it on today rejects the integration the runtime set up for itself. Provisioning that secret is [#138](https://github.com/codespar/codespar/issues/138). Until then, restrict who can reach those four routes at the network layer.

### Changed

- `SECURITY.md` and `README.md` no longer describe the webhook routes as authenticated by signature without qualification. They are authenticated by signature *when a secret is configured*, and the default install has none. The previous wording was wrong in a security document, which is the worst place for it.
- The root `package.json` now carries a version (`0.5.0`), so the git tag, the image tag and the package version have something to be aligned against ([#111](https://github.com/codespar/codespar/issues/111)). The startup banner reads that value instead of the hard-coded `v0.1.0` it printed since the beginning, which told an operator checking whether they had picked up a security release the wrong thing.

### Added
- Session mocks API: optional `mocks` field on `POST /sessions` that intercepts tool dispatch before the MCP bridge, returning scripted outputs instead of calling a real upstream provider. Supports single-shot (object) and stateful (array) entries keyed by canonical `server/tool` form. `CODESPAR_TEST_MODE_ENABLED` (truthy on `true` or `1`, case-insensitive) is a deployment-level mode switch — with it off (the default) the runtime rejects `mocks` with HTTP 501 `mocks_not_permitted` and runs every dispatch through the bridge; with it on, the runtime is in test mode and every external tool dispatch requires a matching mock — a session without a matching entry (or without any `mocks` field at all) returns 422 `tool_not_mocked` rather than leaking to a live provider. Built-in tools (current allow-list: `codespar_list_tools`) bypass the gate; any future built-in that reaches external state must be declared in `mocks` instead. Five error envelopes: `mocks_not_permitted` (501), `mocks_invalid` (400, with RFC 6901 field pointer), `mocks_payload_too_large` (413, 64 KiB cap), `tool_not_mocked` (422), `mocks_exhausted` (422). Applies equally to direct `/execute` calls and chat-loop tool dispatch via `/send`. Counters persist for channel-bridge sessions and live in-memory for HTTP sessions. See [`docs/test-mode.md`](docs/test-mode.md) and [`examples/session-mocks.sh`](examples/session-mocks.sh). ([#113](https://github.com/codespar/codespar/pull/113))

## [0.4.0] - 2026-03-22

### Added
- Lens Agent: ephemeral data analyst agent that queries databases, writes SQL, and generates insights from any messaging channel
- 21 commands (was 19), 8 agent types (was 7)
- Lens Agent docs page: `agents/lens-agent.mdx`

## [0.3.0] - 2026-03-22

### Added
- AgentGate Payments: cross-border payment orchestration with routing (Stripe, Pix, SEPA, USDC, Wire, ACH), 12 currencies, FX quotes, escrow contracts, and HMAC-signed mandates (enterprise)
- Dashboard Payments page: transaction history, escrow management, mandate overview at `/dashboard/payments`
- Payments docs page: `guides/agentgate-payments.mdx`

## [0.2.0] - 2026-03-22

### Added
- AgentGate Governance: policy engine with allow/deny, budget limits, rate limits, time windows, and approval requirements (enterprise)
- Compliance templates: SOX, HIPAA, PCI-DSS pre-built rule sets
- MCP Observability: tool metrics, hallucination detection, anomaly detection, cost reports
- Drift Detection: monitors API changes that break MCP tool definitions
- Secrets Vault: AES-256-GCM encrypted per-tenant credential storage
- Governance docs page: `guides/agentgate-governance.mdx`

## [0.1.0] - 2026-03-22

### Added
- MCP Server Generator: scan codebases and generate MCP servers from source code (enterprise)
- Planning Agent: breaks features into 3-8 sequential sub-tasks with approval flow before execution
- Parallel task execution: up to 3 concurrent tasks per Project Agent with automatic queue and dequeue
- Multi-file refactoring: smart file picker selects up to 15 files, 30KB context per file, refactoring-optimized prompts
- Enterprise connectors: Sentry (Beta), Linear (Beta), Jira (Beta) integrations with IntegrationConnector interface; framework upgrade guides for Next.js 14-15, React 18-19, Angular 16-18 (managed tier, commercial license)
- Enterprise repo index: full repository indexing with symbol extraction, dependency graph, and semantic search for cross-repo refactoring and framework migration
- Dashboard Integrations page: 17 services across 4 categories (Monitoring, Issue Tracking, CI/CD, Communication) with inline configuration
- Discord OAuth install endpoint (`GET /api/discord/install`) for streamlined bot setup
- Image vision for Discord, Telegram, and WhatsApp channels (previously Slack-only)
- Agent state persistence: suspend/resume/autonomy changes saved to `.codespar/agent-states.json`, survives server restarts
- Channel configure endpoint (`POST /api/channels/configure`) for programmatic channel setup
- Admin panel with waitlist management and newsletter subscriber overview (`/dashboard/admin`)
- Billing and usage tracking page with API metrics, agent stats, and rate limit visualization (`/dashboard/admin/billing`)
- Unit tests: 94 tests (was 85)

### Previously added
- Seven agent types: Project (persistent), Task/Dev, Review, Deploy, Incident, Planning (ephemeral), Coordinator (persistent)
- Five channel adapters: Slack (Socket Mode), WhatsApp (Evolution API v2.3.7), Discord, Telegram, CLI
- Dev Agent: reads codebase via GitHub API, creates PRs with Claude Sonnet, diff-based edits (SEARCH/REPLACE format)
- Smart file picker: Claude Haiku selects relevant files from full repo tree (replaces keyword-based search)
- Image vision: agents can see screenshots attached in Slack (base64 encoded, sent as image content blocks)
- Diff-based edits: SEARCH/REPLACE format instead of full-file output for more precise changes
- Multi-turn continuation: if Claude response is truncated, the agent automatically requests continuation
- Merge PR command: `merge PR #N [squash|rebase]` to merge pull requests directly from chat
- Review Agent: fetches PR data, risk classification (low/medium/high), auto-approve at L3+
- Deploy Agent: approval workflows with quorum (1 staging, 2 production), cross-channel voting
- Incident Agent: CI failure investigation, error correlation, root cause analysis
- Coordinator Agent: cross-project orchestration, cascading deploys, status aggregation
- 21 commands with regex parser + Claude Haiku NLU fallback (includes merge PR, plan, lens, demo, kill)
- Smart responses via Claude Sonnet for open-ended questions (multilingual)
- Graduated autonomy L0-L5 with safety guardrails
- RBAC: 6 roles (owner, maintainer, operator, reviewer, read-only, emergency_admin), 15 permissions
- Approval system: token-based, quorum, self-approval blocking, expiration
- Audit trail: append-only, hash chain integrity
- Identity system: cross-channel user mapping, register command
- Vector memory: TF-IDF embeddings replacing hash-based vector store, real semantic search with cosine similarity
- Multi-tenant: x-org-id header, FileStorage org scoping
- Task scheduler: cron-like recurring tasks with pause/resume/cancel support
- Built-in scheduled tasks: health check (5 min), build status report (24h), audit cleanup (24h)
- Streaming responses: `executeStreaming` and `generateSmartResponseStreaming` via SSE from Anthropic API
- Slack thread support: `app_mention` replies are sent in threads automatically, preserving thread context
- File attachments: `ChannelAttachment` type with Slack `files.uploadV2` implementation via `sendFile`
- API versioning: `/v1/` prefix available on all endpoints, `X-API-Version` response header
- Create/Delete agent endpoints: `POST /api/agents` and `DELETE /api/agents/:id`
- `GET /api/agent-types` endpoint to list registered agent types
- REST API: 25+ endpoints (agents, audit, projects, channels, memory, orgs, webhooks, metrics, newsletter, scheduler)
- Rate limiting: 100 req/min API, 30 req/min webhooks
- Webhook signature validation: HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`
- Newsletter endpoints: subscribe, unsubscribe, list subscribers, count
- Resend integration: automated welcome email on newsletter subscription
- Agent plugin registry: registerAgentType for custom agents
- Docker execution sandbox interfaces (contract for future implementation)
- Structured logging (JSON prod, pretty dev) with configurable `LOG_LEVEL` + metrics collector endpoint
- GitHub Actions CI/CD (build + test on push/PR)
- CONTRIBUTING.md with contribution guidelines, code of conduct, and PR workflow
- Documentation site: 62 pages (docs.codespar.dev, Fumadocs MDX)
- Docs search: Cmd+K full-text search across all documentation pages
- Unit tests: 94 tests (Intent Parser, RBAC, FileStorage, Identity)

### Infrastructure
- Turborepo monorepo with 13 TypeScript packages
- Fastify 5 HTTP server
- Docker Compose (base + channel-specific overrides)
- Railway deployment (backend)
- Vercel deployment (docs site)
