/**
 * WhatsApp Channel Adapter — First-class WhatsApp channel for CodeSpar.
 *
 * Implements the ChannelAdapter interface using Baileys (no Business API).
 * Uses multi-device protocol via QR code authentication.
 *
 * Environment variables:
 *   WHATSAPP_AUTH_DIR        — Directory for session persistence (default: ./auth_info)
 *   WHATSAPP_BOT_MENTION     — Mention trigger pattern (default: @codespar)
 *   WHATSAPP_MAX_RECONNECTS  — Max reconnection attempts (default: 5)
 *   WHATSAPP_LOG_LEVEL       — Pino log level for Baileys (default: silent)
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import * as qrcode from "qrcode-terminal";
import { randomUUID } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelResponse,
  MessageHandler,
  NormalizedMessage,
} from "@codespar/core";
import { AntiBan } from "./anti-ban.js";

export class WhatsAppAdapter implements ChannelAdapter {
  readonly type = "whatsapp" as const;

  private sock: WASocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private reconnectAttempts = 0;
  private readonly antiBan = new AntiBan();

  private get authDir(): string {
    return process.env.WHATSAPP_AUTH_DIR || "./auth_info";
  }

  private get botMention(): string {
    return process.env.WHATSAPP_BOT_MENTION || "@codespar";
  }

  private get maxReconnects(): number {
    return parseInt(process.env.WHATSAPP_MAX_RECONNECTS || "5", 10);
  }

  private get logLevel(): string {
    return process.env.WHATSAPP_LOG_LEVEL || "silent";
  }

  // ---------------------------------------------------------------------------
  // connect()
  // ---------------------------------------------------------------------------

  async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

    const logger = pino({ level: this.logLevel });

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: false, // We handle QR rendering ourselves
      logger: logger as never, // Baileys accepts a pino instance
    });

    // --- Connection lifecycle ------------------------------------------------

    this.sock.ev.on(
      "connection.update",
      (update: BaileysEventMap["connection.update"]) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          qrcode.generate(qr, { small: true });
          console.log("[whatsapp] Scan the QR code above to connect.");
        }

        if (connection === "open") {
          this.reconnectAttempts = 0;
          console.log("[whatsapp] WhatsApp connected");
        }

        if (connection === "close") {
          const statusCode =
            (lastDisconnect?.error as Boom)?.output?.statusCode ?? 0;
          const loggedOut = statusCode === DisconnectReason.loggedOut;

          if (loggedOut) {
            console.log(
              "[whatsapp] Logged out. Delete auth directory and re-scan."
            );
            return;
          }

          if (this.reconnectAttempts < this.maxReconnects) {
            this.reconnectAttempts++;
            const backoffMs = Math.min(
              1000 * Math.pow(2, this.reconnectAttempts),
              30_000
            );
            console.log(
              `[whatsapp] Connection closed. Reconnecting in ${backoffMs}ms (attempt ${this.reconnectAttempts}/${this.maxReconnects})...`
            );
            setTimeout(() => {
              void this.connect();
            }, backoffMs);
          } else {
            console.error(
              "[whatsapp] Max reconnection attempts reached. Giving up."
            );
          }
        }
      }
    );

    // --- Credential persistence ----------------------------------------------

    this.sock.ev.on("creds.update", saveCreds);

    // --- Incoming messages ---------------------------------------------------

    this.sock.ev.on(
      "messages.upsert",
      (upsert: BaileysEventMap["messages.upsert"]) => {
        if (!this.messageHandler) return;

        for (const msg of upsert.messages) {
          // Skip our own messages
          if (msg.key.fromMe) continue;

          // Skip non-text messages (status updates, receipts, etc.)
          if (!msg.message) continue;

          const remoteJid = msg.key.remoteJid;
          if (!remoteJid) continue;

          // Extract text content
          const rawText =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            "";

          if (!rawText) continue;

          const isDM = !remoteJid.endsWith("@g.us");
          const mentionPattern = this.botMention.toLowerCase();
          const isMentioningBot = rawText.toLowerCase().includes(mentionPattern);

          // In groups, only process messages that mention the bot
          if (!isDM && !isMentioningBot) continue;

          // Strip the @mention from the text
          const cleanText = rawText
            .replace(new RegExp(mentionPattern, "gi"), "")
            .trim();

          const normalized: NormalizedMessage = {
            id: msg.key.id || randomUUID(),
            channelType: "whatsapp",
            channelId: remoteJid,
            channelUserId: msg.key.participant || remoteJid,
            isDM,
            isMentioningBot: isDM || isMentioningBot,
            text: cleanText,
            timestamp: new Date((msg.messageTimestamp as number) * 1000),
          };

          void this.messageHandler(normalized);
        }
      }
    );
  }

  // ---------------------------------------------------------------------------
  // disconnect()
  // ---------------------------------------------------------------------------

  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.reconnectAttempts = 0;
  }

  // ---------------------------------------------------------------------------
  // onMessage()
  // ---------------------------------------------------------------------------

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  // ---------------------------------------------------------------------------
  // sendToChannel() — send to group or individual chat
  // ---------------------------------------------------------------------------

  async sendToChannel(
    channelId: string,
    response: ChannelResponse
  ): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not connected. Call connect() first.");
    }

    if (!this.antiBan.canSend()) {
      console.warn("[whatsapp] Rate limit reached. Message deferred.");
      return;
    }

    await this.antiBan.simulateTyping(this.sock, channelId);
    await this.antiBan.randomDelay();
    await this.sock.sendMessage(channelId, { text: response.text });
    this.antiBan.recordSend();
  }

  // ---------------------------------------------------------------------------
  // sendDM() — send private message to a user
  // ---------------------------------------------------------------------------

  async sendDM(userId: string, response: ChannelResponse): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not connected. Call connect() first.");
    }

    if (!this.antiBan.canSend()) {
      console.warn("[whatsapp] Rate limit reached. DM deferred.");
      return;
    }

    await this.antiBan.simulateTyping(this.sock, userId);
    await this.antiBan.randomDelay();
    await this.sock.sendMessage(userId, { text: response.text });
    this.antiBan.recordSend();
  }

  // ---------------------------------------------------------------------------
  // getCapabilities()
  // ---------------------------------------------------------------------------

  getCapabilities(): ChannelCapabilities {
    return {
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: true,
    };
  }

  // ---------------------------------------------------------------------------
  // healthCheck()
  // ---------------------------------------------------------------------------

  async healthCheck(): Promise<boolean> {
    if (!this.sock) return false;

    try {
      // The socket user object is populated when connected
      return this.sock.user !== undefined && this.sock.user !== null;
    } catch {
      return false;
    }
  }
}
