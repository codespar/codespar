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

// Router
export { MessageRouter } from "./router/message-router.js";
export { parseIntent } from "./router/intent-parser.js";
