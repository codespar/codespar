/**
 * Sessions MCP dispatch tests — verify that POST /sessions/:id/execute
 * routes `prefix/tool` names through the MCP bridge, and that
 * DELETE /sessions/:id terminates child processes before responding.
 *
 * The mcp-servers.json under test points at the in-tree fixture so we
 * can run end-to-end without `@codespar/mcp-*` packages installed.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import Fastify from "fastify";
import { registerSessionRoutes, clearSessionStore } from "../sessions.js";
import { clearMcpBridge, mcpBridge } from "../../../mcp/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "echo-mcp-server.mjs");

function createTestApp() {
  const app = Fastify({ logger: false });
  const route = (method: "get" | "post" | "delete" | "patch", path: string, handler: any) => {
    app[method](path, handler);
  };
  registerSessionRoutes(route);
  return app;
}

async function createSession(
  app: ReturnType<typeof Fastify>,
  servers: string[] = [],
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/sessions",
    headers: { authorization: "Bearer test" },
    payload: { servers, user_id: "u" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

describe("sessions MCP dispatch", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sessions-mcp-"));
    const seed = {
      echo: {
        command: [process.execPath, FIXTURE],
        transport: "stdio",
      },
      "nuvem-fiscal": {
        command: [process.execPath, FIXTURE],
        transport: "stdio",
      },
    };
    writeFileSync(
      join(tmpDir, "mcp-servers.json"),
      JSON.stringify(seed),
      "utf8",
    );
    process.chdir(tmpDir);
  });

  afterAll(async () => {
    await clearMcpBridge();
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    clearSessionStore();
    await clearMcpBridge();
  });

  afterEach(async () => {
    await clearMcpBridge();
  });

  it("[T-05.A] echo/ping with servers=['echo'] dispatches via the bridge", async () => {
    const app = createTestApp();
    const id = await createSession(app, ["echo"]);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: { hello: "world" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.server).toBe("echo");
    expect(body.tool).toBe("ping");
    expect(body.data.echo).toEqual({ hello: "world" });
  });

  it("[T-05.B] echo/ping with servers=[] returns Tool not registered (HTTP 200)", async () => {
    const app = createTestApp();
    const id = await createSession(app, []);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Tool not registered: echo/ping");
    expect(body.tool).toBe("echo/ping");
    expect(body.server).toBe("oss-runtime");
  });

  it("[T-05.C] nuvem-fiscal/foo/bar splits on first slash only", async () => {
    const app = createTestApp();
    const id = await createSession(app, ["nuvem-fiscal"]);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "nuvem-fiscal/foo/bar", input: { z: 9 } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.server).toBe("nuvem-fiscal");
    expect(body.tool).toBe("foo/bar");
  });

  it("[T-05.D] codespar_list_tools built-in response is unchanged", async () => {
    const app = createTestApp();
    const id = await createSession(app, []);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "codespar_list_tools", input: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.tool).toBe("codespar_list_tools");
    expect(body.server).toBe("oss-runtime");
    expect(Array.isArray(body.data.tools)).toBe(true);
  });

  it("[T-05.E] unknown_thing (no slash) keeps existing Tool not registered shape", async () => {
    const app = createTestApp();
    const id = await createSession(app, ["echo"]);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "unknown_thing", input: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Tool not registered: unknown_thing");
    expect(body.tool).toBe("unknown_thing");
    expect(body.server).toBe("oss-runtime");
  });

  it("[T-06.A] DELETE kills the child spawned for this session", async () => {
    const app = createTestApp();
    const id = await createSession(app, ["echo"]);
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${id}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(mcpBridge.getActiveProcessCount()).toBe(1);

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${id}`,
      headers: { authorization: "Bearer test" },
    });
    expect(del.statusCode).toBe(204);
    expect(mcpBridge.getActiveProcessCount()).toBe(0);
  });

  it("[T-06.B] DELETE on one session leaves the other session's child alive", async () => {
    const app = createTestApp();
    const id1 = await createSession(app, ["echo"]);
    const id2 = await createSession(app, ["echo"]);
    await app.inject({
      method: "POST",
      url: `/sessions/${id1}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: {} },
    });
    await app.inject({
      method: "POST",
      url: `/sessions/${id2}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: {} },
    });
    expect(mcpBridge.getActiveProcessCount()).toBe(2);

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${id1}`,
      headers: { authorization: "Bearer test" },
    });
    expect(del.statusCode).toBe(204);
    expect(mcpBridge.getActiveProcessCount()).toBe(1);

    const stillAlive = await app.inject({
      method: "POST",
      url: `/sessions/${id2}/execute`,
      headers: { authorization: "Bearer test" },
      payload: { tool: "echo/ping", input: { still: "alive" } },
    });
    expect(stillAlive.statusCode).toBe(200);
    expect(stillAlive.json().success).toBe(true);
  });
});
