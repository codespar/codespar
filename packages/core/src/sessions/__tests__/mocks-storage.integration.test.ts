/**
 * Integration test for the FileStorage counter + session.mocks round-trip.
 *
 * Verifies that:
 *   - setSession persists the `mocks` field alongside the row.
 *   - getSession returns the mocks back.
 *   - `bumpSessionToolCallCount` advances a counter, persists it on disk,
 *     and caps at the supplied limit.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../../storage/file-storage.js";

let dir: string;
let storage: FileStorage;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "codespar-mocks-"));
  storage = new FileStorage(dir, "org-it");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileStorage mocks + counter round-trip", () => {
  it("persists session.mocks and round-trips it via getSession", async () => {
    const created = await storage.setSession({
      orgId: "org-it",
      projectId: "prj_default",
      channelType: "whatsapp",
      channelUserId: "u-m",
      status: "active",
      metadata: {},
      mocks: {
        "asaas/create_payment": { id: "pay_test", status: "PENDING" },
        "asaas/get_payment": [
          { id: "pay_test", status: "PENDING" },
          { id: "pay_test", status: "CONFIRMED" },
        ],
      },
    });
    const back = await storage.getSession(created.id);
    expect(back?.mocks).toEqual({
      "asaas/create_payment": { id: "pay_test", status: "PENDING" },
      "asaas/get_payment": [
        { id: "pay_test", status: "PENDING" },
        { id: "pay_test", status: "CONFIRMED" },
      ],
    });
  });

  it("bumpSessionToolCallCount advances and caps", async () => {
    const r1 = await storage.bumpSessionToolCallCount("sess-1", "asaas/get_payment", 2);
    expect(r1).toEqual({ n: 1, bumped: true });
    const r2 = await storage.bumpSessionToolCallCount("sess-1", "asaas/get_payment", 2);
    expect(r2).toEqual({ n: 2, bumped: true });
    const r3 = await storage.bumpSessionToolCallCount("sess-1", "asaas/get_payment", 2);
    expect(r3).toEqual({ n: 2, bumped: false });
    expect(await storage.getSessionToolCallCount("sess-1", "asaas/get_payment")).toBe(2);
  });

  it("counters scope by (session, tool) — no cross-leakage", async () => {
    await storage.bumpSessionToolCallCount("a", "x/y", 5);
    await storage.bumpSessionToolCallCount("a", "x/y", 5);
    await storage.bumpSessionToolCallCount("b", "x/y", 5);
    expect(await storage.getSessionToolCallCount("a", "x/y")).toBe(2);
    expect(await storage.getSessionToolCallCount("b", "x/y")).toBe(1);
    expect(await storage.getSessionToolCallCount("a", "x/z")).toBe(0);
  });
});
