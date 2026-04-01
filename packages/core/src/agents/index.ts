export {
  registerAgentType,
  getAgentFactory,
  getRegisteredTypes,
  isRegisteredType,
  registerAgentMetadata,
  getAgentMetadata,
  getAllAgentMetadata,
} from "./agent-registry.js";
export type { AgentFactory } from "./agent-registry.js";

export { registerAllAgentMetadata, AGENT_METADATA } from "./agent-metadata.js";
