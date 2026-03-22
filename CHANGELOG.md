# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-22

### Added
- Planning Agent: breaks features into 3-8 sequential sub-tasks with approval flow before execution
- Parallel task execution: up to 3 concurrent tasks per Project Agent with automatic queue and dequeue
- Multi-file refactoring: smart file picker selects up to 15 files, 30KB context per file, refactoring-optimized prompts
- Enterprise connectors: Sentry (Beta), Linear (Beta), Jira (Beta) integrations with IntegrationConnector interface; framework upgrade guides for Next.js 14-15, React 18-19, Angular 16-18 (codespar-enterprise repo, commercial license)
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
- 19 commands with regex parser + Claude Haiku NLU fallback (includes merge PR, plan)
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
