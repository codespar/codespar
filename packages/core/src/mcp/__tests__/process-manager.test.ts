/**
 * McpProcessManager tests — exercise spawn, JSON-RPC correlation,
 * lifecycle, and every documented failure mode against the in-tree
 * fixture child. None of these tests import `@codespar/mcp-*`.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpProcessManager } from "../process-manager.js";
import { MCP_ERROR_CODES, type McpServerSpec } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "echo-mcp-server.mjs");

interface StubEntry {
  args?: string[];
  env?: Record<string, string>;
}

function makeRegistry(entries: Record<string, StubEntry>): {
  resolve(serverId: string): McpServerSpec | null;
} {
  return {
    resolve(serverId: string): McpServerSpec | null {
      const entry = entries[serverId];
      if (!entry) return null;
      const spec: McpServerSpec = {
        command: [process.execPath, FIXTURE, ...(entry.args ?? [])],
        transport: "stdio",
      };
      if (entry.env) spec.env = entry.env;
      return spec;
    },
  };
}

describe("McpProcessManager", () => {
  let manager: McpProcessManager | null = null;

  afterEach(async () => {
    if (manager) {
      // Best-effort cleanup — tests may have closed sessions already.
      const sessions = new Set<string>();
      // We don't have a public listing API; tests close their sessions
      // explicitly. As a safety net, give pending exits a tick to run.
      await new Promise((resolve) => setImmediate(resolve));
      manager = null;
      void sessions;
    }
  });

  it("[T-03.A] happy path — echoes input back via tools/call", async () => {
    manager = new McpProcessManager({ registry: makeRegistry({ echo: {} }) });
    const result = await manager.call("s1", "echo", "tools/echo", { x: 1 });
    expect(result.success).toBe(true);
    expect(result.tool).toBe("tools/echo");
    expect(result.server).toBe("echo");
    expect((result.data as { echo: unknown }).echo).toEqual({ x: 1 });
    await manager.closeSession("s1");
    expect(manager.getActiveProcessCount()).toBe(0);
  });

  it("[T-03.B] env passthrough — child sees parent env vars", async () => {
    process.env.BRIDGE_TEST_VAR = "parent";
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--echo-env", "BRIDGE_TEST_VAR"] },
      }),
    });
    try {
      const result = await manager.call("s1", "echo", "tools/echo", {});
      expect(result.success).toBe(true);
      expect((result.data as { env: string }).env).toBe("parent");
    } finally {
      await manager.closeSession("s1");
      delete process.env.BRIDGE_TEST_VAR;
    }
  });

  it("[T-03.C] spec env wins over parent env on key conflict", async () => {
    process.env.BRIDGE_TEST_VAR = "parent";
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: {
          args: ["--echo-env", "BRIDGE_TEST_VAR"],
          env: { BRIDGE_TEST_VAR: "spec" },
        },
      }),
    });
    try {
      const result = await manager.call("s1", "echo", "tools/echo", {});
      expect(result.success).toBe(true);
      expect((result.data as { env: string }).env).toBe("spec");
    } finally {
      await manager.closeSession("s1");
      delete process.env.BRIDGE_TEST_VAR;
    }
  });

  it("[T-03.D] no MCP_DEMO literal in process-manager.ts or registry.ts", () => {
    const pmSrc = readFileSync(
      join(__dirname, "..", "process-manager.ts"),
      "utf8",
    );
    const regSrc = readFileSync(join(__dirname, "..", "registry.ts"), "utf8");
    expect(pmSrc).not.toContain("MCP_DEMO");
    expect(regSrc).not.toContain("MCP_DEMO");
  });

  it("[T-03.E] cache reuses one child for repeated (sessionId, serverId)", async () => {
    manager = new McpProcessManager({
      registry: makeRegistry({ a: {}, b: {} }),
    });
    try {
      await manager.call("s1", "a", "tools/echo", {});
      await manager.call("s1", "a", "tools/echo", {});
      expect(manager.getActiveProcessCount()).toBe(1);

      await manager.call("s1", "b", "tools/echo", {});
      expect(manager.getActiveProcessCount()).toBe(2);
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("[T-03.F] no cross-session reuse — same serverId across sessions spawns two children", async () => {
    manager = new McpProcessManager({ registry: makeRegistry({ a: {} }) });
    try {
      await manager.call("s1", "a", "tools/echo", {});
      await manager.call("s2", "a", "tools/echo", {});
      expect(manager.getActiveProcessCount()).toBe(2);
    } finally {
      await manager.closeSession("s1");
      await manager.closeSession("s2");
    }
  });

  it("[T-03.G] closeSession kills only that session's children", async () => {
    manager = new McpProcessManager({ registry: makeRegistry({ a: {} }) });
    try {
      await manager.call("s1", "a", "tools/echo", {});
      await manager.call("s2", "a", "tools/echo", {});
      expect(manager.getActiveProcessCount()).toBe(2);

      await manager.closeSession("s1");
      expect(manager.getActiveProcessCount()).toBe(1);

      // s2 still answers
      const result = await manager.call("s2", "a", "tools/echo", { y: 2 });
      expect(result.success).toBe(true);
      expect((result.data as { echo: unknown }).echo).toEqual({ y: 2 });
    } finally {
      await manager.closeSession("s2");
    }
  });

  it("[T-03.H] crash mid-call — first call surfaces child_exit, next call respawns", async () => {
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--crash-on-call", "tools/poison"] },
      }),
    });
    try {
      const first = await manager.call("s1", "echo", "tools/poison", { i: 1 });
      expect(first.success).toBe(false);
      expect(first.error).toBe(MCP_ERROR_CODES.child_exit);

      // Allow exit handler to evict cache before the next call.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const second = await manager.call("s1", "echo", "tools/echo", { i: 2 });
      expect(second.success).toBe(true);
      expect((second.data as { echo: unknown }).echo).toEqual({ i: 2 });
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("[T-03.I] parse error — surfaces parse_error and child stays alive", async () => {
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--garbage-on-call", "tools/poison"] },
      }),
    });
    try {
      const bad = await manager.call("s1", "echo", "tools/poison", {});
      expect(bad.success).toBe(false);
      expect(bad.error).toBe(MCP_ERROR_CODES.parse_error);

      const good = await manager.call("s1", "echo", "tools/echo", { ok: 1 });
      expect(good.success).toBe(true);
      expect((good.data as { echo: unknown }).echo).toEqual({ ok: 1 });
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("[T-03.J] timeout — rejects with mcp.timeout, child stays alive", async () => {
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--delay-ms", "200"] },
      }),
    });
    try {
      const slow = await manager.call(
        "s1",
        "echo",
        "tools/echo",
        {},
        { timeoutMs: 50 },
      );
      expect(slow.success).toBe(false);
      expect(slow.error).toBe(MCP_ERROR_CODES.timeout);
      expect(manager.getActiveProcessCount()).toBe(1);

      const fast = await manager.call("s1", "echo", "tools/echo", { z: 9 });
      expect(fast.success).toBe(true);
      expect((fast.data as { echo: unknown }).echo).toEqual({ z: 9 });
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("[T-03.K] stderr separation — JSON-RPC stdout is clean; stderr forwarded via logger", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--noisy-stderr"] },
      }),
    });
    try {
      const result = await manager.call("s1", "echo", "tools/echo", { p: "q" });
      expect(result.success).toBe(true);
      // The stderr marker must not have polluted the data payload.
      expect(JSON.stringify(result.data)).not.toContain(
        "stderr-startup-marker",
      );

      // Wait briefly so stderr line crossing the pipe is observed.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const calls = consoleLog.mock.calls.flat().join("\n");
      expect(calls).toContain("stderr-startup-marker");
      expect(calls).toContain("serverId");
      expect(calls).toContain("sessionId");
      expect(calls).toContain("pid");
    } finally {
      await manager.closeSession("s1");
      consoleLog.mockRestore();
    }
  });

  it("[T-03.L] unknown server returns mcp.unknown_server without spawning", async () => {
    manager = new McpProcessManager({ registry: makeRegistry({}) });
    const result = await manager.call("s1", "not-registered", "tools/x", {});
    expect(result.success).toBe(false);
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_server);
    expect(manager.getActiveProcessCount()).toBe(0);
  });

  it("[T-03.M] canonical MCP envelope from child is parsed end-to-end", async () => {
    // Drives the fixture into the standard MCP envelope shape that every
    // `@codespar/mcp-*` server emits, proving the bridge's translator
    // handles the real-world payload — not just the legacy bespoke shape
    // the in-tree fixture used pre-fix.
    manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { args: ["--envelope", "canonical"] },
      }),
    });
    try {
      const result = await manager.call("s1", "echo", "tools/echo", { y: 42 });
      expect(result.success).toBe(true);
      expect(result.error).toBeNull();
      expect((result.data as { echo: unknown }).echo).toEqual({ y: 42 });
    } finally {
      await manager.closeSession("s1");
    }
  });
});
