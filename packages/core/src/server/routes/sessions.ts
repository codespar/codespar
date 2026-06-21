/**
 * Session routes — implements the codespar SessionBase HTTP contract.
 *
 * Endpoints (registered on both /sessions and /v1/sessions):
 *   POST   /sessions                     — create an in-memory session
 *   POST   /sessions/:id/execute         — execute a registered tool
 *   POST   /sessions/:id/send            — send a message (JSON or SSE)
 *   GET    /sessions/:id/connections     — list session connections
 *   DELETE /sessions/:id                 — close session
 *
 * Auth:
 *   Requires a syntactically valid Bearer token on every request.
 *   When ENGINE_API_TOKEN is set the token is verified; otherwise any
 *   non-empty Bearer string is accepted (local / CI mode).
 *
 * Tenancy (F10.M2): the route resolves `(orgId, projectId)` from the
 * `x-org-id` and `x-codespar-project` headers via the shared
 * `ServerContext`. When the headers are absent the route falls back to
 * org "default" + the org's default project — same self-heal as the
 * other tenancy-aware routes (`webhook-server.ts:294-321`), so the
 * SessionBase contract tests continue to pass without any headers.
 *
 * These routes are the OSS runtime's implementation of the session
 * contract defined in @codespar/types. The contract-oss.test.ts file
 * verifies conformance using runContractSuite from @codespar/types/testing.
 */

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { RouteFn, ServerContext } from "./types.js";
import { getAllAgentMetadata } from "../../agents/agent-registry.js";
import {
  runChatLoop,
  runChatLoopStream,
  type StreamEvent,
} from "../../chat-loop/index.js";
import { mcpBridge } from "../../mcp/index.js";
import type { McpServerSpec } from "../../mcp/index.js";
import { createLogger } from "../../observability/logger.js";
import { pluginRegistry } from "../../plugins/index.js";
import type { MetaToolExecutionContext } from "../../plugins/index.js";
import {
  clearSessionStore as clearCoreStore,
  closeSessionById,
  createSessionForHttp,
  getHttpSessionMap,
  getSessionById,
} from "../../sessions/core.js";
import {
  checkMocksSize,
  validateMocksShape,
} from "../../sessions/mocks-validation.js";
import { tryMockedDispatch } from "../../sessions/mock-dispatch.js";
import {
  isTestModeEnabled,
  MOCKS_NOT_PERMITTED_ENVELOPE,
} from "../../sessions/test-mode-flag.js";
import type { MockValue, Session } from "../../storage/types.js";

const sendLog = createLogger("sessions:send");

/**
 * Validate the optional `server_specs` body field on POST /sessions.
 * Mirrors the wire-format the MCP bridge expects: a string-keyed map of
 * { command: string[], transport: "stdio", env?: Record<string,string> }.
 * Returned `specs` is `undefined` when the caller omitted the field —
 * the route treats undefined and an empty map the same way.
 */
function parseServerSpecs(
  raw: unknown,
): { ok: true; specs: Record<string, McpServerSpec> | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, specs: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "server_specs must be an object keyed by server id" };
  }
  const out: Record<string, McpServerSpec> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      return { ok: false, error: `server_specs.${id} must be an object` };
    }
    const v = value as { command?: unknown; env?: unknown; transport?: unknown };
    if (!Array.isArray(v.command) || v.command.length === 0 || !v.command.every((p) => typeof p === "string")) {
      return { ok: false, error: `server_specs.${id}.command must be a non-empty string array` };
    }
    if (v.transport !== "stdio") {
      return { ok: false, error: `server_specs.${id}.transport must be "stdio"` };
    }
    const spec: McpServerSpec = { command: v.command as string[], transport: "stdio" };
    if (v.env !== undefined) {
      if (!v.env || typeof v.env !== "object" || Array.isArray(v.env)) {
        return { ok: false, error: `server_specs.${id}.env must be a string map` };
      }
      for (const ev of Object.values(v.env as Record<string, unknown>)) {
        if (typeof ev !== "string") {
          return { ok: false, error: `server_specs.${id}.env values must be strings` };
        }
      }
      spec.env = v.env as Record<string, string>;
    }
    out[id] = spec;
  }
  return { ok: true, specs: out };
}

/** Read inline serverSpecs off a session. Stored on `metadata.serverSpecs`
 *  for HTTP (in-memory) sessions; channel-bridge sessions never set it. */
function readServerSpecs(session: Session): Record<string, McpServerSpec> | undefined {
  const raw = session.metadata?.["serverSpecs"];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, McpServerSpec>)
    : undefined;
}

/** Exported for test teardown — clears all entries from the in-memory store. */
export function clearSessionStore(): void {
  clearCoreStore();
}

function checkBearerAuth(request: { headers: Record<string, string | string[] | undefined> }): string | null {
  const auth = request.headers["authorization"] as string | undefined;
  if (!auth?.startsWith("Bearer ")) return null;
  const provided = auth.slice(7).trim();
  if (!provided) return null;

  const engineToken = process.env.ENGINE_API_TOKEN;
  if (engineToken) {
    const providedHash = createHash("sha256").update(provided).digest();
    const expectedHash = createHash("sha256").update(engineToken).digest();
    if (!timingSafeEqual(providedHash, expectedHash)) return null;
  }
  // Without ENGINE_API_TOKEN, any non-empty bearer string is accepted.
  return provided;
}

// Built-in tools available in every OSS session.
const BUILT_IN_TOOLS = new Set(["codespar_list_tools"]);

function executeBuiltIn(toolName: string, sessionId: string): {
  success: boolean;
  data: unknown;
  error: string | null;
  duration: number;
  server: string;
  tool: string;
  tool_call_id: string;
  called_at: string;
} {
  const start = Date.now();
  const tool_call_id = `${sessionId}-${randomUUID().slice(0, 8)}`;
  const called_at = new Date().toISOString();

  if (toolName === "codespar_list_tools") {
    const allMeta = getAllAgentMetadata();
    const agentTools = allMeta.flatMap((m) =>
      m.skills.map((s) => ({ id: s.id, name: s.name, agentType: m.type }))
    );
    // Advertise registered meta-tools alongside agent skills so the
    // listed surface tracks what the runtime can actually dispatch. With
    // no registrant, metaToolDefinitions() is empty and this is a no-op.
    const metaTools = pluginRegistry.metaToolDefinitions().map((d) => ({
      id: d.name,
      name: d.name,
      agentType: "meta-tool",
    }));
    const tools = [...agentTools, ...metaTools];
    return {
      success: true,
      data: { tools },
      error: null,
      duration: Date.now() - start,
      server: "oss-runtime",
      tool: toolName,
      tool_call_id,
      called_at,
    };
  }

  return {
    success: false,
    data: {},
    error: `Tool not registered: ${toolName}`,
    duration: Date.now() - start,
    server: "oss-runtime",
    tool: toolName,
    tool_call_id,
    called_at,
  };
}

/** Read the `servers` list a session was created with (kept in metadata). */
function readServers(session: Session): string[] {
  const raw = session.metadata?.["servers"];
  return Array.isArray(raw) ? (raw as string[]) : [];
}

/**
 * Resolve `(orgId, projectId)` for a request using the shared
 * ServerContext when present. When ctx is null (legacy registration
 * path) falls back to org "default" + the placeholder project string
 * — same shape as before F10.M2 so callers without tenancy headers
 * keep working.
 */
async function resolveOrgAndProject(
  ctx: ServerContext | null,
  request: { headers: Record<string, string | string[] | undefined> },
): Promise<{ orgId: string; projectId: string }> {
  if (!ctx) return { orgId: "default", projectId: "default" };
  const orgId = ctx.getOrgId(request);
  try {
    const projectId = await ctx.resolveProjectId(request, orgId);
    return { orgId, projectId };
  } catch {
    // Fall back to the same "default" placeholder the legacy route
    // used so contract tests with no tenancy headers continue to pass.
    return { orgId, projectId: "default" };
  }
}

export function registerSessionRoutes(route: RouteFn, ctx: ServerContext | null = null): void {
  // POST /sessions — create session
  route("post", "/sessions", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const body = request.body as {
      servers?: string[];
      server_specs?: unknown;
      user_id?: string;
      mocks?: unknown;
    } | undefined;

    const parsed = parseServerSpecs(body?.server_specs);
    if (!parsed.ok) {
      return reply.status(400).send({ error: parsed.error });
    }

    // Optional mocks field — three gates in order so the cheapest
    // rejection reason always surfaces verbatim:
    //   1. Env-flag — deployments that haven't opted in via
    //      `CODESPAR_TEST_MODE_ENABLED=true` get HTTP 501
    //      `mocks_not_permitted` regardless of payload validity.
    //   2. Byte-size cap — 64 KiB ceiling rejects oversized payloads
    //      before the full traversal.
    //   3. Shape — strict-on-shape, lenient-on-membership validation.
    // Mirrors the wire envelope codespar-enterprise emits for the
    // managed runtime so the superset relationship holds. The OSS
    // route omits the per-tenant test-environment gate the managed
    // runtime enforces; the env-flag here is the OSS equivalent.
    let mocks: Record<string, MockValue> | undefined;
    if (body?.mocks !== undefined) {
      if (!isTestModeEnabled()) {
        return reply.status(501).send(MOCKS_NOT_PERMITTED_ENVELOPE);
      }
      const sizeError = checkMocksSize(body.mocks);
      if (sizeError !== null) {
        return reply.status(413).send(sizeError);
      }
      const shapeError = validateMocksShape(body.mocks);
      if (shapeError !== null) {
        return reply.status(400).send(shapeError);
      }
      mocks = body.mocks as Record<string, MockValue>;
    }

    const declared = Array.isArray(body?.servers) ? body.servers : [];
    // If the caller provided inline specs without listing the ids in
    // `servers`, add them — the prefix-validation list must include
    // every server the session expects to dispatch to.
    const inlineIds = parsed.specs ? Object.keys(parsed.specs) : [];
    const mergedServers = Array.from(new Set([...declared, ...inlineIds]));

    const { orgId, projectId } = await resolveOrgAndProject(ctx, request);
    const session = createSessionForHttp({
      orgId,
      projectId,
      userId: typeof body?.user_id === "string" ? body.user_id : "anonymous",
      servers: mergedServers,
      ...(parsed.specs !== undefined ? { serverSpecs: parsed.specs } : {}),
      ...(mocks !== undefined ? { mocks } : {}),
    });

    return reply.status(201).send({ id: session.id, status: session.status });
  });

  // POST /sessions/:id/execute — execute a registered tool
  route("post", "/sessions/:id/execute", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = await getSessionById(id, ctx?.storageProvider ?? null);
    if (!session || session.status !== "active") {
      return reply.status(404).send({ error: "Session not found or closed" });
    }

    const body = request.body as { tool?: string; input?: Record<string, unknown> } | undefined;
    const toolName = typeof body?.tool === "string" ? body.tool : "";

    if (!toolName) {
      return reply.status(400).send({ error: "tool field is required" });
    }

    // MCP dispatch — `prefix/tool` names route to a spawned MCP server
    // when the prefix is registered on this session. Split on the first
    // `/` only so tool paths like `nuvem-fiscal/foo/bar` resolve to
    // server="nuvem-fiscal", tool="foo/bar".
    //
    // Mocks-first: the dispatch seam is consulted before anything
    // else. Under per-deployment strict mode
    // (`CODESPAR_TEST_MODE_ENABLED` on), the seam ALWAYS returns a
    // result — `consumed`/`exhausted`/`tool_not_mocked`/
    // `mocks_engine_error` — never null. With the flag off the seam
    // short-circuits to null and the dispatcher falls through to the
    // bridge (registered prefix) or the legacy `Tool not registered`
    // envelope (unknown prefix) exactly as before mocks shipped.
    if (toolName.includes("/")) {
      const slashIdx = toolName.indexOf("/");
      const serverId = toolName.slice(0, slashIdx);
      const subTool = toolName.slice(slashIdx + 1);
      if (serverId && subTool) {
        const mocked = await tryMockedDispatch(
          session,
          serverId,
          subTool,
          body?.input ?? {},
        );
        if (mocked) {
          if (mocked.outcome.kind === "tool_not_mocked") {
            return reply.status(422).send(mocked.result.data);
          }
          if (mocked.outcome.kind === "exhausted") {
            return reply.status(422).send(mocked.result.data);
          }
          if (mocked.outcome.kind === "mocks_engine_error") {
            return reply.status(503).send(mocked.result.data);
          }
          // consumed
          return mocked.result;
        }
      }

      // Flag off — passthrough to bridge for registered prefixes or
      // the legacy envelope for unknown ones.
      if (serverId && subTool && readServers(session).includes(serverId)) {
        const specOverride = readServerSpecs(session)?.[serverId];
        return mcpBridge.call(id, serverId, subTool, body?.input ?? {}, {
          ...(specOverride !== undefined ? { specOverride } : {}),
        });
      }
      return {
        success: false,
        data: {},
        error: `Tool not registered: ${toolName}`,
        duration: 0,
        server: "oss-runtime",
        tool: toolName,
        tool_call_id: `${id}-${randomUUID().slice(0, 8)}`,
        called_at: new Date().toISOString(),
      };
    }

    if (BUILT_IN_TOOLS.has(toolName)) {
      return executeBuiltIn(toolName, id);
    }

    // Meta-tool dispatch — consult the plugin registry for a hook
    // registered under this name. Meta-tool names contain no `/`, so this
    // is unreachable for MCP-prefixed names (handled in the branch above)
    // and can never shadow them. With no registrant, getMetaTool returns
    // null and the runtime falls through to "Tool not registered" exactly
    // as before the seam existed.
    const metaHook = pluginRegistry.getMetaTool(toolName);
    if (metaHook) {
      const metaCtx: MetaToolExecutionContext = {
        orgId: session.orgId,
        projectId: session.projectId,
        sessionId: id,
        environment: "live",
        ...(request.raw?.signal instanceof AbortSignal
          ? { signal: request.raw.signal }
          : {}),
      };
      const tool_call_id = `${id}-${randomUUID().slice(0, 8)}`;
      const called_at = new Date().toISOString();
      try {
        const result = await metaHook.execute(toolName, body?.input ?? {}, metaCtx);
        return {
          success: true,
          data: result.output,
          error: null,
          duration: result.duration_ms,
          server: result.server_id,
          tool: toolName,
          tool_call_id,
          called_at,
        };
      } catch (err) {
        // Sanitize the failure message — registrants own redaction of
        // sensitive fields, but the runtime must not leak a raw error
        // object across the envelope boundary either.
        const message = err instanceof Error ? err.message : "meta-tool execution failed";
        return {
          success: false,
          data: {},
          error: message,
          duration: 0,
          server: metaHook.id,
          tool: toolName,
          tool_call_id,
          called_at,
        };
      }
    }

    return {
      success: false,
      data: {},
      error: `Tool not registered: ${toolName}`,
      duration: 0,
      server: "oss-runtime",
      tool: toolName,
      tool_call_id: `${id}-${randomUUID().slice(0, 8)}`,
      called_at: new Date().toISOString(),
    };
  });

  // POST /sessions/:id/send — send a message, responds with JSON or SSE.
  //
  // JSON mode (Accept: application/json or default):
  //   Returns SendResult once the chat loop terminates. SendResult is
  //   `{ message, tool_calls, iterations }` where `tool_calls` lists every
  //   MCP dispatch the agent performed during this send.
  //
  // SSE mode (Accept: text/event-stream):
  //   Streams events in this order:
  //     user_message → (assistant_text | tool_use | tool_result)* → done
  //   On failure the terminal event is `error` instead of `done`.
  route("post", "/sessions/:id/send", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = await getSessionById(id, ctx?.storageProvider ?? null);
    if (!session || session.status !== "active") {
      return reply.status(404).send({ error: "Session not found or closed" });
    }

    const body = request.body as { message?: string } | undefined;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const accept = (request.headers["accept"] as string | undefined) ?? "";

    if (accept.includes("text/event-stream")) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const emit = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        for await (const ev of runChatLoopStream(message, session, {
          storage: ctx?.storageProvider ?? null,
        })) {
          const { type, ...rest } = ev as StreamEvent & Record<string, unknown>;
          emit(type, rest);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendLog.error("chat loop stream failed", { sessionId: id, error: msg });
        emit("error", { message: msg });
      } finally {
        reply.raw.end();
      }
      return reply;
    }

    try {
      const result = await runChatLoop(message, session, {
        storage: ctx?.storageProvider ?? null,
      });
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendLog.error("chat loop failed", { sessionId: id, error: msg });
      return reply.status(500).send({ error: "chat_loop_failed", message: msg });
    }
  });

  // GET /sessions/:id/connections — list connections associated with this session
  route("get", "/sessions/:id/connections", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = await getSessionById(id, ctx?.storageProvider ?? null);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    const servers = readServers(session).map((s, i) => ({
      id: `${id}-conn-${i}-${s}`,
      connected: session.status === "active",
    }));

    return { servers };
  });

  // DELETE /sessions/:id — close session and release resources.
  // Awaits the MCP bridge tearing down child processes before replying
  // so callers can rely on lifecycle being tied to the session: when
  // the 204 lands, every child for this session is gone.
  route("delete", "/sessions/:id", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = await getSessionById(id, ctx?.storageProvider ?? null);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    // Atomicity contract: tear down MCP child processes first; on bridge
    // failure abort with 500 so callers don't silently lose the close-
    // session signal. Only proceed to mark the session closed (in-memory
    // or storage) once the bridge has released its resources.
    try {
      await mcpBridge.closeSession(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `mcp.close_failed: ${message}` });
    }

    await closeSessionById(id, ctx?.storageProvider ?? null);
    return reply.status(204).send();
  });

  // `getHttpSessionMap` is only referenced when a test wants to inspect
  // the in-memory store directly. Re-exporting prevents unused-import
  // warnings when a downstream test imports it from sessions.ts.
  void getHttpSessionMap;
}
