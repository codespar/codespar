/**
 * Slack Channel Adapter — First official API channel for CodeSpar.
 *
 * Implements the ChannelAdapter interface using @slack/bolt.
 * Zero ban risk (official API), validates multi-channel architecture.
 *
 * Required environment variables:
 *   SLACK_BOT_TOKEN     — xoxb-* Bot User OAuth Token
 *   SLACK_SIGNING_SECRET — Signing secret from Slack app settings
 *   SLACK_APP_TOKEN      — xapp-* token (for Socket Mode, optional)
 *   SLACK_PORT           — HTTP port for events (default: 3001)
 */

import { App } from "@slack/bolt";
import { randomUUID } from "node:crypto";

/** Subset of Slack message event fields we use. */
interface SlackMessageEvent {
  type: "message";
  subtype?: string;
  text?: string;
  user?: string;
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
}
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";
import { formatSlackBlocks } from "./formatter.js";

export class SlackAdapter implements ChannelAdapter {
  readonly type = "slack" as const;

  private app: App | null = null;
  private messageHandler: MessageHandler | null = null;
  private botUserId: string | null = null;

  async connect(): Promise<void> {
    const token = process.env.SLACK_BOT_TOKEN;
    const signingSecret = process.env.SLACK_SIGNING_SECRET;

    if (!token) {
      throw new Error("SLACK_BOT_TOKEN environment variable is required");
    }
    if (!signingSecret) {
      throw new Error("SLACK_SIGNING_SECRET environment variable is required");
    }

    const appToken = process.env.SLACK_APP_TOKEN;

    // Use Socket Mode if app token is provided, otherwise use HTTP
    this.app = new App({
      token,
      signingSecret,
      ...(appToken
        ? { socketMode: true, appToken }
        : { port: parseInt(process.env.SLACK_PORT || "3001", 10) }),
    });

    // Resolve the bot's own user ID for mention detection
    const authResult = await this.app.client.auth.test({ token });
    this.botUserId = (authResult.user_id as string) || null;

    // DMs only — handle direct messages to the bot
    this.app.message(async ({ message, say }) => {
      const msg = message as SlackMessageEvent;
      if (msg.subtype) return;
      if (!msg.text) return;

      // Only process DMs (channel @mentions handled by app_mention event)
      const isDM = msg.channel_type === "im";
      if (!isDM) return;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "slack",
        channelId: msg.channel,
        channelUserId: msg.user ?? "unknown",
        isDM: true,
        isMentioningBot: true,
        text: msg.text.trim(),
        threadId: msg.thread_ts,
        timestamp: new Date(parseFloat(msg.ts) * 1000),
      };

      if (this.messageHandler) {
        await this.messageHandler(normalized);
      } else {
        await say(`[codespar] Agent initializing. Try again in a moment.`);
      }
    });

    // Channel @mentions — handle @CodeSpar in channels
    this.app.event("app_mention", async ({ event, say }) => {
      if (!this.messageHandler) {
        await say(`[codespar] Agent initializing. Try again in a moment.`);
        return;
      }

      const cleanText = this.botUserId
        ? event.text.replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim()
        : event.text;

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "slack",
        channelId: event.channel,
        channelUserId: event.user ?? "unknown",
        isDM: false,
        isMentioningBot: true,
        text: cleanText,
        threadId: event.thread_ts,
        timestamp: new Date(parseFloat(event.ts) * 1000),
      };

      await this.messageHandler(normalized);
    });

    await this.app.start();
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.botUserId = null;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    if (!this.app) {
      throw new Error("Slack adapter not connected. Call connect() first.");
    }

    const blocks = formatSlackBlocks(response.text);

    await this.app.client.chat.postMessage({
      channel: channelId,
      text: response.text, // Fallback for notifications
      blocks,
      ...(response.threadId ? { thread_ts: response.threadId } : {}),
    });
  }

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    if (!this.app) {
      throw new Error("Slack adapter not connected. Call connect() first.");
    }

    const blocks = formatSlackBlocks(response.text);

    await this.app.client.chat.postMessage({
      channel: userId, // Slack accepts user ID to open/send to DM
      text: response.text,
      blocks,
      ...(response.threadId ? { thread_ts: response.threadId } : {}),
    });
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
    if (!this.app) return false;

    try {
      const result = await this.app.client.auth.test();
      return result.ok === true;
    } catch {
      return false;
    }
  }
}
