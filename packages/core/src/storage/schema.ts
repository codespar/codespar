/**
 * Drizzle ORM schema for PostgreSQL storage layer.
 *
 * Maps directly to the StorageProvider interface:
 * - agent_memory     → getMemory, setMemory, getAllMemory
 * - project_configs  → getProjectConfig, setProjectConfig, deleteProjectConfig
 * - code_repos       → getCodeReposList, addCodeRepo, removeCodeRepo
 *                      (née "projects" pre-pivot; renamed in migration 0002
 *                      because the new `projects` table means "environment"
 *                      in the 2-level tenancy model mirroring enterprise)
 * - projects         → getProjects, addProject, updateProject, deleteProject
 *                      (environments: id, org_id, name, slug, is_default)
 * - channel_links    → bind (channel_type, channel_id) → (org, project)
 * - audit_log        → appendAudit, queryAudit
 * - subscribers      → addSubscriber, getSubscribers, removeSubscriber
 * - slack_installations → save/get/remove SlackInstallation
 * - agent_states     → saveAgentState, getAgentState, getAllAgentStates
 * - channel_configs  → saveChannelConfig, getChannelConfig
 *
 * Tenancy: Organization → Project (2-level). project_id columns are
 * nullable during rollout; a follow-up migration flips NOT NULL once
 * every write path stamps it. See drizzle/0002_projects.sql.
 */

import { pgTable, text, timestamp, jsonb, integer, boolean, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Agent Memory ──────────────────────────────────────────────

export const agentMemory = pgTable("agent_memory", {
  agentId: text("agent_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value"),
  orgId: uuid("org_id"),
  projectId: text("project_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agent_memory_agent_key_idx").on(table.agentId, table.key),
  index("agent_memory_project_id_idx").on(table.projectId),
]);

// ── Project Configs ───────────────────────────────────────────

export const projectConfigs = pgTable("project_configs", {
  agentId: text("agent_id").primaryKey(),
  repoUrl: text("repo_url").notNull(),
  repoOwner: text("repo_owner").notNull(),
  repoName: text("repo_name").notNull(),
  linkedAt: text("linked_at").notNull(),
  linkedBy: text("linked_by").notNull(),
  webhookConfigured: boolean("webhook_configured").default(false).notNull(),
});

// ── Code Repos (née "projects" pre-pivot) ──────────────────────
// Renamed in migration 0002 when the 2-level tenancy model landed —
// the word "project" now means "environment" (see `projects` below),
// and this table's original semantic was "code repository linked to
// an agent". Keeps the table + data, just under an honest name.

export const codeRepos = pgTable("code_repos", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  repo: text("repo").notNull(),
  orgId: uuid("org_id"),
  projectId: text("project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("code_repos_project_id_idx").on(table.projectId),
]);

// ── Projects (environments; 2-level tenancy) ───────────────────
// Mirrors codespar-enterprise's shape exactly so the SDK + dashboard
// + opensource runtime all talk the same contract. One default
// project per org, enforced by the partial unique index.

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  orgId: uuid("org_id").notNull(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  isDefault: boolean("is_default").default(false).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("projects_org_slug_idx").on(table.orgId, table.slug),
  index("projects_org_id_idx").on(table.orgId),
  // Partial unique "at most one default per org" lives on the DB but
  // Drizzle doesn't model partial unique indexes directly — it's in
  // drizzle/0002_projects.sql as `projects_one_default_per_org`.
]);

// ── Channel Links (channel_type + channel_id → org + project) ──
// Explicit routing for inbound messages. A Slack channel, Discord
// guild, Telegram chat, or WhatsApp group binds to exactly one
// (org, project) pair. Resolves the "which project owns this
// conversation?" question the audit flagged as open in opensource.

export const channelLinks = pgTable("channel_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  channelType: text("channel_type").notNull(), // "whatsapp" | "slack" | "telegram" | "discord" | "cli"
  channelId: text("channel_id").notNull(),
  orgId: uuid("org_id").notNull(),
  projectId: text("project_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_links_channel_idx").on(table.channelType, table.channelId),
  index("channel_links_org_idx").on(table.orgId),
  index("channel_links_project_idx").on(table.projectId),
]);

// ── Audit Log ─────────────────────────────────────────────────

export const auditLog = pgTable("audit_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  actorType: text("actor_type").notNull(), // "user" | "agent" | "system"
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  result: text("result").notNull(), // "success" | "failure" | "denied" | "pending" | "approved" | "error"
  metadata: jsonb("metadata"),
  hash: text("hash"),
  orgId: uuid("org_id"),
  projectId: text("project_id"),
}, (table) => [
  index("audit_log_actor_id_idx").on(table.actorId),
  index("audit_log_timestamp_idx").on(table.timestamp),
  index("audit_log_action_idx").on(table.action),
  index("audit_log_project_id_idx").on(table.projectId),
]);

// ── Newsletter Subscribers ────────────────────────────────────

export const subscribers = pgTable("subscribers", {
  email: text("email").primaryKey(),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).defaultNow().notNull(),
  source: text("source").default("homepage").notNull(),
  confirmed: boolean("confirmed").default(false).notNull(),
});

// ── Slack Installations ───────────────────────────────────────

export const slackInstallations = pgTable("slack_installations", {
  teamId: text("team_id").primaryKey(),
  teamName: text("team_name").notNull(),
  botToken: text("bot_token").notNull(),
  botUserId: text("bot_user_id").notNull(),
  appId: text("app_id").notNull(),
  installedBy: text("installed_by").notNull(),
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
  scopes: jsonb("scopes").$type<string[]>().default([]).notNull(),
  orgId: text("org_id"),
});

// ── Agent States ──────────────────────────────────────────────

export const agentStates = pgTable("agent_states", {
  agentId: text("agent_id").primaryKey(),
  state: text("state").notNull(), // "active" | "suspended"
  autonomyLevel: integer("autonomy_level").default(0).notNull(),
  orgId: uuid("org_id"),
  projectId: text("project_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("agent_states_project_id_idx").on(table.projectId),
]);

// ── Channel Configs ───────────────────────────────────────────

export const channelConfigs = pgTable("channel_configs", {
  channel: text("channel").primaryKey(),
  config: jsonb("config").$type<Record<string, string>>().default({}).notNull(),
  configuredAt: timestamp("configured_at", { withTimezone: true }).defaultNow().notNull(),
  configuredBy: text("configured_by").default("dashboard").notNull(),
  orgId: uuid("org_id"),
  projectId: text("project_id"),
}, (table) => [
  index("channel_configs_project_id_idx").on(table.projectId),
]);

// ── Users ────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name"),
  status: text("status").default("active").notNull(), // "active" | "suspended" | "deactivated"
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("users_email_idx").on(table.email),
]);

// ── Organizations ────────────────────────────────────────────

export const organizations = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("organizations_slug_idx").on(table.slug),
]);

// ── Channel Identities (cross-channel user mapping) ──────────

export const channelIdentities = pgTable("channel_identities", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull(),
  channelType: text("channel_type").notNull(), // "whatsapp" | "slack" | "telegram" | "discord" | "cli"
  channelUserId: text("channel_user_id").notNull(), // phone hash, Slack UID, etc.
  displayName: text("display_name"),
  linkedAt: timestamp("linked_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("channel_identities_channel_user_idx").on(table.channelType, table.channelUserId),
  index("channel_identities_user_id_idx").on(table.userId),
]);

// ── Policies (ABAC rules) ────────────────────────────────────

export const policies = pgTable("policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  orgId: uuid("org_id").notNull(),
  projectId: text("project_id"),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type").notNull(), // "rbac" | "abac" | "a2a" | "budget" | "custom"
  rules: jsonb("rules").$type<Record<string, unknown>>().default({}).notNull(),
  priority: integer("priority").default(0).notNull(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("policies_org_id_idx").on(table.orgId),
  index("policies_project_id_idx").on(table.projectId),
]);

// ── Tasks ────────────────────────────────────────────────────

export const tasks = pgTable("tasks", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: text("agent_id").notNull(),
  userId: uuid("user_id"),
  projectId: text("project_id"),
  orgId: uuid("org_id"),
  input: text("input").notNull(),
  intent: text("intent"), // parsed intent type
  riskScore: integer("risk_score").default(0),
  status: text("status").default("pending").notNull(), // "pending" | "running" | "completed" | "failed" | "canceled"
  result: jsonb("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("tasks_agent_id_idx").on(table.agentId),
  index("tasks_status_idx").on(table.status),
  index("tasks_org_id_idx").on(table.orgId),
]);

// ── Executions (Claude Code runs) ────────────────────────────

export const executions = pgTable("executions", {
  id: uuid("id").defaultRandom().primaryKey(),
  taskId: uuid("task_id").notNull(),
  type: text("type").notNull(), // "claude-code" | "review" | "deploy"
  input: text("input").notNull(),
  output: text("output"),
  status: text("status").default("running").notNull(), // "running" | "completed" | "failed" | "canceled"
  containerId: text("container_id"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("executions_task_id_idx").on(table.taskId),
]);

// ── Approvals ────────────────────────────────────────────────

export const approvals = pgTable("approvals", {
  id: uuid("id").defaultRandom().primaryKey(),
  executionId: uuid("execution_id").notNull(),
  requiredQuorum: integer("required_quorum").default(1).notNull(),
  status: text("status").default("pending").notNull(), // "pending" | "approved" | "denied" | "expired"
  approvalToken: text("approval_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("approvals_execution_id_idx").on(table.executionId),
  uniqueIndex("approvals_token_idx").on(table.approvalToken),
]);

// ── Approval Votes ───────────────────────────────────────────

export const approvalVotes = pgTable("approval_votes", {
  id: uuid("id").defaultRandom().primaryKey(),
  approvalId: uuid("approval_id").notNull(),
  userId: uuid("user_id").notNull(),
  channelType: text("channel_type").notNull(),
  vote: text("vote").notNull(), // "approve" | "deny"
  votedAt: timestamp("voted_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("approval_votes_approval_id_idx").on(table.approvalId),
]);
