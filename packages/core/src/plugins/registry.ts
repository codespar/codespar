/**
 * Plugin Registry — singleton that manages enterprise plugin hooks.
 *
 * Usage:
 *   // In enterprise bootstrap:
 *   import { pluginRegistry } from "@codespar/core";
 *   pluginRegistry.registerPolicy(new PolicyEngine());
 *   pluginRegistry.registerObservability(new MCPObserver());
 *   pluginRegistry.registerSecrets(new SecretsVault());
 *
 *   // In core agent code:
 *   const decision = pluginRegistry.evaluatePolicy("agent-1", "deploy", 0.5);
 *   if (!decision.allowed) { ... }
 */

import type {
  PolicyHook,
  ObservabilityHook,
  SecretsHook,
  IntegrationHook,
  PolicyDecision,
  ToolMetric,
} from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("plugin-registry");

class PluginRegistryImpl {
  private policy: PolicyHook | null = null;
  private observability: ObservabilityHook | null = null;
  private secrets: SecretsHook | null = null;
  private integrations: Map<string, IntegrationHook> = new Map();

  /** Register a policy engine plugin */
  registerPolicy(hook: PolicyHook): void {
    this.policy = hook;
    log.info("Policy plugin registered");
  }

  /** Register an observability plugin */
  registerObservability(hook: ObservabilityHook): void {
    this.observability = hook;
    log.info("Observability plugin registered");
  }

  /** Register a secrets vault plugin */
  registerSecrets(hook: SecretsHook): void {
    this.secrets = hook;
    log.info("Secrets plugin registered");
  }

  /** Register an integration connector (Sentry, Linear, Jira, etc.) */
  registerIntegration(hook: IntegrationHook): void {
    this.integrations.set(hook.id, hook);
    log.info("Integration plugin registered", { id: hook.id, name: hook.name });
  }

  // ── Policy API ──────────────────────────────────────────────

  /** Evaluate a policy. Returns allowed:true if no policy plugin registered. */
  evaluatePolicy(agentId: string, toolName: string, estimatedCost?: number): PolicyDecision {
    if (!this.policy) {
      return { allowed: true };
    }
    return this.policy.evaluate(agentId, toolName, estimatedCost);
  }

  /** Record usage after successful execution (for budget tracking) */
  recordPolicyUsage(agentId: string, toolName: string, cost: number): void {
    this.policy?.recordUsage?.(agentId, toolName, cost);
  }

  // ── Observability API ───────────────────────────────────────

  /** Record a tool execution metric */
  recordMetric(metric: ToolMetric): void {
    this.observability?.record(metric);
  }

  /** Check if observability is available */
  hasObservability(): boolean {
    return this.observability !== null;
  }

  // ── Secrets API ─────────────────────────────────────────────

  /** Get a secret for a tenant. Returns null if no secrets plugin or key not found. */
  getSecret(tenantId: string, key: string): string | null {
    if (!this.secrets) return null;
    return this.secrets.get(tenantId, key);
  }

  /** Check if secrets vault is available */
  hasSecrets(): boolean {
    return this.secrets !== null;
  }

  // ── Integrations API ────────────────────────────────────────

  /** Get a registered integration by ID */
  getIntegration(id: string): IntegrationHook | null {
    return this.integrations.get(id) ?? null;
  }

  /** Get all registered integrations */
  getIntegrations(): IntegrationHook[] {
    return Array.from(this.integrations.values());
  }

  // ── Diagnostics ─────────────────────────────────────────────

  /** Get a summary of registered plugins (for health/status endpoints) */
  getStatus(): {
    policy: boolean;
    observability: boolean;
    secrets: boolean;
    integrations: string[];
  } {
    return {
      policy: this.policy !== null,
      observability: this.observability !== null,
      secrets: this.secrets !== null,
      integrations: Array.from(this.integrations.keys()),
    };
  }
}

/** Singleton plugin registry — import and use from anywhere in the core */
export const pluginRegistry = new PluginRegistryImpl();
