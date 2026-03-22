/**
 * Discord Channel Adapter -- via discord.js v14.
 *
 * Implements the ChannelAdapter interface using discord.js.
 * Connects via gateway with required intents, normalizes messages,
 * and supports threads, embeds, buttons, modals, and ephemeral messages.
 *
 * Supports two modes:
 *
 * 1. Legacy (single server): Set DISCORD_BOT_TOKEN env var.
 *    The adapter connects using a static bot token.
 *
 * 2. OAuth (multi-tenant): Set DISCORD_CLIENT_ID + DISCORD_CLIENT_SECRET.
 *    Users install the bot via /api/discord/install. The bot token still
 *    comes from the Developer Portal (Discord bots are inherently
 *    multi-tenant -- one token works across all servers).
 *    DISCORD_BOT_TOKEN is still required for the gateway connection.
 *
 * Legacy-only:
 *   DISCORD_BOT_TOKEN      -- Bot token from Discord Developer Portal
 *
 * OAuth (multi-tenant install flow):
 *   DISCORD_CLIENT_ID      -- OAuth2 application client ID
 *   DISCORD_CLIENT_SECRET  -- OAuth2 application client secret (reserved for future use)
 *   DISCORD_BOT_TOKEN      -- Bot token (still required for gateway connection)
 */

import { Client, GatewayIntentBits, Events } from "discord.js";
import { randomUUID } from "node:crypto";
import type {
  Attachment,
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
  private mode: "legacy" | "oauth" | null = null;

  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;

    if (!token) {
      throw new Error(
        "DISCORD_BOT_TOKEN is required. " +
        "Set DISCORD_BOT_TOKEN for single-server mode, or " +
        "DISCORD_BOT_TOKEN + DISCORD_CLIENT_ID for multi-tenant (OAuth install flow)."
      );
    }

    this.mode = clientId ? "oauth" : "legacy";
    console.log(`[discord] Starting in ${this.mode} mode${clientId ? " (multi-tenant)" : ""}`);

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

      // Extract attachments (images, files)
      const attachments: Attachment[] = [];
      if (message.attachments.size > 0) {
        for (const [, attachment] of message.attachments) {
          const isImage = attachment.contentType?.startsWith("image/") ?? false;
          attachments.push({
            type: isImage ? "image" : "file",
            url: attachment.url,
            mimeType: attachment.contentType || "application/octet-stream",
            filename: attachment.name || "attachment",
          });
        }
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
        ...(attachments.length > 0 ? { attachments } : {}),
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
    this.mode = null;
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
