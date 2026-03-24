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

interface ButtonElement {
  type: "button";
  text: { type: "plain_text"; text: string };
  action_id: string;
  value?: string;
  style?: "primary" | "danger";
  url?: string;
}

interface ActionsBlock {
  type: "actions";
  elements: ButtonElement[];
}

type SlackBlock = SectionBlock | DividerBlock | ActionsBlock;

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

// ---------------------------------------------------------------------------
// Interactive button builders for specific message patterns
// ---------------------------------------------------------------------------

/**
 * Build approval blocks with Approve/Reject action buttons.
 * Extracts the approval token from the message text so button clicks
 * can route to the correct approval flow.
 */
function buildApprovalButtons(text: string): SlackBlock[] {
  const tokenMatch = text.match(/(?:Token|token|approve)\s*:?\s*([a-z]{2}-[a-zA-Z0-9]+)/);
  const token = tokenMatch ? tokenMatch[1] : "";

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text },
    },
  ];

  if (token) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "\u2713 Approve" },
          style: "primary",
          action_id: `approve_${token}`,
          value: token,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `reject_${token}`,
          value: token,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Build blocks for PR-created messages with Review, Merge, and
 * (optionally) a "View on GitHub" link button.
 */
function buildPRCreatedBlocks(text: string): SlackBlock[] {
  const prMatch = text.match(/PR #(\d+)/);
  const prNumber = prMatch ? prMatch[1] : "";
  const urlMatch = text.match(/(https:\/\/github\.com\/[^\s]+)/);
  const prUrl = urlMatch ? urlMatch[1] : "";

  const elements: ButtonElement[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "\uD83D\uDCDD Review PR" },
      action_id: `review_pr_${prNumber}`,
      value: prNumber,
    },
    {
      type: "button",
      text: { type: "plain_text", text: "\u2713 Merge" },
      style: "primary",
      action_id: `merge_pr_${prNumber}`,
      value: prNumber,
    },
  ];

  if (prUrl) {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "View on GitHub" },
      url: prUrl,
      action_id: `view_pr_${prNumber}`,
    });
  }

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    { type: "actions", elements },
  ];
}

/**
 * Build blocks for build-failure messages with Investigate and View Logs buttons.
 */
function buildBuildFailureBlocks(text: string): SlackBlock[] {
  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "\uD83D\uDD0D Investigate" },
          action_id: "investigate_failure",
          value: "investigate",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "\uD83D\uDCCB View Logs" },
          action_id: "view_logs",
          value: "logs",
        },
      ],
    },
  ];
}

/**
 * Build blocks for PR review results (with Risk level) with
 * Approve & Merge and Request Changes buttons.
 */
function buildPRReviewBlocks(text: string): SlackBlock[] {
  const prMatch = text.match(/PR #(\d+)/);
  const prNumber = prMatch ? prMatch[1] : "";

  return [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "\u2713 Approve & Merge" },
          style: "primary",
          action_id: `approve_merge_pr_${prNumber}`,
          value: prNumber,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Request Changes" },
          action_id: `request_changes_pr_${prNumber}`,
          value: prNumber,
        },
      ],
    },
  ];
}

/**
 * Build blocks for deploy failure analysis (smart alert) with
 * Investigate, Auto-fix, and Ignore buttons.
 */
function buildDeployAlertBlocks(text: string): SlackBlock[] {
  // Extract project name from "**Project:** <name>" or "Project: <name>"
  const projectMatch = text.match(/\*?\*?Project:?\*?\*?\s*(\S+)/);
  const project = projectMatch ? projectMatch[1] : "unknown";

  // Extract root cause
  const rootCauseMatch = text.match(/\*?\*?Root [Cc]ause:?\*?\*?\s*(.+)/);
  const rootCause = rootCauseMatch ? rootCauseMatch[1].trim() : "Unknown";

  // Extract branch
  const branchMatch = text.match(/\*?\*?Branch:?\*?\*?\s*(\S+)/);
  const branch = branchMatch ? branchMatch[1].trim() : "unknown";

  // Extract commit
  const commitMatch = text.match(/\*?\*?Commit:?\*?\*?\s*(.+)/);
  const commit = commitMatch ? commitMatch[1].trim() : "unknown";

  // Extract suggested fix
  const fixMatch = text.match(/\*?\*?Suggested [Ff]ix:?\*?\*?\s*(.+)/);
  const suggestedFix = fixMatch ? fixMatch[1].trim() : "Review logs manually";

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\u{1F6A8} *Deploy Failure Analysis — ${project}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: " ",
      },
      fields: [
        { type: "mrkdwn", text: `*Root Cause:*\n${rootCause}` },
        { type: "mrkdwn", text: `*Branch:*\n${branch}` },
        { type: "mrkdwn", text: `*Commit:*\n${commit}` },
      ],
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Suggested Fix:*\n${suggestedFix}`,
      },
    },
    { type: "divider" },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "\uD83D\uDD0D Investigate" },
          action_id: "heal_investigate",
          value: project,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "\uD83D\uDD27 Auto-fix" },
          style: "primary",
          action_id: "heal_autofix",
          value: project,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "\u2713 Ignore" },
          action_id: "heal_ignore",
          value: project,
        },
      ],
    },
  ];

  return blocks;
}

/**
 * Detect whether the message text matches a pattern that should
 * include interactive action buttons.
 *
 * Returns the appropriate Block Kit blocks with buttons, or null
 * if no interactive pattern is detected.
 */
function detectInteractiveBlocks(text: string): SlackBlock[] | null {
  // Smart deploy failure analysis (self-healing alerts)
  if (text.includes("Deploy Failure Analysis")) {
    return buildDeployAlertBlocks(text);
  }
  // Deploy approval requests
  if (
    (text.includes("Deploy") && text.includes("approval")) ||
    text.includes("Waiting approval")
  ) {
    return buildApprovalButtons(text);
  }

  // PR creation notifications
  if (text.includes("PR #") && text.includes("created")) {
    return buildPRCreatedBlocks(text);
  }

  // Build failure alerts
  if (
    text.includes("Build") &&
    (text.includes("failed") || text.includes("broken") || text.includes("failure"))
  ) {
    return buildBuildFailureBlocks(text);
  }

  // PR review results with risk assessment
  if (text.includes("Review") && text.includes("Risk:")) {
    return buildPRReviewBlocks(text);
  }

  return null;
}

/**
 * Formats a plain text response into Slack Block Kit blocks.
 *
 * Recognizes these patterns:
 * - Interactive messages: deploy approvals, PR created, build failures,
 *   PR reviews -- formatted with action buttons
 * - Approval messages: detected by approval keywords, formatted as rich cards
 * - Code blocks: lines indented with spaces or containing pipe characters
 * - Status lines: lines starting with check/cross marks
 * - Regular text: everything else, rendered as mrkdwn sections
 */
export function formatSlackBlocks(text: string): SlackBlock[] {
  // Check for interactive message patterns (buttons for approve/reject/merge etc.)
  const interactiveBlocks = detectInteractiveBlocks(text);
  if (interactiveBlocks) {
    return interactiveBlocks;
  }

  // Check for approval messages first -- they get special formatting
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
