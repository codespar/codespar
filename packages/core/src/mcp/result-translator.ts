/**
 * Translate a JSON-RPC `result` payload returned by an MCP server into
 * the SDK ToolResult contract.
 *
 * Two response shapes are accepted:
 *   1. The canonical MCP envelope (`{content: [{type, text}], isError?}`)
 *      that the official MCP SDK and every `@codespar/mcp-*` server
 *      emit. This is the post-#103 default and the only shape the
 *      bridge needs in production.
 *   2. The legacy bespoke shape (`{success, data, error}`) used by the
 *      in-tree echo fixture and any custom server written against the
 *      pre-standard pattern. Supported for one release so existing
 *      integration scripts do not break in lockstep with this fix.
 *
 * Anything else is treated as an unknown shape — we emit a sanitized
 * warning via the structured logger and surface
 * `mcp.unknown_response_shape` to the caller.
 */

import { createLogger } from "../observability/logger.js";
import { MCP_ERROR_CODES } from "./types.js";

const log = createLogger("mcp-bridge");

interface McpStandardEnvelope {
  content: Array<{ type: unknown; text?: unknown; [k: string]: unknown }>;
  isError?: boolean;
}

interface McpLegacyResult {
  success?: boolean;
  data?: unknown;
  error?: string;
}

export interface TranslatedResult {
  success: boolean;
  data: unknown;
  // `null` on success (the canonical no-error value, converging with the
  // managed runtime and `ExecuteToolResponse.error` in `@codespar/api-types`);
  // a non-empty string on failure.
  error: string | null;
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const first = trimmed[0];
  // Cheap reject — only attempt parse when the leading char could start
  // a JSON value. Keeps plain-prose text blocks fast and avoids an
  // exception per call.
  const couldBeJson =
    first === "{" ||
    first === "[" ||
    first === '"' ||
    first === "-" ||
    (first >= "0" && first <= "9") ||
    first === "t" ||
    first === "f" ||
    first === "n";
  if (!couldBeJson) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

function isStandardEnvelope(x: unknown): x is McpStandardEnvelope {
  return (
    typeof x === "object" &&
    x !== null &&
    Array.isArray((x as { content?: unknown }).content)
  );
}

function isLegacyResult(x: unknown): x is McpLegacyResult {
  // Require all three legacy fields together — anything narrower is
  // ambiguous and falls through to the unknown-shape path so we never
  // silently coerce a partial envelope.
  return (
    typeof x === "object" &&
    x !== null &&
    "success" in x &&
    "data" in x &&
    "error" in x
  );
}

function firstTextBlock(env: McpStandardEnvelope): string | null {
  // Mirror the official MCP SDK's first-text-block-wins behavior. Image,
  // audio, and resource blocks coexist in `content` but the SDK's
  // ToolResult is scalar/JSON; collapsing to the first text block keeps
  // the contract simple. Callers that need the raw envelope can bypass
  // the bridge and talk to the spawned server directly.
  for (const block of env.content) {
    if (
      block &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      return block.text;
    }
  }
  return null;
}

export function translateMcpResult(
  result: unknown,
  context: { serverId: string; sessionId: string },
): TranslatedResult {
  if (isStandardEnvelope(result)) {
    const text = firstTextBlock(result);
    if (text === null) {
      log.warn("mcp envelope missing text block", {
        serverId: context.serverId,
        sessionId: context.sessionId,
        contentTypes: result.content
          .map((b) =>
            b && typeof b === "object" && typeof b.type === "string"
              ? b.type
              : "<no-type>",
          )
          .slice(0, 8),
      });
      return {
        success: false,
        data: null,
        error: MCP_ERROR_CODES.unknown_response_shape,
      };
    }
    if (result.isError === true) {
      return { success: false, data: null, error: text };
    }
    return { success: true, data: tryParseJson(text), error: null };
  }

  if (isLegacyResult(result)) {
    // A legacy server's empty-string error means "no error" — normalize
    // it (and an absent error) to the canonical `null`, so success
    // results carry `null` regardless of which response shape produced
    // them. A non-empty legacy error string passes through unchanged.
    const legacyError = result.error ? result.error : null;
    return {
      success: result.success ?? true,
      data: result.data ?? null,
      error: legacyError,
    };
  }

  log.warn("mcp unknown response shape", {
    serverId: context.serverId,
    sessionId: context.sessionId,
    shape:
      typeof result === "object" && result !== null
        ? Object.keys(result as Record<string, unknown>).slice(0, 8)
        : typeof result,
  });
  return {
    success: false,
    data: null,
    error: MCP_ERROR_CODES.unknown_response_shape,
  };
}
