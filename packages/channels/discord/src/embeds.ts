/**
 * Discord Embed Formatter
 *
 * Converts plain text agent responses into structured Discord embeds.
 * Color-codes messages by type: status (green), error (red), default (blue).
 */

import { EmbedBuilder } from "discord.js";

/** Default embed colors by message type. */
const COLORS = {
  success: 0x1a8c47, // Green — status/success messages
  error: 0xd95c15, // Orange-red — error messages
  default: 0x2558d9, // Blue — default/info messages
} as const;

/**
 * Parses a plain text agent response into a structured Discord embed.
 *
 * Detection rules:
 * - Lines starting with check marks → green (success) embed
 * - Lines starting with cross marks or "error"/"fail" → red (error) embed
 * - Everything else → blue (default) embed
 */
export function formatEmbed(text: string, color?: string): EmbedBuilder {
  const embed = new EmbedBuilder();

  // Determine color from content if not explicitly provided
  let resolvedColor: number;
  if (color) {
    resolvedColor = parseInt(color.replace("#", ""), 16);
  } else {
    resolvedColor = detectColor(text);
  }

  embed.setColor(resolvedColor);
  embed.setDescription(text);

  return embed;
}

/** Detect the appropriate embed color based on message content. */
function detectColor(text: string): number {
  const firstLine = text.trimStart().split("\n")[0] ?? "";
  const lower = firstLine.toLowerCase();

  // Status/success indicators
  const successPatterns = ["\u2713", "\u2714", "\u2705", "success", "done", "complete"];
  if (successPatterns.some((p) => lower.includes(p))) {
    return COLORS.success;
  }

  // Error/failure indicators
  const errorPatterns = ["\u2717", "\u2718", "\u274c", "error", "fail", "denied"];
  if (errorPatterns.some((p) => lower.includes(p))) {
    return COLORS.error;
  }

  return COLORS.default;
}
