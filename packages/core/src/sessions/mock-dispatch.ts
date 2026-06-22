/**
 * Mock-aware dispatch seam shared by the HTTP `/execute` route and the
 * chat-loop tool-use branch.
 *
 * `tryMockedDispatch` is the thin wrapper both dispatchers call BEFORE
 * touching the raw MCP bridge. It:
 *
 *   1. Short-circuits to `null` (passthrough) when
 *      `CODESPAR_TEST_MODE_ENABLED` is off — the mocks engine never
 *      runs and the bridge handles every call. Deployments without
 *      the flag look exactly like they did before the feature shipped.
 *   2. With the flag on, consults the session's `mocks` field via
 *      `evaluateSessionMock` and translates the discriminated outcome
 *      into a `ToolResult`-shaped envelope.
 *   3. Promotes a `passthrough` outcome (no mocks declared on the
 *      session, or the called tool has no entry) into a
 *      `tool_not_mocked` envelope. This is the per-deployment
 *      strict-mode semantic: in test mode, every external tool
 *      dispatch requires a mock match. There is no "flag-on but
 *      session has no mocks → real upstream call" state — that would
 *      contradict the principle of test mode.
 *
 * Built-in tools (the documented `BUILT_IN_TOOLS` allow-list in the
 * route handler — today: `codespar_list_tools`) bypass this seam
 * entirely. They are metadata-only operations with no external side
 * effects, and they are dispatched before the seam ever runs. Any
 * future built-in that would reach external state must NOT join that
 * allow-list — it must be declared in the session's `mocks` field like
 * any other external dispatch. See `docs/test-mode.md` for the spec.
 *
 * The OSS ToolResult shape mirrors enterprise's error-envelope payload
 * (`code`, `message`, optional `tool_name`) so the error codes the
 * contract sweep checks (`tool_not_mocked`, `mocks_exhausted`,
 * `mocks_engine_error`, plus the HTTP-level `mocks_invalid` /
 * `mocks_payload_too_large` / `mocks_not_permitted` envelopes emitted
 * at create time) line up byte-for-byte across the two runtimes.
 *
 * Storage shape: OSS holds session mocks and the per-tool consume
 * counters in process-local memory. Every session this seam handles is
 * an HTTP session (the only path that authors mocks today), so the
 * counter wiring goes through `makeInMemoryCounterStorage` which fronts
 * the in-process counter map on `sessions/core`. The persistent column
 * + counter table that the managed runtime uses live in
 * `codespar-enterprise`, not here.
 */

import { randomUUID } from "node:crypto";
import type { MockValue, Session } from "../storage/types.js";
import type { ToolResult } from "../mcp/types.js";
import {
  bumpHttpSessionToolCallCount,
  HTTP_CHANNEL_TYPE,
} from "./core.js";
import {
  evaluateSessionMock,
  type MockCounterStorage,
  type MockMatchResult,
} from "./mocks.js";
import { isTestModeEnabled } from "./test-mode-flag.js";

/** Session shape this seam reads. The persistent `Session` type has no
 *  `mocks` column; the in-memory HTTP session adds it structurally. */
type SessionWithMocks = Session & {
  mocks?: Record<string, MockValue> | null;
};

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
 *
 * Channel-bridge sessions (anything not `HTTP_CHANNEL_TYPE`) never
 * carry mocks under shape E — the in-memory store is HTTP-only. The
 * seam treats them as if no mock entry applies and short-circuits to
 * `null`, leaving the real bridge to handle the call.
 */
export async function tryMockedDispatch(
  session: SessionWithMocks,
  serverId: string,
  toolName: string,
  input: unknown,
): Promise<MockDispatchOk | null> {
  // Flag off — short-circuit. The mocks engine never runs and the
  // dispatcher falls through to the real bridge as if the feature
  // weren't shipped. Defense in depth for the case where an operator
  // flips the flag off after sessions had mocks declared: every
  // stored mock is ignored and every dispatch goes to the bridge.
  if (!isTestModeEnabled()) return null;
  if (session.channelType !== HTTP_CHANNEL_TYPE) return null;
  const canonical = `${serverId}/${toolName}`;
  const outcome = await evaluateSessionMock({
    sessionMocks: session.mocks ?? null,
    canonicalToolName: canonical,
    input,
    storage: makeInMemoryCounterStorage(),
    sessionId: session.id,
  });

  return promoteOutcome(session.id, serverId, toolName, outcome);
}

/**
 * Meta-tool variant of {@link tryMockedDispatch}. A meta-tool has no
 * `serverId__toolName` split, so the mock is keyed on the bare meta-tool name
 * (e.g. `codespar_invoice`) — matching the managed runtime's session-mock
 * lookup, so one session `mocks` map drives the meta-tool path identically on
 * both runtimes. Returns `null` only on the flag-off / non-HTTP short-circuits;
 * while the flag is on, a session that declares mocks but has no entry for this
 * meta-tool gets a `tool_not_mocked` envelope (strict mode), same as the raw path.
 */
export async function tryMockedMetaToolDispatch(
  session: SessionWithMocks,
  metaToolName: string,
  input: unknown,
): Promise<MockDispatchOk | null> {
  if (!isTestModeEnabled()) return null;
  if (session.channelType !== HTTP_CHANNEL_TYPE) return null;
  const outcome = await evaluateSessionMock({
    sessionMocks: session.mocks ?? null,
    canonicalToolName: metaToolName,
    input,
    storage: makeInMemoryCounterStorage(),
    sessionId: session.id,
  });
  const effective: MockMatchResult =
    outcome.kind === "passthrough"
      ? { kind: "tool_not_mocked", tool_name: metaToolName }
      : outcome;
  const result = mockOutcomeToToolResult(session.id, MOCK_SERVER_LABEL, metaToolName, effective);
  return { result, outcome: effective };
}

/**
 * Translate the evaluator's outcome into the dispatch-seam return.
 * Called only after the flag-on check has already passed.
 *
 * Under per-deployment strict mode, a `passthrough` outcome (no
 * mocks declared on the session, or no entry for this tool) is
 * promoted to a synthesised `tool_not_mocked` envelope — the seam
 * never returns `null` while the flag is on. The only way the
 * caller sees `null` is the flag-off short-circuit at the top of
 * each helper.
 *
 * Every other outcome (`consumed`, `exhausted`, `tool_not_mocked`,
 * `mocks_engine_error`) translates through the same `ToolResult`
 * mapper so the dispatcher returns one shape regardless of which
 * mock branch fired.
 */
function promoteOutcome(
  sessionId: string,
  serverId: string,
  toolName: string,
  outcome: MockMatchResult,
): MockDispatchOk {
  const effective: MockMatchResult =
    outcome.kind === "passthrough"
      ? { kind: "tool_not_mocked", tool_name: `${serverId}/${toolName}` }
      : outcome;
  const result = mockOutcomeToToolResult(sessionId, serverId, toolName, effective);
  return { result, outcome: effective };
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
      error: null,
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
 * Wrap the HTTP-session in-memory counter map behind the `MockCounterStorage`
 * slice the consume helper needs. The slice is intentionally minimal —
 * just the bump method the engine calls — so the in-memory wiring doesn't
 * have to satisfy the full persistent `StorageProvider` interface.
 */
function makeInMemoryCounterStorage(): MockCounterStorage {
  return {
    bumpSessionToolCallCount: async (
      sessionId: string,
      toolName: string,
      cap: number,
    ): Promise<{ n: number; bumped: boolean }> =>
      Promise.resolve(bumpHttpSessionToolCallCount(sessionId, toolName, cap)),
  };
}
