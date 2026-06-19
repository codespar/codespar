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

/**
 * Execution context passed to a meta-tool hook.
 *
 * This is the public, strict subset of the context a registrant receives:
 * only the trusted, scope-defining fields cross the boundary. A registrant
 * that needs richer internal context (database handles, provider clients,
 * etc.) constructs it itself, derived ONLY from the trusted `orgId`/
 * `projectId` here — never from agent-supplied input. The core never
 * widens this shape; widening happens inside the registrant.
 */
export interface MetaToolExecutionContext {
  /** Tenant/org the calling session is scoped to (authorization root). */
  orgId: string;
  /** Project the session is scoped to; null for system-wide contexts. */
  projectId: string | null;
  /** The session driving this execution. */
  sessionId: string;
  /** Optional least-privilege agent scope; defaults to the caller. */
  agentId?: string | null;
  /** Whether this runs against live or test rails. */
  environment?: "live" | "test";
  /** Abort signal — registrants SHOULD honor it to cancel in-flight work. */
  signal?: AbortSignal;
}

/**
 * Advertised definition of a meta-tool, fed to tool-listing surfaces
 * (`codespar_list_tools`, the chat-loop catalog) so the tools a runtime
 * advertises track what is actually registered.
 */
export interface MetaToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** Result envelope a meta-tool hook returns. */
export interface MetaToolResult {
  /** Identifier of the server/provider that produced the result. */
  server_id: string;
  /** The tool's output payload. */
  output: unknown;
  /** Wall-clock duration of the execution, in milliseconds. */
  duration_ms: number;
}

/**
 * Meta-tool hook — the fifth plugin hook. Lets any implementation register
 * a named, higher-level tool (a "meta-tool") that the runtime dispatches by
 * name through the standard execute path, alongside the four existing hooks
 * (`PolicyHook`/`ObservabilityHook`/`SecretsHook`/`IntegrationHook`).
 *
 * A registered hook runs arbitrary in-process code on the execute path, so
 * it is trusted by construction — treat a third-party registrant with the
 * same scrutiny as any dependency you import and call. The seam does not
 * sandbox registrants.
 */
export interface MetaToolHook {
  /** Diagnostic id for this registrant, e.g. "example". */
  id: string;
  /** Meta-tool names this hook serves. */
  handles: string[];
  /** Optional advertised definitions for tool-listing surfaces. */
  definitions?(): MetaToolDefinition[];
  /** Execute a meta-tool by name with the public execution context. */
  execute(
    name: string,
    input: Record<string, unknown>,
    ctx: MetaToolExecutionContext,
  ): Promise<MetaToolResult>;
}

/** All available plugin hooks */
export interface PluginHooks {
  policy?: PolicyHook;
  observability?: ObservabilityHook;
  secrets?: SecretsHook;
  integrations?: IntegrationHook[];
  metaTools?: MetaToolHook[];
}
