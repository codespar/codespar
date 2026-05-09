/**
 * Registry tests — verify resolve() returns the seeded specs and that the
 * public API surface is the single `resolve(serverId): McpServerSpec | null`
 * method (the boundary that lets a future catalog-backed registry drop
 * in without touching the process manager or the dispatch hook).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServerRegistry, type McpServerSpec } from "../index.js";

describe("McpServerRegistry", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-registry-"));
    const seed = {
      asaas: {
        command: ["npx", "@codespar/mcp-asaas"],
        transport: "stdio",
      },
      "nuvem-fiscal": {
        command: ["npx", "@codespar/mcp-nuvem-fiscal"],
        transport: "stdio",
      },
      "z-api": {
        command: ["npx", "@codespar/mcp-z-api"],
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

  afterAll(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("[T-01.A] resolve('asaas') returns a stdio spec with npx + package literal", () => {
    const reg = new McpServerRegistry();
    const spec = reg.resolve("asaas");
    expect(spec).not.toBeNull();
    expect(spec!.command[0]).toBe("npx");
    expect(spec!.command[1]).toBe("@codespar/mcp-asaas");
    expect(spec!.transport).toBe("stdio");
  });

  it("[T-01.B] resolve('does-not-exist') returns null", () => {
    const reg = new McpServerRegistry();
    expect(reg.resolve("does-not-exist")).toBeNull();
  });

  it("[T-01.C] public API is a single resolve method (compile-time check)", () => {
    const reg = new McpServerRegistry();
    // Assignment to the narrow boundary type must succeed.
    const narrow: { resolve(serverId: string): McpServerSpec | null } = reg;
    expect(typeof narrow.resolve).toBe("function");

    // Runtime mirror of the compile-time check: the only public own
    // property on the prototype (besides `constructor`) is `resolve`.
    // Private members use `#` syntax and are invisible here by design.
    const ownPublic = Object.getOwnPropertyNames(
      Object.getPrototypeOf(reg),
    ).filter((name) => name !== "constructor");
    expect(ownPublic).toEqual(["resolve"]);
  });

  it("[T-01.4] every seed entry uses npx verbatim — no auto-prefixing", () => {
    const reg = new McpServerRegistry();
    for (const id of ["asaas", "nuvem-fiscal", "z-api"]) {
      const spec = reg.resolve(id);
      expect(spec).not.toBeNull();
      expect(spec!.command[0]).toBe("npx");
    }
  });
});
