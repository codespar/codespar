/**
 * OSS chat loop — Claude tool-use loop wired to raw MCP via the
 * in-process bridge (`packages/core/src/mcp`).
 *
 * Two surfaces are exported:
 *
 *   `runChatLoop(message, session, opts)`       → SendResult (JSON mode)
 *   `runChatLoopStream(message, session, opts)` → AsyncIterable<StreamEvent>
 *
 * Both share `runInternal` underneath so the loop body is one
 * implementation, no fork.
 *
 * Scope (binding ADR):
 *   - OSS dispatches raw MCP tools only. No commerce meta-tool /
 *     vertical-router abstraction lives here.
 *   - No DB tool-call logging. The route returns the call records in
 *     `SendResult.tool_calls` and that's the full surface.
 *   - No quota / rate-limit.
 *   - `ANTHROPIC_BASE_URL` redirects all Anthropic calls so tests (and
 *     self-hosters running aimock or similar) can intercept without a
 *     real API key.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlock,
  MessageParam,
  TextBlock,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages.js";
import type { McpServerSpec } from "../mcp/index.js";
import { mcpBridge } from "../mcp/index.js";
import { createLogger } from "../observability/logger.js";
import type { Session } from "../storage/types.js";
import { LATAM_COMMERCE_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  buildToolCatalog,
  splitNamespacedToolName,
  type AnthropicTool,
} from "./tool-catalog.js";

/** Read inline server specs from a session — same shape `sessions.ts`
 *  uses for the `/execute` dispatch path. Stored on
 *  `metadata.serverSpecs` for HTTP (in-memory) sessions; absent for
 *  channel-bridge sessions. */
function readSessionServerSpecs(
  session: Session,
): Record<string, McpServerSpec> | undefined {
  const raw = session.metadata?.["serverSpecs"];
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, McpServerSpec>)
    : undefined;
}

const log = createLogger("chat-loop");

/** Maximum number of LLM round-trips per `send` call. Bounded so a
 *  buggy or malicious tool can't lock a session in a loop. */
export const MAX_LOOP_ITERATIONS = 8;

/** Default model — kept current with the latest stable Sonnet alias.
 *  Override via `CODESPAR_CHAT_MODEL`. */
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";
const DEFAULT_MAX_TOKENS = 4096;

/**
 * A single tool dispatch the loop performed. Returned in `SendResult.tool_calls`
 * so callers can render or audit what the agent did during this `send`.
 */
export interface ToolCallRecord {
  tool_name: string;
  server_id: string;
  status: "success" | "error";
  duration_ms: number;
  input: unknown;
  output: unknown;
  error_code?: string;
}

/** Result shape returned in JSON mode. */
export interface SendResult {
  message: string;
  tool_calls: ToolCallRecord[];
  iterations: number;
}

/** SSE event type — emitted by `runChatLoopStream`. */
export type StreamEvent =
  | { type: "user_message"; content: string }
  | { type: "assistant_text"; content: string; iteration: number }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
      iteration: number;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: unknown;
      is_error: boolean;
      iteration: number;
    }
  | { type: "done"; result: SendResult }
  | { type: "error"; message: string; iteration?: number };

/** Optional knobs for tests — never used by the route handler. */
export interface ChatLoopOptions {
  /** Override the Anthropic client. Tests inject a stub. */
  anthropicClient?: Anthropic;
  /** Override the MCP bridge surface. Tests inject a stub. */
  bridge?: Pick<typeof mcpBridge, "call" | "listTools">;
  /** Override the system prompt. Defaults to LATAM_COMMERCE_SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Override the max loop iterations. Defaults to MAX_LOOP_ITERATIONS. */
  maxIterations?: number;
  /** Override the model. Defaults to env CODESPAR_CHAT_MODEL or DEFAULT_MODEL. */
  model?: string;
  /** Override max_tokens per Anthropic call. Defaults to DEFAULT_MAX_TOKENS. */
  maxTokens?: number;
}

/** Build the default Anthropic client, honouring ANTHROPIC_BASE_URL so
 *  aimock and other test/redirect targets work without a real API key. */
export function buildDefaultAnthropicClient(): Anthropic {
  const baseURL = process.env.ANTHROPIC_BASE_URL;
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "placeholder";
  const clientOpts: ConstructorParameters<typeof Anthropic>[0] = { apiKey };
  if (baseURL && baseURL.length > 0) clientOpts.baseURL = baseURL;
  return new Anthropic(clientOpts);
}

/** Extract a flat text summary from the final assistant turn. The JSON
 *  result's `message` field is the catenation of every text block the
 *  model emitted in its last response. */
function joinAssistantText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push((block as TextBlock).text);
    }
  }
  return parts.join("");
}

/** Serialise a tool's output payload for the `tool_result` block.
 *  Anthropic accepts either a string or an array of content blocks; we
 *  pass a JSON-encoded string so a structured payload survives the
 *  round-trip without ambiguity. */
function serialiseToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

/**
 * Pull tool input as a structured-ish object. Anthropic types `input`
 * as `unknown` — the MCP bridge wants an object. When the LLM emits
 * a non-object (rare), we wrap it so the MCP server still receives a
 * valid JSON-RPC `arguments` field.
 */
function coerceToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { input };
}

interface LoopRunContext {
  message: string;
  session: Session;
  tools: AnthropicTool[];
  systemPrompt: string;
  anthropic: Anthropic;
  bridge: Pick<typeof mcpBridge, "call" | "listTools">;
  model: string;
  maxTokens: number;
  maxIterations: number;
  toolCalls: ToolCallRecord[];
  messages: MessageParam[];
  emit?: (event: StreamEvent) => void;
}

/**
 * Core loop body — drives Anthropic's tool-use machinery to fixed
 * point. Used by both the JSON and SSE entry points. Mutates `ctx`
 * (`messages`, `toolCalls`) as it iterates; returns the final
 * SendResult.
 */
async function runInternal(ctx: LoopRunContext): Promise<SendResult> {
  let finalText = "";
  let iterations = 0;

  while (iterations < ctx.maxIterations) {
    iterations += 1;
    const response = await ctx.anthropic.messages.create({
      model: ctx.model,
      max_tokens: ctx.maxTokens,
      system: ctx.systemPrompt,
      ...(ctx.tools.length > 0 ? { tools: ctx.tools as never } : {}),
      messages: ctx.messages,
    });

    const text = joinAssistantText(response.content as ContentBlock[]);
    if (text.length > 0) {
      finalText = text;
      ctx.emit?.({ type: "assistant_text", content: text, iteration: iterations });
    }

    // Append the assistant turn verbatim so subsequent turns carry the
    // tool_use blocks the API expects to see paired with tool_result.
    ctx.messages.push({
      role: "assistant",
      content: response.content as never,
    });

    if (response.stop_reason !== "tool_use") {
      // end_turn, max_tokens, stop_sequence — loop exits.
      break;
    }

    // Collect every tool_use block and dispatch them sequentially.
    // Anthropic requires every tool_use to be paired with a
    // tool_result in the next user turn, so we accumulate the
    // results first then push one user message.
    const toolUseBlocks: ToolUseBlock[] = [];
    for (const block of response.content as ContentBlock[]) {
      if (block.type === "tool_use") {
        toolUseBlocks.push(block as ToolUseBlock);
      }
    }

    if (toolUseBlocks.length === 0) {
      // stop_reason === "tool_use" but no tool_use blocks — defensive
      // break to avoid an infinite spin against an unexpected payload.
      log.warn("stop_reason=tool_use with no tool_use blocks", {
        sessionId: ctx.session.id,
        iteration: iterations,
      });
      break;
    }

    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      ctx.emit?.({
        type: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
        iteration: iterations,
      });

      const split = splitNamespacedToolName(tu.name);
      if (!split) {
        const errMessage = `unknown_tool_name: ${tu.name}`;
        ctx.toolCalls.push({
          tool_name: tu.name,
          server_id: "",
          status: "error",
          duration_ms: 0,
          input: tu.input,
          output: null,
          error_code: errMessage,
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: errMessage,
          is_error: true,
        });
        ctx.emit?.({
          type: "tool_result",
          tool_use_id: tu.id,
          content: errMessage,
          is_error: true,
          iteration: iterations,
        });
        continue;
      }

      const input = coerceToolInput(tu.input);
      const sessionSpecs = readSessionServerSpecs(ctx.session);
      const specOverride = sessionSpecs?.[split.serverId];
      const callOpts = specOverride !== undefined ? { specOverride } : undefined;
      const callResult = await ctx.bridge.call(
        ctx.session.id,
        split.serverId,
        split.toolName,
        input,
        callOpts,
      );

      const status: "success" | "error" = callResult.success ? "success" : "error";
      const record: ToolCallRecord = {
        tool_name: tu.name,
        server_id: split.serverId,
        status,
        duration_ms: callResult.duration,
        input,
        output: callResult.success ? callResult.data : { error: callResult.error },
      };
      if (!callResult.success) record.error_code = callResult.error;
      ctx.toolCalls.push(record);

      const serialised = serialiseToolOutput(record.output);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: serialised,
        is_error: !callResult.success,
      });
      ctx.emit?.({
        type: "tool_result",
        tool_use_id: tu.id,
        content: record.output,
        is_error: !callResult.success,
        iteration: iterations,
      });
    }

    ctx.messages.push({ role: "user", content: toolResults });
  }

  return {
    message: finalText,
    tool_calls: ctx.toolCalls,
    iterations,
  };
}

/**
 * JSON-mode entry point. Runs the loop to completion and returns a
 * `SendResult`. Failures (Anthropic errors, etc.) propagate as thrown
 * exceptions — the route handler translates them into a 500 response.
 */
export async function runChatLoop(
  message: string,
  session: Session,
  opts: ChatLoopOptions = {},
): Promise<SendResult> {
  const bridge = opts.bridge ?? mcpBridge;
  const anthropic = opts.anthropicClient ?? buildDefaultAnthropicClient();
  const tools = await buildToolCatalog(session, bridge);
  const ctx: LoopRunContext = {
    message,
    session,
    tools,
    systemPrompt: opts.systemPrompt ?? LATAM_COMMERCE_SYSTEM_PROMPT,
    anthropic,
    bridge,
    model: opts.model ?? process.env.CODESPAR_CHAT_MODEL ?? DEFAULT_MODEL,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    maxIterations: opts.maxIterations ?? MAX_LOOP_ITERATIONS,
    toolCalls: [],
    messages: [{ role: "user", content: message }],
  };
  return runInternal(ctx);
}

/**
 * SSE-mode entry point. Returns an async iterable of `StreamEvent`s.
 * Emits events in the documented order:
 *
 *   user_message → (assistant_text | tool_use | tool_result)* → done | error
 *
 * Terminal `done` carries the same `SendResult` JSON mode would
 * return; terminal `error` carries the failure message.
 */
export async function* runChatLoopStream(
  message: string,
  session: Session,
  opts: ChatLoopOptions = {},
): AsyncIterable<StreamEvent> {
  // Buffer events emitted from within the loop so we can yield them
  // back as they happen without needing a Promise.race / queue.
  const buffer: StreamEvent[] = [];
  type Waiter = (() => void) | null;
  let resolveWaiter: Waiter = null;
  const wake = (): void => {
    const w: Waiter = resolveWaiter;
    if (w) {
      resolveWaiter = null;
      w();
    }
  };
  const push = (event: StreamEvent): void => {
    buffer.push(event);
    wake();
  };

  // user_message goes out first, before any LLM call.
  yield { type: "user_message", content: message };

  const bridge = opts.bridge ?? mcpBridge;
  const anthropic = opts.anthropicClient ?? buildDefaultAnthropicClient();

  // Run the loop in parallel with the consumer so events flush as they
  // happen. `runPromise` resolves when the loop terminates (success or
  // failure).
  let loopError: unknown = null;
  let loopResult: SendResult | null = null;
  const runPromise = (async () => {
    try {
      const tools = await buildToolCatalog(session, bridge);
      const ctx: LoopRunContext = {
        message,
        session,
        tools,
        systemPrompt: opts.systemPrompt ?? LATAM_COMMERCE_SYSTEM_PROMPT,
        anthropic,
        bridge,
        model: opts.model ?? process.env.CODESPAR_CHAT_MODEL ?? DEFAULT_MODEL,
        maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
        maxIterations: opts.maxIterations ?? MAX_LOOP_ITERATIONS,
        toolCalls: [],
        messages: [{ role: "user", content: message }],
        emit: push,
      };
      loopResult = await runInternal(ctx);
    } catch (err) {
      loopError = err;
    } finally {
      // Wake the consumer one last time so the loop below can observe
      // termination.
      wake();
    }
  })();

  // Drain the buffer as events arrive; exit when the loop has resolved
  // AND the buffer is empty.
  let loopDone = false;
  runPromise.then(() => {
    loopDone = true;
    wake();
  });

  while (true) {
    if (buffer.length > 0) {
      const next = buffer.shift();
      if (next) yield next;
      continue;
    }
    if (loopDone) break;
    await new Promise<void>((resolve) => {
      resolveWaiter = resolve;
    });
  }

  // Make sure runPromise has fully resolved (await any pending fields).
  await runPromise;

  if (loopError) {
    const message = loopError instanceof Error ? loopError.message : String(loopError);
    yield { type: "error", message };
    return;
  }
  if (loopResult) {
    yield { type: "done", result: loopResult };
  }
}
