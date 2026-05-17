/**
 * `mcpBridge.listTools` tests — verify that the bridge forwards an MCP
 * `tools/list` JSON-RPC call through the same child it spawns for
 * `tools/call`, returns the canonical tool descriptors, and surfaces
 * structured failures (unknown_server, unknown_response_shape) without
 * crashing.
 *
 * The fixture under test is the in-tree echo MCP server. No
 * `@codespar/mcp-*` package is installed or required.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpProcessManager } from "../process-manager.js";
import { clearMcpBridge, mcpBridge } from "../index.js";
import { MCP_ERROR_CODES, type McpServerSpec } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "echo-mcp-server.mjs");

function makeRegistry(entries: Record<string, McpServerSpec | undefined>): {
  resolve(serverId: string): McpServerSpec | null;
} {
  return {
    resolve(serverId: string): McpServerSpec | null {
      return entries[serverId] ?? null;
    },
  };
}

describe("McpProcessManager.listTools", () => {
  it("returns the canonical tool descriptors from a healthy child", async () => {
    const manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { command: [process.execPath, FIXTURE], transport: "stdio" },
      }),
    });
    try {
      const result = await manager.listTools("s1", "echo");
      expect(result.success).toBe(true);
      expect(result.server).toBe("echo");
      expect(result.error).toBe("");
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(["ping", "tools/echo"]);
      const ping = result.tools.find((t) => t.name === "ping");
      expect(ping?.description).toMatch(/echo/i);
      expect(ping?.inputSchema).toBeDefined();
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("returns mcp.unknown_server when the registry has no entry", async () => {
    const manager = new McpProcessManager({ registry: makeRegistry({}) });
    const result = await manager.listTools("s1", "not-registered");
    expect(result.success).toBe(false);
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_server);
    expect(result.tools).toEqual([]);
    expect(result.server).toBe("not-registered");
    expect(manager.getActiveProcessCount()).toBe(0);
  });

  it("reuses the same child for tools/list and a subsequent tools/call", async () => {
    const manager = new McpProcessManager({
      registry: makeRegistry({
        echo: { command: [process.execPath, FIXTURE], transport: "stdio" },
      }),
    });
    try {
      const listed = await manager.listTools("s1", "echo");
      expect(listed.success).toBe(true);
      expect(manager.getActiveProcessCount()).toBe(1);

      const called = await manager.call("s1", "echo", "tools/echo", { y: 1 });
      expect(called.success).toBe(true);
      expect(manager.getActiveProcessCount()).toBe(1);
    } finally {
      await manager.closeSession("s1");
    }
  });

  it("honours specOverride for inline session-scoped specs", async () => {
    const manager = new McpProcessManager({ registry: makeRegistry({}) });
    try {
      const result = await manager.listTools("s1", "echo", {
        specOverride: {
          command: [process.execPath, FIXTURE],
          transport: "stdio",
        },
      });
      expect(result.success).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    } finally {
      await manager.closeSession("s1");
    }
  });
});

describe("mcpBridge.listTools", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeAll(async () => {
    await clearMcpBridge();
    tmpDir = mkdtempSync(join(tmpdir(), "list-tools-bridge-"));
    const seed = {
      echo: {
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

  afterEach(async () => {
    await clearMcpBridge();
  });

  it("is exported on the bridge singleton and returns canonical tools", async () => {
    const result = await mcpBridge.listTools("s1", "echo");
    expect(result.success).toBe(true);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["ping", "tools/echo"]);
  });
});
