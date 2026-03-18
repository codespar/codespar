# CodeSpar — Project Instructions

## What is CodeSpar
Open source, multi-agent platform that deploys autonomous AI coding agents to WhatsApp, Slack, Telegram, and Discord via @mention commands. Each project gets its own persistent agent that monitors builds, investigates failures, proposes fixes, and orchestrates deploys on behalf of the team.

**Not a chatbot. Not a code assistant. Not a message relay. A multi-agent platform.**

**Tagline:** "Autonomous agents for every project. Deployed where your team works."

## Repository Strategy

This is the **public** repo (`codespar/codespar`). MIT License. The entire platform lives here — every agent type, every channel adapter, the supervisor, the policy engine, the audit system, and the documentation site.

| Repo | Visibility | Contents |
|------|-----------|----------|
| `codespar/codespar` | **Public** (MIT) | Core engine, agents, channels, bridges, docs site (Fumadocs) |
| `codespar/codespar-web` | **Private** | Marketing homepage, dashboard (future) |

## Language
- All code, comments, file names, docs: **English**
- Conversation with user: **Portuguese**

## Project Structure
```
codespar/
  CLAUDE.md                          # This file
  turbo.json                         # Turborepo config
  package.json                       # Root workspace
  docker-compose.yml                 # Core: PostgreSQL + Redis + core
  docker-compose.whatsapp.yml        # Override: adds WhatsApp adapter
  docker-compose.slack.yml           # Override: adds Slack adapter
  docker-compose.full.yml            # Override: all channels
  packages/
    core/                            # @codespar/core
      src/
        router/                      # Message router + intent parser
          message-router.ts
          intent-parser.ts           # Regex MVP, Claude Haiku v1
          context-resolver.ts
        policy/                      # RBAC + ABAC policy engine
          rbac.ts                    # 6 roles
          abac.ts                    # YAML policy evaluator
          quorum.ts                  # Approval quorum manager
        audit/                       # Immutable audit trail
          audit-log.ts               # Hash chain integrity
        auth/                        # Identity resolution
          identity.ts                # Cross-channel user mapping
        queue/                       # Task queue (Redis Streams)
          task-queue.ts
        formatter/                   # Response formatter per channel
          response-formatter.ts
        types/                       # Shared types
          normalized-message.ts      # NormalizedMessage interface
          channel-adapter.ts         # ChannelAdapter interface
          agent.ts                   # Agent interface + states
          policy.ts                  # Policy types
          approval.ts                # Approval types
    agents/
      supervisor/                    # @codespar/agent-supervisor
        src/
          supervisor.ts              # Agent lifecycle management
          health.ts                  # Heartbeat, auto-restart
          scaling.ts                 # Resource limits, backpressure
      project/                       # @codespar/agent-project
        src/
          project-agent.ts           # Persistent, per-project agent
          context.ts                 # Codebase graph, team knowledge
          event-handler.ts           # CI/CD webhook handling
      task/                          # @codespar/agent-task
        src/
          task-agent.ts              # Ephemeral, Claude Code execution
          docker-pool.ts             # Container pool management
          constraint.ts              # Allowed tools, blocked patterns
      review/                        # @codespar/agent-review
        src/
          review-agent.ts            # PR analysis, code quality
      deploy/                        # @codespar/agent-deploy
        src/
          deploy-agent.ts            # Deploy orchestration
          health-check.ts            # Post-deploy monitoring
          rollback.ts                # Automatic rollback
      incident/                      # @codespar/agent-incident
        src/
          incident-agent.ts          # Error investigation
          correlator.ts              # Change correlation
      coordinator/                   # @codespar/agent-coordinator
        src/
          coordinator-agent.ts       # Cross-project orchestration
          resource-lock.ts           # Shared resource locks
    channels/
      whatsapp/                      # @codespar/channel-whatsapp
        src/
          adapter.ts                 # ChannelAdapter implementation (via Evolution API)
          webhook.ts                 # Incoming message webhook handler
      slack/                         # @codespar/channel-slack
        src/
          adapter.ts                 # Bolt.js adapter
          block-kit.ts               # Block Kit formatter
          modals.ts                  # Modal interactions
      telegram/                      # @codespar/channel-telegram
        src/
          adapter.ts                 # grammy adapter
          inline-keyboard.ts         # Inline keyboard builder
      discord/                       # @codespar/channel-discord
        src/
          adapter.ts                 # discord.js adapter
          embeds.ts                  # Embed builder
      cli/                           # @codespar/channel-cli
        src/
          adapter.ts                 # Terminal adapter (dev/debug)
    bridges/
      claude-code/                   # @codespar/bridge-claude-code
        src/
          executor.ts                # Claude Code CLI wrapper
          docker.ts                  # Container management
          progress.ts                # Progress streaming
      github/                        # @codespar/bridge-github
        src/
          api.ts                     # GitHub API client
          webhooks.ts                # Webhook handler
    plugins/                         # @codespar/plugin-sdk
      src/
        sdk.ts                       # Plugin interface
  apps/
    docs/                            # Fumadocs documentation site
      app/
        layout.tsx
        page.tsx                     # Docs landing
        docs/
          [[...slug]]/page.tsx       # Catch-all docs route
      content/                       # MDX content
        getting-started/
          index.mdx
          quickstart.mdx
          first-agent.mdx
          connect-whatsapp.mdx
          connect-slack.mdx
        architecture/
          index.mdx
          multi-agent.mdx
          agent-lifecycle.mdx
          agent-types.mdx
          autonomy-levels.mdx
          channel-adapters.mdx
        agents/
        channels/
        security/
        config/
        api/
        contributing/
        reference/
      components/                    # Docs-specific components
        callout.tsx
        step.tsx
        tabs.tsx
  migrations/                        # Drizzle ORM migrations
  scripts/                           # Dev/deploy scripts
  tests/                             # Integration tests (Vitest + Testcontainers)
```

## Tech Stack

### Runtime & Framework
- **Node.js 22** + **TypeScript 5.4** (strict mode)
- **Fastify 5** — webhooks, dashboard API, health checks
- **Turborepo** — monorepo management, separate packages per agent/channel

### Data Layer
- **PostgreSQL 16** — primary database (JSONB, pgcrypto, audit log)
- **pgvector** — agent memory embeddings, semantic search
- **Drizzle ORM** — type-safe, lightweight, migrations via drizzle-kit
- **Redis 7** — Streams (agent communication bus, task queues), Pub/Sub (progress events), rate limits

### Channel SDKs
- **Evolution API** (WhatsApp) — REST wrapper over Baileys (community-maintained, 7.5k+ stars), handles QR pairing, session management, reconnection, and anti-ban
- **@slack/bolt 4** (Slack) — events, modals, slash commands
- **grammy** (Telegram) — middleware pattern, inline keyboards
- **discord.js 14** (Discord) — slash commands, embeds, components

### AI & Execution
- **Claude Agent SDK** — hooks, sessions, subagents, MCP
- **Docker** — isolated container per task execution, pooled for fast startup

### Observability & Quality
- **Pino** — structured JSON logging, secret redaction
- **Prometheus + Grafana** — metrics, agent-level dashboards
- **Vitest + Testcontainers** — tests with real containers
- **Biome** — replaces ESLint + Prettier

### Docs Site
- **Fumadocs** — Next.js native, MDX, built-in search (Flexsearch)
- **Shiki** — build-time syntax highlighting with custom brand theme

### Secrets & Deploy
- **SOPS** (MVP) / **HashiCorp Vault** (v1) — secret management
- **Docker Compose** — modular overrides per channel

## Architecture

### Core Principle: Channel-Agnostic
The agent layer never knows which channel is being used. Every incoming message is normalized to a `NormalizedMessage` before reaching any agent.

```typescript
interface NormalizedMessage {
  id: string;
  channelType: 'whatsapp' | 'slack' | 'telegram' | 'discord' | 'cli';
  channelId: string;
  channelUserId: string;
  isDM: boolean;
  isMentioningBot: boolean;
  text: string;               // after @mention removal
  replyToMessageId?: string;
  threadId?: string;
  attachments?: Attachment[];
  timestamp: Date;
}
```

### System Layers
| Layer | Responsibility | Components |
|-------|---------------|------------|
| Channel Adapters | Receive/send messages, normalize format | WhatsApp, Slack, Telegram, Discord, CLI |
| Message Router | Route to correct agent, resolve context | Filter engine, context resolver, identity mapper |
| Agent Layer | Persistent + ephemeral agents, autonomy | Supervisor, Project/Task/Review/Deploy/Incident/Coordinator |
| Intent Parser | Classify message into intent + params | Regex (MVP), Claude Haiku NLU (v1) |
| Policy Engine | RBAC + ABAC, allow/deny/confirm | Rule evaluator, YAML policies, quorum manager |
| Response Formatter | Adapt responses to channel capabilities | Block Kit (Slack), Inline KB (Telegram), Text (WA), Embeds (Discord) |
| Execution Engine | Isolated Claude Code in Docker | Container pool, CLI wrapper, progress streaming |
| Data Layer | Persist entities, sessions, audit logs | PostgreSQL, Redis, vector store |

### ChannelAdapter Interface
Every channel implements this interface:

| Method | Purpose |
|--------|---------|
| `connect()` | Establish connection (QR, OAuth, token) |
| `disconnect()` | Graceful shutdown |
| `onMessage(handler)` | Register message handler (receives NormalizedMessage) |
| `onInteraction(handler)` | Register button/modal handler |
| `sendToChannel(id, response)` | Send to group/channel |
| `sendDM(userId, response)` | Send private message |
| `sendConfirmation(userId, approval)` | Send approval request |
| `getCapabilities()` | Return channel features |
| `healthCheck()` | Verify connection alive |

## Agent Types

| Agent | Lifecycle | Spawned By | Responsibility |
|-------|----------|-----------|----------------|
| Project Agent | Persistent | System (on project creation) | Monitors repo, CI/CD, channels. Maintains codebase context. Handles @mention. |
| Task Agent | Ephemeral | Project Agent | Executes coding tasks in isolated Docker containers. |
| Review Agent | Ephemeral | Project Agent (on PR event) | Reviews PRs, code quality. Auto-approves low-risk per policy. |
| Deploy Agent | Ephemeral | Project Agent (on deploy request) | Orchestrates deployment: pre-checks, approvals, health, rollback. |
| Incident Agent | Ephemeral | Project Agent (on critical alert) | Investigates production errors. Correlates with recent changes. |
| Coordinator | Persistent | System (on org creation) | Cross-project orchestration. Cascading deploys, shared locks. |

### Agent Lifecycle States
```
INITIALIZING → IDLE → ACTIVE → WAITING_APPROVAL → IDLE
                 ↓       ↓              ↓
              SUSPENDED  ERROR      IDLE (denied/expired)
                 ↓       ↓
                IDLE   INITIALIZING (restart) | TERMINATED
```

### Agent Autonomy Levels
| Level | Name | Behavior | Use Case |
|-------|------|----------|----------|
| L0 | Passive | Only responds when addressed | New projects, conservative teams |
| L1 | Notify | Monitors and alerts, never auto-executes | Default for new projects |
| L2 | Suggest | Proposes actions proactively, requires approval | Established projects |
| L3 | Auto-Low | Auto-executes low-risk (format, lint), notifies after | Trusted projects |
| L4 | Auto-Med | Auto-executes medium-risk (bug fixes, PR reviews) | High-trust, experienced teams |
| L5 | Full Auto | Autonomous within policy bounds | Mature projects with policies |

**Safety guardrail:** Regardless of autonomy level, agents NEVER auto-execute: production deployments, data migrations, security-sensitive changes, or infrastructure modifications. Always require human approval.

## Security — 10 Defense Layers

| # | Layer | Details |
|---|-------|---------|
| 1 | Message Filter | Only process @mentions and DMs |
| 2 | Channel Config | Ignore unconfigured channels |
| 3 | Identity Resolution | Map channel user → unified user (phone_hash, Slack UID, etc.) |
| 4 | RBAC | 6 roles: owner, maintainer, operator, reviewer, read-only, emergency_admin |
| 5 | ABAC Policy | Time windows, environments, criticality, quorum, autonomy caps |
| 6 | Agent Sandboxing | Each agent scoped to project, no cross-project data |
| 7 | Prompt Injection Defense | Pattern blocklist + risk classifier + template isolation |
| 8 | Execution Sandbox | Docker container per task, restricted filesystem/network |
| 9 | Output Validation | Scan for leaked secrets, tokens, internal IPs |
| 10 | Audit Trail | Immutable hash chain, 1-year retention |

### Agent Permission Model
Agents do NOT have independent permissions. They always act on behalf of a user:
- **Invoked actions:** Agent executes with the invoking user's permissions
- **Autonomous actions:** Uses "agent service account" (intersection of all members' permissions at L1)
- **Escalation:** If autonomous action requires higher permissions, escalates to appropriate human

### RBAC Permission Matrix
| Action | owner | maintainer | operator | reviewer | read-only |
|--------|-------|-----------|----------|----------|-----------|
| View status / diffs | yes | yes | yes | yes | yes |
| Instruct agent | yes | yes | yes | — | — |
| Deploy staging | yes | yes | yes | — | — |
| Deploy production | yes (q2) | yes (q2) | — | — | — |
| Set autonomy level | yes | yes | L0-L2 | — | — |
| Kill switch | yes | — | — | — | — |

*q2 = requires quorum of 2 approvals from distinct users*

## Data Model (Core Entities)

| Entity | Key Fields | Purpose |
|--------|-----------|---------|
| users | id, email, display_name, status, totp_secret | Unified user identity |
| channel_identities | user_id, channel_type, channel_user_id | Per-channel identity |
| organizations | id, name, slug, settings | Workspace/team grouping |
| projects | org_id, name, slug, repo_url, repo_provider | Code repository mapping |
| agents | id, project_id, type, status, autonomy_level, config | Agent registry and state |
| agent_context | agent_id, key, value, embedding | Persistent agent memory |
| channel_links | channel_type, channel_id, org_id, project_id | Channel → project binding |
| tasks | agent_id, user_id, project_id, input, intent, risk_score, status | Every command/task |
| executions | task_id, type, input, output, status, container_id, duration_ms | Claude Code executions |
| approvals | execution_id, required_quorum, status, approval_token, expires_at | Approval requests |
| approval_votes | approval_id, user_id, channel_type, vote | Individual votes |
| audit_log | prev_hash, event_hash, actor_type, actor_id, action, result | Immutable event chain |
| policies | org_id, name, rules (JSON), priority, enabled | ABAC policy definitions |

### Key Relationships
- organizations →1:N→ projects →1:1→ Project Agent →1:N→ Task Agents
- organizations →1:1→ Coordinator Agent
- projects →1:N→ channel_links
- projects →1:N→ tasks →1:N→ executions →0:1→ approvals →1:N→ approval_votes
- agents →1:N→ agent_context

## Command Reference

| Command | Description | Role | Risk |
|---------|------------|------|------|
| `@codespar status [build\|agent\|all]` | Query current status | read-only+ | Low |
| `@codespar diff [branch\|PR]` | Show code diff | read-only+ | Low |
| `@codespar instruct [task]` | Instruct agent to execute | operator+ | Medium |
| `@codespar fix [issue]` | Investigate and propose fix | operator+ | Medium |
| `@codespar deploy [env]` | Trigger deployment | operator+ (staging) / maintainer+ (prod) | High/Critical |
| `@codespar rollback [env]` | Rollback last deploy | maintainer+ | Critical |
| `@codespar approve [token]` | Approve pending action | per policy | Varies |
| `@codespar autonomy [L0-L5]` | Set autonomy level | operator+ (L0-L2) / owner (L3+) | Medium |
| `@codespar logs [n]` | Show recent activity | reviewer+ | Low |
| `@codespar kill` | Emergency shutdown | emergency_admin | Critical |

## UX Writing & Agent Tone

### Communication Principles
1. **Functional, not cute** — team member, not virtual assistant
2. **Scannable** — emoji as semantic markers, not decoration
3. **Agent-identified** — agent name and project shown in every message
4. **Autonomy-transparent** — always clear if agent acted autonomously or by instruction
5. **Channel-adapted** — plain text (WA), Block Kit (Slack), embeds (Discord)
6. **Never alarmist** — factual, no pressure

### Message Format Examples
```
✅ [agent-gw] Build #348 — api-gateway (main) | 142/142 tests | 87.5% | 3m12s
🔍 [agent-gw] Build #349 broken. Investigating... (autonomous, L2)
🛡️ [agent-gw] No permission for production deploy. Your role: reviewer. Required: maintainer+.
✅ [agent-gw] Fix approved (2/2 — Fabiano via WhatsApp, Maria via Slack). Applying...
```

## Claude Code Integration

### Execution Model
- **Isolation:** Each task runs in a dedicated Docker container with cloned repo, restricted filesystem, limited network (only npm registry + GitHub API)
- **Timeout:** Default 5 min, max 30 min, configurable per project
- **Cancellation:** SIGTERM → 10s graceful → SIGKILL → git reset → notify agent
- **Idempotency:** UUID v7 per task; Redis SET NX for deduplication; results cached 24h
- **Progress:** Streaming via Redis Pub/Sub

### Constraint System
Every instruction to Claude Code includes:
- `allowed_tools`: read, write, edit, bash (configurable per project)
- `blocked_patterns`: rm -rf, DROP, force push, curl, wget
- `blocked_files`: .env*, *.pem, *.key, credentials*
- `require_diff_review`: true
- `auto_commit`: based on autonomy level

## Events & Proactive Behavior

| Event | Priority | Agent Response (L2+) | Human Action |
|-------|---------|---------------------|--------------|
| Build broken (main) | Critical | Investigates, proposes fix, creates draft PR | Approve/reject |
| Deploy pending | High | Sends approval request with summary | Approve/deny |
| PR ready for review | Medium | Review Agent posts review summary | Merge or request changes |
| Critical prod error | Critical | Incident Agent investigates, correlates | Approve hotfix or rollback |
| Flaky test detected | Low | Task Agent investigates, proposes fix | Approve when ready |

### Anti-Spam & Quiet Hours
- Max 10 messages/channel/hour (WhatsApp: 5)
- Non-critical alerts batched in 5-minute windows
- Quiet hours: 22:00-08:00 (only critical breaks through)

## Roadmap

### MVP (Weeks 1-4)
- Channels: WhatsApp (Evolution API) + CLI
- Agents: Project Agent (L1 Notify) + Task Agents
- Features: Build status, alerts, instruct agent, single approval, basic agent memory
- Security: Allowlist, @mention filter, command blocklist, audit log, DM escalation
- Deploy: Docker Compose single node

### Beta (Months 2-3)
- Channels: + Slack adapter
- Agents: + Review Agent, Deploy Agent, Coordinator. Autonomy L0-L3.
- Security: RBAC (6 roles), secure invite, multi-channel identity

### v1.0 (Months 4-6)
- Channels: + Telegram, Discord
- Agents: + Incident Agent, L4-L5, agent-to-agent coordination, vector memory
- Security: ABAC, MFA for prod, kill switch, prompt injection classifier
- Features: NLU (Claude Haiku), web dashboard, plugin SDK

## Coding Conventions

### General
- TypeScript strict mode everywhere
- Fastify for HTTP (webhooks, API, health checks)
- Drizzle ORM with PostgreSQL, migrations via drizzle-kit
- Biome for linting + formatting (replaces ESLint + Prettier)
- Pino for structured JSON logging with secret redaction

### Package Organization
- One package per agent type (`@codespar/agent-project`, `@codespar/agent-task`, etc.)
- One package per channel adapter (`@codespar/channel-whatsapp`, `@codespar/channel-slack`, etc.)
- Core shared types in `@codespar/core`
- Every package has its own `package.json`, `tsconfig.json`, `src/`, `tests/`

### Naming
- Files: kebab-case (`project-agent.ts`, `webhook.ts`)
- Classes/Interfaces: PascalCase (`ProjectAgent`, `NormalizedMessage`)
- Functions/Variables: camelCase (`handleMessage`, `agentContext`)
- Database tables: snake_case (`agent_context`, `approval_votes`)
- Redis keys: colon-delimited (`codespar:agent:{id}:status`)

### Testing
- Vitest for unit + integration tests
- Testcontainers for PostgreSQL + Redis in tests
- Agent behavior tests: simulate message → verify response + side effects
- Channel adapter tests: mock platform SDK, verify NormalizedMessage output

### Error Handling
- Never swallow errors silently — log and propagate
- Agent errors: transition to ERROR state, alert admins, attempt auto-restart
- Channel errors: retry with exponential backoff, fall back to other channels
- Execution errors: git reset, notify agent, record in audit log

## Docker Compose (Modular)

```bash
# WhatsApp only
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml up

# Slack only
docker compose -f docker-compose.yml -f docker-compose.slack.yml up

# WhatsApp + Slack
docker compose -f docker-compose.yml -f docker-compose.whatsapp.yml -f docker-compose.slack.yml up

# Everything
docker compose -f docker-compose.full.yml up
```

## Engineering Preferences

IMPORTANT — Use these to guide every recommendation, review, and code change:

- **DRY is important** — flag repetition aggressively.
- **"Engineered enough"** — not under-engineered (fragile, hacky) and not over-engineered (premature abstraction, unnecessary complexity).
- **Handle more edge cases, not fewer.** Thoughtfulness > speed.
- **Explicit over clever.** Bias toward readability.
- **Readability over cleverness.** If it's hard to follow, simplify it.

---

## Plan Mode — Code Review Protocol

Review this plan thoroughly before making any code changes. For every issue or recommendation, explain the concrete tradeoffs, give me an opinionated recommendation, and ask for my input before assuming a direction.

### BEFORE YOU START

Ask if I want one of two options:

1. **BIG CHANGE:** Work through this interactively, one section at a time (Structure > Code Quality > Security > Performance) with at most 4 top issues in each section.
2. **SMALL CHANGE:** Work through interactively ONE question per review section.

### 1. Structure Review
- Package architecture and module boundaries
- Agent/channel interface consistency
- Separation of concerns (router vs. agent vs. channel)

### 2. Code Quality Review
- TypeScript strictness, type safety
- Error handling and edge cases
- Consistency with interfaces and naming conventions

### 3. Security Review
- Permission checks on every action path
- Prompt injection defense coverage
- Audit trail completeness
- Secret handling (no hardcoded credentials)

### 4. Performance Review
- Redis usage efficiency (Streams vs. Pub/Sub)
- Docker container pool management
- Query performance (indexes, N+1)
- Agent memory/context size limits

### For Each Issue Found
1. **Describe the problem concretely**, with file and line references.
2. **Present 2-3 options**, including "do nothing" where reasonable.
3. **For each option specify:** implementation effort, risk, impact, maintenance burden.
4. **Give your recommended option and why**, mapped to engineering preferences.
5. **Then explicitly ask** whether I agree or want a different direction.

### Interaction Rules
- NUMBER all issues (e.g., Issue #1, Issue #2).
- Give LETTERS for options (e.g., A, B, C).
- IMPORTANT: Make the recommended option always the 1st option.
- Do not assume my priorities on timeline or scale.
- After each section, pause and ask for feedback before moving on.

---

## Workflow Standards

### Plan Before You Code
1. **Explore** — read relevant files, understand context. Do NOT write code yet.
2. **Plan** — think hard about the approach. Propose a plan with tradeoffs.
3. **Implement** — only after approval. Verify correctness as you go.
4. **Verify** — run tests, check types, verify agent behavior.
5. **Commit** — descriptive commit message. Update docs if behavior changes.

### Git Workflow
**Branch Strategy:**
- `main` — stable, tested code only
- `feature/<name>` — new features (e.g., `feature/slack-adapter`, `feature/review-agent`)
- `fix/<name>` — bug fixes

**Rules:**
- Always create a new branch for each task
- Keep diffs small and focused
- Write commit messages that explain *why*, not just *what*
- NEVER commit directly to main (except initial setup)
- PRs that change agent/channel behavior MUST update relevant docs

---

## Quick Commands

### QPLAN
Analyze similar parts of the codebase and determine whether your plan is consistent, introduces minimal changes, and reuses existing interfaces. Present the plan for review. Do NOT code yet.

### QCODE
Implement your plan. Verify type safety, test coverage, and interface compliance.

### QCHECK
Skeptical senior engineer review: check engineering preferences, verify edge cases (error handling, timeouts, race conditions), flag DRY violations, verify security layers, check interface compliance.

### QTEST
Run full test suite. Report failures with context. Suggest fixes for failing tests.

### QSTATUS
Show current project status: packages built vs. planned, test coverage, open TODOs, current branch.

---

## Quality Checklist (before committing)

### Core Packages
- [ ] TypeScript compiles without errors (strict mode)
- [ ] All tests pass (Vitest)
- [ ] New code has test coverage
- [ ] Interfaces match ChannelAdapter / Agent contracts
- [ ] Error states handled (log + propagate + audit)
- [ ] No hardcoded secrets or credentials
- [ ] Audit log entries for all side-effect actions
- [ ] Biome formatting passes

### Channel Adapters
- [ ] Implements full ChannelAdapter interface
- [ ] Normalizes messages to NormalizedMessage correctly
- [ ] Handles reconnection gracefully
- [ ] Confirmation strategy matches security spec (DM for high-risk)
- [ ] Rate limiting implemented

### Agent Packages
- [ ] Implements Agent interface (onMessage, onEvent, getStatus)
- [ ] Respects autonomy level boundaries
- [ ] Escalates properly when permissions insufficient
- [ ] Context/memory properly scoped to project
- [ ] Cleanup on TERMINATED state

### Documentation
- [ ] New features have corresponding MDX page
- [ ] Code examples are copy-paste ready (no pseudo-code)
- [ ] Internal links resolve
- [ ] Troubleshooting callout on tutorial steps

---

## Context Management
- Use `/clear` between distinct tasks to reset context.
- Use `PLAN.md` or `SCRATCHPAD.md` for complex tasks.
- Break work into small, independently testable chunks.
- Use subagents for distinct phases (implement, review).

---

## What NOT to Do
- NEVER bypass security layers. Every action with side effects needs verification.
- NEVER allow agents to act outside their autonomy level.
- NEVER share agent context across project boundaries.
- NEVER auto-execute production deploys regardless of autonomy level.
- NEVER commit directly to main (except initial setup).
- NEVER store secrets in code. Use environment variables + SOPS.
- NEVER add unnecessary dependencies. Evaluate bundle impact.
- NEVER assume priorities on timeline or scale.
- NEVER proceed past a review section without explicit approval.
- NEVER concatenate user input directly into system prompts (prompt injection).
