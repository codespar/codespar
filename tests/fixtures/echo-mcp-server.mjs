#!/usr/bin/env node
/**
 * Echo MCP fixture — used by the OSS bridge unit tests so they can
 * exercise spawn / stdio / lifecycle behaviour without depending on any
 * `@codespar/mcp-*` package being installed.
 *
 * Reads JSON-RPC 2.0 messages from stdin (line-delimited, one per line).
 * On `tools/call`, writes back a deterministic ToolResult-shaped payload
 * with the same `id` field so the parent can correlate request and reply.
 *
 * Flags (each is a CLI arg, all optional):
 *   --crash-after-N        exit(1) after N successful tools/call replies
 *   --crash-on-call <t>    for tool name t, exit(1) BEFORE writing a reply
 *                          (drives the child_exit-mid-call test)
 *   --delay-ms <n>         sleep n ms before writing each reply
 *   --garbage-on-call <t>  for tool name t, write non-JSON to stdout
 *   --noisy-stderr         write a known marker to stderr at startup
 *   --echo-env <name>      include process.env[name] in the reply payload
 *   --envelope <mode>      "legacy" (default) writes the pre-standard
 *                          `{success,data,error,...}` body inside `result`;
 *                          "canonical" writes the MCP-spec envelope
 *                          `{content:[{type:"text",text:JSON.stringify(payload)}], isError}`.
 *                          Real `@codespar/mcp-*` servers emit canonical;
 *                          legacy stays the default so existing tests do
 *                          not change shape in lockstep with the bridge fix.
 *
 * MIT-licensed. This fixture exists for the OSS runtime's MCP bridge
 * test suite — it's not part of the public package surface and is not
 * exported anywhere outside `tests/fixtures/`.
 */

import { createInterface } from "node:readline";

const args = process.argv.slice(2);

function flagValue(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

function flagPresent(name) {
  return args.includes(name);
}

const crashAfter = (() => {
  const v = flagValue("--crash-after-N");
  return v === null ? Infinity : Number.parseInt(v, 10);
})();
const delayMs = (() => {
  const v = flagValue("--delay-ms");
  return v === null ? 0 : Number.parseInt(v, 10);
})();
const garbageOnCall = flagValue("--garbage-on-call");
const crashOnCall = flagValue("--crash-on-call");
const noisyStderr = flagPresent("--noisy-stderr");
const echoEnvName = flagValue("--echo-env");
const envelopeMode = flagValue("--envelope") ?? "legacy";

const STDERR_MARKER = "echo-mcp-server: stderr-startup-marker";

if (noisyStderr) {
  process.stderr.write(STDERR_MARKER + "\n");
}

let callCount = 0;

function nowIso() {
  return new Date().toISOString();
}

function buildToolResult({ id, toolName, params }) {
  if (envelopeMode === "canonical") {
    const data = { echo: params?.arguments ?? null };
    if (echoEnvName) {
      data.env = process.env[echoEnvName] ?? null;
    }
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: JSON.stringify(data) }],
        isError: false,
      },
    };
  }
  const payload = {
    success: true,
    data: { echo: params?.arguments ?? null },
    error: "",
    duration: 0,
    server: "echo-mcp-server",
    tool: toolName,
    tool_call_id: String(id),
    called_at: nowIso(),
  };
  if (echoEnvName) {
    payload.data = {
      ...payload.data,
      env: process.env[echoEnvName] ?? null,
    };
  }
  return { jsonrpc: "2.0", id, result: payload };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    // Non-JSON input — ignore, do not echo back garbage.
    return;
  }
  if (req.method === "tools/list") {
    if (delayMs > 0) await sleep(delayMs);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            {
              name: "ping",
              description: "Echo the input back to the caller.",
              inputSchema: {
                type: "object",
                properties: { message: { type: "string" } },
              },
            },
            {
              name: "tools/echo",
              description: "Echo arbitrary JSON input.",
              inputSchema: { type: "object" },
            },
          ],
        },
      }) + "\n",
    );
    return;
  }

  if (req.method !== "tools/call") {
    // Not a tools/call — reply with method-not-found.
    if (delayMs > 0) await sleep(delayMs);
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: "Method not found" },
      }) + "\n",
    );
    return;
  }

  const toolName = req.params?.name;

  if (crashOnCall && toolName === crashOnCall) {
    if (delayMs > 0) await sleep(delayMs);
    // Exit before writing any reply — the parent must observe a child
    // exit with the request still pending and surface child_exit.
    process.exit(1);
  }

  if (garbageOnCall && toolName === garbageOnCall) {
    if (delayMs > 0) await sleep(delayMs);
    // Intentionally write non-JSON garbage so parent must surface a
    // structured parse_error. Trailing newline so the line reader
    // delimits cleanly.
    process.stdout.write("not-json garbage on the rpc channel\n");
    return;
  }

  if (delayMs > 0) await sleep(delayMs);

  const reply = buildToolResult({ id: req.id, toolName, params: req.params });
  process.stdout.write(JSON.stringify(reply) + "\n");

  callCount += 1;
  if (callCount >= crashAfter) {
    // Flush stdout before exiting non-zero so the parent observes the
    // last reply, then sees the child_exit event.
    process.stdout.write("", () => {
      process.exit(1);
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  handleLine(line).catch((err) => {
    process.stderr.write(`echo-mcp-server: handler error ${err.message}\n`);
  });
});
rl.on("close", () => {
  process.exit(0);
});
