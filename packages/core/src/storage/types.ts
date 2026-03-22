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
  actorType: "user" | "agent" | "system";
  actorId: string;
  action: string;
  result: "success" | "failure" | "denied" | "pending" | "approved" | "error";
  metadata?: Record<string, unknown>;
  hash?: string;
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

export interface NewsletterSubscriber {
  email: string;
  subscribedAt: string;
  source: string; // "blog", "homepage", etc.
  confirmed: boolean;
}

export interface AgentStateEntry {
  agentId: string;
  state: "active" | "suspended";
  autonomyLevel: number;
  updatedAt: string;
}

export interface ChannelConfig {
  channel: string;
  config: Record<string, string>;
  configuredAt: string;
  configuredBy: string;
}

export interface SlackInstallation {
  teamId: string;
  teamName: string;
  botToken: string;
  botUserId: string;
  appId: string;
  installedBy: string;
  installedAt: string;
  scopes: string[];
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

  // Newsletter
  addSubscriber(email: string, source?: string): Promise<NewsletterSubscriber>;
  getSubscribers(): Promise<NewsletterSubscriber[]>;
  removeSubscriber(email: string): Promise<void>;
  getSubscriberCount(): Promise<number>;

  // Slack installations
  saveSlackInstallation(installation: SlackInstallation): Promise<void>;
  getSlackInstallation(teamId: string): Promise<SlackInstallation | null>;
  getAllSlackInstallations(): Promise<SlackInstallation[]>;
  removeSlackInstallation(teamId: string): Promise<void>;

  // Agent state persistence
  saveAgentState(agentId: string, state: AgentStateEntry): Promise<void>;
  getAgentState(agentId: string): Promise<AgentStateEntry | null>;
  getAllAgentStates(): Promise<AgentStateEntry[]>;

  // Channel configuration
  saveChannelConfig(channel: string, config: Record<string, string>): Promise<void>;
  getChannelConfig(channel: string): Promise<Record<string, string> | null>;

  // Audit log
  appendAudit(
    entry: Omit<AuditEntry, "id" | "timestamp">
  ): Promise<AuditEntry>;
  queryAudit(agentId: string, limit?: number, offset?: number): Promise<{ entries: AuditEntry[]; total: number }>;
}
