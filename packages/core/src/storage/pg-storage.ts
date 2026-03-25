/**
 * PostgreSQL-backed StorageProvider using Drizzle ORM.
 *
 * Drop-in replacement for FileStorage. All agent code continues to use
 * the StorageProvider interface — only the constructor changes.
 *
 * Usage:
 *   const storage = new PgStorage("postgresql://user:pass@host:5432/db");
 *   // or
 *   const storage = new PgStorage(process.env.DATABASE_URL!);
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { eq, desc, and, sql, count } from "drizzle-orm";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  agentMemory,
  projectConfigs,
  projects,
  auditLog,
  subscribers,
  slackInstallations,
  agentStates,
  channelConfigs,
} from "./schema.js";
import type {
  StorageProvider,
  AgentMemory,
  AuditEntry,
  ProjectConfig,
  ProjectListEntry,
  NewsletterSubscriber,
  SlackInstallation,
  AgentStateEntry,
} from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("pg-storage");

export class PgStorage implements StorageProvider {
  private db: PostgresJsDatabase;
  private client: ReturnType<typeof postgres>;
  private orgId: string;

  constructor(connectionString: string, orgId?: string) {
    this.orgId = orgId ?? "default";
    this.client = postgres(connectionString, { max: 10 });
    this.db = drizzle(this.client);
    log.info("PostgreSQL storage initialized", { orgId: this.orgId });
  }

  /** Gracefully close the connection pool */
  async close(): Promise<void> {
    await this.client.end();
  }

  // ── Agent Memory ───────────────────────────────────────────────

  async getMemory(agentId: string, key: string): Promise<unknown | null> {
    const rows = await this.db
      .select({ value: agentMemory.value })
      .from(agentMemory)
      .where(and(eq(agentMemory.agentId, agentId), eq(agentMemory.key, key)))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  async setMemory(agentId: string, key: string, value: unknown): Promise<void> {
    await this.db
      .insert(agentMemory)
      .values({ agentId, key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [agentMemory.agentId, agentMemory.key],
        set: { value, updatedAt: new Date() },
      });
  }

  async getAllMemory(agentId: string): Promise<AgentMemory[]> {
    const rows = await this.db
      .select()
      .from(agentMemory)
      .where(eq(agentMemory.agentId, agentId));
    return rows.map((r) => ({
      agentId: r.agentId,
      key: r.key,
      value: r.value,
      updatedAt: r.updatedAt,
    }));
  }

  // ── Project Config ────────────────────────────────────────────

  async getProjectConfig(agentId: string): Promise<ProjectConfig | null> {
    const rows = await this.db
      .select()
      .from(projectConfigs)
      .where(eq(projectConfigs.agentId, agentId))
      .limit(1);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      repoUrl: r.repoUrl,
      repoOwner: r.repoOwner,
      repoName: r.repoName,
      linkedAt: r.linkedAt,
      linkedBy: r.linkedBy,
      webhookConfigured: r.webhookConfigured,
    };
  }

  async setProjectConfig(agentId: string, config: ProjectConfig): Promise<void> {
    await this.db
      .insert(projectConfigs)
      .values({ agentId, ...config })
      .onConflictDoUpdate({
        target: projectConfigs.agentId,
        set: config,
      });
  }

  async deleteProjectConfig(agentId: string): Promise<void> {
    await this.db.delete(projectConfigs).where(eq(projectConfigs.agentId, agentId));
  }

  // ── Projects List ────────────────────────────────────────────

  async getProjectsList(): Promise<ProjectListEntry[]> {
    const rows = await this.db.select().from(projects).orderBy(desc(projects.createdAt));
    return rows.map((r) => ({
      id: r.id,
      agentId: r.agentId,
      repo: r.repo,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async addProject(project: Omit<ProjectListEntry, "createdAt">): Promise<void> {
    await this.db
      .insert(projects)
      .values({ id: project.id, agentId: project.agentId, repo: project.repo })
      .onConflictDoNothing();
  }

  async removeProject(id: string): Promise<void> {
    await this.db.delete(projects).where(eq(projects.id, id));
  }

  // ── Audit Log ──────────────────────────────────────────────────

  async appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const id = randomUUID();
    const now = new Date();

    // Simple hash chain
    const lastRow = await this.db
      .select({ hash: auditLog.hash })
      .from(auditLog)
      .orderBy(desc(auditLog.timestamp))
      .limit(1);
    const prevHash = lastRow[0]?.hash ?? "0000";
    const hashInput = `${prevHash}:${id}:${entry.action}:${entry.actorId}`;
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
    }
    const hashHex = Math.abs(hash).toString(16).padStart(8, "0").slice(0, 8);
    const chainHash = `${prevHash.slice(0, 4)}...${hashHex}`;

    await this.db.insert(auditLog).values({
      id,
      timestamp: now,
      actorType: entry.actorType,
      actorId: entry.actorId,
      action: entry.action,
      result: entry.result,
      metadata: entry.metadata,
      hash: chainHash,
    });

    return { ...entry, id, timestamp: now };
  }

  async queryAudit(
    agentId: string,
    limit: number = 20,
    offset: number = 0,
  ): Promise<{ entries: AuditEntry[]; total: number }> {
    const condition = agentId
      ? eq(auditLog.actorId, agentId)
      : undefined;

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(auditLog)
        .where(condition)
        .orderBy(desc(auditLog.timestamp))
        .limit(limit)
        .offset(offset),
      this.db
        .select({ count: count() })
        .from(auditLog)
        .where(condition),
    ]);

    return {
      entries: rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        actorType: r.actorType as AuditEntry["actorType"],
        actorId: r.actorId,
        action: r.action,
        result: r.result as AuditEntry["result"],
        metadata: r.metadata as Record<string, unknown> | undefined,
        hash: r.hash ?? undefined,
      })),
      total: Number(totalResult[0]?.count ?? 0),
    };
  }

  // ── Newsletter ───────────────────────────────────────────────

  async addSubscriber(email: string, source: string = "homepage"): Promise<NewsletterSubscriber> {
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await this.db
      .select()
      .from(subscribers)
      .where(eq(subscribers.email, normalizedEmail))
      .limit(1);

    if (existing[0]) {
      return {
        email: existing[0].email,
        subscribedAt: existing[0].subscribedAt.toISOString(),
        source: existing[0].source,
        confirmed: existing[0].confirmed,
      };
    }

    await this.db.insert(subscribers).values({
      email: normalizedEmail,
      source,
    });

    return {
      email: normalizedEmail,
      subscribedAt: new Date().toISOString(),
      source,
      confirmed: false,
    };
  }

  async getSubscribers(): Promise<NewsletterSubscriber[]> {
    const rows = await this.db.select().from(subscribers).orderBy(desc(subscribers.subscribedAt));
    return rows.map((r) => ({
      email: r.email,
      subscribedAt: r.subscribedAt.toISOString(),
      source: r.source,
      confirmed: r.confirmed,
    }));
  }

  async removeSubscriber(email: string): Promise<void> {
    await this.db.delete(subscribers).where(eq(subscribers.email, email.trim().toLowerCase()));
  }

  async getSubscriberCount(): Promise<number> {
    const result = await this.db.select({ count: count() }).from(subscribers);
    return Number(result[0]?.count ?? 0);
  }

  // ── Slack Installations ──────────────────────────────────────────

  async saveSlackInstallation(installation: SlackInstallation): Promise<void> {
    await this.db
      .insert(slackInstallations)
      .values({
        teamId: installation.teamId,
        teamName: installation.teamName,
        botToken: installation.botToken,
        botUserId: installation.botUserId,
        appId: installation.appId,
        installedBy: installation.installedBy,
        scopes: installation.scopes,
        orgId: installation.orgId,
      })
      .onConflictDoUpdate({
        target: slackInstallations.teamId,
        set: {
          teamName: installation.teamName,
          botToken: installation.botToken,
          botUserId: installation.botUserId,
          scopes: installation.scopes,
        },
      });
  }

  async getSlackInstallation(teamId: string): Promise<SlackInstallation | null> {
    const rows = await this.db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.teamId, teamId))
      .limit(1);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      teamId: r.teamId,
      teamName: r.teamName,
      botToken: r.botToken,
      botUserId: r.botUserId,
      appId: r.appId,
      installedBy: r.installedBy,
      installedAt: r.installedAt.toISOString(),
      scopes: r.scopes,
      orgId: r.orgId ?? undefined,
    };
  }

  async getAllSlackInstallations(): Promise<SlackInstallation[]> {
    const rows = await this.db.select().from(slackInstallations);
    return rows.map((r) => ({
      teamId: r.teamId,
      teamName: r.teamName,
      botToken: r.botToken,
      botUserId: r.botUserId,
      appId: r.appId,
      installedBy: r.installedBy,
      installedAt: r.installedAt.toISOString(),
      scopes: r.scopes,
      orgId: r.orgId ?? undefined,
    }));
  }

  async removeSlackInstallation(teamId: string): Promise<void> {
    await this.db.delete(slackInstallations).where(eq(slackInstallations.teamId, teamId));
  }

  // ── Agent State Persistence ─────────────────────────────────────

  async saveAgentState(agentId: string, state: AgentStateEntry): Promise<void> {
    await this.db
      .insert(agentStates)
      .values({
        agentId,
        state: state.state,
        autonomyLevel: state.autonomyLevel,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: agentStates.agentId,
        set: {
          state: state.state,
          autonomyLevel: state.autonomyLevel,
          updatedAt: new Date(),
        },
      });
  }

  async getAgentState(agentId: string): Promise<AgentStateEntry | null> {
    const rows = await this.db
      .select()
      .from(agentStates)
      .where(eq(agentStates.agentId, agentId))
      .limit(1);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      agentId: r.agentId,
      state: r.state as AgentStateEntry["state"],
      autonomyLevel: r.autonomyLevel,
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async getAllAgentStates(): Promise<AgentStateEntry[]> {
    const rows = await this.db.select().from(agentStates);
    return rows.map((r) => ({
      agentId: r.agentId,
      state: r.state as AgentStateEntry["state"],
      autonomyLevel: r.autonomyLevel,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  // ── Channel Configuration ─────────────────────────────────────

  async saveChannelConfig(channel: string, config: Record<string, string>): Promise<void> {
    await this.db
      .insert(channelConfigs)
      .values({ channel, config, configuredAt: new Date() })
      .onConflictDoUpdate({
        target: channelConfigs.channel,
        set: { config, configuredAt: new Date() },
      });
  }

  async getChannelConfig(channel: string): Promise<Record<string, string> | null> {
    const rows = await this.db
      .select({ config: channelConfigs.config })
      .from(channelConfigs)
      .where(eq(channelConfigs.channel, channel))
      .limit(1);
    return rows[0]?.config ?? null;
  }
}
