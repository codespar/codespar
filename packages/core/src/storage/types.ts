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
  /** 2-level tenancy: org this event belongs to. Null for system-wide
   *  events (e.g. startup, install). */
  orgId?: string;
  /** 2-level tenancy: project this event belongs to. Null for events
   *  above the project level (org-wide settings, billing). */
  projectId?: string;
}

export interface ProjectConfig {
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  linkedAt: string;
  linkedBy: string;
  webhookConfigured: boolean;
}

/**
 * Legacy shape: a code repository linked to an agent. Lives on the
 * renamed `code_repos` table post-Layer 1. Kept under this name for
 * backwards compatibility with existing callers; prefer `CodeRepo`
 * going forward.
 */
export interface ProjectListEntry {
  id: string;
  agentId: string;
  repo: string;
  createdAt: string;
}

/** Alias for clarity. Same shape as ProjectListEntry. */
export type CodeRepo = ProjectListEntry;

/**
 * Project as an environment (dev/staging/prod inside one org).
 * Mirrors the enterprise shape; id is `prj_<16 hex>` to match the
 * SDK + dashboard id format end-to-end.
 */
export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  isDefault: boolean;
  createdAt: string;
}

/** Input when creating a new project via the storage API. */
export interface CreateProjectInput {
  orgId: string;
  name: string;
  slug: string;
  isDefault?: boolean;
}

/** Patch shape for updating a project. All fields optional. */
export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  isDefault?: boolean;
}

/**
 * Channel link — binds an inbound channel conversation to a specific
 * project. `channelType + channelId` is unique globally; `project_id`
 * is where the message ends up routed.
 */
export interface ChannelLink {
  id: string;
  channelType: "whatsapp" | "slack" | "telegram" | "discord" | "cli";
  channelId: string;
  orgId: string;
  projectId: string;
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
  /** 2-level tenancy: org this agent belongs to. Null during
   *  rollout; flipped NOT NULL in a later migration. */
  orgId?: string;
  /** 2-level tenancy: project this agent belongs to. Null during
   *  rollout; flipped NOT NULL in a later migration. */
  projectId?: string;
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
  orgId?: string;
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

  // Code repos (née "projects list" pre-pivot; operates on code_repos
  // post-Layer 1). Method names stay for backwards compatibility.
  getProjectsList(): Promise<ProjectListEntry[]>;
  addProject(project: Omit<ProjectListEntry, "createdAt">): Promise<void>;
  removeProject(id: string): Promise<void>;

  // Projects (environments; 2-level tenancy)
  /** List all projects within an org, default first. */
  listProjects(orgId: string): Promise<Project[]>;
  /** Fetch a single project by id. Returns null if not in the caller's
   *  org — callers MUST pass orgId to guard cross-org reads. */
  getProject(orgId: string, id: string): Promise<Project | null>;
  /** Get-or-create the org's default project. Self-heals missing rows
   *  the same way enterprise auth does, so the first read after org
   *  creation never returns null. */
  getOrCreateDefaultProject(orgId: string): Promise<Project>;
  /** Create a new project. Throws a typed error on slug conflict /
   *  reserved slug (the route handler translates these to 400 bodies). */
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Patch an existing project. Promoting to default atomically
   *  clears the prior default in the same transaction. */
  updateProject(orgId: string, id: string, patch: UpdateProjectInput): Promise<Project | null>;
  /** Hard delete. Caller is responsible for the "cannot delete the
   *  only / default project" checks the enterprise /v1/projects
   *  route enforces. */
  deleteProject(orgId: string, id: string): Promise<boolean>;

  // Channel links (inbound routing → project)
  /** Resolve an inbound channel conversation to its (org, project).
   *  Returns null when no binding exists; the caller should fall back
   *  to the org's default project. */
  getChannelLink(channelType: string, channelId: string): Promise<ChannelLink | null>;
  /** Upsert a channel → project binding. Replaces any prior binding
   *  on the same (channelType, channelId). */
  setChannelLink(link: Omit<ChannelLink, "id" | "createdAt">): Promise<ChannelLink>;
  /** List every binding for an org, most recent first. */
  listChannelLinks(orgId: string): Promise<ChannelLink[]>;
  /** Remove a binding. Returns true when a row was removed. */
  deleteChannelLink(channelType: string, channelId: string): Promise<boolean>;

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
