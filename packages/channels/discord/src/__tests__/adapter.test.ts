import { describe, it, expect, vi } from "vitest";
import { DiscordAdapter } from "../adapter.js";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

// Mock discord.js — prevent real Discord connections
vi.mock("discord.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    once: vi.fn(),
    login: vi.fn().mockResolvedValue("token"),
    destroy: vi.fn(),
    isReady: vi.fn().mockReturnValue(true),
    user: { id: "bot123", tag: "TestBot#0001" },
    channels: { fetch: vi.fn() },
    users: { fetch: vi.fn() },
  })),
  GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
  Events: { MessageCreate: "messageCreate", InteractionCreate: "interactionCreate", ClientReady: "ready", Error: "error" },
  ActionRowBuilder: vi.fn().mockImplementation(() => ({ addComponents: vi.fn().mockReturnThis() })),
  ButtonBuilder: vi.fn().mockImplementation(() => ({
    setCustomId: vi.fn().mockReturnThis(),
    setLabel: vi.fn().mockReturnThis(),
    setStyle: vi.fn().mockReturnThis(),
  })),
  ButtonStyle: { Success: 1, Danger: 2, Secondary: 3 },
}));

describe("DiscordAdapter", () => {
  it("creates an instance", () => {
    const adapter = new DiscordAdapter();
    expect(adapter).toBeInstanceOf(DiscordAdapter);
  });

  it("has type 'discord'", () => {
    const adapter = new DiscordAdapter();
    expect(adapter.type).toBe("discord");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new DiscordAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities", () => {
    const adapter = new DiscordAdapter();
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

  it("registers a message handler via onMessage", () => {
    const adapter = new DiscordAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
  });
});
