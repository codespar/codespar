/**
 * Plugin system types for enterprise extensions.
 *
 * The core engine calls these hooks at specific points in the agent lifecycle.
 * Enterprise packages (policy-engine, observability, secrets-vault) register
 * themselves as plugins without the core importing them directly.
 *
 * This keeps the core independent of enterprise code while allowing
 * deep integration when enterprise packages are available.
 */

/** Decision from a policy evaluation */
export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
  /** If true, requires human approval before proceeding */
  requiresApproval?: boolean;
}

/** Metric recorded after a tool/action execution */
export interface ToolMetric {
  toolName: string;
  agentId: string;
  latencyMs: number;
  success: boolean;
  cost: number;
  inputTokens?: number;
  outputTokens?: number;
  errorType?: string;
}

/** Policy hook — called BEFORE agent executes an action */
export interface PolicyHook {
  evaluate(agentId: string, toolName: string, estimatedCost?: number): PolicyDecision;
  recordUsage?(agentId: string, toolName: string, cost: number): void;
}

/** Observability hook — called AFTER agent executes an action */
export interface ObservabilityHook {
  record(metric: ToolMetric): void;
  getStats?(toolName?: string): unknown;
}

/** Secrets hook — called when agent needs credentials */
export interface SecretsHook {
  get(tenantId: string, key: string): string | null;
  set?(tenantId: string, key: string, value: string): void;
}

/** Integration connector for external services (Sentry, Linear, Jira, etc.) */
export interface IntegrationHook {
  id: string;
  name: string;
  handleWebhook(payload: unknown, headers: Record<string, string>): Promise<{
    eventType: string;
    severity: string;
    title: string;
    detail?: string;
    url?: string;
  } | null>;
  verifySignature?(payload: string, signature: string, secret: string): boolean;
  healthCheck?(): Promise<boolean>;
}

/** All available plugin hooks */
export interface PluginHooks {
  policy?: PolicyHook;
  observability?: ObservabilityHook;
  secrets?: SecretsHook;
  integrations?: IntegrationHook[];
}
