---
status: Proposed
upstream: docs/prds/PRD-docker-healthcheck.md
problem: |
  The core engine service has no Docker healthcheck or restart policy.
  A crashed engine stays dead until manual intervention. PostgreSQL and
  Redis have healthchecks but the engine does not.
decision: |
  Add a Node.js-based healthcheck hitting GET /health and restart:
  unless-stopped to the core service in all 6 compose files. No
  Dockerfile changes needed.
rationale: |
  A Node.js one-liner avoids installing curl in the alpine image. The
  /health endpoint is already excluded from auth and rate limiting, so
  no code changes are needed. The same healthcheck block is added to
  all compose files for consistency.
---

# DESIGN: Docker Healthcheck and Restart Policy

## Status

Proposed

## Context and Problem Statement

The `core` service definition appears in 6 docker-compose files. In all of
them, it has no `healthcheck` and no `restart` policy. PostgreSQL and Redis
both have healthchecks, and the core service uses `condition: service_healthy`
to wait for them — but the engine never reports its own health to Docker.

The `/health` endpoint exists at `webhook-server.ts:521`, returns uptime
and memory stats, and is excluded from both API auth and rate limiting. It's
ready to use as a healthcheck target.

The Dockerfile uses `node:22-alpine`, which has no `curl` or `wget`. Node.js
is available since it's the runtime.

## Decision Drivers

- **No code changes** — the `/health` endpoint already works
- **No image bloat** — avoid installing curl in alpine
- **Consistency** — all 6 compose files get the same block

## Considered Options

### Decision 1: Healthcheck command

#### Chosen: Node.js one-liner

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s
```

Node.js is already in the image. The one-liner makes an HTTP GET to
`/health`, exits 0 on 200, exits 1 on any other status or connection
error. No additional dependencies.

#### Alternatives considered

**Install curl in Dockerfile:**
Rejected because it adds ~5MB to the image, requires a Dockerfile change
(`RUN apk add --no-cache curl`), and creates a maintenance surface for
a tool used only by the healthcheck.

**wget (available in some alpine images):**
Rejected because `node:22-alpine` does not include wget by default.
Would require the same `apk add` step as curl.

### Decision 2: Healthcheck port

The `PORT` env var controls the engine's listening port (default 3000).
The healthcheck must use the same port.

#### Chosen: Hardcode port 3000 in healthcheck

All compose files set `PORT: 3000` explicitly or rely on the default.
Hardcoding 3000 in the healthcheck matches this. If an operator changes
the port, they must also update the healthcheck — this is standard
Docker practice.

## Solution Architecture

### Changes per compose file

Add to the `core` service block:

```yaml
core:
  build: .
  restart: unless-stopped
  ports:
    - "3000:3000"
  healthcheck:
    test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', r => { process.exit(r.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"]
    interval: 30s
    timeout: 10s
    retries: 3
    start_period: 40s
  environment:
    # ... existing env vars
```

### Files to modify

| File | Change |
|------|--------|
| `docker-compose.yml` | Add healthcheck + restart to core |
| `docker-compose.full.yml` | Add healthcheck + restart to core |
| `docker-compose.whatsapp.yml` | Add healthcheck + restart to core |
| `docker-compose.slack.yml` | Add healthcheck + restart to core |
| `docker-compose.telegram.yml` | Add healthcheck + restart to core |
| `docker-compose.discord.yml` | Add healthcheck + restart to core |

No Dockerfile changes. No code changes.

### Healthcheck timing rationale

| Parameter | Value | Why |
|-----------|-------|-----|
| `interval` | 30s | Frequent enough to catch crashes, not so frequent it adds load |
| `timeout` | 10s | The `/health` endpoint is fast (<10ms), but allow headroom for slow starts |
| `retries` | 3 | Three consecutive failures before marking unhealthy (avoids flapping) |
| `start_period` | 40s | Engine needs time to initialize (npm build, DB connection, agent spawn) |

## Implementation Approach

Single commit: add healthcheck and `restart: unless-stopped` to the `core`
service in all 6 compose files.

## Security Considerations

The healthcheck hits `/health` which is excluded from API auth (no bearer
token needed). This is correct — the healthcheck runs inside the container
network and should not require credentials. The endpoint returns uptime
and memory stats, which are not sensitive.

## Consequences

### Positive

- Engine restarts automatically on crash
- `docker compose ps` shows health status
- Operators can detect hung engines before users notice

### Negative

- If the engine hangs but `/health` still responds (e.g., event loop
  blocked on a non-health route), the healthcheck won't detect it
- Hardcoded port 3000 must be updated if operators change PORT

### Mitigations

- A more sophisticated healthcheck (checking agent responsiveness) can
  be added later without changing the compose structure
- The PORT concern is documented and matches standard Docker practice
