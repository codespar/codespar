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

export interface ProjectConfig {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  linkedAt: string;
  linkedBy: string;
  webhookConfigured: boolean;
}

export interface ProjectListEntry {
  id: string;
  agentId: string;
  repo: string;
  createdAt: string;
}

export interface StorageProvider {
  // Agent memory
  getMemory(agentId: string, key: string): Promise<unknown | null>;
  setMemory(agentId: string, key: string, value: unknown): Promise<void>;
  getAllMemory(agentId: string): Promise<AgentMemory[]>;

  // Project config
  getProjectConfig(agentId: string): Promise<ProjectConfig | null>;
  setProjectConfig(agentId: string, config: ProjectConfig): Promise<void>;
  deleteProjectConfig(agentId: string): Promise<void>;

  // Projects list
  getProjectsList(): Promise<ProjectListEntry[]>;
  addProject(project: Omit<ProjectListEntry, "createdAt">): Promise<void>;
  removeProject(id: string): Promise<void>;

  // Audit log
  appendAudit(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry>;
  queryAudit(agentId: string, limit?: number): Promise<AuditEntry[]>;
}
