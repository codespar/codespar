/**
 * `buildToolCatalog` tests — verify that:
 *   1. The catalog iterates `session.metadata.servers` and namespaces
 *      each tool name as `${serverId}/${toolName}`.
 *   2. Failures from any single server are skipped (partial catalog,
 *      not full failure).
 *   3. `splitNamespacedToolName` correctly reverses the namespacing
 *      including for MCP tools that contain a slash in their name.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildToolCatalog,
  splitNamespacedToolName,
} from "../tool-catalog.js";
import type { Session } from "../../storage/types.js";
import type { ListToolsResult } from "../../mcp/index.js";

function makeSession(servers: string[]): Session {
  return {
    id: "sess-1",
    orgId: "org",
    projectId: "proj",
    channelType: "http",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers },
  };
}

function stubBridge(
  responses: Record<string, ListToolsResult>,
): { listTools: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn(async (_sessionId: string, serverId: string) => {
      return (
        responses[serverId] ?? {
          success: false,
          tools: [],
          error: "mcp.unknown_server",
          server: serverId,
          duration: 0,
        }
      );
    }),
  };
}

describe("buildToolCatalog", () => {
  it("namespaces tool names as serverId__toolName for Anthropic-compatible shape", async () => {
    const session = makeSession(["nuvem-fiscal"]);
    const bridge = stubBridge({
      "nuvem-fiscal": {
        success: true,
        tools: [
          {
            name: "create_nfse",
            description: "Issue an NFS-e",
            inputSchema: {
              type: "object",
              properties: { servico: { type: "string" } },
              required: ["servico"],
            },
          },
        ],
        error: "",
        server: "nuvem-fiscal",
        duration: 1,
      },
    });
    const tools = await buildToolCatalog(session, bridge);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("nuvem-fiscal__create_nfse");
    // Confirm the encoded name still matches Anthropic's tools.*.custom.name regex.
    expect(tools[0].name).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(tools[0].description).toBe("Issue an NFS-e");
    expect(tools[0].input_schema.type).toBe("object");
    expect(tools[0].input_schema.required).toEqual(["servico"]);
  });

  it("merges tools from multiple servers", async () => {
    const session = makeSession(["a", "b"]);
    const bridge = stubBridge({
      a: {
        success: true,
        tools: [{ name: "ping" }],
        error: "",
        server: "a",
        duration: 0,
      },
      b: {
        success: true,
        tools: [{ name: "pong" }, { name: "echo" }],
        error: "",
        server: "b",
        duration: 0,
      },
    });
    const tools = await buildToolCatalog(session, bridge);
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["a__ping", "b__echo", "b__pong"]);
  });

  it("skips servers that fail to list tools (partial catalog)", async () => {
    const session = makeSession(["good", "bad"]);
    const bridge = stubBridge({
      good: {
        success: true,
        tools: [{ name: "ok" }],
        error: "",
        server: "good",
        duration: 0,
      },
      bad: {
        success: false,
        tools: [],
        error: "mcp.child_exit",
        server: "bad",
        duration: 0,
      },
    });
    const tools = await buildToolCatalog(session, bridge);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("good__ok");
  });

  it("returns an empty array when the session has no servers", async () => {
    const session = makeSession([]);
    const bridge = stubBridge({});
    const tools = await buildToolCatalog(session, bridge);
    expect(tools).toEqual([]);
    expect(bridge.listTools).not.toHaveBeenCalled();
  });

  it("falls back to a permissive empty-object schema when the MCP server omits inputSchema", async () => {
    const session = makeSession(["x"]);
    const bridge = stubBridge({
      x: {
        success: true,
        tools: [{ name: "noschema" }],
        error: "",
        server: "x",
        duration: 0,
      },
    });
    const tools = await buildToolCatalog(session, bridge);
    expect(tools[0].input_schema).toEqual({ type: "object" });
  });
});

describe("splitNamespacedToolName", () => {
  it("splits the canonical serverId__toolName form", () => {
    expect(splitNamespacedToolName("nuvem-fiscal__create_nfse")).toEqual({
      serverId: "nuvem-fiscal",
      toolName: "create_nfse",
    });
  });

  it("splits on the first `__` so MCP tool names with embedded `__` survive", () => {
    // First `__` wins — server `echo`, tool `nested__bar`.
    expect(splitNamespacedToolName("echo__nested__bar")).toEqual({
      serverId: "echo",
      toolName: "nested__bar",
    });
  });

  it("preserves single underscores inside server IDs and tool names", () => {
    // Hyphens in server IDs and single underscores in tool names round-trip cleanly.
    expect(splitNamespacedToolName("nuvem-fiscal__create_nfse")).toEqual({
      serverId: "nuvem-fiscal",
      toolName: "create_nfse",
    });
    expect(splitNamespacedToolName("z-api__send_text")).toEqual({
      serverId: "z-api",
      toolName: "send_text",
    });
  });

  it("returns null for names without `__`, or with a leading/trailing `__`", () => {
    expect(splitNamespacedToolName("plain")).toBeNull();
    expect(splitNamespacedToolName("single_underscore_only")).toBeNull();
    expect(splitNamespacedToolName("__leading")).toBeNull();
    expect(splitNamespacedToolName("trailing__")).toBeNull();
  });
});
