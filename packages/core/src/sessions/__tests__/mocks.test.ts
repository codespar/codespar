/**
 * Unit tests for `evaluateSessionMock` + `consumeMockEntry`.
 *
 * Covers the five `MockMatchResult` outcomes:
 *   - passthrough  — no mocks declared, or empty store, or array-shaped
 *                    store (defensive)
 *   - consumed     — single-shot object, or stateful array within cap
 *   - exhausted    — stateful array at cap
 *   - tool_not_mocked — mocks declared but no entry under canonical name
 *   - mocks_engine_error — counter persistence throws / shape invalid
 *
 * Counter persistence runs against a minimal in-memory StorageProvider
 * shim so the unit tests stay deterministic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { evaluateSessionMock, consumeMockEntry } from "../mocks.js";
import type { StorageProvider } from "../../storage/types.js";

function mkStorage(): StorageProvider {
  const counters = new Map<string, number>();
  const key = (s: string, t: string) => `${s}::${t}`;
  return {
    getSessionToolCallCount: async (s, t) => counters.get(key(s, t)) ?? 0,
    bumpSessionToolCallCount: async (s, t, cap) => {
      const prior = counters.get(key(s, t)) ?? 0;
      if (prior >= cap) return { n: prior, bumped: false };
      const next = prior + 1;
      counters.set(key(s, t), next);
      return { n: next, bumped: true };
    },
  } as unknown as StorageProvider;
}

describe("evaluateSessionMock", () => {
  let storage: StorageProvider;
  beforeEach(() => {
    storage = mkStorage();
  });

  it("returns passthrough when mocks is null", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: null,
      canonicalToolName: "asaas/create_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r.kind).toBe("passthrough");
  });

  it("returns passthrough when mocks is undefined", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: undefined,
      canonicalToolName: "asaas/foo",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r.kind).toBe("passthrough");
  });

  it("returns passthrough when mocks is an empty object", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: {},
      canonicalToolName: "asaas/foo",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r.kind).toBe("passthrough");
  });

  it("returns tool_not_mocked when mocks declared but tool absent", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: { "asaas/other": { ok: true } },
      canonicalToolName: "asaas/create_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r).toEqual({
      kind: "tool_not_mocked",
      tool_name: "asaas/create_payment",
    });
  });

  it("returns consumed for a single-shot object entry", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: {
        "asaas/create_payment": { id: "pay_test", status: "PENDING" },
      },
      canonicalToolName: "asaas/create_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r).toEqual({
      kind: "consumed",
      output: { id: "pay_test", status: "PENDING" },
      n: 1,
      cap: 1,
    });
  });

  it("advances the counter on stateful array calls and exhausts cleanly", async () => {
    const mocks = {
      "asaas/get_payment": [
        { id: "p1", status: "PENDING" },
        { id: "p1", status: "CONFIRMED" },
      ],
    };
    const r1 = await evaluateSessionMock({
      sessionMocks: mocks,
      canonicalToolName: "asaas/get_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r1).toMatchObject({ kind: "consumed", n: 1, cap: 2 });
    const r2 = await evaluateSessionMock({
      sessionMocks: mocks,
      canonicalToolName: "asaas/get_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r2).toMatchObject({ kind: "consumed", n: 2, cap: 2 });
    const r3 = await evaluateSessionMock({
      sessionMocks: mocks,
      canonicalToolName: "asaas/get_payment",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r3).toEqual({ kind: "exhausted", n: 2, cap: 2 });
  });

  it("returns mocks_engine_error on counter persistence failure", async () => {
    const broken = {
      bumpSessionToolCallCount: async () => {
        throw new Error("disk full");
      },
      getSessionToolCallCount: async () => 0,
    } as unknown as StorageProvider;
    const r = await evaluateSessionMock({
      sessionMocks: { "asaas/foo": [{ a: 1 }] },
      canonicalToolName: "asaas/foo",
      input: {},
      storage: broken,
      sessionId: "s1",
    });
    expect(r.kind).toBe("mocks_engine_error");
  });

  it("returns mocks_engine_error on an empty-array entry (defensive)", async () => {
    const r = await evaluateSessionMock({
      sessionMocks: { "asaas/foo": [] },
      canonicalToolName: "asaas/foo",
      input: {},
      storage,
      sessionId: "s1",
    });
    expect(r.kind).toBe("mocks_engine_error");
  });
});

describe("consumeMockEntry", () => {
  it("passthrough when mocksJsonb is not an object", async () => {
    const r = await consumeMockEntry({
      sessionId: "s",
      toolName: "asaas/foo",
      // intentional mistyped input to verify defensive branch
      mocksJsonb: null as unknown as Record<string, unknown>,
      storage: mkStorage(),
    });
    expect(r.kind).toBe("passthrough");
  });

  it("passthrough when tool entry is missing", async () => {
    const r = await consumeMockEntry({
      sessionId: "s",
      toolName: "asaas/missing",
      mocksJsonb: { "asaas/other": [] },
      storage: mkStorage(),
    });
    expect(r.kind).toBe("passthrough");
  });

  it("returns consumed with n=1/cap=1 for a non-array entry", async () => {
    const r = await consumeMockEntry({
      sessionId: "s",
      toolName: "asaas/foo",
      mocksJsonb: { "asaas/foo": { hello: "world" } },
      storage: mkStorage(),
    });
    expect(r).toEqual({
      kind: "consumed",
      output: { hello: "world" },
      n: 1,
      cap: 1,
    });
  });
});
