/**
 * Slack Block Kit Formatter
 *
 * Converts plain text responses into Slack Block Kit blocks for
 * rich message rendering. Handles code blocks, status lines, and
 * regular markdown text.
 */

interface SectionBlock {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
}

interface DividerBlock {
  type: "divider";
}

type SlackBlock = SectionBlock | DividerBlock;

/**
 * Formats a plain text response into Slack Block Kit blocks.
 *
 * Recognizes three patterns:
 * - Code blocks: lines indented with spaces or containing pipe characters
 * - Status lines: lines starting with check/cross marks
 * - Regular text: everything else, rendered as mrkdwn sections
 */
export function formatSlackBlocks(text: string): SlackBlock[] {
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
