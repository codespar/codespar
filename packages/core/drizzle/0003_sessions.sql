-- 0003_sessions.sql
-- Durable inbound sessions for the channel → session bridge (F10.M2).
--
-- Scope:
--   * One row per (project_id, channel_type, channel_user_id) durable
--     session reified by the bridge (or by the /sessions HTTP route).
--   * id is a text primary key; the HTTP contract surfaces it as `id`
--     (matches the SDK SessionBase shape).
--   * status: "active" | "closed" | "error".
--   * updated_at drives M4 lazy-TTL eviction (M2 ships durable;
--     M4 adds the bound).
--
-- Non-destructive + idempotent.

CREATE TABLE IF NOT EXISTS sessions (
  id               text PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id       text NOT NULL REFERENCES projects(id)     ON DELETE CASCADE,
  channel_type     text NOT NULL,
  channel_user_id  text NOT NULL,
  instance_id      text,
  status           text NOT NULL DEFAULT 'active',
  created_at       timestamp with time zone NOT NULL DEFAULT now(),
  updated_at       timestamp with time zone NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (status IN ('active', 'closed', 'error'))
);
--> statement-breakpoint

-- Fast lookup by (project, channelType, channelUserId) for active sessions.
-- Partial index keeps it small; closed sessions don't compete for the slot.
CREATE UNIQUE INDEX IF NOT EXISTS sessions_active_lookup
  ON sessions (project_id, channel_type, channel_user_id)
  WHERE status = 'active';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sessions_org_idx     ON sessions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions (project_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_updated_idx ON sessions (updated_at);
--> statement-breakpoint
