/**
 * JSON file-based StorageProvider implementation.
 *
 * Stores data in a `.codespar/` directory:
 * - `.codespar/memory.json` — agent key-value memory
 * - `.codespar/audit.json`  — append-only audit log
 *
 * Thread-safe for single-process use (reads full file, modifies, writes back).
 * Auto-creates directory and files on first write.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMemory, AuditEntry, NewsletterSubscriber, ProjectConfig, ProjectListEntry, StorageProvider } from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("storage");

/** Serializable shape stored in memory.json */
interface MemoryFile {
  [agentId: string]: {
    [key: string]: { value: unknown; updatedAt: string };
  };
}

/** Serializable shape stored in projects.json */
interface ProjectsFile {
  [agentId: string]: ProjectConfig;
}

/** Serializable shape stored in audit.json */
interface AuditFile {
  entries: Array<Omit<AuditEntry, "timestamp"> & { timestamp: string }>;
}

export class FileStorage implements StorageProvider {
  private readonly dir: string;
  private readonly memoryPath: string;
  private readonly auditPath: string;
  private readonly projectsPath: string;
  private readonly projectsListPath: string;
  private readonly subscribersPath: string;

  /**
   * @param baseDir  Root storage directory (default ".codespar")
   * @param orgId    Optional organization ID for multi-tenant scoping.
   *                 When provided, data is stored under `baseDir/orgs/<orgId>/`.
   *                 When omitted, data is stored directly in `baseDir/` (legacy).
   */
  constructor(baseDir: string = ".codespar", orgId?: string) {
    const dir = orgId ? path.join(baseDir, "orgs", orgId) : baseDir;
    this.dir = path.resolve(dir);
    this.memoryPath = path.join(this.dir, "memory.json");
    this.auditPath = path.join(this.dir, "audit.json");
    this.projectsPath = path.join(this.dir, "projects.json");
    this.projectsListPath = path.join(this.dir, "projects-list.json");
    this.subscribersPath = path.join(this.dir, "subscribers.json");
  }

  // ── Agent Memory ───────────────────────────────────────────────

  async getMemory(agentId: string, key: string): Promise<unknown | null> {
    const data = await this.readMemoryFile();
    return data[agentId]?.[key]?.value ?? null;
  }

  async setMemory(
    agentId: string,
    key: string,
    value: unknown
  ): Promise<void> {
    const data = await this.readMemoryFile();
    if (!data[agentId]) {
      data[agentId] = {};
    }
    data[agentId][key] = { value, updatedAt: new Date().toISOString() };
    await this.writeFile(this.memoryPath, data);
  }

  async getAllMemory(agentId: string): Promise<AgentMemory[]> {
    const data = await this.readMemoryFile();
    const agentData = data[agentId];
    if (!agentData) return [];

    return Object.entries(agentData).map(([key, entry]) => ({
      agentId,
      key,
      value: entry.value,
      updatedAt: new Date(entry.updatedAt),
    }));
  }

  // ── Project Config ────────────────────────────────────────────

  async getProjectConfig(agentId: string): Promise<ProjectConfig | null> {
    const data = await this.readProjectsFile();
    return data[agentId] ?? null;
  }

  async setProjectConfig(
    agentId: string,
    config: ProjectConfig
  ): Promise<void> {
    const data = await this.readProjectsFile();
    data[agentId] = config;
    await this.writeFile(this.projectsPath, data);
  }

  async deleteProjectConfig(agentId: string): Promise<void> {
    const data = await this.readProjectsFile();
    delete data[agentId];
    await this.writeFile(this.projectsPath, data);
  }

  // ── Projects List ────────────────────────────────────────────

  async getProjectsList(): Promise<ProjectListEntry[]> {
    return this.readProjectsListFile();
  }

  async addProject(project: Omit<ProjectListEntry, "createdAt">): Promise<void> {
    const list = await this.readProjectsListFile();
    const existing = list.find((p) => p.id === project.id);
    if (existing) return; // idempotent
    list.push({ ...project, createdAt: new Date().toISOString() });
    await this.writeFile(this.projectsListPath, list);
  }

  async removeProject(id: string): Promise<void> {
    const list = await this.readProjectsListFile();
    const filtered = list.filter((p) => p.id !== id);
    await this.writeFile(this.projectsListPath, filtered);
  }

  // ── Audit Log ──────────────────────────────────────────────────

  async appendAudit(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry> {
    const data = await this.readAuditFile();

    // Generate hash chain: hash of previous entry + current data
    const prevHash = data.entries.length > 0
      ? (data.entries[data.entries.length - 1] as Record<string, unknown>).hash as string || "0000"
      : "0000";
    const entryId = randomUUID();
    const hashInput = `${prevHash}:${entryId}:${entry.action}:${entry.actorId}`;
    // Simple hash: first 12 chars of hex
    let hash = 0;
    for (let i = 0; i < hashInput.length; i++) {
      hash = ((hash << 5) - hash + hashInput.charCodeAt(i)) | 0;
    }
    const hashHex = Math.abs(hash).toString(16).padStart(8, "0").slice(0, 8);
    const chainHash = `${prevHash.slice(0, 4)}...${hashHex}`;

    const full: AuditEntry = {
      ...entry,
      id: entryId,
      timestamp: new Date(),
    };

    data.entries.push({
      ...full,
      timestamp: full.timestamp.toISOString(),
      hash: chainHash,
    });
    try {
      await this.writeFile(this.auditPath, data);
      log.debug("Audit entry saved", { action: full.action, actor: full.actorId, total: data.entries.length });
    } catch (err) {
      log.error("Failed to write audit", { error: err instanceof Error ? err.message : String(err) });
    }

    return full;
  }

  async queryAudit(agentId: string, limit: number = 20, offset: number = 0): Promise<{ entries: AuditEntry[]; total: number }> {
    const data = await this.readAuditFile();
    const filtered = agentId
      ? data.entries.filter((e) => e.actorId === agentId || e.metadata?.agentId === agentId)
      : data.entries;

    // Reverse so newest first
    const reversed = [...filtered].reverse();
    const total = reversed.length;
    const page = reversed.slice(offset, offset + limit);

    return {
      entries: page.map((e) => ({ ...e, timestamp: new Date(e.timestamp) })),
      total,
    };
  }

  // ── Newsletter ───────────────────────────────────────────────

  async addSubscriber(email: string, source: string = "homepage"): Promise<NewsletterSubscriber> {
    const normalizedEmail = email.trim().toLowerCase();
    const subscribers = await this.readSubscribersFile();

    const existing = subscribers.find((s) => s.email === normalizedEmail);
    if (existing) return existing;

    const subscriber: NewsletterSubscriber = {
      email: normalizedEmail,
      subscribedAt: new Date().toISOString(),
      source,
      confirmed: false,
    };

    subscribers.push(subscriber);
    await this.writeFile(this.subscribersPath, subscribers);
    return subscriber;
  }

  async getSubscribers(): Promise<NewsletterSubscriber[]> {
    return this.readSubscribersFile();
  }

  async removeSubscriber(email: string): Promise<void> {
    const normalizedEmail = email.trim().toLowerCase();
    const subscribers = await this.readSubscribersFile();
    const filtered = subscribers.filter((s) => s.email !== normalizedEmail);
    await this.writeFile(this.subscribersPath, filtered);
  }

  async getSubscriberCount(): Promise<number> {
    const subscribers = await this.readSubscribersFile();
    return subscribers.length;
  }

  // ── Internal helpers ───────────────────────────────────────────

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private async readMemoryFile(): Promise<MemoryFile> {
    try {
      const raw = await fs.readFile(this.memoryPath, "utf-8");
      return JSON.parse(raw) as MemoryFile;
    } catch {
      return {};
    }
  }

  private async readProjectsFile(): Promise<ProjectsFile> {
    try {
      const raw = await fs.readFile(this.projectsPath, "utf-8");
      return JSON.parse(raw) as ProjectsFile;
    } catch {
      return {};
    }
  }

  private async readProjectsListFile(): Promise<ProjectListEntry[]> {
    try {
      const raw = await fs.readFile(this.projectsListPath, "utf-8");
      return JSON.parse(raw) as ProjectListEntry[];
    } catch {
      return [];
    }
  }

  private async readSubscribersFile(): Promise<NewsletterSubscriber[]> {
    try {
      const raw = await fs.readFile(this.subscribersPath, "utf-8");
      return JSON.parse(raw) as NewsletterSubscriber[];
    } catch {
      return [];
    }
  }

  private async readAuditFile(): Promise<AuditFile> {
    try {
      const raw = await fs.readFile(this.auditPath, "utf-8");
      return JSON.parse(raw) as AuditFile;
    } catch {
      return { entries: [] };
    }
  }

  private async writeFile(filePath: string, data: unknown): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}
