/**
 * A2A Outbound — client and registry for discovering and invoking external agents.
 */

export { A2AClient, A2AClientError } from "./client.js";
export type { A2AClientOptions } from "./client.js";

export { A2ARegistry } from "./registry.js";

// A2A Outbound Policy Enforcement (AgentGate)
export type {
  A2AOutboundPolicy,
  A2ACallContext,
  A2APolicyResult,
} from "./policy.js";

export { DEFAULT_A2A_POLICY, A2APolicyEvaluator, matchesPattern } from "./policy.js";
