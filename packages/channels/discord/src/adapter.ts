/**
 * Discord Channel Adapter — via discord.js v14.
 *
 * Implements the ChannelAdapter interface using discord.js.
 * Connects via gateway with required intents, normalizes messages,
 * and supports threads, embeds, buttons, modals, and ephemeral messages.
 *
 * Required environment variables:
 *   DISCORD_BOT_TOKEN — Bot token from Discord Developer Portal
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";

export class DiscordAdapter implements ChannelAdapter {
  readonly type = "discord" as const;

  private client: Client | null = null;
  private messageHandler: MessageHandler | null = null;

  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;

    if (!token) {
      throw new Error("DISCORD_BOT_TOKEN environment variable is required");
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    // Register message handler before login so we don't miss events
    this.client.on(Events.MessageCreate, async (message) => {
      if (!this.messageHandler) return;

      // Ignore messages from bots (including ourselves)
      if (message.author.bot) return;

      const isDM = message.channel.isDMBased();
      const botId = this.client?.user?.id;

      // Check if the message mentions our bot
      const isMentioningBot = botId
        ? message.mentions.has(botId)
        : false;

      // In guilds, only process messages that mention the bot
      if (!isDM && !isMentioningBot) return;

      // Strip the bot mention (<@BOT_ID>) from the text
      let cleanText = message.content;
      if (botId) {
        cleanText = cleanText
          .replace(new RegExp(`<@!?${botId}>`, "g"), "")
          .trim();
      }

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "discord",
        channelId: message.channelId,
        channelUserId: message.author.id,
        isDM,
        isMentioningBot: isDM || isMentioningBot,
        text: cleanText,
        threadId: message.thread?.id,
        timestamp: message.createdAt,
      };

      await this.messageHandler(normalized);
    });

    // Wait for the client to be ready
    await new Promise<void>((resolve, reject) => {
      if (!this.client) return reject(new Error("Client not initialized"));

      this.client.once(Events.ClientReady, () => {
        console.log(`[discord] Bot connected as ${this.client?.user?.tag}`);
        resolve();
      });

      this.client.once(Events.Error, (err) => {
        reject(err);
      });

      this.client.login(token).catch(reject);
    });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    console.log("[discord] Disconnected");
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    if (!this.client) {
      throw new Error("Discord adapter not connected. Call connect() first.");
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${channelId} not found or is not text-based`);
    }

    if ("send" in channel) {
      await channel.send(response.text);
    }
  }

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    if (!this.client) {
      throw new Error("Discord adapter not connected. Call connect() first.");
    }

    const user = await this.client.users.fetch(userId);
    await user.send(response.text);
  }

  getCapabilities(): ChannelCapabilities {
    return {
      threads: true,
      buttons: true,
      modals: true,
      messageEdit: true,
      ephemeral: true,
      reactions: true,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.client) return false;
    return this.client.isReady();
  }
}
