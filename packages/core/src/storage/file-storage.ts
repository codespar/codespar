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
import type { AgentMemory, AuditEntry, StorageProvider } from "./types.js";

/** Serializable shape stored in memory.json */
interface MemoryFile {
  [agentId: string]: {
    [key: string]: { value: unknown; updatedAt: string };
  };
}

/** Serializable shape stored in audit.json */
interface AuditFile {
  entries: Array<Omit<AuditEntry, "timestamp"> & { timestamp: string }>;
}

export class FileStorage implements StorageProvider {
  private readonly dir: string;
  private readonly memoryPath: string;
  private readonly auditPath: string;

  constructor(baseDir: string = ".codespar") {
    this.dir = path.resolve(baseDir);
    this.memoryPath = path.join(this.dir, "memory.json");
    this.auditPath = path.join(this.dir, "audit.json");
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

  // ── Audit Log ──────────────────────────────────────────────────

  async appendAudit(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry> {
    const full: AuditEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: new Date(),
    };

    const data = await this.readAuditFile();
    data.entries.push({
      ...full,
      timestamp: full.timestamp.toISOString(),
    });
    await this.writeFile(this.auditPath, data);

    return full;
  }

  async queryAudit(agentId: string, limit: number = 20): Promise<AuditEntry[]> {
    const data = await this.readAuditFile();
    return data.entries
      .filter((e) => e.actorId === agentId)
      .slice(-limit)
      .map((e) => ({ ...e, timestamp: new Date(e.timestamp) }));
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
