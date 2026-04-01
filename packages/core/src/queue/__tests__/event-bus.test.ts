import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryEventBus,
  type EventBusMessage,
  type EventBusChannel,
} from "../event-bus.js";

describe("EventBus — InMemory fallback", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  // ── publish / subscribe ───────────────────────────────────────────

  it("delivers a published event to the subscriber", async () => {
    const received: EventBusMessage[] = [];

    await bus.subscribe("agent:progress", (msg) => received.push(msg));

    const event: EventBusMessage = {
      type: "step",
      agentId: "a-1",
      projectId: "p-1",
      timestamp: Date.now(),
      payload: { step: 3, total: 10 },
    };

    await bus.publish("agent:progress", event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });

  it("does not deliver to unrelated channels", async () => {
    const received: EventBusMessage[] = [];

    await bus.subscribe("task:created", (msg) => received.push(msg));

    await bus.publish("task:completed", {
      type: "done",
      timestamp: Date.now(),
      payload: null,
    });

    expect(received).toHaveLength(0);
  });

  it("delivers multiple events in order", async () => {
    const received: EventBusMessage[] = [];

    await bus.subscribe("deploy:status", (msg) => received.push(msg));

    for (let i = 0; i < 5; i++) {
      await bus.publish("deploy:status", {
        type: `step-${i}`,
        timestamp: Date.now(),
        payload: { index: i },
      });
    }

    expect(received).toHaveLength(5);
    expect(received.map((m) => m.type)).toEqual([
      "step-0",
      "step-1",
      "step-2",
      "step-3",
      "step-4",
    ]);
  });

  // ── unsubscribe ───────────────────────────────────────────────────

  it("stops delivering after unsubscribe", async () => {
    const received: EventBusMessage[] = [];

    await bus.subscribe("agent:status", (msg) => received.push(msg));

    await bus.publish("agent:status", {
      type: "online",
      timestamp: Date.now(),
      payload: null,
    });

    await bus.unsubscribe("agent:status");

    await bus.publish("agent:status", {
      type: "offline",
      timestamp: Date.now(),
      payload: null,
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("online");
  });

  it("unsubscribe on a channel with no handler is a no-op", async () => {
    // Should not throw.
    await bus.unsubscribe("agent:progress");
  });

  // ── JSON serialization ────────────────────────────────────────────

  it("preserves full EventBusMessage structure through publish/subscribe", async () => {
    const received: EventBusMessage[] = [];

    await bus.subscribe("task:completed", (msg) => received.push(msg));

    const event: EventBusMessage = {
      type: "task:done",
      agentId: "agent-42",
      projectId: "proj-7",
      timestamp: 1700000000000,
      payload: {
        result: "success",
        files: ["src/index.ts", "tests/foo.test.ts"],
        nested: { depth: 2 },
      },
    };

    await bus.publish("task:completed", event);

    expect(received[0]).toEqual(event);
    expect(received[0].agentId).toBe("agent-42");
    expect(received[0].projectId).toBe("proj-7");
    expect(received[0].timestamp).toBe(1700000000000);
    expect((received[0].payload as Record<string, unknown>).result).toBe("success");
  });

  // ── close ─────────────────────────────────────────────────────────

  it("close removes all listeners", async () => {
    const received: EventBusMessage[] = [];

    const channels: EventBusChannel[] = [
      "agent:progress",
      "agent:status",
      "task:created",
    ];

    for (const ch of channels) {
      await bus.subscribe(ch, (msg) => received.push(msg));
    }

    await bus.close();

    for (const ch of channels) {
      await bus.publish(ch, {
        type: "after-close",
        timestamp: Date.now(),
        payload: null,
      });
    }

    expect(received).toHaveLength(0);
  });
});
