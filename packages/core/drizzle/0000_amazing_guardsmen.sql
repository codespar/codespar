CREATE TABLE "agent_memory" (
	"agent_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_states" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"autonomy_level" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"result" text NOT NULL,
	"metadata" jsonb,
	"hash" text
);
--> statement-breakpoint
CREATE TABLE "channel_configs" (
	"channel" text PRIMARY KEY NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"configured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"configured_by" text DEFAULT 'dashboard' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_configs" (
	"agent_id" text PRIMARY KEY NOT NULL,
	"repo_url" text NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"linked_at" text NOT NULL,
	"linked_by" text NOT NULL,
	"webhook_configured" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"repo" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_installations" (
	"team_id" text PRIMARY KEY NOT NULL,
	"team_name" text NOT NULL,
	"bot_token" text NOT NULL,
	"bot_user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"installed_by" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"org_id" text
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"email" text PRIMARY KEY NOT NULL,
	"subscribed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text DEFAULT 'homepage' NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_agent_key_idx" ON "agent_memory" USING btree ("agent_id","key");--> statement-breakpoint
CREATE INDEX "audit_log_actor_id_idx" ON "audit_log" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action");