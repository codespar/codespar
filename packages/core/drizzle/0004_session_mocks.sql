-- 0004_session_mocks.sql
-- Hosted-test-mode mocks API: adds the per-session mock store and the
-- per-session per-tool consume counter that the dispatcher uses to
-- traverse stateful array entries one element at a time.
--
-- Scope:
--   * `sessions.mocks` (jsonb, nullable) — the canonical "server/tool"
--     keyed map declared on POST /sessions. Null when the caller omits
--     the field (byte-for-byte parity with the pre-mocks INSERT shape).
--   * `session_tool_call_counts(session_id, tool_name, n)` — counter
--     storage. One row per (session, canonical tool name) pair; n is
--     capped at the array length by the dispatcher's bump helper.
--
-- Non-destructive + idempotent: guarded ADD COLUMN + CREATE TABLE IF
-- NOT EXISTS so the migration is safe to re-apply during dev resets.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS mocks jsonb;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS session_tool_call_counts (
  session_id  text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name   text NOT NULL,
  n           integer NOT NULL DEFAULT 0,
  updated_at  timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, tool_name)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS session_tool_call_counts_session_idx
  ON session_tool_call_counts (session_id);
--> statement-breakpoint
