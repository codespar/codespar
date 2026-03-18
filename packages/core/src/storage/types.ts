/**
 * Storage layer interfaces for agent memory and audit logging.
 *
 * MVP uses JSON file storage (FileStorage). The interface is designed
 * so a PostgreSQL/Drizzle implementation can replace it without
 * changing any agent code.
 */

export interface AgentMemory {
  agentId: string;
  key: string;
  value: unknown;
  updatedAt: Date;
}

export interface AuditEntry {
  id: string;
  timestamp: Date;
  actorType: "user" | "agent";
  actorId: string;
  action: string;
  result: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
}

export interface StorageProvider {
  // Agent memory
  getMemory(agentId: string, key: string): Promise<unknown | null>;
  setMemory(agentId: string, key: string, value: unknown): Promise<void>;
  getAllMemory(agentId: string): Promise<AgentMemory[]>;

  // Audit log
  appendAudit(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry>;
  queryAudit(agentId: string, limit?: number): Promise<AuditEntry[]>;
}
