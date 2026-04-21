# Exploration Findings: oss-contract-test

## Round 1 Summary

### Issue #95 — What it asks for

Add `contract-oss.test.ts` to `packages/core/src/__tests__/` (the package that exports `WebhookServer`):
- Import `WebhookServer` locally and `runContractSuite` from `@codespar/types/testing`
- `beforeAll`: `new WebhookServer({ port: 13001 })`, `await server.start()`, health-check GET /health
- `afterAll`: `server?.stop()`
- Call `runContractSuite("http://localhost:13001", "csk_live_oss_test_key")`
- Add `@codespar/types` to `devDependencies` of `packages/core/package.json`
- Add CI step to `.github/workflows/ci.yml` — no env var gate

### What the contract suite actually tests

`runContractSuite` in `@codespar/types/src/testing/contract-suite.ts` fires 5 tests:

1. **execute()** — POST `/v1/sessions/:id/execute`, expects `{ success, data, error, duration, server, tool }` where `data` is not null/undefined
2. **send()** — POST `/v1/sessions/:id/send` (JSON Accept), expects `{ message, tool_calls, iterations }`
3. **sendStream()** — POST `/v1/sessions/:id/send` (SSE Accept), expects valid StreamEvent types
4. **connections()** — GET `/v1/sessions/:id/connections`, expects array of `{ id, connected }`
5. **close()** — DELETE `/v1/sessions/:id`, expects status transitions to "closed" locally

Session creation: POST `/v1/sessions` → `{ id, status: "active" }`

### Gap #1: OSS runtime has no session API

The current `WebhookServer` in `packages/core/src/server/webhook-server.ts` implements:
- GitHub/Vercel/Sentry webhooks
- Agent management API (`/api/agents/`, `/api/projects/`)
- Chat (`/api/chat`)
- A2A tasks (`/a2a/tasks`)
- Health check (`/health`)
- Observability, approval/audit, channel routing, etc.

**No `/sessions` routes exist.** For the contract tests to pass, they must be added.

The DESIGN doc specifies these routes are part of the "codespar runtime path" for `SessionBase` conformance. This is what makes the OSS runtime usable with `@codespar/sdk` in self-hosted mode.

### Gap #2: @codespar/types not published

`@codespar/types@0.1.0` was introduced in codespar-core PR #7, merged 2026-04-21. The publish workflow is tag-triggered (`v*`). No v0.3.0 tag has been pushed — the package is not on npm.

npm confirms: `404 Not Found` for `@codespar/types`.

**Dependency resolution path:**
- **Published version**: requires pushing v0.3.0 tag on codespar-core (triggers publish workflow)
- **File path reference**: `"@codespar/types": "file:../../codespar-core/packages/types"` works locally; CI needs an additional checkout step + build step for codespar-core
- Local codespar-core is available at `../codespar-core` relative to the OSS repo

### What works today

- `WebhookServer` constructor: `new WebhookServer({ port?: number, host?: string })`
- `start()` / `stop()` methods work (used in existing tests)
- `/health` endpoint returns `{ status: "ok", ... }` — contract suite health-check will pass
- `@codespar/core` devDependency already in vitest config include pattern — tests auto-discovered
- CI pattern: single `npx vitest run` step discovers all packages

### Implementation plan (what needs to be built)

**File: `packages/core/src/server/routes/sessions.ts`** (NEW)
- POST `/sessions` → create in-memory session, return `{ id, status: "active" }`
- POST `/sessions/:id/execute` → stub ToolResult `{ success: true, data: {}, error: null, duration: N, server: "oss", tool: name }`
- POST `/sessions/:id/send` → SendResult (JSON) + SSE stream (user_message + assistant_text + done events)
- GET `/sessions/:id/connections` → `{ servers: [] }` (empty, valid per contract)
- DELETE `/sessions/:id` → mark closed, 204

**File: `packages/core/src/server/webhook-server.ts`** (MODIFY)
- Import and register `registerSessionRoutes`

**File: `packages/core/package.json`** (MODIFY)
- Add `"@codespar/types": "file:../../codespar-core/packages/types"` to devDependencies

**File: `packages/core/src/__tests__/contract-oss.test.ts`** (NEW)
- Implement per issue acceptance criteria

**File: `.github/workflows/ci.yml`** (MODIFY)
- Add checkout of codespar-core + build step before npm install
- Add named `OSS contract tests` step

### Open questions

1. **Should we publish @codespar/types first** (create v0.3.0 tag on codespar-core) or use file path?
2. **What depth of session implementation is appropriate?** Minimal stub (just enough to pass contract) or wired to actual agent execution?
3. **Auth for session routes:** The issue says "OSS server accepts any syntactically valid bearer token in local mode." Bearer token check is on `/api/*` paths only; session routes at `/sessions` would bypass auth by default. Should session routes require a bearer token?

## Decision: Crystallize
