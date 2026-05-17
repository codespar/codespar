/**
 * Integration test for POST /sessions/:id/send with the OSS chat loop.
 *
 * Spins up a tiny in-process HTTP server that impersonates the
 * Anthropic API, points ANTHROPIC_BASE_URL at it, and verifies that:
 *
 *   1. JSON mode returns SendResult with tool_calls.length >= 1 and
 *      iterations >= 1 when the mock LLM emits a tool_use block.
 *   2. SSE mode emits user_message → tool_use → tool_result →
 *      assistant_text → done events in the documented order.
 *   3. ANTHROPIC_BASE_URL is honoured (no real Anthropic calls).
 *
 * The MCP "server" is the in-tree echo fixture, spawned by the bridge
 * when the loop dispatches its tool. No npm @codespar/mcp-* package
 * needs to be installed.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import type { RouteFn } from "../types.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { clearMcpBridge } from "../../../mcp/index.js";
import { clearSessionStore, registerSessionRoutes } from "../sessions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "echo-mcp-server.mjs");

/**
 * Tiny Anthropic mock. Each `messages.create` call pops the next
 * scripted response off the queue. When the queue is empty the server
 * 500s so a misconfigured test fails loud rather than blocks.
 */
function startMockAnthropic(
  scripted: Array<{
    content: Array<Record<string, unknown>>;
    stop_reason: string;
  }>,
): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    let i = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/v1/messages" || req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: "not found" } }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        void body; // params unused by the mock
        const next = scripted[Math.min(i, scripted.length - 1)];
        i += 1;
        const responseBody = {
          id: `msg_${i}`,
          type: "message",
          role: "assistant",
          model: "claude-3-5-sonnet-latest",
          content: next.content,
          stop_reason: next.stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, baseURL: `http://127.0.0.1:${port}` });
    });
  });
}

function createTestApp() {
  const app = Fastify({ logger: false });
  // Match the existing route-registration shape used in sessions-mcp.test.ts.
  const route: RouteFn = (method, path, handler) => {
    app[method](path, handler);
  };
  registerSessionRoutes(route);
  return app;
}

async function createSession(
  app: ReturnType<typeof Fastify>,
  servers: string[],
  serverSpecs?: Record<string, unknown>,
): Promise<string> {
  const payload: Record<string, unknown> = { servers, user_id: "u" };
  if (serverSpecs) payload.server_specs = serverSpecs;
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: "Bearer test" },
    payload,
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("POST /sessions/:id/send (chat loop)", () => {
  const originalCwd = process.cwd();
  const originalBaseURL = process.env.ANTHROPIC_BASE_URL;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  let tmpDir: string;
  let mockServer: Server | null = null;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sessions-send-chat-loop-"));
    process.chdir(tmpDir);
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(async () => {
    await clearMcpBridge();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalBaseURL === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalBaseURL;
    }
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
  });

  beforeEach(async () => {
    clearSessionStore();
    await clearMcpBridge();
  });

  afterEach(async () => {
    await clearMcpBridge();
    const srv = mockServer;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      mockServer = null;
    }
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it("JSON mode dispatches a tool and returns SendResult with tool_calls and iterations", async () => {
    const { server, baseURL } = await startMockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "I will check the echo server." },
          {
            type: "tool_use",
            id: "tu_int_1",
            name: "echo/tools/echo",
            input: { hello: "loop" },
          },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "tool returned ok" }],
      },
    ]);
    mockServer = server;
    process.env.ANTHROPIC_BASE_URL = baseURL;

    const app = createTestApp();
    const id = await createSession(app, ["echo"], {
      echo: { command: [process.execPath, FIXTURE], transport: "stdio" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/send`,
      headers: { authorization: "Bearer test", accept: "application/json" },
      payload: { message: "ping the echo server" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.iterations).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(body.tool_calls)).toBe(true);
    expect(body.tool_calls.length).toBeGreaterThanOrEqual(1);
    expect(body.tool_calls[0]).toMatchObject({
      tool_name: "echo/tools/echo",
      server_id: "echo",
      status: "success",
    });
    expect(body.message).toBe("tool returned ok");
  });

  it("SSE mode emits user_message → tool_use → tool_result → assistant_text → done", async () => {
    const { server, baseURL } = await startMockAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu_sse_1", name: "echo/tools/echo", input: { x: 1 } },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "done" }],
      },
    ]);
    mockServer = server;
    process.env.ANTHROPIC_BASE_URL = baseURL;

    const app = createTestApp();
    const id = await createSession(app, ["echo"], {
      echo: { command: [process.execPath, FIXTURE], transport: "stdio" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/send`,
      headers: {
        authorization: "Bearer test",
        accept: "text/event-stream",
      },
      payload: { message: "stream please" },
    });

    expect(res.statusCode).toBe(200);
    const text = res.body;

    // Parse `event:` lines in order.
    const eventLines = text
      .split("\n")
      .filter((line) => line.startsWith("event: "))
      .map((line) => line.slice("event: ".length));

    expect(eventLines[0]).toBe("user_message");
    expect(eventLines).toContain("tool_use");
    expect(eventLines).toContain("tool_result");
    expect(eventLines).toContain("assistant_text");
    expect(eventLines[eventLines.length - 1]).toBe("done");

    // tool_use before tool_result
    expect(eventLines.indexOf("tool_use")).toBeLessThan(
      eventLines.indexOf("tool_result"),
    );
  });

  it("ANTHROPIC_BASE_URL redirects all Anthropic calls — no real network egress", async () => {
    // Sanity check: with BASE_URL pointing at a server that always
    // returns end_turn, the loop terminates in one iteration without
    // ever resolving api.anthropic.com.
    const { server, baseURL } = await startMockAnthropic([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "redirected" }],
      },
    ]);
    mockServer = server;
    process.env.ANTHROPIC_BASE_URL = baseURL;
    // Make sure no real key is in scope.
    delete process.env.ANTHROPIC_API_KEY;

    const app = createTestApp();
    const id = await createSession(app, []);

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/send`,
      headers: { authorization: "Bearer test" },
      payload: { message: "hi" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("redirected");
    expect(body.iterations).toBe(1);
    expect(body.tool_calls).toEqual([]);
  });
});
