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

import { Bot, InlineKeyboard } from "grammy";
import { randomUUID } from "node:crypto";
import type {
  Attachment,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";

// ---------------------------------------------------------------------------
// Interactive button detection — mirrors Slack formatter patterns
// ---------------------------------------------------------------------------

interface InlineButtonDef {
  label: string;
  callbackData: string;
}

/** Row of buttons (each inner array becomes one row in the inline keyboard). */
type ButtonRow = InlineButtonDef[];

/**
 * Detect interactive patterns in a response text and return inline
 * keyboard button definitions. Returns null when no pattern matches.
 */
function detectInlineButtons(text: string): ButtonRow[] | null {
  // Deploy failure analysis (self-healing alerts)
  if (text.includes("Deploy Failure Analysis")) {
    const projectMatch = text.match(/\*?\*?Project:?\*?\*?\s*(\S+)/);
    const project = projectMatch ? projectMatch[1] : "unknown";
    return [
      [
        { label: "\uD83D\uDD0D Investigate", callbackData: `heal_investigate_${project}` },
        { label: "\uD83D\uDD27 Auto-fix", callbackData: `heal_autofix_${project}` },
      ],
      [
        { label: "\u2713 Ignore", callbackData: `heal_ignore_${project}` },
      ],
    ];
  }

  // Deploy approval requests
  if (
    (text.includes("Deploy") && text.includes("approval")) ||
    text.includes("Waiting approval")
  ) {
    const tokenMatch = text.match(/(?:Token|token|approve)\s*:?\s*([a-z]{2}-[a-zA-Z0-9]+)/);
    const token = tokenMatch ? tokenMatch[1] : null;
    if (token) {
      return [
        [
          { label: "\u2705 Approve", callbackData: `approve_${token}` },
          { label: "\u274C Reject", callbackData: `reject_${token}` },
        ],
      ];
    }
  }

  // PR creation notifications
  if (text.includes("PR #") && text.includes("created")) {
    const prMatch = text.match(/PR #(\d+)/);
    const prNumber = prMatch ? prMatch[1] : "";
    if (prNumber) {
      return [
        [
          { label: "\uD83D\uDCDD Review PR", callbackData: `review_pr_${prNumber}` },
          { label: "\u2713 Merge", callbackData: `merge_pr_${prNumber}` },
        ],
      ];
    }
  }

  // Build failure alerts
  if (
    text.includes("Build") &&
    (text.includes("failed") || text.includes("broken") || text.includes("failure"))
  ) {
    return [
      [
        { label: "\uD83D\uDD0D Investigate", callbackData: "investigate_failure" },
        { label: "\uD83D\uDCCB View Logs", callbackData: "view_logs" },
      ],
    ];
  }

  // PR review results with risk assessment
  if (text.includes("Review") && text.includes("Risk:")) {
    const prMatch = text.match(/PR #(\d+)/);
    const prNumber = prMatch ? prMatch[1] : "";
    if (prNumber) {
      return [
        [
          { label: "\u2713 Approve & Merge", callbackData: `approve_merge_pr_${prNumber}` },
          { label: "Request Changes", callbackData: `request_changes_${prNumber}` },
        ],
      ];
    }
  }

  return null;
}

/**
 * Build a grammy InlineKeyboard from button row definitions.
 */
function buildInlineKeyboard(rows: ButtonRow[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const row of rows) {
    for (const btn of row) {
      keyboard.text(btn.label, btn.callbackData);
    }
    keyboard.row();
  }
  return keyboard;
}

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

    // Interactive button clicks — callback queries from inline keyboards.
    this.bot.on("callback_query:data", async (ctx) => {
      if (!this.messageHandler) {
        await ctx.answerCallbackQuery({ text: "Agent initializing. Try again." });
        return;
      }

      const callbackData = ctx.callbackQuery.data;
      const userId = ctx.from.id.toString();
      const channelId = ctx.chat?.id?.toString() ?? userId;

      let command = "";

      if (callbackData.startsWith("approve_merge_pr_")) {
        const prNumber = callbackData.replace("approve_merge_pr_", "");
        command = `merge PR #${prNumber}`;
      } else if (callbackData.startsWith("merge_pr_")) {
        const prNumber = callbackData.replace("merge_pr_", "");
        command = `merge PR #${prNumber}`;
      } else if (callbackData.startsWith("review_pr_")) {
        const prNumber = callbackData.replace("review_pr_", "");
        command = `review PR #${prNumber}`;
      } else if (callbackData.startsWith("approve_")) {
        const token = callbackData.replace("approve_", "");
        command = `approve ${token}`;
      } else if (callbackData.startsWith("reject_")) {
        const token = callbackData.replace("reject_", "");
        command = `reject ${token}`;
      } else if (callbackData === "investigate_failure") {
        command = "logs 5";
      } else if (callbackData === "view_logs") {
        command = "logs 10";
      } else if (callbackData.startsWith("request_changes_")) {
        const prNumber = callbackData.replace("request_changes_", "");
        await ctx.answerCallbackQuery({ text: `Changes requested on PR #${prNumber}` });
        await ctx.reply(`Changes requested on PR #${prNumber} by user ${userId}`);
        return;
      } else if (callbackData.startsWith("heal_investigate_")) {
        const project = callbackData.replace("heal_investigate_", "");
        command = `fix investigate-deploy ${project}`;
      } else if (callbackData.startsWith("heal_autofix_")) {
        const project = callbackData.replace("heal_autofix_", "");
        command = `fix auto-heal ${project}`;
      } else if (callbackData.startsWith("heal_ignore_")) {
        await ctx.answerCallbackQuery({ text: "Alert acknowledged. No action taken." });
        await ctx.reply(`\u2713 Alert acknowledged by user ${userId}. No action taken.`);
        return;
      }

      if (command) {
        await ctx.answerCallbackQuery({ text: `Vote recorded: ${command}` });

        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "telegram",
          channelId,
          channelUserId: userId,
          isDM: ctx.chat?.type === "private",
          isMentioningBot: true,
          text: command,
          timestamp: new Date(),
          metadata: { channelId },
        };

        await this.messageHandler(normalized);
      }
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

    const buttonRows = detectInlineButtons(response.text);
    if (buttonRows) {
      const keyboard = buildInlineKeyboard(buttonRows);
      await this.bot.api.sendMessage(channelId, response.text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await this.bot.api.sendMessage(channelId, response.text, {
        parse_mode: "Markdown",
      });
    }
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
