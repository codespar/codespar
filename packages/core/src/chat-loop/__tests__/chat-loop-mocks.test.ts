/**
 * Chat-loop tests for the hosted-test-mode mocks engine.
 *
 * Verifies that:
 *   - When the session declares a `mocks` entry for the canonical
 *     `${serverId}/${tool}` name the loop returns the mocked output
 *     without ever invoking the bridge.
 *   - The mock-derived ToolResult lands in `SendResult.tool_calls`
 *     with `server_id: "mock"` and `status: "success"`.
 *   - Stateful array entries advance the in-process counter across
 *     successive iterations.
 *   - When mocks are declared but the tool has no entry the loop
 *     emits an error tool_result with `error_code: "tool_not_mocked"`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runChatLoop } from "../index.js";
import { clearSessionStore, type HttpSession } from "../../sessions/core.js";
import type { ListToolsResult, ToolResult } from "../../mcp/index.js";

const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";
const originalTestMode = process.env[TEST_MODE_ENV_KEY];

beforeAll(() => {
  process.env[TEST_MODE_ENV_KEY] = "true";
});
afterAll(() => {
  if (originalTestMode === undefined) delete process.env[TEST_MODE_ENV_KEY];
  else process.env[TEST_MODE_ENV_KEY] = originalTestMode;
});

function makeMockedSession(mocks: HttpSession["mocks"]): HttpSession {
  return {
    id: `sess-mocks-${Math.random().toString(36).slice(2, 10)}`,
    orgId: "org",
    projectId: "proj",
    channelType: "http",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers: ["asaas"] },
    ...(mocks !== undefined ? { mocks } : {}),
  };
}

function stubAnthropic(
  scripted: Array<{ content: unknown[]; stop_reason: string }>,
): unknown {
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const resp = scripted[Math.min(i, scripted.length - 1)];
        i += 1;
        return resp;
      }),
    },
  };
}

function stubBridge(): {
  listTools: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
} {
  return {
    listTools: vi.fn(
      async (_sessionId: string, serverId: string): Promise<ListToolsResult> => ({
        success: true,
        tools: [
          { name: "create_payment" },
          { name: "get_payment" },
        ],
        error: "",
        server: serverId,
        duration: 0,
      }),
    ),
    call: vi.fn(
      async (_sessionId: string, serverId: string, tool: string): Promise<ToolResult> => ({
        success: true,
        data: { unmocked: true },
        error: "",
        duration: 0,
        server: serverId,
        tool,
        tool_call_id: "x",
        called_at: new Date().toISOString(),
      }),
    ),
  };
}

describe("runChatLoop with session.mocks", () => {
  it("returns the single-shot mock without calling the bridge", async () => {
    clearSessionStore();
    const session = makeMockedSession({
      "asaas/create_payment": { id: "pay_test_42", status: "PENDING" },
    });
    const bridge = stubBridge();
    const client = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "let me create the payment" },
          {
            type: "tool_use",
            id: "tu_1",
            name: "asaas__create_payment",
            input: { value: 1000 },
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    ]);

    const result = await runChatLoop("crie um pagamento", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(bridge.call).not.toHaveBeenCalled();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({
      tool_name: "asaas__create_payment",
      server_id: "asaas",
      status: "success",
    });
    expect(result.tool_calls[0].output).toEqual({
      id: "pay_test_42",
      status: "PENDING",
    });
  });

  it("advances stateful-array counters across iterations", async () => {
    clearSessionStore();
    const session = makeMockedSession({
      "asaas/get_payment": [
        { status: "PENDING" },
        { status: "CONFIRMED" },
      ],
    });
    const bridge = stubBridge();
    const tu = (id: string) => ({
      type: "tool_use",
      id,
      name: "asaas__get_payment",
      input: {},
    });
    const client = stubAnthropic([
      { stop_reason: "tool_use", content: [tu("u1")] },
      { stop_reason: "tool_use", content: [tu("u2")] },
      { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
    ]);

    const result = await runChatLoop("check payment", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(result.tool_calls).toHaveLength(2);
    expect((result.tool_calls[0].output as { status: string }).status).toBe("PENDING");
    expect((result.tool_calls[1].output as { status: string }).status).toBe("CONFIRMED");
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it("surfaces tool_not_mocked as an error tool_result when mocks declared but tool absent", async () => {
    clearSessionStore();
    const session = makeMockedSession({ "asaas/known": { ok: true } });
    const bridge = stubBridge();
    const client = stubAnthropic([
      {
        stop_reason: "tool_use",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "asaas__unknown",
            input: {},
          },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }] },
    ]);

    const result = await runChatLoop("call something else", session, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      anthropicClient: client as any,
      bridge,
    });

    expect(bridge.call).not.toHaveBeenCalled();
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toMatchObject({
      tool_name: "asaas__unknown",
      server_id: "asaas",
      status: "error",
      error_code: "tool_not_mocked",
    });
  });
});
