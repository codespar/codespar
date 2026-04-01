import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryTaskQueue, type QueuedTask } from "../task-queue.js";

function makeTask(overrides: Partial<QueuedTask> = {}): QueuedTask {
  return {
    type: "instruct",
    projectId: "proj-1",
    payload: { command: "fix lint errors" },
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("TaskQueue — InMemory fallback", () => {
  let queue: InMemoryTaskQueue;

  beforeEach(() => {
    queue = new InMemoryTaskQueue();
  });

  afterEach(async () => {
    await queue.close();
  });

  // ── enqueue / dequeue ─────────────────────────────────────────────

  it("enqueue returns a string id", async () => {
    const id = await queue.enqueue(makeTask());
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("dequeue returns the enqueued task", async () => {
    const task = makeTask({ type: "review" });
    await queue.enqueue(task);

    const result = await queue.dequeue("worker-1");

    expect(result).not.toBeNull();
    expect(result!.type).toBe("review");
    expect(result!.id).toBeDefined();
  });

  it("dequeue returns null on empty queue", async () => {
    const result = await queue.dequeue("worker-1");
    expect(result).toBeNull();
  });

  // ── FIFO ordering ────────────────────────────────────────────────

  it("dequeues in FIFO order", async () => {
    const tasks = [
      makeTask({ type: "first" }),
      makeTask({ type: "second" }),
      makeTask({ type: "third" }),
    ];

    for (const t of tasks) {
      await queue.enqueue(t);
    }

    const r1 = await queue.dequeue("w");
    const r2 = await queue.dequeue("w");
    const r3 = await queue.dequeue("w");

    expect(r1!.type).toBe("first");
    expect(r2!.type).toBe("second");
    expect(r3!.type).toBe("third");
  });

  // ── acknowledge ───────────────────────────────────────────────────

  it("acknowledge removes task from pending set", async () => {
    await queue.enqueue(makeTask());

    const task = await queue.dequeue("w");
    expect(await queue.pending()).toBe(1);

    await queue.acknowledge(task!.id!);
    expect(await queue.pending()).toBe(0);
  });

  it("acknowledge unknown id is a no-op", async () => {
    // Should not throw.
    await queue.acknowledge("does-not-exist");
  });

  // ── pending ───────────────────────────────────────────────────────

  it("pending returns 0 on empty queue", async () => {
    expect(await queue.pending()).toBe(0);
  });

  it("pending tracks in-flight tasks correctly", async () => {
    await queue.enqueue(makeTask());
    await queue.enqueue(makeTask());
    await queue.enqueue(makeTask());

    await queue.dequeue("w");
    await queue.dequeue("w");

    expect(await queue.pending()).toBe(2);
  });

  // ── close ─────────────────────────────────────────────────────────

  it("close empties the queue and in-flight set", async () => {
    await queue.enqueue(makeTask());
    await queue.enqueue(makeTask());
    await queue.dequeue("w");

    await queue.close();

    expect(await queue.dequeue("w")).toBeNull();
    expect(await queue.pending()).toBe(0);
  });

  // ── id uniqueness ────────────────────────────────────────────────

  it("each enqueued task gets a unique id", async () => {
    const ids = new Set<string>();

    for (let i = 0; i < 100; i++) {
      const id = await queue.enqueue(makeTask());
      ids.add(id);
    }

    expect(ids.size).toBe(100);
  });
});
