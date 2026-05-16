/**
 * Echo MCP fixture tests — sanity-check that the fixture itself behaves
 * the way the bridge tests expect, before T-03 starts depending on it.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "..", "echo-mcp-server.mjs");

function spawnFixture(args: string[] = []): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [FIXTURE, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readOneLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx !== -1) {
        child.stdout.off("data", onData);
        resolve(buf.slice(0, idx));
      }
    };
    child.stdout.on("data", onData);
    child.stdout.once("error", reject);
    child.once("exit", () => {
      if (!buf) reject(new Error("child exited with no stdout"));
    });
  });
}

function readAllStderr(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
    });
    child.stderr.on("end", () => resolve(buf));
  });
}

describe("echo-mcp-server fixture", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
    }
    child = null;
  });

  it("[T-02.A] echoes a tools/call reply with the same id", async () => {
    child = spawnFixture();
    const replyPromise = readOneLine(child);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-1",
        method: "tools/call",
        params: { name: "echo", arguments: { x: 1 } },
      }) + "\n",
    );

    const line = await replyPromise;
    const parsed = JSON.parse(line);
    expect(parsed.jsonrpc).toBe("2.0");
    expect(parsed.id).toBe("rpc-1");
    expect(parsed.result.success).toBe(true);
    expect(parsed.result.tool).toBe("echo");
    expect(parsed.result.data.echo).toEqual({ x: 1 });
  });

  it("[T-02.B] --noisy-stderr emits marker on stderr, never on stdout", async () => {
    child = spawnFixture(["--noisy-stderr"]);
    const stderrPromise = readAllStderr(child);

    const replyPromise = readOneLine(child);
    child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-stderr",
        method: "tools/call",
        params: { name: "echo", arguments: {} },
      }) + "\n",
    );
    const line = await replyPromise;
    expect(() => JSON.parse(line)).not.toThrow();
    expect(line).not.toContain("stderr-startup-marker");

    child.stdin.end();
    await new Promise((resolve) => child!.once("exit", resolve));

    const stderrText = await stderrPromise;
    expect(stderrText).toContain("stderr-startup-marker");
  });
});
