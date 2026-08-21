/**
 * BLOCKER oss-sdk#5 — the control surfaces must never answer an anonymous
 * caller, and closing them must not cost the install its autonomy.
 *
 * These two properties are tested together on purpose, because either one
 * alone is easy and wrong. Requiring an operator-supplied token closes the
 * hole and bricks every unattended install on the next `docker pull`;
 * leaving the default open keeps the install running and hands `/sessions`
 * to the internet. The invariant this file pins is the conjunction:
 *
 *   1. An anonymous request reaches nothing. Not `/api/*`, not
 *      `/sessions/*`, not `/a2a/*`, and above all not `child_process.spawn`.
 *   2. A runtime started with no operator input at all still ends up with a
 *      working credential that a local client on the same machine can read,
 *      and that credential survives a restart.
 *
 * The spawn case runs a real child process. It is deliberately the most
 * boring command that still proves execution: it writes a marker file into
 * a temp directory this test owns and exits. No network, no port, nothing
 * outside the sandbox. If the marker exists after the request, an
 * unauthenticated HTTP caller chose an argv that this process executed.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebhookServer } from "../webhook-server.js";
import { clearMcpBridge } from "../../mcp/index.js";
import { clearSessionStore } from "../routes/sessions.js";

/** Where the runtime is expected to keep the credential it materializes. */
function tokenPath(stateDir: string): string {
  return path.join(stateDir, "api-token");
}

/** Read the token the way a local client on the same host would. */
function readMaterializedToken(stateDir: string): string {
  return fs.readFileSync(tokenPath(stateDir), "utf8").trim();
}

function freshStateDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codespar-${label}-`));
}

describe("BLOCKER oss-sdk#5: anonymous access to the control surfaces", () => {
  let stateDir: string;
  let markerDir: string;
  let server: WebhookServer;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR"]) {
      savedEnv[key] = process.env[key];
    }
    // The default install: the operator set nothing. This is exactly what
    // `docker compose up` produces today, because `.env.example` has never
    // mentioned ENGINE_API_TOKEN.
    delete process.env.ENGINE_API_TOKEN;
    stateDir = freshStateDir("state");
    markerDir = freshStateDir("marker");
    process.env.CODESPAR_STATE_DIR = stateDir;
    server = new WebhookServer({ port: 0 });
  });

  afterEach(async () => {
    await clearMcpBridge();
    clearSessionStore();
  });

  afterAll(async () => {
    await clearMcpBridge();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(markerDir, { recursive: true, force: true });
  });

  // ── 1. Nothing answers an anonymous caller ────────────────────────

  it("refuses an anonymous GET /api/agents", async () => {
    const res = await server.inject({ method: "GET", url: "/api/agents" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses an anonymous POST /a2a/tasks", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/a2a/tasks",
      payload: { skill: "review", input: {} },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses POST /sessions carrying an arbitrary bearer string", async () => {
    // The session routes have always demanded a syntactically valid
    // Authorization header, and with no ENGINE_API_TOKEN they accepted any
    // non-empty string behind `Bearer `. A header whose value nobody has to
    // know is not a credential. `examples/session-mocks.sh` even shipped
    // "test" as the default, so this is the documented value, not a guess.
    const res = await server.inject({
      method: "POST",
      url: "/sessions",
      payload: { servers: [] },
      headers: { "content-type": "application/json", authorization: "Bearer test" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses POST /sessions with no Authorization header at all", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/sessions",
      payload: { servers: [] },
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("applies the same rule to the /v1 mirror of every surface", async () => {
    // registerRoutes() registers each path twice, at `/x` and at `/v1/x`.
    // A guard that only matched the unprefixed form would leave a complete
    // second copy of the API open.
    for (const url of ["/v1/api/agents", "/v1/sessions", "/v1/a2a/tasks"]) {
      const res = await server.inject({
        method: url === "/v1/api/agents" ? "GET" : "POST",
        url,
        payload: {},
        headers: { "content-type": "application/json" },
      });
      expect(res.statusCode, `${url} answered an anonymous caller`).toBe(401);
    }
  });

  // ── 2. The remote-code-execution chain itself ─────────────────────

  it("does not let an anonymous caller reach child_process.spawn", async () => {
    // The chain under test, all of it reachable with the constant bearer
    // string above:
    //   POST /sessions        — `server_specs.<id>.command` is an arbitrary
    //                           argv, merged into the session's server list
    //                           (routes/sessions.ts, parseServerSpecs).
    //   POST /sessions/:id/execute with tool "<id>/anything" — resolves the
    //                           caller's spec and hands it to the bridge,
    //                           which spawns it (mcp/process-manager.ts
    //                           #ensureChild) with `{ ...process.env }`, so
    //                           the child inherits ANTHROPIC_API_KEY,
    //                           GITHUB_TOKEN and DATABASE_URL.
    const marker = path.join(markerDir, "spawned.txt");
    const argv = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "reached")`,
    ];

    const created = await server.inject({
      method: "POST",
      url: "/sessions",
      payload: {
        servers: ["probe"],
        server_specs: { probe: { command: argv, transport: "stdio" } },
      },
      headers: { "content-type": "application/json", authorization: "Bearer test" },
    });

    // The fix is expected to stop the chain right here. If session creation
    // is already refused there is nothing left to execute, and the marker
    // assertion below still holds.
    if (created.statusCode === 201) {
      const sessionId = JSON.parse(created.body).id;
      await server.inject({
        method: "POST",
        url: `/sessions/${sessionId}/execute`,
        payload: { tool: "probe/anything", input: {} },
        headers: { "content-type": "application/json", authorization: "Bearer test" },
      });
    }

    // Marker first: this is the assertion that states the actual security
    // property. The status code is the mechanism, the marker is the harm.
    expect(
      fs.existsSync(marker),
      "an unauthenticated HTTP caller executed a command of its own choosing",
    ).toBe(false);
    expect(created.statusCode).toBe(401);
  });

  // ── 3. The install stays autonomous ───────────────────────────────

  it("materializes a credential on first boot with no operator input", async () => {
    // Nobody set ENGINE_API_TOKEN. Nobody was asked to. The runtime has to
    // have produced a credential on its own, or the install that upgrades
    // unattended is dead.
    expect(
      fs.existsSync(tokenPath(stateDir)),
      "the runtime started without materializing a credential",
    ).toBe(true);
    expect(readMaterializedToken(stateDir).length).toBeGreaterThanOrEqual(32);
  });

  it("accepts the materialized credential a local client reads off disk", async () => {
    const token = readMaterializedToken(stateDir);
    const res = await server.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("keeps the same credential across a restart", async () => {
    // `docker compose restart` must not invalidate whatever the operator's
    // local client already read. A token regenerated per boot would be a
    // slower version of the same outage.
    const before = readMaterializedToken(stateDir);
    const restarted = new WebhookServer({ port: 0 });
    const after = readMaterializedToken(stateDir);
    expect(after).toBe(before);

    const res = await restarted.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${before}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("leaves the credential file readable only by its owner", async () => {
    if (process.platform === "win32") return;
    const mode = fs.statSync(tokenPath(stateDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("still serves /health unauthenticated so the container healthcheck passes", async () => {
    // docker-compose.yml probes /health with a bare node http.get and no
    // credential. If auth swallowed it the container would be marked
    // unhealthy and restarted forever.
    const res = await server.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  });
});

describe("BLOCKER oss-sdk#5: an operator-supplied token still wins", () => {
  const OPERATOR_TOKEN = "operator-chosen-token-not-the-generated-one";
  let stateDir: string;
  let server: WebhookServer;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR"]) {
      savedEnv[key] = process.env[key];
    }
    stateDir = freshStateDir("operator");
    process.env.CODESPAR_STATE_DIR = stateDir;
    process.env.ENGINE_API_TOKEN = OPERATOR_TOKEN;
    server = new WebhookServer({ port: 0 });
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("accepts the operator's token", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("does not write a generated credential when the operator supplied one", async () => {
    // Persisting a second, also-valid credential would widen the surface
    // for no reason: the operator manages this one.
    expect(fs.existsSync(tokenPath(stateDir))).toBe(false);
  });

  it("protects /sessions with the operator's token too", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/sessions",
      payload: { servers: [] },
      headers: { "content-type": "application/json", authorization: "Bearer test" },
    });
    expect(res.statusCode).toBe(401);
  });
});
