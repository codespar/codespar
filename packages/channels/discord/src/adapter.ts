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

import {
  Client,
  GatewayIntentBits,
  Events,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import type { ButtonInteraction } from "discord.js";
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

interface ButtonDef {
  label: string;
  customId: string;
  style: "primary" | "danger" | "secondary";
}

/**
 * Detect interactive patterns in a response text and return button
 * definitions. Returns null when no pattern matches.
 */
function detectButtons(text: string): ButtonDef[] | null {
  // Deploy failure analysis (self-healing alerts)
  if (text.includes("Deploy Failure Analysis")) {
    const projectMatch = text.match(/\*?\*?Project:?\*?\*?\s*(\S+)/);
    const project = projectMatch ? projectMatch[1] : "unknown";
    return [
      { label: "\uD83D\uDD0D Investigate", customId: `heal_investigate_${project}`, style: "secondary" },
      { label: "\uD83D\uDD27 Auto-fix", customId: `heal_autofix_${project}`, style: "primary" },
      { label: "\u2713 Ignore", customId: `heal_ignore_${project}`, style: "secondary" },
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
        { label: "\u2705 Approve", customId: `approve_${token}`, style: "primary" },
        { label: "\u274C Reject", customId: `reject_${token}`, style: "danger" },
      ];
    }
  }

  // PR creation notifications
  if (text.includes("PR #") && text.includes("created")) {
    const prMatch = text.match(/PR #(\d+)/);
    const prNumber = prMatch ? prMatch[1] : "";
    if (prNumber) {
      return [
        { label: "\uD83D\uDCDD Review PR", customId: `review_pr_${prNumber}`, style: "secondary" },
        { label: "\u2713 Merge", customId: `merge_pr_${prNumber}`, style: "primary" },
      ];
    }
  }

  // Build failure alerts
  if (
    text.includes("Build") &&
    (text.includes("failed") || text.includes("broken") || text.includes("failure"))
  ) {
    return [
      { label: "\uD83D\uDD0D Investigate", customId: "investigate_failure", style: "secondary" },
      { label: "\uD83D\uDCCB View Logs", customId: "view_logs", style: "secondary" },
    ];
  }

  // PR review results with risk assessment
  if (text.includes("Review") && text.includes("Risk:")) {
    const prMatch = text.match(/PR #(\d+)/);
    const prNumber = prMatch ? prMatch[1] : "";
    if (prNumber) {
      return [
        { label: "\u2713 Approve & Merge", customId: `approve_merge_pr_${prNumber}`, style: "primary" },
        { label: "Request Changes", customId: `request_changes_${prNumber}`, style: "danger" },
      ];
    }
  }

  return null;
}

/**
 * Build a discord.js ActionRow from button definitions.
 */
function buildActionRow(buttons: ButtonDef[]): ActionRowBuilder<ButtonBuilder> {
  const styleMap = {
    primary: ButtonStyle.Success,
    danger: ButtonStyle.Danger,
    secondary: ButtonStyle.Secondary,
  };

  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const btn of buttons) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(btn.customId)
        .setLabel(btn.label)
        .setStyle(styleMap[btn.style])
    );
  }
  return row;
}

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

    // Interactive button clicks — approve, reject, merge, investigate, etc.
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (!this.messageHandler) return;

      const buttonInteraction = interaction as ButtonInteraction;
      const customId = buttonInteraction.customId;
      const userId = buttonInteraction.user.id;
      const channelId = buttonInteraction.channelId;

      let command = "";

      if (customId.startsWith("approve_merge_pr_")) {
        const prNumber = customId.replace("approve_merge_pr_", "");
        command = `merge PR #${prNumber}`;
      } else if (customId.startsWith("merge_pr_")) {
        const prNumber = customId.replace("merge_pr_", "");
        command = `merge PR #${prNumber}`;
      } else if (customId.startsWith("review_pr_")) {
        const prNumber = customId.replace("review_pr_", "");
        command = `review PR #${prNumber}`;
      } else if (customId.startsWith("approve_")) {
        const token = customId.replace("approve_", "");
        command = `approve ${token}`;
      } else if (customId.startsWith("reject_")) {
        const token = customId.replace("reject_", "");
        command = `reject ${token}`;
      } else if (customId === "investigate_failure") {
        command = "logs 5";
      } else if (customId === "view_logs") {
        command = "logs 10";
      } else if (customId.startsWith("request_changes_")) {
        const prNumber = customId.replace("request_changes_", "");
        await buttonInteraction.reply({
          content: `Changes requested on PR #${prNumber} by <@${userId}>`,
          ephemeral: false,
        });
        return;
      } else if (customId.startsWith("heal_investigate_")) {
        const project = customId.replace("heal_investigate_", "");
        command = `fix investigate-deploy ${project}`;
      } else if (customId.startsWith("heal_autofix_")) {
        const project = customId.replace("heal_autofix_", "");
        command = `fix auto-heal ${project}`;
      } else if (customId.startsWith("heal_ignore_")) {
        await buttonInteraction.reply({
          content: `\u2713 Alert acknowledged by <@${userId}>. No action taken.`,
          ephemeral: false,
        });
        return;
      }

      if (command) {
        // Acknowledge the interaction with an ephemeral confirmation
        await buttonInteraction.reply({
          content: `\u2705 Vote recorded: \`${command}\``,
          ephemeral: true,
        });

        const normalized: NormalizedMessage = {
          id: randomUUID(),
          channelType: "discord",
          channelId,
          channelUserId: userId,
          isDM: false,
          isMentioningBot: true,
          text: command,
          timestamp: new Date(),
          metadata: { channelId },
        };

        await this.messageHandler(normalized);
      }
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
      const buttons = detectButtons(response.text);
      if (buttons) {
        const row = buildActionRow(buttons);
        await channel.send({ content: response.text, components: [row] });
      } else {
        await channel.send(response.text);
      }
    }
  }

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    if (!this.client) {
      throw new Error("Discord adapter not connected. Call connect() first.");
    }

    const user = await this.client.users.fetch(userId);
    const buttons = detectButtons(response.text);
    if (buttons) {
      const row = buildActionRow(buttons);
      await user.send({ content: response.text, components: [row] });
    } else {
      await user.send(response.text);
    }
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
