/**
 * Result-translator tests — focused unit coverage for the JSON-RPC
 * `result`-to-ToolResult translation that lets the OSS bridge accept
 * the canonical MCP envelope emitted by every `@codespar/mcp-*` server.
 *
 * End-to-end coverage through a spawned child still lives in
 * `process-manager.test.ts`. These tests exercise the translator in
 * isolation so each envelope shape is asserted without depending on the
 * stdio plumbing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { translateMcpResult } from "../result-translator.js";
import { MCP_ERROR_CODES } from "../types.js";

const CTX = { serverId: "test-server", sessionId: "test-session" };

describe("translateMcpResult — canonical MCP envelope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses JSON text payload into ToolResult.data", () => {
    const result = translateMcpResult(
      {
        content: [{ type: "text", text: JSON.stringify({ a: 1, b: "two" }) }],
        isError: false,
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.error).toBe("");
    expect(result.data).toEqual({ a: 1, b: "two" });
  });

  it("returns non-JSON text verbatim as a string", () => {
    const result = translateMcpResult(
      {
        content: [{ type: "text", text: "hello world" }],
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.error).toBe("");
    expect(result.data).toBe("hello world");
  });

  it("surfaces isError: true as a failure with the error text", () => {
    const result = translateMcpResult(
      {
        content: [{ type: "text", text: "asaas: 401 Unauthorized" }],
        isError: true,
      },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBe("asaas: 401 Unauthorized");
  });

  it("first text block wins — additional blocks are discarded", () => {
    const result = translateMcpResult(
      {
        content: [
          { type: "text", text: '{"first":true}' },
          { type: "text", text: '{"second":true}' },
          { type: "image", data: "base64...", mimeType: "image/png" },
        ],
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ first: true });
  });

  it("skips non-text blocks to find the first text block", () => {
    const result = translateMcpResult(
      {
        content: [
          { type: "image", data: "base64...", mimeType: "image/png" },
          { type: "text", text: '{"ok":true}' },
        ],
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ ok: true });
  });

  it("envelope with no text blocks → unknown_response_shape with warning", () => {
    const consoleLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateMcpResult(
      {
        content: [
          { type: "image", data: "base64...", mimeType: "image/png" },
          { type: "audio", data: "base64...", mimeType: "audio/wav" },
        ],
      },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_response_shape);

    const logs = consoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("mcp envelope missing text block");
    expect(logs).toContain("test-server");
    expect(logs).toContain("test-session");
  });
});

describe("translateMcpResult — legacy bespoke shape", () => {
  it("forwards success/data/error verbatim", () => {
    const result = translateMcpResult(
      {
        success: true,
        data: { legacy: true },
        error: "",
      },
      CTX,
    );
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ legacy: true });
    expect(result.error).toBe("");
  });

  it("preserves explicit failure payload", () => {
    const result = translateMcpResult(
      {
        success: false,
        data: null,
        error: "legacy.error.code",
      },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBe("legacy.error.code");
  });
});

describe("translateMcpResult — unknown shapes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plain object without content/legacy keys → structured error + warning", () => {
    const consoleLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateMcpResult(
      { foo: "bar", baz: 1 },
      CTX,
    );
    expect(result.success).toBe(false);
    expect(result.data).toBeNull();
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_response_shape);

    const logs = consoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("mcp unknown response shape");
    expect(logs).toContain("test-server");
  });

  it("null result → structured error", () => {
    const consoleLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateMcpResult(null, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_response_shape);

    const logs = consoleLog.mock.calls.flat().join("\n");
    expect(logs).toContain("mcp unknown response shape");
  });

  it("partial legacy shape (success only) falls through to unknown", () => {
    // Guards against silent coercion — a legacy result without all of
    // success/data/error is ambiguous and must not be treated as legacy.
    const consoleLog = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = translateMcpResult({ success: true }, CTX);
    expect(result.success).toBe(false);
    expect(result.error).toBe(MCP_ERROR_CODES.unknown_response_shape);
    consoleLog.mockRestore();
  });
});
