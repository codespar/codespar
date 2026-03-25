/**
 * Drizzle ORM schema for PostgreSQL storage layer.
 *
 * Maps directly to the StorageProvider interface:
 * - agent_memory     → getMemory, setMemory, getAllMemory
 * - project_configs  → getProjectConfig, setProjectConfig, deleteProjectConfig
 * - projects         → getProjectsList, addProject, removeProject
 * - audit_log        → appendAudit, queryAudit
 * - subscribers      → addSubscriber, getSubscribers, removeSubscriber
 * - slack_installations → save/get/remove SlackInstallation
 * - agent_states     → saveAgentState, getAgentState, getAllAgentStates
 * - channel_configs  → saveChannelConfig, getChannelConfig
 */

import { pgTable, text, timestamp, jsonb, integer, boolean, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";

// ── Agent Memory ──────────────────────────────────────────────

export const agentMemory = pgTable("agent_memory", {
  agentId: text("agent_id").notNull(),
  key: text("key").notNull(),
  value: jsonb("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("agent_memory_agent_key_idx").on(table.agentId, table.key),
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

// ── Projects List ─────────────────────────────────────────────

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  repo: text("repo").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
}, (table) => [
  index("audit_log_actor_id_idx").on(table.actorId),
  index("audit_log_timestamp_idx").on(table.timestamp),
  index("audit_log_action_idx").on(table.action),
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
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// ── Channel Configs ───────────────────────────────────────────

export const channelConfigs = pgTable("channel_configs", {
  channel: text("channel").primaryKey(),
  config: jsonb("config").$type<Record<string, string>>().default({}).notNull(),
  configuredAt: timestamp("configured_at", { withTimezone: true }).defaultNow().notNull(),
  configuredBy: text("configured_by").default("dashboard").notNull(),
});
