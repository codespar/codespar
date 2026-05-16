/**
 * Bridge singleton tests — verify identity sharing across import paths
 * and that `clearMcpBridge` closes every active session.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpBridge as fromIndex, clearMcpBridge } from "../index.js";
import { mcpBridge as fromBridge } from "../bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const FIXTURE = join(REPO_ROOT, "tests", "fixtures", "echo-mcp-server.mjs");

describe("mcpBridge singleton", () => {
  it("[T-04.A] is the same identity from index.ts and bridge.ts", () => {
    expect(fromIndex).toBe(fromBridge);
  });
});

describe("clearMcpBridge", () => {
  const originalCwd = process.cwd();
  let tmpDir: string;

  beforeAll(async () => {
    await clearMcpBridge();
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-bridge-"));
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

  it("[T-04.B] clearMcpBridge after a call leaves active count at 0", async () => {
    const result = await fromIndex.call("s1", "echo", "tools/echo", { p: 1 });
    expect(result.success).toBe(true);
    expect(fromIndex.getActiveProcessCount()).toBe(1);

    await clearMcpBridge();
    expect(fromIndex.getActiveProcessCount()).toBe(0);
  });
});
