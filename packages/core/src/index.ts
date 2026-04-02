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
  AgentSkill,
  AgentMetadata,
  AutonomyLevel,
} from "./types/agent.js";

export type { ParsedIntent, IntentType, RiskLevel } from "./types/intent.js";
export { INTENT_RISK } from "./types/intent.js";

export type {
  A2ATaskRequest,
  A2ATaskStatus,
  A2ATaskResponse,
  ExternalAgentCard,
  ExternalAgentEntry,
  ExternalAgentSkill,
} from "./types/a2a.js";

// A2A Outbound (client + registry)
export { A2AClient, A2AClientError } from "./a2a/index.js";
export type { A2AClientOptions } from "./a2a/index.js";
export { A2ARegistry } from "./a2a/index.js";

// A2A Outbound Policy Enforcement (AgentGate)
export type { A2AOutboundPolicy, A2ACallContext, A2APolicyResult } from "./a2a/index.js";
export { DEFAULT_A2A_POLICY, A2APolicyEvaluator, matchesPattern } from "./a2a/index.js";

// Storage
export type {
  AgentMemory,
  AgentStateEntry,
  AuditEntry,
  ChannelConfig,
  NewsletterSubscriber,
  ProjectConfig,
  ProjectListEntry,
  SlackInstallation,
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
  DeployAlert,
} from "./server/webhook-server.js";
export { WebhookServer, broadcastEvent } from "./server/webhook-server.js";

// Agents (Plugin Registry)
export {
  registerAgentType,
  getAgentFactory,
  getRegisteredTypes,
  isRegisteredType,
  registerAgentMetadata,
  getAgentMetadata,
  getAllAgentMetadata,
  registerAllAgentMetadata,
  AGENT_METADATA,
} from "./agents/index.js";
export type { AgentFactory as AgentPluginFactory } from "./agents/index.js";

// Execution
export { ClaudeBridge } from "./execution/index.js";
export type {
  ProgressEvent,
  ExecutionRequest,
  RepoExecutionRequest,
  ExecutionResult,
  SandboxConfig,
  SandboxResult,
  ExecutionSandbox,
} from "./execution/index.js";
export { DEFAULT_SANDBOX_CONFIG } from "./execution/index.js";
export { DockerSandbox } from "./execution/index.js";
export { ContainerPool } from "./execution/index.js";
export type { PoolStats } from "./execution/index.js";
export { createSandbox } from "./execution/index.js";

// Memory (Vector Store)
export { VectorStore } from "./memory/index.js";
export type { MemoryEntry, SearchResult } from "./memory/index.js";

// AI (Smart Responder + Smart Alert)
export { generateSmartResponse, generateSmartResponseStreaming } from "./ai/index.js";
export type { AgentContext } from "./ai/index.js";
export { analyzeDeployFailure, formatSmartAlert } from "./ai/index.js";
export type { SmartAlertResult } from "./ai/index.js";

// GitHub
export { GitHubClient } from "./github/index.js";

// Observability
export { createLogger, metrics } from "./observability/index.js";
export type { LogLevel, Logger } from "./observability/index.js";

// Scheduler
export { scheduler, scheduleBuildStatusReport, scheduleHealthCheck, scheduleAuditCleanup } from "./scheduler/index.js";
export type { ScheduledTask } from "./scheduler/index.js";

// Plugins (enterprise extension hooks)
export { pluginRegistry } from "./plugins/index.js";
export type {
  PolicyDecision,
  ToolMetric,
  PolicyHook,
  ObservabilityHook,
  SecretsHook,
  IntegrationHook,
  PluginHooks,
} from "./plugins/index.js";

// Storage (PostgreSQL)
export { PgStorage, createStorage } from "./storage/index.js";

// Security
export { PromptGuard, promptGuard } from "./security/prompt-guard.js";
export type { PromptAnalysis } from "./security/prompt-guard.js";

// Queue (Redis Pub/Sub event bus + task queue)
export { createEventBus, createTaskQueue } from "./queue/index.js";
export type { EventBus, EventBusChannel, EventBusMessage, EventBusHandler } from "./queue/event-bus.js";
export type { TaskQueue, QueuedTask } from "./queue/task-queue.js";
