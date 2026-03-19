/**
 * Slack Block Kit Formatter
 *
 * Converts plain text responses into Slack Block Kit blocks for
 * rich message rendering. Handles code blocks, status lines,
 * approval cards, and regular markdown text.
 */

interface SectionBlock {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
  fields?: Array<{
    type: "mrkdwn";
    text: string;
  }>;
}

interface DividerBlock {
  type: "divider";
}

type SlackBlock = SectionBlock | DividerBlock;

/**
 * Detect whether a text block contains approval-related content.
 * Matches patterns like:
 *   - "Approve with: @codespar approve <token>"
 *   - "Requires X approval"
 *   - "pending_approval"
 *   - "Approval required"
 */
function isApprovalMessage(text: string): boolean {
  return (
    /approve with:/i.test(text) ||
    /requires?\s+\d*\s*approvals?/i.test(text) ||
    /pending_approval/i.test(text) ||
    /approval required/i.test(text)
  );
}

/**
 * Extract approval metadata from a text block and format it as
 * rich Block Kit blocks with fields layout.
 *
 * Parses:
 *   - Environment from "deploy to <env>" or "Environment: <env>"
 *   - Approval token from "approve <token>"
 *   - Approval counts from "0/N required" or "Requires N approval"
 */
function formatApprovalBlocks(text: string): SlackBlock[] {
  const blocks: SlackBlock[] = [];

  // Extract environment (from "deploy to staging" or "Environment: staging")
  const envMatch =
    text.match(/deploy\s+to\s+(\w+)/i) ||
    text.match(/environment:\s*(\w+)/i);
  const environment = envMatch ? envMatch[1] : "unknown";

  // Extract approval token (from "approve abc123" pattern)
  const tokenMatch = text.match(/approve\s+([a-zA-Z0-9_-]+)/);
  const token = tokenMatch ? tokenMatch[1] : null;

  // Extract approval counts (from "0/1 required" or "Approvals: 0/2")
  const countMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:required|approval)/i);
  const currentApprovals = countMatch ? countMatch[1] : "0";
  const requiredApprovals = countMatch ? countMatch[2] : "1";

  // Header
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: "\u{1F514} *Deploy Approval Required*",
    },
  });

  // Fields: environment and approvals
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: " ",
    },
    fields: [
      {
        type: "mrkdwn",
        text: `*Environment:*\n${environment}`,
      },
      {
        type: "mrkdwn",
        text: `*Approvals:*\n${currentApprovals}/${requiredApprovals} required`,
      },
    ],
  });

  // Approve instruction with token in monospace
  if (token) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Approve with: \`@codespar approve ${token}\``,
      },
    });
  }

  // Divider to separate from other content
  blocks.push({ type: "divider" });

  return blocks;
}

/**
 * Formats a plain text response into Slack Block Kit blocks.
 *
 * Recognizes these patterns:
 * - Approval messages: detected by approval keywords, formatted as rich cards
 * - Code blocks: lines indented with spaces or containing pipe characters
 * - Status lines: lines starting with check/cross marks
 * - Regular text: everything else, rendered as mrkdwn sections
 */
export function formatSlackBlocks(text: string): SlackBlock[] {
  // Check for approval messages first — they get special formatting
  if (isApprovalMessage(text)) {
    const approvalBlocks = formatApprovalBlocks(text);

    // Also include the original text below the card (as context),
    // but only lines that are NOT part of the approval instruction
    const remainingLines = text
      .split("\n")
      .filter(
        (line) =>
          !/approve with:/i.test(line) &&
          !/approval required/i.test(line) &&
          !/pending_approval/i.test(line) &&
          !/requires?\s+\d*\s*approvals?/i.test(line)
      )
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (remainingLines.length > 0) {
      approvalBlocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: remainingLines.join("\n"),
        },
      });
    }

    return approvalBlocks;
  }

  // Standard formatting for non-approval messages
  const lines = text.split("\n");
  const blocks: SlackBlock[] = [];

  let codeBuffer: string[] = [];
  let textBuffer: string[] = [];

  const flushCode = () => {
    if (codeBuffer.length === 0) return;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: "```\n" + codeBuffer.join("\n") + "\n```",
      },
    });
    codeBuffer = [];
  };

  const flushText = () => {
    if (textBuffer.length === 0) return;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: textBuffer.join("\n"),
      },
    });
    textBuffer = [];
  };

  const isCodeLine = (line: string): boolean => {
    return (line.startsWith("  ") || line.startsWith("\t") || line.includes("|")) && line.trim().length > 0;
  };

  const isStatusLine = (line: string): boolean => {
    const trimmed = line.trimStart();
    return trimmed.startsWith("\u2713") || trimmed.startsWith("\u2717") ||
           trimmed.startsWith("\u2714") || trimmed.startsWith("\u2718") ||
           trimmed.startsWith("\u2705") || trimmed.startsWith("\u274C");
  };

  for (const line of lines) {
    if (isCodeLine(line)) {
      flushText();
      codeBuffer.push(line);
    } else if (isStatusLine(line)) {
      flushCode();
      flushText();
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: line,
        },
      });
    } else if (line.trim() === "") {
      // Empty lines: flush current buffers to separate sections
      flushCode();
      flushText();
    } else {
      flushCode();
      textBuffer.push(line);
    }
  }

  // Flush any remaining buffers
  flushCode();
  flushText();

  // Slack requires at least one block
  if (blocks.length === 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: text || " ",
      },
    });
  }

  return blocks;
}
