/**
 * Process manager for the OSS MCP bridge.
 *
 * Spawns stdio child processes from `McpServerSpec`, proxies JSON-RPC 2.0
 * `tools/call` requests over stdin, correlates replies on stdout, and
 * ties process lifecycle to the `(sessionId, serverId)` tuple. Stderr is
 * read on a separate stream and forwarded via the structured logger; it
 * never mixes into the JSON-RPC channel.
 *
 * The bridge is intentionally data-driven: spawn args come straight from
 * `spec.command`, environment is `process.env` merged with `spec.env`
 * (spec wins on key conflict), and there is no hard-coded server-id
 * allowlist. The same code path serves OSS demos, CI integration runs,
 * and production self-hosted deployments.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createLogger } from "../observability/logger.js";
import { MCP_ERROR_CODES, type McpServerSpec, type ToolResult } from "./types.js";

const log = createLogger("mcp-bridge");

/**
 * Boundary interface — the manager talks to the registry only through
 * `resolve(serverId)`. Keeping this structural lets a future catalog-
 * backed implementation drop in without touching the manager, and lets
 * tests substitute a stub registry without depending on the seed JSON.
 */
export interface McpRegistryLike {
  resolve(serverId: string): McpServerSpec | null;
}

interface PendingCall {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout | null;
  baseFields: Pick<
    ToolResult,
    "server" | "tool" | "tool_call_id" | "called_at"
  >;
  startedAt: number;
}

interface ChildHandle {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, PendingCall>;
  pendingOrder: string[];
  stdoutBuf: string;
  stderrBuf: string;
  nextRpcId: number;
  serverId: string;
  sessionId: string;
  exited: boolean;
}

interface ManagerOptions {
  registry: McpRegistryLike;
  defaultTimeoutMs?: number;
}

function buildKey(sessionId: string, serverId: string): string {
  return `${sessionId}::${serverId}`;
}

function buildFailure(
  base: PendingCall["baseFields"],
  errorCode: string,
  startedAt: number,
): ToolResult {
  return {
    success: false,
    data: {},
    error: errorCode,
    duration: Date.now() - startedAt,
    ...base,
  };
}

export class McpProcessManager {
  readonly #registry: McpRegistryLike;
  readonly #defaultTimeoutMs: number;
  readonly #children = new Map<string, ChildHandle>();

  constructor(opts: ManagerOptions) {
    this.#registry = opts.registry;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 30_000;
  }

  async call(
    sessionId: string,
    serverId: string,
    tool: string,
    input: unknown,
    opts?: { timeoutMs?: number; specOverride?: McpServerSpec },
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const tool_call_id = `${sessionId}-${randomUUID().slice(0, 8)}`;
    const called_at = new Date().toISOString();
    const baseFields = {
      server: serverId,
      tool,
      tool_call_id,
      called_at,
    };

    // Inline session-scoped spec wins over the registry. Lets callers
    // (typically sessions.ts when the session was created with
    // `server_specs`) bypass the config-file path entirely without the
    // bridge needing a second resolution surface.
    const spec = opts?.specOverride ?? this.#registry.resolve(serverId);
    if (!spec) {
      return buildFailure(baseFields, MCP_ERROR_CODES.unknown_server, startedAt);
    }

    const key = buildKey(sessionId, serverId);
    let handle = this.#children.get(key);
    if (!handle) {
      const env = { ...process.env, ...(spec.env ?? {}) };
      const child = spawn(spec.command[0], spec.command.slice(1), {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      handle = {
        child,
        pending: new Map(),
        pendingOrder: [],
        stdoutBuf: "",
        stderrBuf: "",
        nextRpcId: 1,
        serverId,
        sessionId,
        exited: false,
      };
      this.#children.set(key, handle);
      this.#wireChild(handle);
    }

    const id = String(handle.nextRpcId++);
    const request = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: input },
    };

    return new Promise<ToolResult>((resolve) => {
      const timeoutMs = opts?.timeoutMs ?? this.#defaultTimeoutMs;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              const entry = handle!.pending.get(id);
              if (!entry) return;
              this.#removePending(handle!, id);
              entry.resolve(
                buildFailure(baseFields, MCP_ERROR_CODES.timeout, startedAt),
              );
            }, timeoutMs)
          : null;

      handle!.pending.set(id, {
        resolve,
        timer,
        baseFields,
        startedAt,
      });
      handle!.pendingOrder.push(id);

      try {
        handle!.child.stdin.write(JSON.stringify(request) + "\n");
      } catch (err) {
        // Write failed (e.g. child closed stdin). Surface as parse_error
        // so callers see a structured failure; the cache entry will be
        // evicted by the exit handler.
        this.#removePending(handle!, id);
        if (timer) clearTimeout(timer);
        log.warn("stdin write failed", {
          serverId,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        resolve(
          buildFailure(baseFields, MCP_ERROR_CODES.child_exit, startedAt),
        );
      }
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    const prefix = `${sessionId}::`;
    const keys: string[] = [];
    for (const key of this.#children.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    if (keys.length === 0) return;

    await Promise.all(
      keys.map(async (key) => {
        const handle = this.#children.get(key);
        if (!handle) return;
        await this.#killChild(handle);
        this.#children.delete(key);
      }),
    );
  }

  /** @internal Test-only diagnostic — exposes cache size for assertions. */
  getActiveProcessCount(): number {
    return this.#children.size;
  }

  #wireChild(handle: ChildHandle): void {
    const { child, serverId, sessionId } = handle;
    const pid = child.pid;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      handle.stdoutBuf += chunk;
      let nlIdx = handle.stdoutBuf.indexOf("\n");
      while (nlIdx !== -1) {
        const line = handle.stdoutBuf.slice(0, nlIdx);
        handle.stdoutBuf = handle.stdoutBuf.slice(nlIdx + 1);
        this.#handleStdoutLine(handle, line);
        nlIdx = handle.stdoutBuf.indexOf("\n");
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      handle.stderrBuf += chunk;
      let nlIdx = handle.stderrBuf.indexOf("\n");
      while (nlIdx !== -1) {
        const line = handle.stderrBuf.slice(0, nlIdx);
        handle.stderrBuf = handle.stderrBuf.slice(nlIdx + 1);
        if (line.length > 0) {
          log.info("mcp child stderr", {
            serverId,
            sessionId,
            pid,
            line,
          });
        }
        nlIdx = handle.stderrBuf.indexOf("\n");
      }
    });

    child.on("exit", (code, signal) => {
      handle.exited = true;
      // Drop any partial stderr without a trailing newline.
      if (handle.stderrBuf.trim().length > 0) {
        log.info("mcp child stderr (partial)", {
          serverId,
          sessionId,
          pid,
          line: handle.stderrBuf,
        });
        handle.stderrBuf = "";
      }
      log.info("mcp child exit", {
        serverId,
        sessionId,
        pid,
        code,
        signal,
      });

      // Resolve every still-pending call with child_exit and evict.
      const pendingIds = [...handle.pendingOrder];
      for (const id of pendingIds) {
        const entry = handle.pending.get(id);
        if (!entry) continue;
        if (entry.timer) clearTimeout(entry.timer);
        handle.pending.delete(id);
        entry.resolve(
          buildFailure(
            entry.baseFields,
            MCP_ERROR_CODES.child_exit,
            entry.startedAt,
          ),
        );
      }
      handle.pendingOrder = [];

      const key = buildKey(sessionId, serverId);
      if (this.#children.get(key) === handle) {
        this.#children.delete(key);
      }
    });

    child.on("error", (err) => {
      log.warn("mcp child error", {
        serverId,
        sessionId,
        pid,
        err: err.message,
      });
    });
  }

  #handleStdoutLine(handle: ChildHandle, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Parse error — match to oldest pending (FIFO) and resolve as
      // structured parse_error. Child stays alive.
      log.warn("mcp parse error on stdout", {
        serverId: handle.serverId,
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        line: trimmed,
      });
      this.#resolveOldestPending(handle, MCP_ERROR_CODES.parse_error);
      return;
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("id" in parsed) ||
      (parsed as { id: unknown }).id == null
    ) {
      log.warn("mcp reply missing id", {
        serverId: handle.serverId,
        sessionId: handle.sessionId,
        pid: handle.child.pid,
      });
      return;
    }

    const id = String((parsed as { id: unknown }).id);
    const entry = handle.pending.get(id);
    if (!entry) {
      log.warn("mcp reply id not pending", {
        serverId: handle.serverId,
        sessionId: handle.sessionId,
        pid: handle.child.pid,
        id,
      });
      return;
    }
    this.#removePending(handle, id);
    if (entry.timer) clearTimeout(entry.timer);

    const obj = parsed as { result?: unknown; error?: unknown };
    if (obj.error !== undefined) {
      // JSON-RPC error envelope — surface as structured failure.
      entry.resolve(
        buildFailure(
          entry.baseFields,
          MCP_ERROR_CODES.child_exit,
          entry.startedAt,
        ),
      );
      return;
    }

    const result = (obj.result ?? {}) as Partial<ToolResult> & {
      success?: boolean;
      data?: unknown;
      error?: string;
    };
    entry.resolve({
      success: result.success ?? true,
      data: result.data ?? null,
      error: result.error ?? "",
      duration: Date.now() - entry.startedAt,
      ...entry.baseFields,
    });
  }

  #resolveOldestPending(handle: ChildHandle, errorCode: string): void {
    const id = handle.pendingOrder[0];
    if (!id) return;
    const entry = handle.pending.get(id);
    if (!entry) {
      handle.pendingOrder.shift();
      return;
    }
    this.#removePending(handle, id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(
      buildFailure(entry.baseFields, errorCode, entry.startedAt),
    );
  }

  #removePending(handle: ChildHandle, id: string): void {
    handle.pending.delete(id);
    const idx = handle.pendingOrder.indexOf(id);
    if (idx !== -1) handle.pendingOrder.splice(idx, 1);
  }

  async #killChild(handle: ChildHandle): Promise<void> {
    if (handle.exited) return;
    const exitPromise = new Promise<void>((resolve) => {
      if (handle.exited) {
        resolve();
        return;
      }
      handle.child.once("exit", () => resolve());
    });

    handle.child.kill("SIGTERM");

    const killTimer = setTimeout(() => {
      if (!handle.exited) {
        try {
          handle.child.kill("SIGKILL");
        } catch {
          // Already dead.
        }
      }
    }, 2_000);

    await exitPromise;
    clearTimeout(killTimer);
  }
}
