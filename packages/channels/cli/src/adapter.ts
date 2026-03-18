/**
 * CLI Channel Adapter — Terminal stdin/stdout for development and debugging.
 *
 * Implements the ChannelAdapter interface using Node.js readline.
 * No network dependencies. Perfect for testing agent logic locally.
 */

import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";

export class CLIAdapter implements ChannelAdapter {
  readonly type = "cli" as const;

  private rl: readline.Interface | null = null;
  private messageHandler: MessageHandler | null = null;

  async connect(): Promise<void> {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "codespar> ",
    });
  }

  async disconnect(): Promise<void> {
    this.rl?.close();
    this.rl = null;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Start the interactive REPL loop */
  async startREPL(): Promise<void> {
    if (!this.rl) {
      throw new Error("CLI adapter not connected. Call connect() first.");
    }

    this.rl.prompt();

    let closed = false;

    this.rl.on("line", async (line: string) => {
      if (closed) return;

      const text = line.trim();
      if (!text) {
        this.rl?.prompt();
        return;
      }

      if (text === "exit" || text === "quit") {
        closed = true;
        this.rl?.close();
        return;
      }

      if (this.messageHandler) {
        const message: NormalizedMessage = {
          id: randomUUID(),
          channelType: "cli",
          channelId: "terminal",
          channelUserId: "local-user",
          isDM: true,
          isMentioningBot: true,
          text,
          timestamp: new Date(),
        };

        await this.messageHandler(message);
      }

      if (!closed) this.rl?.prompt();
    });

    this.rl.on("close", () => {
      // Will be handled by supervisor shutdown
    });
  }

  async sendToChannel(
    _channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    console.log(`\n${response.text}\n`);
  }

  async sendDM(_userId: string, response: ChannelResponse): Promise<void> {
    console.log(`\n${response.text}\n`);
  }

  getCapabilities(): ChannelCapabilities {
    return {
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    return this.rl !== null;
  }
}
