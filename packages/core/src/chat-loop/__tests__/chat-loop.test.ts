/**
 * Chat-loop unit tests — exercise the loop's tool-dispatch path,
 * iteration cap, and stream-mode event ordering against a stub
 * Anthropic client + stub MCP bridge.
 *
 * No network, no real Anthropic API, no spawned MCP child.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MAX_LOOP_ITERATIONS,
  buildDefaultAnthropicClient,
  runChatLoop,
  runChatLoopStream,
  type StreamEvent,
} from "../index.js";
import type { Session } from "../../storage/types.js";
import type { ListToolsResult, ToolResult } from "../../mcp/index.js";

function makeSession(servers: string[]): Session {
  return {
    id: "sess-test",
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

/** Build a stub Anthropic client whose `messages.create` returns
 *  responses in scripted order. The last response should have
 *  stop_reason !== "tool_use" so the loop terminates. */
function stubAnthropic(
  scripted: Array<{ content: unknown[]; stop_reason: string }>,
): { client: unknown; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const client = {
    messages: {
      create: vi.fn(async (params: Record<string, unknown>) => {
        calls.push(params);
        const resp = scripted[Math.min(i, scripted.length - 1)];
        i += 1;
        return resp;
      }),
    },
  };
  return { client, calls };
}

function stubBridge(opts: {
  list?: Record<string, ListToolsResult>;
  call?: (serverId: string, tool: string, input: unknown) => ToolResult;
}): {
  listTools: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  callsMade: Array<{ serverId: string; tool: string; input: unknown }>;
} {
  const callsMade: Array<{ serverId: string; tool: string; input: unknown }> = [];
  return {
    callsMade,
    listTools: vi.fn(async (_sessionId: string, serverId: string) => {
      return (
        opts.list?.[serverId] ?? {
          success: true,
          tools: [],
          error: "",
          server: serverId,
          duration: 0,
        }
      );
    }),
    call: vi.fn(async (_sessionId: string, serverId: string, tool: string, input: unknown) => {
      callsMade.push({ serverId, tool, input });
      if (opts.call) return opts.call(serverId, tool, input);
      return {
        success: true,
        data: { ok: true },
        error: "",
        duration: 1,
        server: serverId,
        tool,
        tool_call_id: "t",
        called_at: new Date().toISOString(),
      };
    }),
  };
}

describe("runChatLoop", () => {
  it("dispatches a tool when the assistant emits a tool_use block and returns the final text", async () => {
    const session = makeSession(["echo"]);
    const bridge = stubBridge({
      list: {
        echo: {
          success: true,
          tools: [{ name: "ping", description: "echo back" }],
          error: "",
          server: "echo",
          duration: 0,
        },
      },
      call: (_s, _t, input) => ({
        success: true,
        data: { echoed: input },
        error: "",
        duration: 5,
        server: "echo",
        tool: "ping",
        tool_call_id: "x",
        called_at: new Date().toISOString(),
      }),
    });

    const { client } = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "tu_1", name: "echo__ping", input: { hi: 1 } },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "all done" }],
      },
    ]);

    const result = await runChatLoop("hello", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(result.iterations).toBe(2);
    expect(result.message).toBe("all done");
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({
      tool_name: "echo__ping",
      server_id: "echo",
      status: "success",
      input: { hi: 1 },
    });
    expect((result.tool_calls[0].output as { echoed: unknown }).echoed).toEqual({
      hi: 1,
    });
    expect(bridge.callsMade).toEqual([
      { serverId: "echo", tool: "ping", input: { hi: 1 } },
    ]);
  });

  it("caps iterations at maxIterations and returns the latest text without further LLM calls", async () => {
    const session = makeSession(["echo"]);
    const bridge = stubBridge({
      list: {
        echo: {
          success: true,
          tools: [{ name: "ping" }],
          error: "",
          server: "echo",
          duration: 0,
        },
      },
    });

    // Script: every response asks for one more tool_use. The loop must
    // hard-stop at maxIterations instead of spinning forever.
    const looper = {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "thinking..." },
        { type: "tool_use", id: "t", name: "echo__ping", input: {} },
      ],
    };
    const { client, calls } = stubAnthropic([looper, looper, looper, looper]);

    const result = await runChatLoop("hi", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
      maxIterations: 3,
    });

    expect(result.iterations).toBe(3);
    expect(calls).toHaveLength(3);
    expect(result.tool_calls).toHaveLength(3);
  });

  it("MAX_LOOP_ITERATIONS exported constant matches the documented default (8)", () => {
    expect(MAX_LOOP_ITERATIONS).toBe(8);
  });

  it("records tool dispatch failures with error_code and continues the loop", async () => {
    const session = makeSession(["echo"]);
    const bridge = stubBridge({
      list: {
        echo: {
          success: true,
          tools: [{ name: "ping" }],
          error: "",
          server: "echo",
          duration: 0,
        },
      },
      call: () => ({
        success: false,
        data: {},
        error: "mcp.child_exit",
        duration: 3,
        server: "echo",
        tool: "ping",
        tool_call_id: "x",
        called_at: new Date().toISOString(),
      }),
    });

    const { client } = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu1", name: "echo__ping", input: {} },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "tool failed; here's a fallback" }],
      },
    ]);

    const result = await runChatLoop("try a tool", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0].status).toBe("error");
    expect(result.tool_calls[0].error_code).toBe("mcp.child_exit");
    expect(result.message).toBe("tool failed; here's a fallback");
  });

  it("records unknown_tool_name when the LLM emits a non-namespaced tool", async () => {
    const session = makeSession(["echo"]);
    const bridge = stubBridge({
      list: {
        echo: {
          success: true,
          tools: [{ name: "ping" }],
          error: "",
          server: "echo",
          duration: 0,
        },
      },
    });

    const { client } = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu1", name: "noslash", input: {} }],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "recovered" }],
      },
    ]);

    const result = await runChatLoop("hi", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(result.tool_calls[0].status).toBe("error");
    expect(result.tool_calls[0].error_code).toContain("unknown_tool_name");
    // bridge.call must NOT have been invoked for an unknown name.
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("ends the loop immediately when the assistant responds with text only (no tools)", async () => {
    const session = makeSession([]);
    const bridge = stubBridge({});
    const { client } = stubAnthropic([
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "hi there" }],
      },
    ]);

    const result = await runChatLoop("hi", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(result.iterations).toBe(1);
    expect(result.tool_calls).toEqual([]);
    expect(result.message).toBe("hi there");
  });
});

describe("buildDefaultAnthropicClient", () => {
  it("honours ANTHROPIC_BASE_URL when set", () => {
    const prev = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "http://localhost:12345";
    try {
      const client = buildDefaultAnthropicClient();
      // SDK stores baseURL on the client.
      expect((client as unknown as { baseURL: string }).baseURL).toContain(
        "localhost:12345",
      );
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prev;
    }
  });

  it("falls back to a placeholder API key when ANTHROPIC_API_KEY is unset", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const client = buildDefaultAnthropicClient();
      expect(client).toBeDefined();
      // No throw — placeholder accepted.
    } finally {
      if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("runChatLoopStream", () => {
  it("emits user_message → tool_use → tool_result → assistant_text → done in order", async () => {
    const session = makeSession(["echo"]);
    const bridge = stubBridge({
      list: {
        echo: {
          success: true,
          tools: [{ name: "ping" }],
          error: "",
          server: "echo",
          duration: 0,
        },
      },
      call: (_s, _t, input) => ({
        success: true,
        data: { echoed: input },
        error: "",
        duration: 1,
        server: "echo",
        tool: "ping",
        tool_call_id: "x",
        called_at: new Date().toISOString(),
      }),
    });
    const { client } = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: "tu1", name: "echo__ping", input: { a: 1 } },
        ],
      },
      {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "ok" }],
      },
    ]);

    const events: StreamEvent[] = [];
    for await (const ev of runChatLoopStream("hi", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    })) {
      events.push(ev);
    }

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("user_message");
    expect(types[types.length - 1]).toBe("done");
    expect(types).toContain("tool_use");
    expect(types).toContain("tool_result");
    expect(types).toContain("assistant_text");

    // tool_use must come before tool_result, which must come before
    // the final assistant_text emit for the closing turn.
    const idxToolUse = types.indexOf("tool_use");
    const idxToolResult = types.indexOf("tool_result");
    expect(idxToolUse).toBeLessThan(idxToolResult);
  });

  it("emits a terminal error event when the loop throws", async () => {
    const session = makeSession([]);
    const bridge = stubBridge({});
    const client = {
      messages: {
        create: vi.fn(async () => {
          throw new Error("anthropic exploded");
        }),
      },
    };
    const events: StreamEvent[] = [];
    for await (const ev of runChatLoopStream("hi", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    })) {
      events.push(ev);
    }
    expect(events[0].type).toBe("user_message");
    const last = events[events.length - 1];
    expect(last.type).toBe("error");
    if (last.type === "error") {
      expect(last.message).toContain("anthropic exploded");
    }
  });
});
