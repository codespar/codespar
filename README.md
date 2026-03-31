<p align="center">
  <strong>code&lt;spar&gt;</strong>
</p>

<p align="center">
  <em>Autonomous agents for every project. Deployed where your team works.</em>
</p>

<p align="center">
  <a href="https://github.com/codespar/codespar/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
</p>

---

## Current Status

| Feature | Status |
|---------|--------|
| CLI Adapter | ✅ Working |
| Slack Adapter (Socket Mode, app_mention + DMs) | ✅ Working |
| WhatsApp Adapter (Evolution API v2.3.7) | ✅ Working |
| Discord Adapter | ✅ Working |
| Telegram Adapter | ✅ Working |
| Project Agent (persistent, L0-L5) | ✅ Working |
| Task/Dev Agent (creates real PRs via GitHub API) | ✅ Working |
| Review Agent (fetches PR, risk classification, auto-approve) | ✅ Working |
| Deploy Agent + Approval System | ✅ Working |
| Incident Agent (CI failure investigation) | ✅ Working |
| Coordinator Agent (cross-project, cascading deploy) | ✅ Working |
| Planning Agent (feature decomposition, 3-8 sub-tasks) | ✅ Working |
| Lens Agent (data analysis, SQL queries, visualizations) | ✅ Working |
| Parallel Task Execution (3 concurrent per agent) | ✅ Working |
| Multi-file Refactoring (15 files, 30KB context) | ✅ Working |
| RBAC (6 roles, 15 permissions) | ✅ Working |
| Audit Trail (hash chain integrity) | ✅ Working |
| 3-Tier Intent Parsing (regex → Claude Haiku NLU → Claude Sonnet smart response) | ✅ Working |
| Vector Memory (TF-IDF semantic search) | ✅ Working |
| Identity System (cross-channel user mapping) | ✅ Working |
| Multi-tenant Organizations (Clerk Organizations, org-scoped everything) | ✅ Working |
| GitHub Webhooks (auto-configured on link) | ✅ Working |
| Task Scheduler (cron-like recurring tasks) | ✅ Working |
| Streaming Responses (SSE from Anthropic API) | ✅ Working |
| Slack Thread Support (responses in threads) | ✅ Working |
| Image Vision (screenshot analysis, all channels) | ✅ Working |
| Smart File Picker (Claude Haiku file selection) | ✅ Working |
| Context-Aware Agent (language detection, project context gathering) | ✅ Working |
| File Attachments (Slack files.uploadV2) | ✅ Working |
| API Versioning (/v1/ prefix on all endpoints) | ✅ Working |
| Create/Delete Agent API | ✅ Working |
| Newsletter + Resend Integration | ✅ Working |
| Structured Logging + Metrics Endpoint | ✅ Working |
| Zod Request Validation (all API endpoints) | ✅ Working |
| Rate Limiting (100/min API, 30/min webhooks) | ✅ Working |
| Webhook Signature Validation (HMAC-SHA256) | ✅ Working |
| GitHub Actions CI/CD | ✅ Working |
| Docker Compose | ✅ Working |
| Railway Deploy | ✅ Working |
| Agent State Persistence (.codespar/agent-states.json) | ✅ Working |
| Channel Configure API (POST /api/channels/configure) | ✅ Working |
| Self-healing Agent Loop (smart alerts, auto-fix, autonomous healing L3-L5) | ✅ Working |
| Slack OAuth Multi-workspace (Socket Mode) | ✅ Working |
| Claude API Instrumentation (token/cost tracking) | ✅ Working |
| Observability (Vercel/Railway API integration, Recharts dashboards) | ✅ Working |
| Agent Canvas (React Flow visual editor with inspector) | ✅ Working |
| Code Panel (Monaco Editor in chat) | ✅ Working |
| Per-org Integration Tokens (Vercel, Railway, Sentry, Datadog) | ✅ Working |
| Web Chat (streaming SSE, image vision, deploy alerts) | ✅ Working |
| Admin Panel (waitlist + newsletter management) | ✅ Working |
| Billing & Usage Page (API metrics, agent stats) | ✅ Working |
| Dashboard Integrations Page (17 services, 4 categories) | ✅ Working |
| Dashboard (codespar.dev/dashboard) | ✅ Working |
| Docs Site (docs.codespar.dev, 75 pages) | ✅ Working |
| Docs Search (Cmd+K) | ✅ Working |
| MCP Server Generator (enterprise) | ✅ Working |
| AgentGate Governance (enterprise) | ✅ Working |
| AgentGate Payments (enterprise) | ✅ Working |

---

**CodeSpar** is an open source, multi-agent platform that deploys autonomous AI coding agents to **WhatsApp**, **Slack**, **Telegram**, **Discord**, and **Web Chat** via `@mention` commands.

Each project gets its own persistent agent that monitors builds, investigates failures, proposes fixes, and orchestrates deploys. Everything is controllable from your messaging channels.

## New in v0.1.0

- **Smart file picker** -- Claude Haiku selects the most relevant files from the full repository tree, replacing keyword-based search.
- **Image vision** -- agents can analyze screenshots attached in Slack messages, enabling visual debugging workflows.
- **Diff-based edits** -- SEARCH/REPLACE format for precise code changes instead of full-file output, with multi-turn continuation when responses are truncated.
- **Merge PR command** -- `merge PR #N [squash|rebase]` to merge pull requests directly from chat.
- **TF-IDF vector memory** -- real semantic search using term frequency-inverse document frequency, replacing the previous hash-based vector store. Cosine similarity search across agent memory.
- **Task scheduler** -- cron-like recurring tasks with pause/resume/cancel support. Built-in tasks: health check (5 min), build status report (24h), audit cleanup (24h).
- **Streaming responses** -- SSE streaming from the Anthropic API via `executeStreaming` and `generateSmartResponseStreaming`. Progressive message updates in channels.
- **Slack thread support** -- all `app_mention` responses are automatically sent as thread replies, keeping channels clean. Thread context is preserved for follow-up messages.
- **File attachments** -- `ChannelAttachment` type with Slack `files.uploadV2` support. Agents can send diffs, reports, and logs as file uploads.
- **API versioning** -- all endpoints are available under the `/v1/` prefix (e.g., `/v1/api/agents`). Responses include the `X-API-Version` header.
- **Create/Delete Agent API** -- `POST /api/agents` to create agents programmatically, `DELETE /api/agents/:id` to remove them. `GET /api/agent-types` lists registered agent types.
- **Newsletter subscriber management** -- subscribe/unsubscribe endpoints with Resend integration for automated welcome emails.
- **Structured logging** -- JSON-formatted logs in production, pretty-printed in development. Configurable via `LOG_LEVEL`. Metrics collector with `GET /api/metrics`.
- **Rate limiting** -- 100 requests/min for API endpoints, 30 requests/min for webhooks.
- **Webhook signature validation** -- HMAC-SHA256 verification of GitHub webhook payloads via `GITHUB_WEBHOOK_SECRET`.
- **GitHub Actions CI/CD** -- automated build and test pipeline on every push and pull request.
- **Docs search** -- Cmd+K full-text search across all 62 documentation pages.
- **Self-healing agent loop** -- agents detect failures via smart alerts, propose fixes, and autonomously heal at L3-L5 autonomy levels. The full cycle: detect → diagnose → fix → verify.
- **3-tier intent parsing** -- regex patterns for known commands → Claude Haiku NLU for intent classification → Claude Sonnet for open-ended smart responses. Progressive escalation keeps latency low for common commands.
- **Agent Canvas** -- React Flow visual editor for agent orchestration with an inspector panel. Drag-and-drop agent workflows, visualize agent relationships and state.
- **Code Panel** -- Monaco Editor embedded in chat for inline code viewing and editing.
- **Web chat with streaming** -- browser-based chat with SSE streaming, image vision support, and deploy alert notifications.
- **Multi-tenant organizations** -- Clerk Organizations integration with org-scoped agents, projects, and configurations.
- **Slack OAuth multi-workspace** -- OAuth flow for multi-workspace installation with Socket Mode for real-time events.
- **Claude API instrumentation** -- token usage and cost tracking per request, per agent, and per organization.
- **Observability dashboards** -- Vercel and Railway API integration for deploy metrics, with Recharts-powered dashboards.
- **Per-org integration tokens** -- organization-scoped tokens for Vercel, Railway, Sentry, and Datadog integrations.
- **3 new commands** -- `docs` (search documentation), `scan` (codebase analysis for security/lint/type issues), `perf` (performance metrics and regression detection). 24 commands total.
- **Webhook server decomposition** -- the monolithic webhook handler was decomposed into 8 route modules (480-line orchestrator + 8 focused modules) for maintainability and testability.
- **Context-aware agents** -- language detection and project context gathering for smarter responses across all channels.
- **CONTRIBUTING.md and CHANGELOG.md** -- contribution guidelines and a detailed changelog are now included in the repository.
- **186+ unit tests** -- Intent Parser, RBAC, FileStorage, Identity, and more.

## Quick Start

### With npm

```bash
git clone https://github.com/codespar/codespar.git
cd codespar
npm install
cp .env.example .env  # set ANTHROPIC_API_KEY + GITHUB_TOKEN
ENABLE_SLACK=true SLACK_BOT_TOKEN=xoxb-... npm run start:server
```

### With Docker

```bash
git clone https://github.com/codespar/codespar.git
cd codespar
cp .env.example .env   # add your ANTHROPIC_API_KEY + GITHUB_TOKEN
docker compose up -d
```

```
✓ PostgreSQL ready
✓ Redis ready
✓ Agent supervisor online
✓ Project agent spawned: agent-gw (L1 Notify)
✓ WhatsApp connected (QR verified)
✓ Listening on #squad-backend

Ready. Your agents are live.
```

Then, in your WhatsApp group:

```
@codespar status build

✅ [agent-gw] Build #348 - api-gateway (main)
   142/142 tests | 87.5% coverage | 3m12s
```

## Configuration

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude | `sk-ant-...` |
| `GITHUB_TOKEN` | GitHub API token for webhooks/PRs | `ghp_...` |

### AI Models

| Variable | Description | Default |
|----------|-------------|---------|
| `TASK_MODEL` | Model for Dev Agent code generation | `claude-sonnet-4-20250514` |
| `NLU_MODEL` | Model for intent classification | `claude-haiku` |
| `SMART_MODEL` | Model for open-ended smart responses | `claude-sonnet` |
| `REVIEW_MODEL` | Model for PR review and risk analysis | `claude-sonnet` |
| `PLANNING_MODEL` | Model for plan decomposition | `claude-sonnet-4-20250514` |

### Channel Configuration

Enable channels by setting their env vars. All channels are optional. Enable only what you need.

**WhatsApp (via Evolution API):**
| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_WHATSAPP` | Enable WhatsApp adapter | `false` |
| `EVOLUTION_API_URL` | Evolution API base URL | `http://localhost:8084` |
| `EVOLUTION_API_KEY` | Evolution API auth key | |
| `EVOLUTION_INSTANCE` | Instance name | `codespar` |
| `WHATSAPP_WEBHOOK_PORT` | Webhook receiver port | `3001` |
| `WHATSAPP_BOT_MENTION` | Mention trigger | `@codespar` |

**Slack:**
| Variable | Description |
|----------|-------------|
| `ENABLE_SLACK` | Enable Slack adapter (`true`/`false`) |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | App signing secret |
| `SLACK_APP_TOKEN` | App-level token for Socket Mode (`xapp-...`) |

**Telegram:**
| Variable | Description |
|----------|-------------|
| `ENABLE_TELEGRAM` | Enable Telegram adapter (`true`/`false`) |
| `TELEGRAM_BOT_TOKEN` | BotFather token |

**Discord:**
| Variable | Description |
|----------|-------------|
| `ENABLE_DISCORD` | Enable Discord adapter (`true`/`false`) |
| `DISCORD_BOT_TOKEN` | Bot token from Discord Developer Portal |

### Infrastructure

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://...` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `CODESPAR_WORK_DIR` | Working directory for agents | `process.cwd()` |
| `PROJECT_NAME` | Default project name | `default` |
| `WEBHOOK_BASE_URL` | Public URL for GitHub webhook callbacks | |
| `ADMIN_NAME` | Display name for admin user | |
| `RESEND_API_KEY` | Resend API key for newsletter emails | |
| `RESEND_FROM_EMAIL` | Newsletter from address | `CodeSpar <dispatch@codespar.dev>` |
| `GITHUB_WEBHOOK_SECRET` | HMAC-SHA256 webhook validation secret | |
| `LOG_LEVEL` | Logging level (debug/info/warn/error) | `info` |

## What It Does

| You type | Agent does |
|----------|-----------|
| `@codespar status` | Reports project status, build info, agent state |
| `@codespar status build` | Reports build status, test coverage, duration |
| `@codespar fix [issue]` | Investigates, proposes fix, creates draft PR |
| `@codespar instruct <task>` | Dev Agent reads code, creates PR with changes |
| `@codespar review PR #<n>` | Review Agent analyzes PR, classifies risk, comments |
| `@codespar prs` | Lists open pull requests for the linked repo |
| `@codespar deploy staging` | Runs pre-checks, requests approval, deploys |
| `@codespar rollback prod` | Requires quorum (2 approvals), rolls back |
| `@codespar approve <token>` | Cross-channel approval for pending operations |
| `@codespar autonomy L3` | Changes agent autonomy level |
| `@codespar link <owner/repo>` | Links a GitHub repo, auto-configures webhooks |
| `@codespar unlink` | Unlinks the current GitHub repo |
| `@codespar config` | Shows current project configuration |
| `@codespar agents` | Lists all active agents and their states |
| `@codespar audit [n]` | Shows recent audit trail entries |
| `@codespar permissions` | Shows your roles and permissions |
| `@codespar plan <feature>` | Breaks feature into 3-8 sequential sub-tasks |
| `@codespar merge PR #<n> [squash\|rebase]` | Merges a pull request (default, squash, or rebase) |
| `@codespar lens <question>` | Queries data, generates SQL, returns insights and visualization suggestions |
| `@codespar docs <topic>` | Searches documentation, returns relevant excerpts |
| `@codespar scan [path]` | Scans codebase for issues (security, lint, type errors) |
| `@codespar perf [endpoint]` | Analyzes performance metrics, identifies regressions |
| `@codespar demo [name]` | Show interactive demos (MCP Generator) |
| `@codespar kill` | Emergency kill switch, stops all agent activity |
| `@codespar help` | Shows all available commands |
| Natural language | Works in any language (Portuguese, Spanish, etc.) |

## Dev Agent

The Dev Agent reads your actual codebase via the GitHub API, sends context to Claude Sonnet, and creates pull requests. A smart file picker (Claude Haiku) selects the most relevant files from the full repo tree instead of relying on keyword search. Changes are generated using diff-based edits (SEARCH/REPLACE format) for precise modifications instead of full-file output. The full flow: pick files, read contents, prompt Claude, parse diffs, create branch, commit changes, open PR. All from a single WhatsApp or Slack message.

```
@codespar instruct add input validation to the signup endpoint

🔍 Reading codebase...
📝 Generating changes with Claude Sonnet...
🔀 Creating branch: codespar/add-input-validation
✅ PR #42 opened: "Add input validation to signup endpoint"
   → 3 files changed, 47 additions
```

## Eight Agent Types

| Agent | Lifecycle | What it does |
|-------|----------|-------------|
| **Project Agent** | Persistent | Monitors repo, CI/CD, channels. Handles all @mention commands. |
| **Task/Dev Agent** | Ephemeral | Reads codebase via GitHub API, generates code with Claude, creates PRs. |
| **Review Agent** | Ephemeral | Fetches PR diffs, classifies risk, auto-approves low-risk per policy. |
| **Deploy Agent** | Ephemeral | Orchestrates deploys with approvals and health monitoring. |
| **Incident Agent** | Ephemeral | Investigates CI failures and production errors. Correlates with recent changes. |
| **Planning Agent** | Ephemeral | Decomposes features into 3-8 ordered sub-tasks for structured execution. |
| **Lens Agent** | Ephemeral | Queries databases, generates SQL, returns insights and visualization suggestions. |
| **Coordinator** | Persistent | Cross-project orchestration. Cascading deploys, shared locks. |

## Six Channels, Same Syntax

| Channel | Status | Connection |
|---------|--------|-----------|
| WhatsApp | ✅ Working | Evolution API v2.3.7 (QR scan, session management) |
| Slack | ✅ Working | OAuth multi-workspace, Socket Mode (app_mention + DMs) |
| Telegram | ✅ Working | Official API (BotFather token) |
| Discord | ✅ Working | Official API (Bot token + Gateway) |
| Web Chat | ✅ Working | Streaming SSE, image vision, deploy alerts |
| CLI | ✅ Working | Terminal (dev/debug) |

The agent layer never knows which channel is being used. Every message is normalized to a `NormalizedMessage` before reaching any agent.

## Graduated Autonomy

Agents earn trust over time. You control the pace.

| Level | Name | Behavior |
|-------|------|----------|
| L0 | Passive | Only responds when addressed |
| L1 | **Notify** | Monitors and alerts. Never auto-executes. **Default.** |
| L2 | Suggest | Proposes actions proactively. Requires approval. |
| L3 | Auto-Low | Auto-executes low-risk (format, lint). Notifies after. Self-healing for minor issues. |
| L4 | Auto-Med | Auto-executes medium-risk (bug fixes, PR reviews). Auto-fix with verification. |
| L5 | Full Auto | Autonomous within policy bounds. Full self-healing loop (detect → diagnose → fix → verify). |

> **Safety guardrail:** Regardless of autonomy level, agents **never** auto-execute: production deployments, data migrations, security-sensitive changes, or infrastructure modifications. These always require human approval.

## Security: 10 Defense Layers

1. Message Filter. Only process @mentions and DMs.
2. Channel Config. Ignore unconfigured channels.
3. Identity Resolution. Map channel user to unified user.
4. RBAC. 6 roles (owner to read-only + emergency_admin), 15 permissions.
5. ABAC Policies. Time windows, environment restrictions, quorum.
6. Agent Sandboxing. Each agent scoped to project, no cross-project data.
7. Prompt Injection Defense. Pattern blocklist + risk classifier + template isolation + Prompt Injection Guard.
8. Execution Sandbox. Docker container per task, restricted filesystem/network.
9. Output Validation. Scan for leaked secrets before sending to channels.
10. Audit Trail. Immutable hash chain, 1-year retention.

## Architecture

```
Channel Adapters (WhatsApp, Slack, Telegram, Discord, CLI, Web Chat)
        ↓
3-Tier Intent Parsing (regex → Claude Haiku NLU → Claude Sonnet smart response)
        ↓
Agent Layer (Supervisor → Project/Task/Review/Deploy/Incident/Planning/Lens/Coordinator)
        ↓
Self-healing Loop (smart alerts → auto-fix → autonomous healing L3-L5)
        ↓
Execution Engine (GitHub API + Claude Sonnet)
        ↓
Storage (PostgreSQL 16, FileStorage fallback)
        ↓
Plugin System (pluginRegistry, PolicyHook, ObservabilityHook, SecretsHook)
        ↓
Observability (Claude API instrumentation, Vercel/Railway metrics, Recharts dashboards)
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js 22 + TypeScript 5.4 |
| Framework | Fastify 5 |
| Database | PostgreSQL 16 via Drizzle ORM (FileStorage fallback for development) |
| Cache/Queue | Redis 7 (Streams + Pub/Sub) |
| ORM | Drizzle ORM |
| AI | Anthropic Messages API (Claude Sonnet, Claude Haiku) |
| Execution | Docker containers (pooled) |
| Monorepo | Turborepo |
| Deploy | Railway, Docker Compose |

## Modular Docker Compose

Pick only the channels you need:

```bash
# WhatsApp only
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up

# WhatsApp + Slack
docker compose -f docker-compose.yml \
  -f docker-compose.whatsapp.yml \
  -f docker-compose.slack.yml up

# Everything
docker compose -f docker-compose.full.yml up
```

## Development

Get started locally without Docker:

```bash
git clone https://github.com/codespar/codespar.git
cd codespar
npm install
npm run build
npm start  # starts the CLI adapter
```

The CLI adapter provides a terminal interface for testing agents without configuring external channels. For full multi-channel support, use Docker Compose (see [Modular Docker Compose](#modular-docker-compose) above).

Other useful commands:

```bash
npm run dev    # development mode with watch
npm run lint   # run linter
npm test       # run all tests
```

## Links

| | URL |
|--|-----|
| Website | https://codespar.dev |
| Docs | https://docs.codespar.dev |
| Blog | https://codespar.dev/blog |
| Dashboard | https://codespar.dev/dashboard |
| Backend | codespar-production.up.railway.app |

## Enterprise

CodeSpar Enterprise adds production monitoring integrations, MCP connectors, and advanced incident response on top of the open source core.

| Feature | Open Source (MIT) | Enterprise |
|---------|------------------|------------|
| Core engine | 8 agents, 6 channels, 24 commands, RBAC, audit, self-healing | Included |
| Integrations | GitHub webhooks (CI/CD) | Sentry, Datadog, PagerDuty, New Relic, Grafana, Jira, Linear |
| Protocol | REST webhooks | MCP (Model Context Protocol), custom connectors |
| Analysis | Build failure investigation | Production error root cause, performance regression |
| Fix automation | PR creation via GitHub API | Auto-fix with test validation, staging deploy + verify |
| Dashboard | Overview, audit, agents | Integration marketplace, SLA tracking, cost analytics |
| Infrastructure | FileStorage, single instance | PostgreSQL, Redis, horizontal scaling |
| Auth | Clerk basic | SSO/SAML, custom RBAC policies, audit compliance |
| Support | Community (GitHub Issues) | Dedicated, SLA |

Contact: [enterprise@codespar.dev](mailto:enterprise@codespar.dev)

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Write a custom agent** in ~300 lines of TypeScript
- **Write a channel adapter** by implementing one interface
- **Report issues.** We respond within 48h.
- **Propose changes** via RFC process for architectural decisions

## License

[MIT](LICENSE). No asterisks.

The entire platform (every agent type, every channel adapter, the supervisor, the policy engine, the audit system) is in this repo under MIT license.

---

<p align="center">
  <strong>code&lt;spar&gt;</strong><br>
  <em>Your projects deserve dedicated agents.</em>
</p>
