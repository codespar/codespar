/**
 * Docker Execution Sandbox interface.
 *
 * Defines how agents execute code in isolated Docker containers.
 * Currently not implemented (tasks run via Anthropic API).
 * This interface is the contract for the future Docker execution engine.
 */

export interface SandboxConfig {
  /** Docker image to use (default: "node:22-alpine") */
  image: string;
  /** Working directory inside the container */
  workDir: string;
  /** Maximum execution time in milliseconds */
  timeoutMs: number;
  /** Memory limit (e.g., "512m") */
  memoryLimit: string;
  /** CPU limit (e.g., "1.0" for 1 core) */
  cpuLimit: string;
  /** Network access (default: false) */
  networkEnabled: boolean;
  /** Environment variables to pass */
  env: Record<string, string>;
  /** Files to mount (host path -> container path) */
  mounts: Array<{ hostPath: string; containerPath: string; readOnly: boolean }>;
}

export interface SandboxResult {
  /** Exit code (0 = success) */
  exitCode: number;
  /** Combined stdout */
  stdout: string;
  /** Combined stderr */
  stderr: string;
  /** Execution duration in ms */
  durationMs: number;
  /** Whether the execution timed out */
  timedOut: boolean;
}

export interface ExecutionSandbox {
  /** Execute a command in an isolated container */
  execute(command: string, config: Partial<SandboxConfig>): Promise<SandboxResult>;

  /** Execute a script file in an isolated container */
  executeScript(script: string, language: string, config: Partial<SandboxConfig>): Promise<SandboxResult>;

  /** Check if Docker is available */
  isAvailable(): Promise<boolean>;

  /** Clean up any running containers */
  cleanup(): Promise<void>;
}

/** Default sandbox configuration */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  image: "node:22-alpine",
  workDir: "/workspace",
  timeoutMs: 60_000,
  memoryLimit: "512m",
  cpuLimit: "1.0",
  networkEnabled: false,
  env: {},
  mounts: [],
};
