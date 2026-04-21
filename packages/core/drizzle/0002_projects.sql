-- 0002_projects.sql
-- Introduces 2-level tenancy: Organization → Project.
--
-- Context:
--   Enterprise tier (codespar-enterprise) shipped this in Marcos F.1 +
--   F.2 + F.3 (April 2026). Opensource runtime was on 1-level (org only)
--   and conflated "project" = code repo with the environment concept.
--   This migration aligns the opensource data model with the enterprise
--   one before channel inbound semantics ossify around the old shape.
--
-- Scope decisions (documented for future archaeology):
--   - Old `projects(id, agent_id, repo)` table → renamed to `code_repos`.
--     Its semantics were "code project/repo" (pre-pivot), which collides
--     with the new project = environment model. Renaming keeps data;
--     callers that used the old shape move to code_repos.
--   - New `projects(id, org_id, name, slug, is_default, created_at)`
--     mirrors the enterprise shape exactly. id is text `prj_<16 hex>` to
--     match the SDK + dashboard ids end-to-end.
--   - project_id is nullable on every child table during rollout. A
--     follow-up migration flips NOT NULL once every write path is
--     project-aware (same strategy enterprise used in 0014 → 0015).
--   - channel_links is a NEW table (opensource didn't have one). It binds
--     `(channel_type, channel_id)` to a specific `(org_id, project_id)`
--     — explicit routing, zero magic. channel_configs stays for
--     global-per-channel config (Slack workspace creds etc.).
--
-- Non-destructive + idempotent:
--   1. ALTER TABLE projects RENAME TO code_repos (only runs if the old
--      shape is still there)
--   2. CREATE TABLE projects with the new shape (IF NOT EXISTS)
--   3. Backfill one default project per existing organization
--   4. Add nullable project_id on the 8 child tables + channel_links
--   5. Populate project_id from the org's default project where possible
--
-- Rollback: drop FKs + project_id columns, drop projects, rename
-- code_repos back to projects. No data destroyed unless a subsequent
-- migration fires.

-- ── 1. Rename old `projects` → `code_repos` ──────────────────────────
-- Guarded: only fires if the old shape is still in place. Detection is
-- by column presence — the new `projects` has no `agent_id` column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'projects'
      AND column_name = 'agent_id'
  ) THEN
    ALTER TABLE projects RENAME TO code_repos;
  END IF;
END $$;
--> statement-breakpoint

-- ── 2. New `projects` table (shape mirrors codespar-enterprise) ──────
CREATE TABLE IF NOT EXISTS projects (
  id          text PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name        text NOT NULL,
  slug        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS projects_org_id_idx ON projects (org_id);
--> statement-breakpoint

-- Exactly one default project per org at any time. Partial unique index
-- lets us toggle the default cleanly — set-new-first then clear-old,
-- never zero or two defaults in the middle.
CREATE UNIQUE INDEX IF NOT EXISTS projects_one_default_per_org
  ON projects (org_id) WHERE is_default = true;
--> statement-breakpoint

-- ── 3. Backfill: one default project per existing organization ───────
-- Deterministic id derived from the org uuid so re-running yields the
-- same row (ON CONFLICT skips). md5(uuid::text) gives us a stable hex.
INSERT INTO projects (id, org_id, name, slug, is_default)
SELECT
  'prj_' || substr(md5(o.id::text), 1, 16),
  o.id,
  'Default project',
  'default',
  true
FROM organizations o
ON CONFLICT (org_id, slug) DO NOTHING;
--> statement-breakpoint

-- ── 4. Add nullable project_id on child tables ───────────────────────
-- Every table below either had an org_id already (tasks, policies,
-- code_repos-via-agent) or is new-in-this-migration (channel_links).
-- project_id stays nullable until a follow-up flips NOT NULL (same
-- pattern as enterprise 0014→0015).

ALTER TABLE agent_states    ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE agent_states    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE agent_memory    ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE agent_memory    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE policies        ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE audit_log       ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE audit_log       ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE channel_configs ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint

-- tasks already has project_id + org_id (linha 169-170 do schema pre-migration)
-- but project_id was untyped (text). Add FK for referential integrity.
-- Guarded so it doesn't re-add if a drizzle regeneration already wired it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_name = 'tasks_project_id_fkey'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'tasks' AND constraint_name = 'tasks_org_id_fkey'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_org_id_fkey
      FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE;
  END IF;
END $$;
--> statement-breakpoint

-- code_repos (née projects) picks up project_id so a code repo can be
-- pinned to a specific environment. Org_id inferred from the parent
-- agent_states row at backfill time; direct-on-code-repo for future
-- orphans.
ALTER TABLE code_repos      ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE code_repos      ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint

-- ── 5. channel_links: explicit (channel, id) → (org, project) map ─────
-- Opensource didn't have this before; inbound messages routed via
-- channel_configs (1 row per channel name, no per-room/per-workspace
-- granularity) or via agent_id lookups. New table makes routing
-- explicit: a Slack channel, Discord guild, Telegram chat, etc. binds
-- to exactly one (org, project) pair.
CREATE TABLE IF NOT EXISTS channel_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_type  text NOT NULL, -- "whatsapp" | "slack" | "telegram" | "discord" | "cli"
  channel_id    text NOT NULL, -- Slack channel id, Discord guild, Telegram chat, WA group id, etc.
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id    text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at    timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE (channel_type, channel_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS channel_links_org_idx     ON channel_links (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_links_project_idx ON channel_links (project_id);
--> statement-breakpoint

-- ── 6. Populate project_id from each row's org default project ───────
-- Only touches rows where project_id IS NULL so re-running is safe.
-- Rows that don't carry an org_id (legacy agent_states / agent_memory
-- pre-dating 0002's org_id column) stay NULL; a later pass can
-- associate them once the org association is decided at the runtime
-- layer.

UPDATE tasks          SET project_id = p.id
FROM projects p
WHERE tasks.org_id          = p.org_id AND p.is_default AND tasks.project_id          IS NULL;
--> statement-breakpoint

UPDATE policies       SET project_id = p.id
FROM projects p
WHERE policies.org_id       = p.org_id AND p.is_default AND policies.project_id       IS NULL;
--> statement-breakpoint

-- ── 7. Per-table project_id indexes ──────────────────────────────────
CREATE INDEX IF NOT EXISTS agent_states_project_id_idx   ON agent_states   (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_memory_project_id_idx   ON agent_memory   (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS policies_project_id_idx       ON policies       (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_project_id_idx      ON audit_log      (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS channel_configs_project_id_idx ON channel_configs (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tasks_project_id_idx          ON tasks          (project_id) WHERE project_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS code_repos_project_id_idx     ON code_repos     (project_id) WHERE project_id IS NOT NULL;
