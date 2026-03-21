# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-21

### Added
- Six agent types: Project (persistent), Task/Dev, Review, Deploy, Incident (ephemeral), Coordinator (persistent)
- Five channel adapters: Slack (Socket Mode), WhatsApp (Evolution API v2.3.7), Discord, Telegram, CLI
- Dev Agent: reads codebase via GitHub API, creates PRs with Claude Sonnet
- Review Agent: fetches PR data, risk classification (low/medium/high), auto-approve at L3+
- Deploy Agent: approval workflows with quorum (1 staging, 2 production), cross-channel voting
- Incident Agent: CI failure investigation, error correlation, root cause analysis
- Coordinator Agent: cross-project orchestration, cascading deploys, status aggregation
- 17 commands with regex parser + Claude Haiku NLU fallback
- Smart responses via Claude Sonnet for open-ended questions (multilingual)
- Graduated autonomy L0-L5 with safety guardrails
- RBAC: 6 roles (owner, maintainer, operator, reviewer, read-only, emergency_admin), 15 permissions
- Approval system: token-based, quorum, self-approval blocking, expiration
- Audit trail: append-only, hash chain integrity
- Identity system: cross-channel user mapping, register command
- Vector memory: hash-based embeddings, cosine similarity search
- Multi-tenant: x-org-id header, FileStorage org scoping
- REST API: 25+ endpoints (agents, audit, projects, channels, memory, orgs, webhooks, metrics, newsletter)
- Rate limiting: 100 req/min API, 30 req/min webhooks
- Webhook signature validation: HMAC-SHA256
- Newsletter: subscriber storage + Resend welcome emails
- Agent plugin registry: registerAgentType for custom agents
- Docker execution sandbox interfaces (contract for future implementation)
- Structured logging (JSON prod, pretty dev) + metrics collector
- GitHub Actions CI/CD (build + test on push/PR)
- Documentation site: 53 pages (docs.codespar.dev, Fumadocs MDX)
- Unit tests: 85 tests (Intent Parser, RBAC, FileStorage, Identity)

### Infrastructure
- Turborepo monorepo with 13 TypeScript packages
- Fastify 5 HTTP server
- Docker Compose (base + channel-specific overrides)
- Railway deployment (backend)
- Vercel deployment (docs site)
