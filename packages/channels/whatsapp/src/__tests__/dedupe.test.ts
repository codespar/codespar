import { describe, it, expect } from "vitest";
import { WebhookDedupe } from "../dedupe.js";

describe("WebhookDedupe — in-memory LRU (F10.M4 / #366)", () => {
  it("first sighting of an event is fresh; the second is a duplicate", async () => {
    const dd = new WebhookDedupe();
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(true);
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(false);
  });

  it("distinct event ids stay distinct", async () => {
    const dd = new WebhookDedupe();
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(true);
    expect(await dd.seenBefore("whatsapp", "evt-2")).toBe(true);
    expect(await dd.seenBefore("whatsapp", "evt-2")).toBe(false);
  });

  it("channelType participates in the key — same id under two channels does not collide", async () => {
    const dd = new WebhookDedupe();
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(true);
    expect(await dd.seenBefore("slack", "evt-1")).toBe(true);
  });

  it("evicts older entries once capacity is exceeded", async () => {
    const dd = new WebhookDedupe({ max: 3 });
    expect(await dd.seenBefore("c", "1")).toBe(true);
    expect(await dd.seenBefore("c", "2")).toBe(true);
    expect(await dd.seenBefore("c", "3")).toBe(true);
    expect(dd.size()).toBe(3);
    // Insert #4: bound stays at 3, #1 evicted.
    expect(await dd.seenBefore("c", "4")).toBe(true);
    expect(dd.size()).toBe(3);
    // #1 now appears fresh again because it was evicted.
    expect(await dd.seenBefore("c", "1")).toBe(true);
  });

  it("repeated duplicates touch the LRU so they don't get evicted by churn", async () => {
    const dd = new WebhookDedupe({ max: 3 });
    await dd.seenBefore("c", "hot");
    await dd.seenBefore("c", "a");
    await dd.seenBefore("c", "b");
    // "hot" arrives again; should remain present (touch).
    expect(await dd.seenBefore("c", "hot")).toBe(false);
    // Two more arrivals push the cold tail out.
    await dd.seenBefore("c", "c");
    await dd.seenBefore("c", "d");
    // "hot" is still tracked because touching kept it live.
    expect(await dd.seenBefore("c", "hot")).toBe(false);
  });
});

describe("WebhookDedupe — Redis fallback (F10.M4 / #366)", () => {
  it("uses Redis NX-set when a client is provided; success counts as fresh", async () => {
    const set = (..._args: unknown[]): Promise<string | null> => Promise.resolve("OK");
    const redis = { set };
    const dd = new WebhookDedupe({ redis });
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(true);
  });

  it("Redis NX-set returning null is treated as a duplicate", async () => {
    const dd = new WebhookDedupe({
      redis: {
        set: () => Promise.resolve(null),
      },
    });
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(false);
  });

  it("Redis errors degrade the dedupe to the in-memory LRU without throwing", async () => {
    const dd = new WebhookDedupe({
      redis: {
        set: () => Promise.reject(new Error("redis down")),
      },
    });
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(true);
    // Subsequent call still resolves; Redis stays degraded.
    expect(await dd.seenBefore("whatsapp", "evt-1")).toBe(false);
  });
});
