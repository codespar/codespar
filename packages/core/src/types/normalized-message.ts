/**
 * Every incoming message, regardless of channel, is normalized to this
 * structure before routing to agents. The agent layer never knows which
 * channel is being used.
 */

export type ChannelType = "whatsapp" | "slack" | "telegram" | "discord" | "cli";

export interface Attachment {
  type: "image" | "file" | "audio" | "video";
  url: string;
  mimeType?: string;
  filename?: string;
}

export interface NormalizedMessage {
  /** Unique message ID */
  id: string;

  /** Source channel */
  channelType: ChannelType;

  /** Group/channel identifier */
  channelId: string;

  /** User ID in that channel */
  channelUserId: string;

  /** True if direct message (not group) */
  isDM: boolean;

  /** True if @mention detected */
  isMentioningBot: boolean;

  /** Text content after @mention removal */
  text: string;

  /** If replying to a bot/agent message */
  replyToMessageId?: string;

  /** Thread ID (Slack/Discord) */
  threadId?: string;

  /** Attached files, images, voice messages */
  attachments?: Attachment[];

  /** Message timestamp */
  timestamp: Date;

  /** Channel-specific metadata (e.g., Slack threadTs, channelId) */
  metadata?: Record<string, unknown>;
}
