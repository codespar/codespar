import { describe, it, expect, vi } from "vitest";
import { TelegramAdapter } from "../adapter.js";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

// Mock grammy — prevent real Telegram connections
vi.mock("grammy", () => ({
  Bot: vi.fn().mockImplementation(() => ({
    api: {
      getMe: vi.fn().mockResolvedValue({ username: "test_bot" }),
      sendMessage: vi.fn().mockResolvedValue({}),
    },
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  })),
  InlineKeyboard: vi.fn().mockImplementation(() => ({
    text: vi.fn().mockReturnThis(),
    row: vi.fn().mockReturnThis(),
  })),
}));

describe("TelegramAdapter", () => {
  it("creates an instance", () => {
    const adapter = new TelegramAdapter();
    expect(adapter).toBeInstanceOf(TelegramAdapter);
  });

  it("has type 'telegram'", () => {
    const adapter = new TelegramAdapter();
    expect(adapter.type).toBe("telegram");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new TelegramAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities", () => {
    const adapter = new TelegramAdapter();
    const caps: ChannelCapabilities = adapter.getCapabilities();
    expect(caps).toEqual({
      threads: false,
      buttons: true,
      modals: false,
      messageEdit: true,
      ephemeral: false,
      reactions: false,
    });
  });

  it("registers a message handler via onMessage", () => {
    const adapter = new TelegramAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
  });
});
