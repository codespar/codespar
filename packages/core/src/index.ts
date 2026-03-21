// Types
export type {
  NormalizedMessage,
  ChannelType,
  Attachment,
} from "./types/normalized-message.js";

export type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
} from "./types/channel-adapter.js";

export type {
  Agent,
  AgentConfig,
  AgentStatus,
  AgentType,
  AgentState,
  AutonomyLevel,
} from "./types/agent.js";

export type { ParsedIntent, IntentType, RiskLevel } from "./types/intent.js";
export { INTENT_RISK } from "./types/intent.js";

// Storage
export type {
  AgentMemory,
  AuditEntry,
  NewsletterSubscriber,
  ProjectConfig,
  ProjectListEntry,
  StorageProvider,
} from "./storage/index.js";

export { FileStorage } from "./storage/index.js";

// Router
export { MessageRouter } from "./router/message-router.js";
export { parseIntent } from "./router/intent-parser.js";
export { parseWithNLU } from "./router/nlu-parser.js";

// Webhooks
export type {
  GitHubEventType,
  CIStatus,
  CIEvent,
} from "./webhooks/github-handler.js";
export { parseGitHubWebhook } from "./webhooks/github-handler.js";

// Approval
export { ApprovalManager } from "./approval/index.js";
export type { ApprovalRequest, VoteResult } from "./approval/index.js";

// Auth (RBAC + Identity)
export type { Role, Permission, UserIdentity } from "./auth/index.js";
export {
  ROLE_PERMISSIONS,
  hasPermission,
  canExecuteIntent,
  getRequiredRole,
  IdentityResolver,
  IdentityStore,
} from "./auth/index.js";

// Server
export type {
  WebhookServerConfig,
  CIEventHandler,
  AgentStatusProvider,
  AgentFactory,
} from "./server/webhook-server.js";
export { WebhookServer } from "./server/webhook-server.js";

// Agents (Plugin Registry)
export {
  registerAgentType,
  getAgentFactory,
  getRegisteredTypes,
  isRegisteredType,
} from "./agents/index.js";
export type { AgentFactory as AgentPluginFactory } from "./agents/index.js";

// Execution
export { ClaudeBridge } from "./execution/index.js";
export type {
  ExecutionRequest,
  RepoExecutionRequest,
  ExecutionResult,
  SandboxConfig,
  SandboxResult,
  ExecutionSandbox,
} from "./execution/index.js";
export { DEFAULT_SANDBOX_CONFIG } from "./execution/index.js";

// Memory (Vector Store)
export { VectorStore } from "./memory/index.js";
export type { MemoryEntry, SearchResult } from "./memory/index.js";

// AI (Smart Responder)
export { generateSmartResponse, generateSmartResponseStreaming } from "./ai/index.js";
export type { AgentContext } from "./ai/index.js";

// GitHub
export { GitHubClient } from "./github/index.js";

// Observability
export { createLogger, metrics } from "./observability/index.js";
export type { LogLevel, Logger } from "./observability/index.js";

// Scheduler
export { scheduler, scheduleBuildStatusReport, scheduleHealthCheck, scheduleAuditCleanup } from "./scheduler/index.js";
export type { ScheduledTask } from "./scheduler/index.js";
