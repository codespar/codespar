---
status: Draft
problem: |
  The core engine service in all docker-compose files has no healthcheck
  and no restart policy. If the engine crashes or hangs, the container
  stays in "running" state with no automatic recovery. A self-hosted
  deployment has no built-in resilience.
goals: |
  The engine container reports its health to Docker, restarts
  automatically on failure, and operators can see health status via
  docker compose ps.
---

# PRD: Docker Healthcheck and Restart Policy

## Status

Draft

## Problem Statement

The `core` service in `docker-compose.yml` (and all override files) has no
healthcheck configured. PostgreSQL and Redis both have healthchecks — the
`core` service uses `condition: service_healthy` to wait for them — but the
engine itself never reports its own health to Docker.

If the engine process crashes, the container stays in "running" state. If
the engine hangs (e.g., event loop blocked), Docker has no way to detect
it. A self-hosted deployment has no resilience — a crashed engine stays
dead until someone manually restarts the container.

The `/health` endpoint already exists and returns server uptime, memory
usage, and agent status. It's excluded from auth and rate limiting. The
infrastructure for health reporting is in place — it's just not wired to
Docker.

## Goals

1. Docker knows whether the engine is healthy via the `/health` endpoint
2. A crashed or hanging engine is automatically restarted
3. Operators can see health status via `docker compose ps`

## User Stories

**As a self-hosted operator**, I want the engine to restart automatically
when it crashes so that my team's agents recover without manual
intervention.

**As an operator monitoring a deployment**, I want `docker compose ps` to
show the engine's health status so that I can quickly tell if something
is wrong.

## Requirements

**R1.** The `core` service in all docker-compose files must have a
healthcheck that hits `GET /health` on the engine.

**R2.** Since the Dockerfile uses `node:22-alpine` (no curl or wget), the
healthcheck must use a Node.js one-liner or install curl in the image.

**R3.** The `core` service must have `restart: unless-stopped` so Docker
restarts it on crash.

**R4.** The healthcheck must use reasonable intervals: 30s interval, 10s
timeout, 3 retries, 40s start period (engine needs time to initialize).

**R5.** All 6 docker-compose files must be updated consistently:
`docker-compose.yml`, `docker-compose.full.yml`,
`docker-compose.whatsapp.yml`, `docker-compose.slack.yml`,
`docker-compose.telegram.yml`, `docker-compose.discord.yml`.

## Acceptance Criteria

- [ ] `core` service has a working healthcheck in all 6 compose files
- [ ] `core` service has `restart: unless-stopped` in all 6 compose files
- [ ] `docker compose ps` shows health status for the core service
- [ ] A killed engine process (`docker kill --signal=KILL`) is
  automatically restarted
- [ ] Healthcheck passes when engine is running normally
- [ ] Healthcheck fails when engine is unresponsive

## Out of Scope

- Custom health check endpoint (the existing `/health` is sufficient)
- Health check for channel adapter sidecars (if any exist in the future)
- Alerting or external monitoring integration
- Graceful shutdown handling (separate concern)

## Decisions and Trade-offs

**Node.js one-liner vs. installing curl:** Using
`node -e "require('http').get('http://localhost:3000/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"`
avoids adding curl to the alpine image (saves ~5MB and a build step).
The trade-off is a slightly less readable healthcheck command, but it's
a one-time configuration that operators rarely read.
