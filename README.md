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
| Project Agent (L1 Notify) | ✅ Working |
| Task Agent (ephemeral) | ✅ Working |
| Deploy Agent + Approvals | ✅ Working |
| RBAC (6 roles) | ✅ Working |
| Audit Trail | ✅ Working |
| GitHub Webhooks | ✅ Ready |
| Slack Adapter | ✅ Ready (needs tokens) |
| WhatsApp Adapter | 🔄 In Progress |
| Docker Compose | ✅ Ready |

---

**CodeSpar** is an open source, multi-agent platform that deploys autonomous AI coding agents to **WhatsApp**, **Slack**, **Telegram**, and **Discord** via `@mention` commands.

Each project gets its own persistent agent that monitors builds, investigates failures, proposes fixes, and orchestrates deploys — all controllable from your messaging channels.

## Quick Start

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

✅ [agent-gw] Build #348 — api-gateway (main)
   142/142 tests | 87.5% coverage | 3m12s
```

## Configuration

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key for Claude Code execution | `sk-ant-...` |

### Channel Configuration

Enable channels by setting their env vars. All channels are optional — enable only what you need.

**WhatsApp (via Evolution API):**
| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_WHATSAPP` | Enable WhatsApp adapter | `false` |
| `EVOLUTION_API_URL` | Evolution API base URL | `http://localhost:8084` |
| `EVOLUTION_API_KEY` | Evolution API auth key | — |
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

### Infrastructure (auto-configured in Docker)

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `3000` |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://...` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `GITHUB_TOKEN` | GitHub API token for webhooks/PRs | — |
| `CODESPAR_WORK_DIR` | Working directory for Claude Code | `process.cwd()` |
| `PROJECT_NAME` | Default project name | `default` |

## What It Does

| You type | Agent does |
|----------|-----------|
| `@codespar status build` | Reports build status, test coverage, duration |
| `@codespar fix [issue]` | Investigates, proposes fix, creates draft PR |
| `@codespar deploy staging` | Runs pre-checks, requests approval, deploys |
| `@codespar rollback prod` | Requires quorum (2 approvals), rolls back |

## Six Agent Types

| Agent | Lifecycle | What it does |
|-------|----------|-------------|
| **Project Agent** | Persistent | Monitors repo, CI/CD, channels. Handles all @mention commands. |
| **Task Agent** | Ephemeral | Executes coding tasks in isolated Docker containers. |
| **Review Agent** | Ephemeral | Analyzes PRs. Auto-approves low-risk per policy. |
| **Deploy Agent** | Ephemeral | Orchestrates deploys with approvals and health monitoring. |
| **Incident Agent** | Ephemeral | Investigates production errors. Correlates with recent changes. |
| **Coordinator** | Persistent | Cross-project orchestration. Cascading deploys, shared locks. |

## Five Channels, Same Syntax

| Channel | Status | Connection |
|---------|--------|-----------|
| WhatsApp | First-class | Evolution API (QR scan, session management) |
| Slack | Official API | OAuth + Bot token |
| Telegram | Official API | BotFather token |
| Discord | Official API | Bot token + Gateway |
| CLI | Built-in | Terminal (dev/debug) |

The agent layer never knows which channel is being used. Every message is normalized to a `NormalizedMessage` before reaching any agent.

## Graduated Autonomy

Agents earn trust over time. You control the pace.

| Level | Name | Behavior |
|-------|------|----------|
| L0 | Passive | Only responds when addressed |
| L1 | **Notify** | Monitors and alerts. Never auto-executes. **Default.** |
| L2 | Suggest | Proposes actions proactively. Requires approval. |
| L3 | Auto-Low | Auto-executes low-risk (format, lint). Notifies after. |
| L4 | Auto-Med | Auto-executes medium-risk (bug fixes, PR reviews). |
| L5 | Full Auto | Autonomous within policy bounds. |

> **Safety guardrail:** Regardless of autonomy level, agents **never** auto-execute: production deployments, data migrations, security-sensitive changes, or infrastructure modifications. These always require human approval.

## Security: 10 Defense Layers

1. Message Filter — only process @mentions and DMs
2. Channel Config — ignore unconfigured channels
3. Identity Resolution — map channel user → unified user
4. RBAC — 6 roles (owner → read-only + emergency_admin)
5. ABAC Policies — time windows, environment restrictions, quorum
6. Agent Sandboxing — each agent scoped to project, no cross-project data
7. Prompt Injection Defense — pattern blocklist + risk classifier + template isolation
8. Execution Sandbox — Docker container per task, restricted filesystem/network
9. Output Validation — scan for leaked secrets before sending to channels
10. Audit Trail — immutable hash chain, 1-year retention

## Architecture

```
Channel Adapters (WhatsApp, Slack, Telegram, Discord, CLI)
        ↓
Message Router + Intent Parser
        ↓
Agent Layer (Supervisor → Project/Task/Review/Deploy/Incident/Coordinator)
        ↓
Execution Engine (Docker containers + Claude Code)
```

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js 22 + TypeScript 5.4 |
| Framework | Fastify 5 |
| Database | PostgreSQL 16 + pgvector |
| Cache/Queue | Redis 7 (Streams + Pub/Sub) |
| ORM | Drizzle ORM |
| AI | Claude Agent SDK |
| Execution | Docker containers (pooled) |
| Monorepo | Turborepo |

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

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

- **Write a custom agent** in ~300 lines of TypeScript
- **Write a channel adapter** by implementing one interface
- **Report issues** — we respond within 48h
- **Propose changes** via RFC process for architectural decisions

## License

[MIT](LICENSE) — no asterisks.

The entire platform — every agent type, every channel adapter, the supervisor, the policy engine, the audit system — is in this repo under MIT license.

---

<p align="center">
  <strong>code&lt;spar&gt;</strong><br>
  <em>Your projects deserve dedicated agents.</em>
</p>
