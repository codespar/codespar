// Types
export type {
  NormalizedMessage,
  ChannelType,
  Attachment,
} from "./types/normalized-message.js";

export type {
  ChannelAdapter,
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
  ProjectConfig,
  StorageProvider,
} from "./storage/index.js";

export { FileStorage } from "./storage/index.js";

// Router
export { MessageRouter } from "./router/message-router.js";
export { parseIntent } from "./router/intent-parser.js";

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

// Auth (RBAC)
export type { Role, Permission, UserIdentity } from "./auth/index.js";
export {
  ROLE_PERMISSIONS,
  hasPermission,
  canExecuteIntent,
  getRequiredRole,
  IdentityResolver,
} from "./auth/index.js";

// Server
export type {
  WebhookServerConfig,
  CIEventHandler,
  AgentStatusProvider,
} from "./server/webhook-server.js";
export { WebhookServer } from "./server/webhook-server.js";

// Execution
export { ClaudeBridge } from "./execution/index.js";
export type { ExecutionRequest, ExecutionResult } from "./execution/index.js";
