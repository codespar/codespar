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
  MetaToolHook,
  MetaToolDefinition,
  PolicyDecision,
  ToolMetric,
} from "./types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("plugin-registry");

export class PluginRegistry {
  private policy: PolicyHook | null = null;
  private observability: ObservabilityHook | null = null;
  private secrets: SecretsHook | null = null;
  private integrations: Map<string, IntegrationHook> = new Map();
  /** Meta-tool hooks keyed by the meta-tool name they handle. */
  private metaTools: Map<string, MetaToolHook> = new Map();
  private sealed = false;

  /** Register a policy engine plugin.
   *
   * Throws if the registry is already sealed or if a policy hook has already
   * been registered. Call seal() after registration to lock the registry
   * against further overwrites. The hook object is frozen at registration
   * time to prevent post-registration mutation.
   */
  registerPolicy(hook: PolicyHook): void {
    if (this.sealed) {
      throw new Error("Plugin registry is sealed; no further registrations are allowed.");
    }
    if (this.policy !== null) {
      throw new Error("Policy hook already registered. Seal the registry after registration to prevent accidental overwrites.");
    }
    this.policy = Object.freeze(hook) as PolicyHook;
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

  /** Register a meta-tool hook.
   *
   * The hook is indexed by every name in `hook.handles`. This seam is
   * hardened beyond `registerIntegration`'s silent overwrite because it
   * carries money-path names (a registered meta-tool runs arbitrary
   * in-process code on the execute path):
   *
   *   - It honors `seal()`: registering after the registry is sealed
   *     throws, closing the post-boot registration window — matching
   *     `registerPolicy`'s safety intent.
   *   - It logs a warning on every name-override, carrying the incoming
   *     and shadowed registrant ids plus the shadowed name, so a
   *     money-path shadow is observable rather than silent.
   *
   * Last-registrant-wins is retained as the intended override mechanism
   * (a self-hoster overriding an example adapter) — the logging makes it
   * auditable, not blocked.
   */
  registerMetaTool(hook: MetaToolHook): void {
    if (this.sealed) {
      throw new Error("Plugin registry is sealed; no further registrations are allowed.");
    }
    for (const name of hook.handles) {
      const existing = this.metaTools.get(name);
      if (existing && existing.id !== hook.id) {
        log.warn("Meta-tool name override", {
          name,
          shadowedBy: hook.id,
          shadowed: existing.id,
        });
      }
      this.metaTools.set(name, hook);
    }
    log.info("Meta-tool plugin registered", { id: hook.id, handles: hook.handles });
  }

  /** Seal the registry against any further policy registrations.
   *
   * Call this after all plugins have been registered, before the server
   * starts accepting requests. Once sealed, any call to registerPolicy
   * will throw regardless of whether a hook is currently registered.
   */
  seal(): void {
    this.sealed = true;
    log.info("Plugin registry sealed");
  }

  /** Returns true if the registry has been sealed. */
  isSealed(): boolean {
    return this.sealed;
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

  // ── Meta-tools API ──────────────────────────────────────────

  /** Get the meta-tool hook registered for a name, or null when none is.
   *  Null is the permissive default — the dispatch path falls through to
   *  the normal "Tool not registered" envelope, so an OSS runtime with no
   *  registrant behaves exactly as before the seam existed. */
  getMetaTool(name: string): MetaToolHook | null {
    return this.metaTools.get(name) ?? null;
  }

  /** Advertised definitions across all registered meta-tool hooks, so
   *  tool-listing surfaces track what is actually registered. Definitions
   *  are de-duplicated by name (last-registrant-wins, mirroring dispatch). */
  metaToolDefinitions(): MetaToolDefinition[] {
    const byName = new Map<string, MetaToolDefinition>();
    for (const hook of new Set(this.metaTools.values())) {
      for (const def of hook.definitions?.() ?? []) {
        byName.set(def.name, def);
      }
    }
    return Array.from(byName.values());
  }

  // ── Diagnostics ─────────────────────────────────────────────

  /** Get a summary of registered plugins (for health/status endpoints) */
  getStatus(): {
    policy: boolean;
    observability: boolean;
    secrets: boolean;
    integrations: string[];
    metaTools: string[];
    sealed: boolean;
  } {
    return {
      policy: this.policy !== null,
      observability: this.observability !== null,
      secrets: this.secrets !== null,
      integrations: Array.from(this.integrations.keys()),
      metaTools: Array.from(this.metaTools.keys()),
      sealed: this.sealed,
    };
  }
}

/** Singleton plugin registry — import and use from anywhere in the core */
export const pluginRegistry = new PluginRegistry();
