/**
 * Agent Registry - plugin system for custom agent types.
 *
 * Built-in types: project, task, review, deploy, incident, coordinator
 * Custom types can be registered at startup.
 */

import type { Agent, AgentConfig, AgentMetadata, AgentType } from "../types/agent.js";
import type { StorageProvider } from "../storage/types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("agent-registry");

export type AgentFactory = (
  config: AgentConfig,
  storage?: StorageProvider
) => Agent;

const registry = new Map<string, AgentFactory>();

/** Register a custom agent type. */
export function registerAgentType(type: string, factory: AgentFactory): void {
  if (registry.has(type)) {
    log.warn("Overwriting existing agent type", { type });
  }
  registry.set(type, factory);
  log.info("Registered agent type", { type });
}

/** Get a factory for the given agent type. Returns undefined if not registered. */
export function getAgentFactory(type: string): AgentFactory | undefined {
  return registry.get(type);
}

/** List all registered agent types. */
export function getRegisteredTypes(): string[] {
  return Array.from(registry.keys());
}

/** Check if an agent type is registered. */
export function isRegisteredType(type: string): boolean {
  return registry.has(type);
}

// ── Agent Metadata Registry (A2A Agent Cards) ────────────────────────

const metadataMap = new Map<AgentType, AgentMetadata>();

/** Register metadata for an agent type (A2A Agent Card). */
export function registerAgentMetadata(type: AgentType, metadata: AgentMetadata): void {
  if (metadataMap.has(type)) {
    log.warn("Overwriting existing agent metadata", { type });
  }
  metadataMap.set(type, metadata);
  log.info("Registered agent metadata", { type });
}

/** Get metadata for a specific agent type. */
export function getAgentMetadata(type: AgentType): AgentMetadata | undefined {
  return metadataMap.get(type);
}

/** Get metadata for all registered agent types. */
export function getAllAgentMetadata(): AgentMetadata[] {
  return Array.from(metadataMap.values());
}
