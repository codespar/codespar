import { describe, it, expect, vi } from "vitest";
import { WhatsAppAdapter } from "../adapter.js";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

// Mock fastify — prevent real server startup
vi.mock("fastify", () => ({
  __esModule: true,
  default: vi.fn(() => ({
    post: vi.fn(),
    get: vi.fn(),
    listen: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("WhatsAppAdapter", () => {
  it("creates an instance", () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  it("has type 'whatsapp'", () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.type).toBe("whatsapp");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new WhatsAppAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities", () => {
    const adapter = new WhatsAppAdapter();
    const caps: ChannelCapabilities = adapter.getCapabilities();
    expect(caps).toEqual({
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: true,
    });
  });

  it("registers a message handler via onMessage", () => {
    const adapter = new WhatsAppAdapter();
    const handler = vi.fn();
    // Should not throw
    adapter.onMessage(handler);
  });
});
