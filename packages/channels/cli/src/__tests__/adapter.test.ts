import { describe, it, expect, vi } from "vitest";
import { CLIAdapter } from "../adapter.js";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

describe("CLIAdapter", () => {
  it("creates an instance", () => {
    const adapter = new CLIAdapter();
    expect(adapter).toBeInstanceOf(CLIAdapter);
  });

  it("has type 'cli'", () => {
    const adapter = new CLIAdapter();
    expect(adapter.type).toBe("cli");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new CLIAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities (all false)", () => {
    const adapter = new CLIAdapter();
    const caps: ChannelCapabilities = adapter.getCapabilities();
    expect(caps).toEqual({
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: false,
    });
  });

  it("registers a message handler via onMessage", () => {
    const adapter = new CLIAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
  });

  it("healthCheck returns false before connect", async () => {
    const adapter = new CLIAdapter();
    expect(await adapter.healthCheck()).toBe(false);
  });

  it("sendToChannel writes to console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const adapter = new CLIAdapter();
    await adapter.sendToChannel("terminal", { text: "hello" });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("hello"));
    spy.mockRestore();
  });
});
