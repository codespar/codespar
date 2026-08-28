/**
 * The environment label the chat loop hands a meta-tool hook (oss-sdk#4).
 *
 * `MetaToolExecutionContext.environment` exists so a registrant can branch:
 * a payment meta-tool decides whether it is talking to a provider's sandbox or
 * to production from this field. The loop hardcoded `"live"`, so a registrant in
 * a deployment with `CODESPAR_TEST_MODE_ENABLED=true` took the production branch
 * — the one case the flag exists to prevent.
 *
 * The hook is reached under the flag whenever the mocks seam does not answer,
 * which is what a non-HTTP (channel-bridge) session does: `tryMockedMetaToolDispatch`
 * short-circuits on `channelType !== "http"`. That is the session used below,
 * so the assertion is on the branch that actually runs in production.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { runChatLoop } from "../index.js";
import type { Session } from "../../storage/types.js";
import type {
  MetaToolDefinition,
  MetaToolExecutionContext,
  MetaToolHook,
  MetaToolResult,
} from "../../plugins/index.js";
import type { ListToolsResult, ToolResult } from "../../mcp/index.js";

const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";
const savedFlag = process.env[TEST_MODE_ENV_KEY];

afterEach(() => {
  if (savedFlag === undefined) delete process.env[TEST_MODE_ENV_KEY];
  else process.env[TEST_MODE_ENV_KEY] = savedFlag;
});

/** A channel session: the seam short-circuits on it, so the hook runs. */
function channelSession(): Session {
  return {
    id: "sess-channel-env",
    orgId: "org",
    projectId: "proj",
    channelType: "whatsapp",
    channelUserId: "u",
    status: "active",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: { servers: [] },
  } as unknown as Session;
}

function stubRegistry(hook: MetaToolHook): {
  metaToolDefinitions: () => MetaToolDefinition[];
  getMetaTool: (name: string) => MetaToolHook | null;
} {
  const defs = hook.definitions?.() ?? [];
  return {
    metaToolDefinitions: () => defs,
    getMetaTool: (name: string) => (hook.handles.includes(name) ? hook : null),
  };
}

function stubBridge() {
  return {
    listTools: vi.fn(
      async (_s: string, serverId: string): Promise<ListToolsResult> => ({
        success: true,
        tools: [],
        error: "",
        server: serverId,
        duration: 0,
      }),
    ),
    call: vi.fn(
      async (): Promise<ToolResult> => {
        throw new Error("the bridge must not be reached in this test");
      },
    ),
  };
}

function stubAnthropic() {
  const scripted = [
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "tu1", name: "codespar_pay", input: { amount: 1 } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] },
  ];
  let i = 0;
  return {
    messages: {
      create: vi.fn(async () => scripted[Math.min(i++, scripted.length - 1)]),
    },
  };
}

async function runAndCaptureContext(): Promise<MetaToolExecutionContext> {
  const seen: MetaToolExecutionContext[] = [];
  const hook: MetaToolHook = {
    id: "fixture-pay",
    handles: ["codespar_pay"],
    definitions: () => [
      {
        name: "codespar_pay",
        description: "fixture",
        input_schema: { type: "object", properties: {} },
      },
    ],
    execute: async (
      _name: string,
      _input: Record<string, unknown>,
      ctx: MetaToolExecutionContext,
    ): Promise<MetaToolResult> => {
      seen.push(ctx);
      return { server_id: "fixture", output: { ok: true }, duration_ms: 1 };
    },
  };
  await runChatLoop("pay it", channelSession(), {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    anthropicClient: stubAnthropic() as any,
    bridge: stubBridge(),
    registry: stubRegistry(hook),
  });
  expect(seen, "the hook did not run, so nothing here measures the label").toHaveLength(1);
  return seen[0]!;
}

describe("meta-tool environment in the chat loop", () => {
  it("is 'test' when the deployment is in test mode", async () => {
    process.env[TEST_MODE_ENV_KEY] = "true";
    expect((await runAndCaptureContext()).environment).toBe("test");
  });

  it("control: is 'live' when it is not", async () => {
    delete process.env[TEST_MODE_ENV_KEY];
    expect((await runAndCaptureContext()).environment).toBe("live");
  });
});
