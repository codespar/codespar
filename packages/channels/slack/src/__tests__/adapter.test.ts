import { describe, it, expect, vi } from "vitest";
import { SlackAdapter } from "../adapter.js";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

// Mock @slack/bolt — prevent real Slack connections
vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    message: vi.fn(),
    event: vi.fn(),
    action: vi.fn(),
    client: { auth: { test: vi.fn().mockResolvedValue({ ok: true, user_id: "U123" }) } },
  })),
}));

describe("SlackAdapter", () => {
  it("creates an instance", () => {
    const adapter = new SlackAdapter();
    expect(adapter).toBeInstanceOf(SlackAdapter);
  });

  it("has type 'slack'", () => {
    const adapter = new SlackAdapter();
    expect(adapter.type).toBe("slack");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new SlackAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities", () => {
    const adapter = new SlackAdapter();
    const caps: ChannelCapabilities = adapter.getCapabilities();
    expect(caps).toEqual({
      threads: true,
      buttons: true,
      modals: true,
      messageEdit: true,
      ephemeral: true,
      reactions: true,
    });
  });

  it("accepts an optional StorageProvider in constructor", () => {
    const mockStorage = {} as any;
    const adapter = new SlackAdapter(mockStorage);
    expect(adapter).toBeInstanceOf(SlackAdapter);
  });

  it("registers a message handler via onMessage", () => {
    const adapter = new SlackAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
  });
});
