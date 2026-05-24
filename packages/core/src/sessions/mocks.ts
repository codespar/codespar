/**
 * Session mocks engine — OSS implementation of the hosted-test-mode
 * wire contract.
 *
 * Two exports:
 *
 *   - `evaluateSessionMock` — pure dispatcher that answers "what does
 *     this session's mock store say about this canonical tool name?"
 *     Returns a discriminated union the caller acts on.
 *   - `consumeMockEntry` — counter-advance helper for the stateful
 *     array variant. Advances the per-session per-tool counter, capped
 *     at the array length, and returns the indexed mock output.
 *
 * Strict-mode (R3a in the managed runtime's design) activates
 * structurally: when `sessionMocks` is a non-empty object and the
 * canonical tool name has no entry, the helper returns
 * `tool_not_mocked` and the dispatcher MUST NOT fall through to a real
 * MCP server. This is the structural fix for the typo-driven real-
 * upstream leak — a misspelled tool name in test mode fails loud.
 *
 * Counter semantics:
 *   - Single-shot object value → `{ kind: "consumed", n: 1, cap: 1 }`
 *     every time it is consulted; no counter is advanced because the
 *     value is idempotent.
 *   - Stateful array value → counter advances on every consume, capped
 *     at `entry.length`. The cap is enforced by the storage layer's
 *     bump so a concurrent dispatcher cannot overshoot.
 *
 * What this module deliberately omits, relative to the managed runtime
 * it mirrors: no audit-chain stamping, no commerce-memory capture, no
 * AgentGate policy wrapper, no approval-replay orphan annotation. Those
 * are wrapper concerns of the managed tier and stay outside the MIT
 * surface.
 */

import type { MockObject, MockValue, StorageProvider } from "../storage/types.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("session-mocks");

/** Result of evaluating a single canonical tool name against the
 *  session's mock store. */
export type MockMatchResult =
  | { kind: "consumed"; output: unknown; n: number; cap: number }
  | { kind: "exhausted"; n: number; cap: number }
  | { kind: "tool_not_mocked"; tool_name: string }
  | { kind: "passthrough" }
  | { kind: "mocks_engine_error"; message: string };

const MOCKS_ENGINE_ERROR_MESSAGE =
  "mock engine unavailable; retry the call or contact support";

export interface EvaluateSessionMockArgs {
  /** The Session.mocks field as loaded — may be undefined, null, or a
   *  populated object. The helper handles every shape. */
  sessionMocks: Record<string, MockValue> | null | undefined;
  /** Canonical "server/tool" name. */
  canonicalToolName: string;
  /** Tool input — opaque to the helper; reserved for future mock-input
   *  matching variants. */
  input: unknown;
  /** Per-session storage for counter persistence. When `null` the
   *  evaluator runs in counter-less mode: stateful arrays return the
   *  first entry every call and never advance. Used by the in-memory
   *  HTTP path which keeps its counter in process state instead. */
  storage: StorageProvider | null;
  /** Session id keyed by the counter. */
  sessionId: string;
}

/**
 * Pure mock-evaluation dispatcher. Inspects the session's mocks for an
 * entry under `canonicalToolName` and returns the matching variant.
 *
 *   - `passthrough` when no mocks are declared on the session, or the
 *     mocks object is empty.
 *   - `tool_not_mocked` when mocks are declared but this tool has no
 *     entry (strict-mode).
 *   - `consumed` when an entry exists and is consumable.
 *   - `exhausted` when a stateful array's counter is already at cap.
 *   - `mocks_engine_error` on a defensive failure (counter persistence
 *     blew up, malformed entry slipped past validation, etc.).
 */
export async function evaluateSessionMock(
  args: EvaluateSessionMockArgs,
): Promise<MockMatchResult> {
  const { sessionMocks, canonicalToolName } = args;

  if (
    sessionMocks === null ||
    sessionMocks === undefined ||
    typeof sessionMocks !== "object" ||
    Array.isArray(sessionMocks)
  ) {
    return { kind: "passthrough" };
  }
  const mocks = sessionMocks as Record<string, unknown>;
  if (Object.keys(mocks).length === 0) return { kind: "passthrough" };

  const entry = mocks[canonicalToolName];
  if (entry === undefined) {
    return { kind: "tool_not_mocked", tool_name: canonicalToolName };
  }

  if (Array.isArray(entry)) {
    const cap = entry.length;
    if (cap === 0) {
      // Defensive — Decision-7 validation rejects empty arrays at create
      // time; if one slipped in we fail closed instead of silently
      // returning `passthrough`.
      return { kind: "mocks_engine_error", message: MOCKS_ENGINE_ERROR_MESSAGE };
    }
    try {
      const consumed = await consumeMockEntry({
        sessionId: args.sessionId,
        toolName: canonicalToolName,
        mocksJsonb: mocks,
        storage: args.storage,
      });
      return consumed;
    } catch (err) {
      log.warn("mock-consume failed; surfacing mocks_engine_error", {
        sessionId: args.sessionId,
        tool: canonicalToolName,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: "mocks_engine_error", message: MOCKS_ENGINE_ERROR_MESSAGE };
    }
  }

  if (typeof entry === "object" && entry !== null) {
    return { kind: "consumed", output: entry, n: 1, cap: 1 };
  }

  // Defensive — primitives are rejected at create time. If a malformed
  // entry slipped into storage we fail closed.
  return { kind: "mocks_engine_error", message: MOCKS_ENGINE_ERROR_MESSAGE };
}

export interface ConsumeMockEntryArgs {
  sessionId: string;
  /** Canonical "server/tool" form. */
  toolName: string;
  /** The session's mocks object — already-loaded JSON. */
  mocksJsonb: Record<string, unknown>;
  /** Storage backend used to persist the counter; `null` runs in
   *  in-memory mode (see [[evaluateSessionMock]] for semantics). */
  storage: StorageProvider | null;
}

/**
 * Advance the per-session per-tool counter and return the next mock
 * output. The storage layer is responsible for the cap-respecting
 * advance — this helper just translates the result into the wire-shape
 * the dispatcher expects.
 *
 * For single-shot entries the caller already short-circuits in
 * `evaluateSessionMock`; this helper only sees array values.
 */
export async function consumeMockEntry(
  args: ConsumeMockEntryArgs,
): Promise<MockMatchResult> {
  const { sessionId, toolName, mocksJsonb, storage } = args;

  if (
    mocksJsonb === null ||
    typeof mocksJsonb !== "object" ||
    Array.isArray(mocksJsonb)
  ) {
    return { kind: "passthrough" };
  }
  const entry = mocksJsonb[toolName];
  if (entry === undefined) return { kind: "passthrough" };
  if (!Array.isArray(entry)) {
    // Object entries are handled by the caller.
    return { kind: "consumed", output: entry as MockObject, n: 1, cap: 1 };
  }
  const cap = entry.length;
  if (cap === 0) return { kind: "passthrough" };

  if (storage === null) {
    // In-memory path uses a process-local counter map kept by the
    // sessions/core module; counter persistence is the caller's job
    // there. We just return the first entry as a safe default — the
    // caller is expected to have advanced its own state already.
    return { kind: "consumed", output: entry[0], n: 1, cap };
  }

  const { n, bumped } = await storage.bumpSessionToolCallCount(
    sessionId,
    toolName,
    cap,
  );
  if (!bumped) {
    return { kind: "exhausted", n: cap, cap };
  }
  if (n > cap) {
    // Defensive — storage's bump is contracted to cap. If it ever
    // overshoots we treat it as an engine error rather than emitting
    // an out-of-range mock index.
    return { kind: "mocks_engine_error", message: MOCKS_ENGINE_ERROR_MESSAGE };
  }
  return { kind: "consumed", output: entry[n - 1], n, cap };
}
