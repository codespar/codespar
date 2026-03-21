/**
 * Agent Registry - plugin system for custom agent types.
 *
 * Built-in types: project, task, review, deploy, incident, coordinator
 * Custom types can be registered at startup.
 */

import type { Agent, AgentConfig } from "../types/agent.js";
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
