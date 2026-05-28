# CodeSpar — Project Instructions

## What is CodeSpar

MIT-licensed agent runtime for **commerce AI agents in Latin America**. The runtime is channel-agnostic and vertical-agnostic in its core abstractions; the shipped application is LATAM commerce — agents that transact on Pix + NF-e + WhatsApp Business + LATAM PSPs without rebuilding the plumbing every team.

This repo (`codespar/codespar`, public, MIT) is the **open-source self-hostable runtime**. The managed tier (`codespar/codespar-enterprise`, private) registers commerce-governance capabilities (programmable wallet, policy engine, fiscal-compliance certifications) against the plugin hooks exposed here.

**Authoritative thesis:** [VISION-codespar.md](https://github.com/codespar/codespar-web/blob/main/docs/visions/VISION-codespar.md) (Accepted 2026-04-19, lives in `codespar-web`). Read it before making strategic decisions.

**Five-point MIT commitment** (VISION §Premise 1a, non-negotiable):
1. Every MCP server already published is MIT forever.
2. Every future MCP server will be MIT — not BSL, SSPL, AGPL, GPL, or "source-available."
3. `@codespar/sdk` stays MIT.
4. No usage-based restrictions on OSS components — no rate limits, no feature gates, no telemetry that restricts functionality.
5. Copyleft is never used as a competitive weapon.

If codespar ceased to exist tomorrow, agent code built on this runtime does not break: the MIT stack is forkable, self-hostable, and functionally complete without anything running on codespar infrastructure.

## Language

- All code, comments, file names, docs: **English**
- Conversation with user: **Portuguese**

## Repository Strategy

| Repo | Visibility | Contents |
|------|-----------|----------|
| **`codespar/codespar`** (this repo) | Public, MIT | Self-hostable agent runtime + channel adapters + session API |
| `codespar/codespar-core` | Public, MIT | SDK — `@codespar/sdk` (TS) + `codespar` (PyPI) + framework adapters + `@codespar/api-types` session contract |
| `codespar/mcp-dev-latam` | Public, MIT | LATAM MCP server catalog (109 servers · 2,289 tools · 6 countries as of 2026-04) |
| `codespar/codespar-enterprise` | Private, commercial | Managed-tier capabilities (programmable wallet, policy engine, observability, vault) — registers against plugin hooks here |
| `codespar/codespar-web` | Private | Marketing site + dashboard UI |

**Dependency arrow:** strictly enterprise → MIT. The public core never imports enterprise packages. Plugin hooks (`PolicyHook`, `ObservabilityHook`, `SecretsHook`, `IntegrationHook`) are the integration surface; enterprise registers implementations at runtime.

## What this runtime ships

The runtime is **the OSS implementation of the session contract** defined in [`@codespar/api-types`](https://www.npmjs.com/package/@codespar/api-types). The same contract is implemented by `codespar-enterprise`, so an agent written against `@codespar/sdk` runs unchanged against either endpoint — `baseUrl` is a configuration change, not a rewrite.

Concretely:

- **Session API** (`packages/core/src/server/routes/sessions.ts`) — implements `POST /sessions`, `POST /sessions/:id/execute`, `POST /sessions/:id/send` (JSON + SSE), `GET /sessions/:id/connections`, `DELETE /sessions/:id`. Mounted at both `/sessions` and `/v1/sessions`.
- **Projects API** (`packages/core/src/server/routes/projects.ts`) — CRUD for the 2-level tenancy model (Org → Project), mirroring the contract `codespar-enterprise` serves.
- **WhatsApp channel adapter** (`packages/channels/whatsapp`) — Evolution API integration. WhatsApp is the deepest channel because Brazilian commerce concentrates there (~78% of businesses, 6× web-e-commerce conversion); other channels exist as composable capabilities (see `packages/channels/`).
- **Plugin hooks** (`packages/core/src/plugins/`) — `PolicyHook`, `ObservabilityHook`, `SecretsHook`, `IntegrationHook`. Enterprise registers implementations here.
- **Storage** — `StorageProvider` interface with `FileStorage` (single-tenant) and `PgStorage` (PostgreSQL via Drizzle) implementations. Tenancy: `org_id` + `project_id` stamped on every event/audit row.
- **Audit log** — append-only hash chain (`AuditEntry.hash` chained with `prev_hash`), per-tenant.

## What's not in OSS yet

The OSS runtime is functionally complete for self-hosting an agent that transacts on LATAM rails, but the following surfaces live only in `codespar-enterprise` today and are on the OSS roadmap:

- **MCP server catalog API** (`/v1/servers`). Enterprise has 109 servers in a Postgres-backed catalog with category × country metadata. In OSS, providers are registered manually via SDK config.
- **Connections vault** (`/v1/connections`, `/v1/auth-configs`). Enterprise has an AES-256-GCM vault with per-tenant scrypt-derived keys for storing provider credentials. In OSS, credentials live in environment variables.
- **Programmable wallet + policy engine**. Status: design-only, engineering not yet started — the safety contract is the commitment, not implemented behavior.
- **Commerce-specific observability**. Generic trace infrastructure (Pino logger, metrics) exists; commerce-flavored observability (per-provider transaction success, Pix reconciliation latency, NF-e rejection-code clustering) is enterprise-only.

When these surfaces land in OSS, the dependency arrow stays the same — enterprise will simplify to operational hosting + governance UI + tenancy multiplication on top.

## Tech Stack

### Runtime
- **Node.js 22** + **TypeScript 5.4** (strict mode)
- **Fastify 5** for HTTP (sessions, projects, channels, health)
- **Turborepo** for the monorepo

### Data
- **PostgreSQL 16** + **Drizzle ORM** (`packages/core/migrations/`)
- **Redis 7** for queues + pub/sub
- **pgvector** for agent memory embeddings

### Channels
- **Evolution API** (WhatsApp) — REST wrapper over Baileys, handles QR pairing, session management, anti-ban

### AI & SDK
- **@codespar/sdk** — TypeScript SDK ([`codespar-core`](https://github.com/codespar/codespar-core))
- **codespar** — Python SDK on PyPI (v0.1.x)
- **Claude Agent SDK** — hooks, sessions, MCP

### Observability & Quality
- **Pino** — structured JSON logging with secret redaction
- **Vitest + Testcontainers** — tests with real PostgreSQL + Redis
- **Biome** — linting + formatting

### Docs site

User-facing docs live in [`codespar-web`](https://github.com/codespar/codespar-web) (Fumadocs at `content/docs/`) and are deployed at [docs.codespar.dev](https://docs.codespar.dev). This repo does not ship a docs site of its own.

## Project Structure

```
codespar-opensource/
  CLAUDE.md                          # This file
  README.md                          # Public-facing project README
  package.json                       # Root workspace
  turbo.json
  docker-compose.yml                 # Core: Postgres + Redis + runtime
  docker-compose.whatsapp.yml        # Override: + WhatsApp adapter
  packages/
    core/                            # @codespar/core — runtime + session API
      src/
        server/                      # Fastify server + routes (sessions, projects)
        plugins/                     # Plugin hooks (PolicyHook, ObservabilityHook, ...)
        storage/                     # StorageProvider + FileStorage + PgStorage
        observability/               # Logger, metrics
        webhooks/                    # Inbound webhook handlers
        types/                       # Public types
      migrations/                    # Drizzle migrations (org/project schema, audit)
    channels/
      whatsapp/                      # @codespar/channel-whatsapp (Evolution API)
      cli/                           # @codespar/channel-cli (terminal REPL)
  server/
    start.mjs                        # Production entry point
  tests/                             # Integration tests
```

## Tenancy (2-level: Org → Project)

Mirrors the enterprise contract. Every write path stamps `project_id`.

- **Org** — workspace/company. Has at least one project.
- **Project** — environment isolation (`dev`, `staging`, `prod`). API keys, sessions, channel bindings, audit events all scope to a project.
- **Default project** — auto-created at org creation. Slug `default` is reserved.
- **Header contract** — `x-org-id` (existing OSS pattern) resolves the org; `x-codespar-project` selects the project. Cross-tenant existence cannot be probed: GET /:id returns 404 (not 403) when the project belongs to a different org.

Storage operations that write project-scoped data must take `projectId` explicitly. The audit log carries `orgId` + `projectId` columns; `null` is reserved for system-wide events (startup, install).

## Plugin Hooks

The integration surface for enterprise (and any third party). Hooks live in `packages/core/src/plugins/`.

| Hook | Purpose |
|------|---------|
| `PolicyHook` | Pre-execution policy evaluation — gate sessions/tool calls based on org rules. Enterprise registers programmable wallet limits, mandate caps, deny-list enforcement. |
| `ObservabilityHook` | Trace + metric emission. Enterprise registers commerce-specific span enrichment (provider, currency, settlement). |
| `SecretsHook` | Provider credential retrieval. Enterprise registers vault-backed lookup. |
| `IntegrationHook` | Outbound integration registration (e.g. Sentry, Linear). |

**Rule:** `@codespar/core` never imports enterprise packages. Enterprise loads at runtime via `pluginRegistry.register(...)`.

## Coding Conventions

### General
- TypeScript strict mode everywhere
- ESM only — all imports end in `.js`, even when importing `.ts` source files
- No `any` — prefer `unknown` + type guards
- Biome for linting + formatting

### Package Organization
- One package per channel adapter (`@codespar/channel-whatsapp`, etc.)
- Core shared types in `@codespar/core`
- Every package has its own `package.json`, `tsconfig.json`, `src/`, `tests/`
- Tests at `packages/**/src/**/__tests__/**/*.test.ts`; excluded from `tsc` via `tsconfig.base.json`

### Naming
- Files: kebab-case (`session-routes.ts`, `webhook.ts`)
- Classes/Interfaces: PascalCase (`StorageProvider`, `SessionEntry`)
- Functions/Variables: camelCase
- Database tables: snake_case
- Redis keys: colon-delimited (`codespar:session:{id}:status`)

### Migrations
- `packages/core/migrations/` — SQL migrations, numbered sequentially
- Idempotent where possible (`IF NOT EXISTS`, guarded `ALTER`)
- Never edit an applied migration — create a new one (the runner hashes content for drift detection)

### Error Handling
- Never swallow errors silently — log and propagate
- Storage operations that hit typed error codes (`slug_conflict`, `cannot_delete_default`, etc.) translate to 4xx responses with the same `error` codes as enterprise
- Audit log entries for all side-effect actions

## Build, Test, Run

```bash
npm install
npx turbo run build

npx vitest run                # all packages
npx vitest run packages/core/src/__tests__/contract-oss.test.ts  # OSS session-contract conformance

npm start                     # CLI mode
npm run start:server          # HTTP server (Fastify on :3000 by default)

# Docker
docker compose up                                                          # Postgres + Redis + core
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up    # + WhatsApp

# Database
npm run db:generate && npm run db:migrate    # from packages/core/
```

**Required env:** `ANTHROPIC_API_KEY` (for agents that use Claude). **Optional:** `CODESPAR_BASE_URL` to override the SDK's default endpoint, `DATABASE_URL` to switch from FileStorage to PgStorage.

## Deploy

See [`DEPLOY.md`](DEPLOY.md) for shipping this runtime to Railway (service `codespar`) in staging (any branch) or prod (push to `main` → auto-deploy). In staging, `ENABLE_WHATSAPP=false` and the `calm-prosperity` (Evolution API) service is at `NO DEPLOYMENT`. Full staging topology in `~/projects/codespar/.local-dev/STAGING.md`.

## Workflow Standards

### Plan Before You Code
1. **Explore** — read the relevant route + storage + migration files. The stack is layered; changes often span 3 files.
2. **Plan** — for schema changes, draft the migration first and check the backfill path + rollout (nullable → NOT NULL in a later migration).
3. **Implement** — small diffs; run `npx tsc --noEmit` after each significant edit.
4. **Verify** — `npx vitest run`. Integration tests use Testcontainers for Postgres + Redis.
5. **Live LLM smoke** (REQUIRED before pushing changes that touch the chat loop in `packages/core/src/chat-loop/`, the MCP bridge surface, or anything that affects the Anthropic SDK request shape). The unit + integration tests in this repo use a stub Anthropic client and the in-test mock at `packages/core/src/server/routes/__tests__/sessions-send-chat-loop.test.ts` — none of them enforce Anthropic's actual tool-name regex or model-id validity. To catch that class of regression, run the live smoke in the consumer repo against your local fix branch:

   ```bash
   # In codespar-core (sibling clone):
   cd ../codespar-core
   ANTHROPIC_API_KEY=sk-ant-... CODESPAR_RUNTIME_DIR=<absolute path to this codespar checkout> \
     (cd examples/pix-nfse-skeleton && npm run validate:live) && \
     (cd examples/nfse-from-natural-language && npm run validate:live)
   ```

   Costs a few cents per run. Not wired into CI here or in codespar-core — too expensive and too probabilistic for every PR — but mandatory before pushing chat-loop changes. The live smoke is what caught the tool-name `/` separator bug (`tools.0.custom.name` regex violation) and the `claude-3-5-sonnet-latest` model-id bug (404 not_found_error); both passed every unit + integration test unchallenged.
6. **Commit** — descriptive commit message.

### Git Workflow
- `main` — stable, tested code only
- `feature/<name>` — new features
- `fix/<name>` — bug fixes
- Always create a new branch per task; keep diffs small and focused
- Commit messages explain *why*, not just *what*
- NEVER commit directly to `main`

## What NOT to do

- NEVER violate the five-point MIT commitment.
- NEVER import from enterprise packages in `@codespar/core`. The dependency arrow is strictly enterprise → MIT.
- NEVER skip migrations by editing already-applied SQL. The runner hashes file content; drift fails loud.
- NEVER silently fall back to "org-wide" scope when `projectId` is missing — fail loud (the auth layer does this; new code paths should mirror it).
- NEVER store provider credentials in plaintext. In OSS, env vars; in enterprise, vault.
- NEVER auto-execute commerce actions that the safety contract gates (fund transfers above tenant cap, NF-e/CFDI/Factura issuance for contested carts, wallet-policy overrides, bulk outbound messaging above threshold, cross-tenant agent-to-agent commitments). These require human approval regardless of autonomy configuration.
- NEVER concatenate user input directly into system prompts (prompt injection).

## Engineering Preferences

- **DRY is important** — flag repetition aggressively.
- **"Engineered enough"** — not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
- **Handle more edge cases, not fewer.** Thoughtfulness > speed.
- **Explicit over clever.** Bias toward readability.

## Quick Commands

- **QPLAN** — analyze similar parts of the codebase, propose plan with tradeoffs. Do not code yet.
- **QCODE** — implement. Verify type safety + tests.
- **QCHECK** — skeptical review: race conditions, cross-tenant leaks, migration drift, secret handling.
- **QTEST** — `npx vitest run`. Report failures with context.
- **QSTATUS** — current state: open migrations, branch status, test coverage.

## Legacy Surfaces

This repo originated as a coding-agent platform; the thesis pivoted to LATAM commerce in April 2026. Some pre-pivot surfaces still exist in the tree (e.g. `packages/agents/{project,task,review,deploy,incident,coordinator,lens,planning}`, intent-parser regex patterns for `@codespar status|deploy|fix|rollback|...`, channel adapters for Slack/Telegram/Discord). They are not part of the post-pivot product surface and are scheduled for removal as the catalog/connections OSS work lands. Do not extend them; if you touch them for another reason, simplify or remove rather than preserve. Do not write new documentation for them.

## License

MIT. The five-point commitment in VISION is the binding contract.
