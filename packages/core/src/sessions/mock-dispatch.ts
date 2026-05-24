/**
 * Mock-aware dispatch seam shared by the HTTP `/execute` route and the
 * chat-loop tool-use branch.
 *
 * `tryMockedDispatch` is the thin wrapper both dispatchers call BEFORE
 * touching the raw MCP bridge. It:
 *
 *   1. Consults the session's `mocks` field via `evaluateSessionMock`.
 *   2. Translates the discriminated union into the same `ToolResult`
 *      wire shape the bridge emits, so the dispatcher can return it
 *      without further branching.
 *   3. Returns `null` when the dispatch should fall through to the
 *      bridge (no mocks declared, or empty mocks object).
 *
 * Strict-mode: when the session's mocks are non-empty and the called
 * tool has no entry, the wrapper synthesises a `tool_not_mocked`
 * ToolResult with `success: false` and the dispatcher MUST NOT then
 * call the bridge. This is the structural fix that prevents a
 * misspelled tool from leaking to a real upstream provider.
 *
 * The OSS ToolResult shape mirrors enterprise's error-envelope payload
 * (`code`, `message`, optional `tool_name`) so the four error codes
 * the contract sweep checks (`tool_not_mocked`, `mocks_exhausted`,
 * `mocks_engine_error`, plus the HTTP-level `mocks_invalid` /
 * `mocks_payload_too_large` envelopes emitted at create time) line up
 * byte-for-byte across the two runtimes.
 */

import { randomUUID } from "node:crypto";
import type { Session, StorageProvider } from "../storage/types.js";
import type { ToolResult } from "../mcp/types.js";
import {
  bumpHttpSessionToolCallCount,
  getHttpSessionToolCallCount,
  HTTP_CHANNEL_TYPE,
} from "./core.js";
import { evaluateSessionMock, type MockMatchResult } from "./mocks.js";

const MOCK_SERVER_LABEL = "mock";

function newToolCallId(sessionId: string): string {
  return `${sessionId}-${randomUUID().slice(0, 8)}`;
}

/** Mock-derived error envelope embedded in a `ToolResult.data` slot.
 *  Shape matches the managed runtime's `AgentGateToolResultPayload`
 *  for the three mock variants the OSS layer emits. */
export type MockErrorEnvelope =
  | { code: "tool_not_mocked"; tool_name: string; message: string }
  | { code: "mocks_exhausted"; message: string }
  | { code: "mocks_engine_error"; message: string };

export interface MockDispatchOk {
  /** The synthesised tool-result the dispatcher should return verbatim. */
  result: ToolResult;
  /** The structured mock outcome, useful for callers that want to
   *  classify the outcome (e.g. an HTTP route mapping the envelope
   *  onto a 422/503 status code). */
  outcome: MockMatchResult;
}

/**
 * Try the mocks engine first. Returns:
 *   - `null` when no mock branch applies and the caller should
 *     proceed with the real MCP bridge dispatch.
 *   - a `MockDispatchOk` containing the synthesised `ToolResult` and
 *     the structured outcome the caller can act on (e.g. mapping to
 *     an HTTP status code).
 */
export async function tryMockedDispatch(
  session: Session,
  serverId: string,
  toolName: string,
  input: unknown,
): Promise<MockDispatchOk | null> {
  const canonical = `${serverId}/${toolName}`;
  // HTTP-route sessions live in-memory and persist nothing. Their
  // counter mirror lives on the sessions/core module. Channel-bridge
  // sessions persist to the StorageProvider, so we hand the storage
  // backend down to the consume helper. The split mirrors how
  // `getSessionById` already routes lookups based on channelType.
  const isHttpSession = session.channelType === HTTP_CHANNEL_TYPE;
  const storage: StorageProvider | null = isHttpSession
    ? makeInMemoryCounterStorage()
    : null; // populated by the caller via the route's ctx when needed
  const outcome = await evaluateSessionMock({
    sessionMocks: session.mocks ?? null,
    canonicalToolName: canonical,
    input,
    storage,
    sessionId: session.id,
  });

  if (outcome.kind === "passthrough") return null;
  const result = mockOutcomeToToolResult(session.id, serverId, toolName, outcome);
  return { result, outcome };
}

/**
 * Channel-bridge variant — same as `tryMockedDispatch` but takes an
 * explicit `StorageProvider` for counter persistence. Used by the
 * chat-loop when running against a persisted channel session.
 */
export async function tryMockedDispatchWithStorage(
  session: Session,
  serverId: string,
  toolName: string,
  input: unknown,
  storage: StorageProvider | null,
): Promise<MockDispatchOk | null> {
  const canonical = `${serverId}/${toolName}`;
  const isHttpSession = session.channelType === HTTP_CHANNEL_TYPE;
  const effectiveStorage = isHttpSession
    ? makeInMemoryCounterStorage()
    : storage;
  const outcome = await evaluateSessionMock({
    sessionMocks: session.mocks ?? null,
    canonicalToolName: canonical,
    input,
    storage: effectiveStorage,
    sessionId: session.id,
  });
  if (outcome.kind === "passthrough") return null;
  const result = mockOutcomeToToolResult(session.id, serverId, toolName, outcome);
  return { result, outcome };
}

/** Translate the discriminated `MockMatchResult` into the bridge's
 *  `ToolResult` wire shape so the dispatcher can return it without
 *  caring whether the result came from the mock store or the bridge. */
export function mockOutcomeToToolResult(
  sessionId: string,
  serverId: string,
  toolName: string,
  outcome: MockMatchResult,
): ToolResult {
  const tool_call_id = newToolCallId(sessionId);
  const called_at = new Date().toISOString();
  const canonical = `${serverId}/${toolName}`;

  if (outcome.kind === "consumed") {
    return {
      success: true,
      data: outcome.output,
      error: "",
      duration: 0,
      server: MOCK_SERVER_LABEL,
      tool: canonical,
      tool_call_id,
      called_at,
    };
  }

  if (outcome.kind === "exhausted") {
    const envelope: MockErrorEnvelope = {
      code: "mocks_exhausted",
      message: `mock store exhausted for tool ${canonical} after ${outcome.cap} calls`,
    };
    return {
      success: false,
      data: envelope,
      error: envelope.code,
      duration: 0,
      server: MOCK_SERVER_LABEL,
      tool: canonical,
      tool_call_id,
      called_at,
    };
  }

  if (outcome.kind === "tool_not_mocked") {
    const envelope: MockErrorEnvelope = {
      code: "tool_not_mocked",
      tool_name: canonical,
      message: `tool ${canonical} has no matching mock in this session; declare a mock entry or omit the mocks field`,
    };
    return {
      success: false,
      data: envelope,
      error: envelope.code,
      duration: 0,
      server: MOCK_SERVER_LABEL,
      tool: canonical,
      tool_call_id,
      called_at,
    };
  }

  // mocks_engine_error (the passthrough kind is filtered upstream).
  if (outcome.kind !== "mocks_engine_error") {
    throw new Error(
      `mockOutcomeToToolResult: unexpected kind ${outcome.kind}; passthrough should be filtered before this call`,
    );
  }
  const envelope: MockErrorEnvelope = {
    code: "mocks_engine_error",
    message: outcome.message,
  };
  return {
    success: false,
    data: envelope,
    error: envelope.code,
    duration: 0,
    server: MOCK_SERVER_LABEL,
    tool: canonical,
    tool_call_id,
    called_at,
  };
}

/**
 * Wrap the HTTP-session in-memory counter map behind the
 * `StorageProvider` interface slice the consume helper needs. Letting
 * both the persistent and in-memory paths share the same call signature
 * keeps the dispatch seam straight — no second branch on session
 * channelType inside `evaluateSessionMock`.
 *
 * Only the two counter methods are wired; every other StorageProvider
 * method is irrelevant on the consume path and is left unimplemented.
 * Casting through `unknown` keeps the type-checker honest without
 * forcing a hundred-method stub here.
 */
function makeInMemoryCounterStorage(): StorageProvider {
  const partial = {
    getSessionToolCallCount: async (
      sessionId: string,
      toolName: string,
    ): Promise<number> =>
      Promise.resolve(getHttpSessionToolCallCount(sessionId, toolName)),
    bumpSessionToolCallCount: async (
      sessionId: string,
      toolName: string,
      cap: number,
    ): Promise<{ n: number; bumped: boolean }> =>
      Promise.resolve(bumpHttpSessionToolCallCount(sessionId, toolName, cap)),
  };
  return partial as unknown as StorageProvider;
}
