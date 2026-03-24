/**
 * Slack Channel Adapter -- Multi-tenant support.
 *
 * Implements the ChannelAdapter interface using @slack/bolt.
 * Supports two modes:
 *
 * 1. Legacy (single workspace): Set SLACK_BOT_TOKEN env var.
 *    Works exactly as before -- one workspace, one token.
 *
 * 2. OAuth (multi-tenant): Set SLACK_CLIENT_ID + SLACK_CLIENT_SECRET.
 *    Uses Bolt's installationStore to fetch tokens per workspace
 *    from the StorageProvider.
 *
 * Common environment variables:
 *   SLACK_SIGNING_SECRET -- Signing secret from Slack app settings
 *   SLACK_APP_TOKEN      -- xapp-* token (for Socket Mode, optional)
 *   SLACK_PORT           -- HTTP port for events (default: 3001)
 *
 * Legacy-only:
 *   SLACK_BOT_TOKEN      -- xoxb-* Bot User OAuth Token
 *
 * OAuth-only:
 *   SLACK_CLIENT_ID      -- OAuth client ID
 *   SLACK_CLIENT_SECRET  -- OAuth client secret
 *   SLACK_STATE_SECRET   -- State parameter secret (default: "codespar-slack-state")
 */

import { App } from "@slack/bolt";
import type { Installation, InstallationQuery } from "@slack/bolt";
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
  team?: string;
}
import type {
  Attachment,
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
  StorageProvider,
} from "@codespar/core";
import { formatSlackBlocks } from "./formatter.js";

/** Slack file shape attached to message/event payloads. */
interface SlackFile {
  url_private: string;
  url_private_download?: string;
  mimetype: string;
  name: string;
}

/** Extract Attachment[] from a Slack files array. */
function extractAttachments(files: SlackFile[] | undefined): Attachment[] {
  if (!files) return [];
  const attachments: Attachment[] = [];
  for (const file of files) {
    if (file.mimetype?.startsWith("image/")) {
      attachments.push({
        type: "image",
        url: file.url_private_download || file.url_private,
        mimeType: file.mimetype,
        filename: file.name,
      });
    } else {
      attachments.push({
        type: "file",
        url: file.url_private_download || file.url_private,
        mimeType: file.mimetype,
        filename: file.name,
      });
    }
  }
  return attachments;
}

export class SlackAdapter implements ChannelAdapter {
  readonly type = "slack" as const;

  private app: App | null = null;
  private messageHandler: MessageHandler | null = null;
  private botUserId: string | null = null;
  private storage: StorageProvider | null;
  private mode: "legacy" | "oauth" | null = null;
  private _lastTeamId: string | null = null;

  constructor(storage?: StorageProvider) {
    this.storage = storage ?? null;
  }

  async connect(): Promise<void> {
    const legacyToken = process.env.SLACK_BOT_TOKEN;
    const clientId = process.env.SLACK_CLIENT_ID;
    const clientSecret = process.env.SLACK_CLIENT_SECRET;

    if (legacyToken) {
      // Legacy single-workspace mode
      console.log("[slack] Starting in legacy mode (SLACK_BOT_TOKEN)");
      await this.connectLegacy(legacyToken);
    } else if (clientId && clientSecret) {
      // OAuth multi-workspace mode
      console.log("[slack] Starting in OAuth mode (multi-tenant)");
      await this.connectOAuth(clientId, clientSecret);
    } else {
      throw new Error(
        "Set SLACK_BOT_TOKEN (single workspace) or SLACK_CLIENT_ID + SLACK_CLIENT_SECRET (OAuth multi-tenant)"
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Legacy mode -- existing single-workspace behavior
  // ---------------------------------------------------------------------------

  private async connectLegacy(token: string): Promise<void> {
    this.mode = "legacy";

    const signingSecret = process.env.SLACK_SIGNING_SECRET;
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

    this.registerEventHandlers();
    await this.app.start();
  }

  // ---------------------------------------------------------------------------
  // OAuth mode -- multi-tenant via installationStore
  // ---------------------------------------------------------------------------

  private async connectOAuth(
    clientId: string,
    clientSecret: string
  ): Promise<void> {
    this.mode = "oauth";

    if (!this.storage) {
      throw new Error(
        "StorageProvider is required for OAuth mode. Pass it to the SlackAdapter constructor."
      );
    }

    const storage = this.storage;

    const installationStore = {
      storeInstallation: async (installation: Installation): Promise<void> => {
        // Called after OAuth callback -- but we already handle this in webhook-server.
        // Just log it here.
        const teamId = installation.team?.id;
        console.log(`[slack] Installation stored for team: ${teamId}`);
      },

      fetchInstallation: async (
        query: InstallationQuery<boolean>
      ): Promise<Installation> => {
        // Called on every incoming event to get the bot token
        const teamId = query.teamId;
        if (!teamId) throw new Error("No teamId in installation query");

        const stored = await storage.getSlackInstallation(teamId);
        if (!stored)
          throw new Error(`No installation found for team: ${teamId}`);

        return {
          team: { id: stored.teamId, name: stored.teamName },
          bot: {
            token: stored.botToken,
            userId: stored.botUserId,
            id: stored.appId,
            scopes: stored.scopes,
          },
        } as Installation;
      },

      deleteInstallation: async (
        query: InstallationQuery<boolean>
      ): Promise<void> => {
        const teamId = query.teamId;
        if (teamId) {
          await storage.removeSlackInstallation(teamId);
          console.log(`[slack] Installation removed for team: ${teamId}`);
        }
      },
    };

    const appToken = process.env.SLACK_APP_TOKEN;

    if (appToken) {
      // Socket Mode + OAuth: use authorize callback instead of installationStore
      // (Bolt's installationStore + socketMode combo can hang on app.start())
      console.log("[slack] Connecting via Socket Mode + OAuth authorize");
      this.app = new App({
        signingSecret: process.env.SLACK_SIGNING_SECRET || "",
        socketMode: true,
        appToken,
        authorize: async ({ teamId }) => {
          if (!teamId) throw new Error("No teamId in authorize");
          const stored = await storage.getSlackInstallation(teamId);
          if (!stored) throw new Error(`No installation for team: ${teamId}`);
          return {
            botToken: stored.botToken,
            botUserId: stored.botUserId,
            botId: stored.appId,
            teamId: stored.teamId,
          };
        },
      });
    } else {
      // HTTP mode + OAuth: use installationStore for full OAuth flow
      console.log("[slack] Connecting via HTTP + OAuth installationStore");
      this.app = new App({
        signingSecret: process.env.SLACK_SIGNING_SECRET || "",
        clientId,
        clientSecret,
        stateSecret: process.env.SLACK_STATE_SECRET || "codespar-slack-state",
        scopes: [
          "app_mentions:read",
          "chat:write",
          "channels:read",
          "files:read",
          "users:read",
        ],
        installationStore,
        port: parseInt(process.env.SLACK_PORT || "3001", 10),
      });
    }

    this.registerEventHandlers();
    await this.app.start();
    console.log("[slack] App started successfully");
  }

  // ---------------------------------------------------------------------------
  // Shared event handlers (used by both modes)
  // ---------------------------------------------------------------------------

  private registerEventHandlers(): void {
    if (!this.app) return;

    // Interactive button clicks -- approve, reject, merge, investigate, etc.
    // The regex matches all action_id prefixes used by the formatter's button builders.
    this.app.action(
      /^(approve_|reject_|review_pr_|merge_pr_|approve_merge_pr_|investigate_failure|view_logs|request_changes_)/,
      async ({ action, ack, body, client }) => {
        await ack();

        const buttonAction = action as {
          action_id: string;
          value: string;
        };
        const actionId = buttonAction.action_id;
        const value = buttonAction.value;
        const userId = body.user?.id || "unknown";
        const channelId =
          (body as Record<string, any>).channel?.id ||
          (body as Record<string, any>).container?.channel_id ||
          "";

        let command = "";

        if (actionId.startsWith("approve_merge_pr_")) {
          command = `merge PR #${value}`;
        } else if (actionId.startsWith("merge_pr_")) {
          command = `merge PR #${value}`;
        } else if (actionId.startsWith("review_pr_")) {
          command = `review PR #${value}`;
        } else if (actionId.startsWith("approve_")) {
          command = `approve ${value}`;
        } else if (actionId.startsWith("reject_")) {
          command = `reject ${value}`;
        } else if (actionId === "investigate_failure") {
          command = "logs 5";
        } else if (actionId === "view_logs") {
          command = "logs 10";
        } else if (actionId.startsWith("request_changes_")) {
          if (channelId) {
            await client.chat.postMessage({
              channel: channelId,
              text: `Changes requested on PR #${value} by <@${userId}>`,
            });
          }
          return;
        }

        if (command && this.messageHandler) {
          const normalized: NormalizedMessage = {
            id: randomUUID(),
            channelType: "slack",
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
      }
    );

    // DMs only -- handle direct messages to the bot
    this.app.message(async ({ message, say }) => {
      const msg = message as SlackMessageEvent;
      if (msg.subtype) return;
      if (!msg.text) return;

      // Only process DMs (channel @mentions handled by app_mention event)
      const isDM = msg.channel_type === "im";
      if (!isDM) return;

      const files = (msg as unknown as Record<string, unknown>).files as
        | SlackFile[]
        | undefined;
      const attachments = extractAttachments(files);

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
        attachments: attachments.length > 0 ? attachments : undefined,
      };

      if (this.messageHandler) {
        await this.messageHandler(normalized);
      } else {
        await say(`[codespar] Agent initializing. Try again in a moment.`);
      }
    });

    // Channel @mentions -- handle @CodeSpar in channels
    this.app.event("app_mention", async ({ event, say }) => {
      // Track team ID for OAuth token resolution
      const teamId = (event as unknown as Record<string, unknown>).team as string | undefined;
      if (teamId) this._lastTeamId = teamId;

      if (!this.messageHandler) {
        await say(`[codespar] Agent initializing. Try again in a moment.`);
        return;
      }

      // Resolve bot user ID: use cached value (legacy) or look up per workspace (OAuth)
      const botUserId = await this.resolveBotUserId(teamId);

      const cleanText = botUserId
        ? event.text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim()
        : event.text;

      // Use event.thread_ts if already in a thread, otherwise event.ts
      // so the response is always sent as a thread reply to the mention.
      const threadTs = event.thread_ts || event.ts;

      const files = (event as unknown as Record<string, unknown>).files as
        | SlackFile[]
        | undefined;
      const attachments = extractAttachments(files);

      // Resolve orgId from Slack team installation
      let orgId: string | undefined;
      if (teamId && this.storage) {
        const inst = await this.storage.getSlackInstallation(teamId);
        orgId = inst?.orgId || undefined;
      }

      const normalized: NormalizedMessage = {
        id: randomUUID(),
        channelType: "slack",
        channelId: event.channel,
        channelUserId: event.user ?? "unknown",
        isDM: false,
        isMentioningBot: true,
        text: cleanText,
        threadId: threadTs,
        timestamp: new Date(parseFloat(event.ts) * 1000),
        attachments: attachments.length > 0 ? attachments : undefined,
        metadata: {
          threadTs,
          channelId: event.channel,
          orgId,
        },
      };

      await this.messageHandler(normalized);
    });
  }

  /**
   * Resolve the bot user ID for mention cleaning.
   *
   * In legacy mode, it was resolved once at startup and cached on `this.botUserId`.
   * In OAuth mode, each workspace has a different bot user ID stored in the
   * installation record.
   */
  private async resolveBotUserId(
    teamId: string | undefined
  ): Promise<string | null> {
    // Legacy mode: use the cached value
    if (this.botUserId) return this.botUserId;

    // OAuth mode: look up per workspace
    if (this.storage && teamId) {
      const installation = await this.storage.getSlackInstallation(teamId);
      return installation?.botUserId || null;
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // ChannelAdapter interface
  // ---------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this.botUserId = null;
    this.mode = null;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Resolve bot token: legacy mode uses built-in token, OAuth looks up per team */
  private async resolveToken(channelId?: string): Promise<string | undefined> {
    if (this.mode === "legacy") return undefined; // app.client already has the token
    // In OAuth mode, look up the first available installation
    if (this.storage) {
      // Try to find installation — channelId doesn't give us teamId directly,
      // so we use the last known team from message context
      if (this._lastTeamId) {
        const inst = await this.storage.getSlackInstallation(this._lastTeamId);
        if (inst) return inst.botToken;
      }
    }
    return undefined;
  }

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    if (!this.app) {
      throw new Error("Slack adapter not connected. Call connect() first.");
    }

    const blocks = formatSlackBlocks(response.text);
    const token = await this.resolveToken(channelId);

    await this.app.client.chat.postMessage({
      ...(token ? { token } : {}),
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
    const token = await this.resolveToken();

    await this.app.client.chat.postMessage({
      ...(token ? { token } : {}),
      channel: userId, // Slack accepts user ID to open/send to DM
      text: response.text,
      blocks,
      ...(response.threadId ? { thread_ts: response.threadId } : {}),
    });
  }

  async sendFile(
    channelId: string,
    filename: string,
    content: string,
    threadTs?: string
  ): Promise<void> {
    if (!this.app) {
      throw new Error("Slack adapter not connected. Call connect() first.");
    }

    const args: Record<string, string> = {
      channel_id: channelId,
      filename,
      content,
    };
    if (threadTs) {
      args.thread_ts = threadTs;
    }
    await this.app.client.files.uploadV2(
      args as unknown as Parameters<typeof this.app.client.files.uploadV2>[0]
    );
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

    // In OAuth mode, app.client has no default token — check if app is running
    if (this.mode === "oauth") {
      return true; // App is started and receiving events via Socket Mode
    }

    try {
      const result = await this.app.client.auth.test();
      return result.ok === true;
    } catch {
      return false;
    }
  }
}
