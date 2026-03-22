/**
 * Telegram Channel Adapter -- via grammy framework.
 *
 * Implements the ChannelAdapter interface using the grammy Bot API.
 * Connects via long polling, normalizes messages, and sends responses
 * with Markdown formatting.
 *
 * Required environment variables:
 *   TELEGRAM_BOT_TOKEN -- Bot token from @BotFather
 */

import { Bot } from "grammy";
import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram" as const;

  private bot: Bot | null = null;
  private messageHandler: MessageHandler | null = null;
  private botUsername: string | null = null;

  async connect(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
      throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
    }

    this.bot = new Bot(token);

    // Resolve the bot's username for mention detection
    const me = await this.bot.api.getMe();
    this.botUsername = me.username ?? null;

    // Register message handler -- process text, photo, and document messages.
    // Only process DMs or messages that mention the bot.
    this.bot.on("message", async (ctx) => {
      if (!this.messageHandler) return;

      const msg = ctx.message;

      // Extract text from text messages or captions on media
      const text = (msg as any).text ?? (msg as any).caption ?? "";
      const isDM = ctx.chat.type === "private";

      // Check if the message mentions the bot by @username
      const mentionPattern = this.botUsername
        ? `@${this.botUsername}`
        : null;
      const isMentioningBot = mentionPattern
        ? text.includes(mentionPattern)
        : false;

      // In groups, only process messages that mention the bot
      if (!isDM && !isMentioningBot) return;

      // Strip the bot mention from the text
      let cleanText = text;
      if (mentionPattern) {
        cleanText = cleanText.replace(new RegExp(mentionPattern, "g"), "").trim();
      }

      // Extract attachments (photos, documents)
      const attachments: Attachment[] = [];

      // Photos: array of PhotoSize objects, largest is last
      const photo = (msg as any).photo;
      if (photo && Array.isArray(photo) && photo.length > 0) {
        const largest = photo[photo.length - 1];
        try {
          const fileInfo = await ctx.api.getFile(largest.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
          attachments.push({
            type: "image",
            url: fileUrl,
            mimeType: "image/jpeg",
            filename: `photo_${largest.file_id}.jpg`,
          });
        } catch {
          // Skip if file link cannot be resolved
        }
      }

      // Documents (files sent as attachments)
      const document = (msg as any).document;
      if (document) {
        try {
          const fileInfo = await ctx.api.getFile(document.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
          const isImage = document.mime_type?.startsWith("image/") ?? false;
          attachments.push({
            type: isImage ? "image" : "file",
            url: fileUrl,
            mimeType: document.mime_type || "application/octet-stream",
            filename: document.file_name || "document",
          });
        } catch {
          // Skip if file link cannot be resolved
        }
      }

      // Skip messages with no text and no attachments
      if (!cleanText && attachments.length === 0) return;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "telegram",
        channelId: ctx.chat.id.toString(),
        channelUserId: ctx.from.id.toString(),
        isDM,
        isMentioningBot: isDM || isMentioningBot,
        text: cleanText,
        ...(attachments.length > 0 ? { attachments } : {}),
        timestamp: new Date(msg.date * 1000),
      };

      await this.messageHandler(normalized);
    });

    // Start long polling (non-blocking)
    this.bot.start();
    console.log("[telegram] Bot adapter connected via long polling");
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
    this.botUsername = null;
    console.log("[telegram] Disconnected");
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    if (!this.bot) {
      throw new Error("Telegram adapter not connected. Call connect() first.");
    }

    await this.bot.api.sendMessage(channelId, response.text, {
      parse_mode: "Markdown",
    });
  }

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    // Telegram treats DMs as regular chats -- same API call
    await this.sendToChannel(userId, response);
  }

  getCapabilities(): ChannelCapabilities {
    return {
      threads: false,
      buttons: true,
      modals: false,
      messageEdit: true,
      ephemeral: false,
      reactions: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.bot) return false;

    try {
      await this.bot.api.getMe();
      return true;
    } catch {
      return false;
    }
  }
}
