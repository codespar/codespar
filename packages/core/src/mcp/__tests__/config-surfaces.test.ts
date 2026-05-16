/**
 * Config-surface tests — prove that the three documented ways of
 * telling the bridge about a server (inline session spec via the
 * dispatch route, `CODESPAR_MCP_SERVERS_PATH` env override, and the
 * `process.cwd()/mcp-servers.json` fallback) each work, and that the
 * "no configuration anywhere" case fails cleanly rather than crashing.
 *
 * The registry-level cases live here; the route-level inline-spec case
 * is exercised end-to-end in `sessions-mcp.test.ts` because it needs
 * the Fastify dispatch hook to be wired up.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServerRegistry } from "../index.js";

const SEED = {
  asaas: {
    command: ["npx", "@codespar/mcp-asaas"],
    transport: "stdio",
  },
};

describe("McpServerRegistry config surfaces", () => {
  const originalCwd = process.cwd();
  const originalEnv = process.env.CODESPAR_MCP_SERVERS_PATH;
  let cwdSeed: string;
  let envSeed: string;

  beforeEach(() => {
    cwdSeed = mkdtempSync(join(tmpdir(), "mcp-cfg-cwd-"));
    envSeed = mkdtempSync(join(tmpdir(), "mcp-cfg-env-"));
    delete process.env.CODESPAR_MCP_SERVERS_PATH;
    process.chdir(cwdSeed);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnv === undefined) {
      delete process.env.CODESPAR_MCP_SERVERS_PATH;
    } else {
      process.env.CODESPAR_MCP_SERVERS_PATH = originalEnv;
    }
    rmSync(cwdSeed, { recursive: true, force: true });
    rmSync(envSeed, { recursive: true, force: true });
  });

  it("loads from process.cwd()/mcp-servers.json when no env override is set", () => {
    writeFileSync(join(cwdSeed, "mcp-servers.json"), JSON.stringify(SEED), "utf8");
    const reg = new McpServerRegistry();
    const spec = reg.resolve("asaas");
    expect(spec).not.toBeNull();
    expect(spec!.command).toEqual(["npx", "@codespar/mcp-asaas"]);
  });

  it("CODESPAR_MCP_SERVERS_PATH wins over the cwd file", () => {
    // Decoy at cwd that should NOT be loaded.
    writeFileSync(
      join(cwdSeed, "mcp-servers.json"),
      JSON.stringify({
        asaas: { command: ["npx", "@decoy/mcp-asaas"], transport: "stdio" },
      }),
      "utf8",
    );
    // The real config is somewhere else and pointed at by the env var.
    const envFile = join(envSeed, "elsewhere.json");
    writeFileSync(envFile, JSON.stringify(SEED), "utf8");
    process.env.CODESPAR_MCP_SERVERS_PATH = envFile;

    const reg = new McpServerRegistry();
    const spec = reg.resolve("asaas");
    expect(spec).not.toBeNull();
    expect(spec!.command).toEqual(["npx", "@codespar/mcp-asaas"]);
  });

  it("returns null for every id when no env var and no cwd file exist", () => {
    // Nothing written, env unset. Registry must not throw.
    const reg = new McpServerRegistry();
    expect(reg.resolve("asaas")).toBeNull();
    expect(reg.resolve("anything")).toBeNull();
  });

  it("returns null when CODESPAR_MCP_SERVERS_PATH points at a missing file", () => {
    process.env.CODESPAR_MCP_SERVERS_PATH = join(envSeed, "does-not-exist.json");
    const reg = new McpServerRegistry();
    expect(reg.resolve("asaas")).toBeNull();
  });

  it("returns null when the file exists but is unparseable", () => {
    const envFile = join(envSeed, "bad.json");
    writeFileSync(envFile, "{not valid json", "utf8");
    process.env.CODESPAR_MCP_SERVERS_PATH = envFile;
    const reg = new McpServerRegistry();
    expect(reg.resolve("asaas")).toBeNull();
  });
});
