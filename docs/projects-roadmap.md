# 2-Level Tenancy (Organization → Project) — Port Status

**Status:** Shipped in Layers 1–4 (April 2026). This file is kept as
a historical record of the port; refer to the migration files and
the guides in `apps/docs/content/docs/` for current behaviour.

## What shipped

Layer 1 — schema (`drizzle/0002_projects.sql`):
- Renamed pre-pivot `projects(id, agent_id, repo)` → `code_repos`.
- Added `projects(id, org_id, name, slug, is_default, created_at)`
  with partial-unique "one default per org" index.
- Backfilled one default project per organization (deterministic id
  from md5(org_id)).
- `project_id` nullable FK on agent_states, agent_memory, policies,
  audit_log, channel_configs, code_repos; tasks already had it.
- New `channel_links(channel_type, channel_id, org_id, project_id)`
  table for explicit inbound routing.

Layer 2 — storage + routes:
- StorageProvider gained listProjects / getProject /
  getOrCreateDefaultProject / createProject / updateProject /
  deleteProject (pg + file backends).
- HTTP CRUD at `/api/projects-env` (temporary path — the legacy
  `/api/projects` still serves code-repos until callers migrate).
- Typed errors: slug_conflict / slug_reserved / slug_invalid /
  name_required / cannot_delete_default / cannot_delete_last_project.

Layer 3 — header + routing:
- `ServerContext.resolveProjectId` validates `x-codespar-project`
  against `/^prj_[a-z0-9]{16}$/`, verifies org ownership, falls back
  to the org's default project (self-healed).
- AuditEntry + AgentStateEntry types gained optional orgId/projectId;
  writers persist them.
- `channel_links` storage API (getChannelLink, setChannelLink,
  listChannelLinks, deleteChannelLink).
- `resolveInboundChannelTenancy` helper for channel adapters: returns
  `{orgId, projectId}` from the bound link, or `orgId="default" +
  projectId=null` so the caller lazy-creates on first write.

Layer 4 — CLI + docs:
- `codespar` CLI accepts `--project=prj_<16>` flag and
  `CODESPAR_PROJECT_ID` env var; flag wins over env.
- Docs updated: multi-tenant guide, README.
- No MCP transport to update — opensource runtime doesn't ship an
  MCP server (distinct from the enterprise tier which does).

## What's deliberately deferred

The port is intentionally minimal-viable. Follow-ups to consider
once there are usage signals:

- **Collapse `/api/projects-env` into `/api/projects`** once every
  caller of the legacy code-repos CRUD has moved to a dedicated
  `/api/code-repos` path.
- **Flip project_id NOT NULL** across the child tables (mirrors
  enterprise migration 0015). NOT a drop-in follow-up — the writer
  audit (April 2026) surfaced four design questions that each need a
  decision before the migration can land safely:

  1. **`setMemory` system-level writes.** Channel Router (`system` agent
     persisting `channel-routes`) and GitHub OAuth token storage call
     `setMemory` without any project context — they're org-wide or
     global. Forcing NOT NULL means either inventing a "null-sentinel
     project" convention, or carving out a permanent "system memory"
     surface that bypasses project scoping. No decision yet.

  2. **Agent lifecycle doesn't know about projects.** TaskAgent /
     ReviewAgent / DeployAgent are spawned by the supervisor without
     being told which env-project they belong to. The config carries
     the legacy `AgentConfig.projectId` (= code-repo tag), not the
     environment project id. Stamping requires either passing the
     env-project through `spawnAgent` or deriving it at runtime from
     the agent's host project (needs an agentId→env-project lookup).

  3. **Channel configs: per-channel global or per-project?** The
     `channel_configs` table (Slack workspace creds, etc.) is
     currently one row per channel name. Adding project scope means
     deciding whether configs are shared across projects of the same
     org, or each project gets its own. The answer affects whether
     enterprise-tier users can run dev + prod Slack workspaces
     against a single CodeSpar instance.

  4. **Autonomy-set route has no agent context.** `POST /api/agents/
     :id/autonomy` in `routes/agents.ts` invokes `saveAgentState`
     with the agentId only. Stamping org + project requires threading
     both through the route or adding a `getAgentById` lookup that
     returns metadata. Not hard, but blocked on (2).

  The safe path is: answer (1) and (3) at the product level, fix (4)
  once the conventions from (1) + (3) are known, then fix (2) as
  part of a broader agent-lifecycle refactor, then flip NOT NULL.
  Estimated total: ~1 day of work once decisions exist. No user pain
  today — the column is populated by auth-layer writers on every
  request, and the remaining gaps only affect system-level rows
  that never get read under a project scope.
- **Agent ↔ project one-to-many**: today agents still use the
  legacy `AgentConfig.projectId` (= code-repo tag). The new
  environment-level project_id coexists without coupling; a future
  pass can drop AgentConfig.projectId in favour of deriving from
  the agent's host project.
- **Dashboard / CLI project switcher UI** — nothing UI-side exists
  in opensource yet. The dashboard lives in codespar-web and is
  enterprise-only; opensource stays headless (CLI flag only).

## Reference

- Enterprise reference implementation that shaped this port:
  `codespar-enterprise` migrations 0014 + 0015, routes in
  `packages/api/src/routes/projects.ts`.
- The port audit that framed the open design questions before
  Layer 1: conversation log April 2026 (see commit messages on
  `b02988f`, `916b440`, `ab3e624`, and Layer 4).
