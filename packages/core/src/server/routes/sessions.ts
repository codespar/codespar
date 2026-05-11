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
 * These routes are the OSS runtime's implementation of the session
 * contract defined in @codespar/types. The contract-oss.test.ts file
 * verifies conformance using runContractSuite from @codespar/types/testing.
 */

import { randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { RouteFn } from "./types.js";
import { generateSmartResponse, type AgentContext } from "../../ai/smart-responder.js";
import { getAllAgentMetadata } from "../../agents/agent-registry.js";
import { mcpBridge } from "../../mcp/index.js";
import type { McpServerSpec } from "../../mcp/index.js";

interface SessionEntry {
  id: string;
  status: "active" | "closed" | "error";
  servers: string[];
  // Optional inline specs supplied at session creation. When present,
  // dispatch passes the spec to the bridge as `specOverride` and skips
  // the registry — letting callers configure MCP servers per session
  // without a shared `mcp-servers.json` file.
  serverSpecs?: Record<string, McpServerSpec>;
  userId: string;
  createdAt: Date;
}

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

// In-memory store — scoped to process lifetime; CI creates a fresh process
// per test run, so cross-test contamination is impossible.
const sessions = new Map<string, SessionEntry>();

/** Exported for test teardown — clears all entries from the in-memory store. */
export function clearSessionStore(): void {
  sessions.clear();
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
// codespar_list_tools exposes the skill manifest from the agent registry
// so SDK callers can discover agent capabilities without additional config.
const BUILT_IN_TOOLS = new Set(["codespar_list_tools"]);

function executeBuiltIn(toolName: string, sessionId: string): {
  success: boolean;
  data: unknown;
  error: string;
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
    const tools = allMeta.flatMap((m) =>
      m.skills.map((s) => ({ id: s.id, name: s.name, agentType: m.type }))
    );
    return {
      success: true,
      data: { tools },
      error: "",
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

function makeAgentContext(session: SessionEntry): AgentContext {
  return {
    agentId: `session-${session.id.slice(0, 8)}`,
    projectId: "default",
    autonomyLevel: 1,
    tasksHandled: 0,
    uptimeMinutes: Math.round((Date.now() - session.createdAt.getTime()) / 60_000),
    recentAudit: [],
    memoryStats: { total: 0, byCategory: {} },
    linkedChannels: [],
  };
}

export function registerSessionRoutes(route: RouteFn): void {
  // POST /sessions — create session
  route("post", "/sessions", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const body = request.body as {
      servers?: string[];
      server_specs?: unknown;
      user_id?: string;
    } | undefined;

    const parsed = parseServerSpecs(body?.server_specs);
    if (!parsed.ok) {
      return reply.status(400).send({ error: parsed.error });
    }

    const declared = Array.isArray(body?.servers) ? body.servers : [];
    // If the caller provided inline specs without listing the ids in
    // `servers`, add them — the prefix-validation list must include
    // every server the session expects to dispatch to.
    const inlineIds = parsed.specs ? Object.keys(parsed.specs) : [];
    const merged = Array.from(new Set([...declared, ...inlineIds]));

    const id = randomUUID();
    sessions.set(id, {
      id,
      status: "active",
      servers: merged,
      serverSpecs: parsed.specs,
      userId: typeof body?.user_id === "string" ? body.user_id : "anonymous",
      createdAt: new Date(),
    });

    return reply.status(201).send({ id, status: "active" });
  });

  // POST /sessions/:id/execute — execute a registered tool
  route("post", "/sessions/:id/execute", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = sessions.get(id);
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
    // server="nuvem-fiscal", tool="foo/bar". Unknown prefixes return the
    // existing `Tool not registered` shape (HTTP 200), not 403.
    if (toolName.includes("/")) {
      const slashIdx = toolName.indexOf("/");
      const serverId = toolName.slice(0, slashIdx);
      const subTool = toolName.slice(slashIdx + 1);
      if (serverId && subTool && session.servers.includes(serverId)) {
        const specOverride = session.serverSpecs?.[serverId];
        return mcpBridge.call(id, serverId, subTool, body?.input ?? {}, {
          specOverride,
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

    // Unknown tool — return structured error so callers can distinguish
    // "tool not found" from a network/server error.
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

  // POST /sessions/:id/send — send a message, responds with JSON or SSE
  //
  // JSON mode (Accept: application/json or default):
  //   Returns SendResult immediately after the agent responds.
  //
  // SSE mode (Accept: text/event-stream):
  //   Streams user_message → assistant_text → done events. When
  //   ANTHROPIC_API_KEY is unset the assistant_text is a fallback string so
  //   the CI contract test passes without any credentials.
  route("post", "/sessions/:id/send", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session || session.status !== "active") {
      return reply.status(404).send({ error: "Session not found or closed" });
    }

    const body = request.body as { message?: string } | undefined;
    const message = typeof body?.message === "string" ? body.message.trim() : "";
    const accept = (request.headers["accept"] as string | undefined) ?? "";

    const ctx = makeAgentContext(session);
    const aiText = await generateSmartResponse(message || "hello", ctx);
    const responseText = aiText ?? "Message received. Set ANTHROPIC_API_KEY for AI responses.";

    const sendResult = {
      message: responseText,
      tool_calls: [] as unknown[],
      iterations: 1,
    };

    if (accept.includes("text/event-stream")) {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const emit = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      emit("user_message", { content: message });
      emit("assistant_text", { content: responseText, iteration: 1 });
      emit("done", sendResult);

      reply.raw.end();
      return reply;
    }

    return sendResult;
  });

  // GET /sessions/:id/connections — list connections associated with this session
  route("get", "/sessions/:id/connections", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    const servers = session.servers.map((s, i) => ({
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
    const session = sessions.get(id);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    try {
      await mcpBridge.closeSession(id);
    } catch (err) {
      // Lifecycle bug — surface as 500 so callers don't silently lose
      // the close-session signal. The in-memory session is still marked
      // closed for audit purposes.
      session.status = "closed";
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: `mcp.close_failed: ${message}` });
    }

    session.status = "closed";
    return reply.status(204).send();
  });
}
