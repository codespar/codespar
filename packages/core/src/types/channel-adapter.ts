/**
 * The core abstraction. Every channel implements this interface.
 * The agent layer never knows which channel is being used.
 */

import type { NormalizedMessage, ChannelType } from "./normalized-message.js";

export interface ChannelCapabilities {
  threads: boolean;
  buttons: boolean;
  modals: boolean;
  messageEdit: boolean;
  ephemeral: boolean;
  reactions: boolean;
}

export interface ChannelResponse {
  text: string;
  replyToMessageId?: string;
  threadId?: string;
}

export type MessageHandler = (message: NormalizedMessage) => Promise<void>;

export interface ChannelAdapter {
  /** Channel type identifier */
  readonly type: ChannelType;

  /** Establish connection to platform (QR, OAuth, token) */
  connect(): Promise<void>;

  /** Graceful shutdown */
  disconnect(): Promise<void>;

  /** Register message handler — receives NormalizedMessage */
  onMessage(handler: MessageHandler): void;

  /** Send to group/channel */
  sendToChannel(channelId: string, response: ChannelResponse): Promise<void>;

  /** Send private message (for approval escalation) */
  sendDM(userId: string, response: ChannelResponse): Promise<void>;

  /** Return channel features */
  getCapabilities(): ChannelCapabilities;

  /** Verify connection alive */
  healthCheck(): Promise<boolean>;
}
