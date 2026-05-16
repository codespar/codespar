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
  clearSessionStore as clearCoreStore,
  closeSessionById,
  createSessionForHttp,
  getHttpSessionMap,
  getSessionById,
  sendInboundMessage,
} from "../../sessions/core.js";
import type { Session } from "../../storage/types.js";

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

    const body = request.body as { servers?: string[]; user_id?: string } | undefined;
    const { orgId, projectId } = await resolveOrgAndProject(ctx, request);
    const session = createSessionForHttp({
      orgId,
      projectId,
      userId: typeof body?.user_id === "string" ? body.user_id : "anonymous",
      servers: Array.isArray(body?.servers) ? body.servers : [],
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

    if (BUILT_IN_TOOLS.has(toolName)) {
      return executeBuiltIn(toolName, id);
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

  // POST /sessions/:id/send — send a message, responds with JSON or SSE
  //
  // JSON mode (Accept: application/json or default):
  //   Returns SendResult immediately after the agent responds.
  //
  // SSE mode (Accept: text/event-stream):
  //   Streams user_message → assistant_text → done events. When
  //   ANTHROPIC_API_KEY is unset the assistant_text is a fallback string
  //   so the contract test passes without any credentials.
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

    const sendResult = await sendInboundMessage(session, message);

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
      emit("assistant_text", { content: sendResult.message, iteration: 1 });
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

  // DELETE /sessions/:id — close session and release resources
  route("delete", "/sessions/:id", async (request: any, reply: any) => {
    if (!checkBearerAuth(request)) {
      return reply.status(401).send({ error: "Missing or invalid Bearer token" });
    }

    const { id } = request.params as { id: string };
    const session = await getSessionById(id, ctx?.storageProvider ?? null);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }

    await closeSessionById(id, ctx?.storageProvider ?? null);
    return reply.status(204).send();
  });

  // `getHttpSessionMap` is only referenced when a test wants to inspect
  // the in-memory store directly. Re-exporting prevents unused-import
  // warnings when a downstream test imports it from sessions.ts.
  void getHttpSessionMap;
}
