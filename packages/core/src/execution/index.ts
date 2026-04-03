export { ClaudeBridge, parseFileChanges, parseDiffChanges } from "./claude-bridge.js";
export type {
  ProgressEvent,
  ExecutionRequest,
  RepoExecutionRequest,
  ExecutionResult,
} from "./claude-bridge.js";

// Docker Execution Sandbox
export type { SandboxConfig, SandboxResult, ExecutionSandbox } from "./sandbox.js";
export { DEFAULT_SANDBOX_CONFIG } from "./sandbox.js";
export { DockerSandbox } from "./docker-sandbox.js";
export { ContainerPool } from "./container-pool.js";
export type { PoolStats } from "./container-pool.js";

/**
 * Create an ExecutionSandbox backed by Docker if Docker is reachable,
 * otherwise returns null (caller should fall back to ClaudeBridge).
 *
 * Usage:
 *   const sandbox = await createSandbox();
 *   if (sandbox) {
 *     const result = await sandbox.execute("npm test");
 *   } else {
 *     // fall back to ClaudeBridge
 *   }
 */
export async function createSandbox(
  config?: Partial<import("./sandbox.js").SandboxConfig>,
): Promise<import("./sandbox.js").ExecutionSandbox | null> {
  const { DockerSandbox: DS } = await import("./docker-sandbox.js");
  const sandbox = new DS(config);
  const available = await sandbox.isAvailable();
  return available ? sandbox : null;
}
