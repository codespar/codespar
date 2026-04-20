# 2-Level Tenancy (Organization → Project) — Port Roadmap

**Status:** Not implemented in opensource. Tracked here for future work.

## Context

The managed tier (`codespar-enterprise`) shipped a 2-level tenancy model across
Marcos F.1 + F.2 + F.3 (April 2026):

- `projects` table scoped under `orgs`; exactly one `is_default` per org
- Every `/v1` data path (sessions, triggers, events, api-keys, connected_accounts,
  secrets, …) threads `project_id` alongside `org_id`
- Dashboard UI adds a Project Switcher and routes under
  `/dashboard/projects/[projectId]/…`
- `@codespar/sdk` accepts optional `projectId` (client-wide or per-session) and
  sends `x-codespar-project` on requests

The opensource runtime today uses **1-level tenancy** (`x-org-id` only). Agents
are effectively 1:1 with projects — there is no separate `projectId` concept in
the storage schema or HTTP surface.

## Why this isn't in opensource yet

The first real users of projects are on the managed tier. Porting the full
architecture to opensource before we have usage signals would likely lock in
decisions we'd want to revisit (see Open Questions below).

Near-term product focus is on the managed tier. When the opensource port
happens it should mirror the enterprise design unless open questions surface a
reason to diverge.

## Scope of the port, when we do it

Schema:
- Add `projects(id, org_id, name, slug, is_default, created_at)` table
- Add nullable `project_id` column to every org-scoped resource
- Backfill one default project per org; then migrate `NOT NULL`
- Unique `(project_id, user_id, server_id) WHERE status='connected'` on channel
  bindings (replaces current org-scoped unique)

HTTP:
- Accept `x-codespar-project` header on every `/api/*` and `/v1/*` route
- Absent header → resolve to org's default project (match enterprise semantics)
- Validate format `prj_<16 alphanumeric>` and ownership against `x-org-id`

Runtime:
- Agent lifecycle scoped to `(org_id, project_id)` tuple
- Channel bindings decide how inbound messages resolve a project (see Q3)
- CLI passes project context on commands that mutate state (see Q5)

Docs:
- `apps/docs/content/docs/api/projects.mdx` — replace `x-org-id`-only examples
- `apps/docs/content/docs/guides/multi-tenant.mdx` — explain the 2-level model
- Add `apps/docs/content/docs/concepts/projects.mdx` (mirror the managed-tier page)

Reference implementation:
- `codespar-enterprise` migrations `0014_projects.sql` + follow-ups
- `codespar-enterprise/packages/api/src/auth.ts` (bearer + service-key paths)
- `codespar-enterprise/packages/api/src/routes/projects.ts`

## Open questions to resolve before implementing

1. **Agent ↔ project mapping.** Today `agentId` is the de facto project id.
   Do agents become N:1 under a project, or stay 1:1 with a project entity
   that simply gets a display name + slug?
2. **Default project semantics.** Should we auto-create a default project on
   org creation (matches enterprise), or leave `project_id` nullable
   indefinitely for self-hosted deployments that don't care about the second
   level?
3. **Channel → project resolution.** When a WhatsApp/Slack/Telegram message
   arrives, which project owns the conversation? Options: per-channel binding,
   per-agent binding, per-sender mapping. Enterprise sidesteps this because it
   doesn't own channel inbound.
4. **Backward compatibility for existing self-hosted deployments.** Migration
   must not break a running cluster. Enterprise used nullable columns + a
   follow-up `NOT NULL` migration; same pattern should work here.
5. **CLI surface.** Does `codespar <command>` need a `--project` flag, or do
   we rely on `CODESPAR_PROJECT_ID` env var (matches SDK precedence)?
6. **MCP transport.** The enterprise MCP headers inherit `x-codespar-project`;
   opensource MCP routing needs the same treatment if we keep the header
   contract.

## When to revisit

Revisit when either happens:

- Managed-tier usage produces signals that answer the open questions above
  (especially Q3 around channel routing)
- A self-hosted user requests multi-environment isolation within a single
  opensource deployment

Until then, the 1-level tenancy in the opensource runtime is the correct
shipping state.
