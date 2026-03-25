import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaudeBridge } from "../claude-bridge.js";
import type { ExecutionRequest } from "../claude-bridge.js";

// ── Mock logger and metrics to avoid side effects ─────────────────
vi.mock("../../observability/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../observability/metrics.js", () => ({
  metrics: {
    increment: vi.fn(),
    observe: vi.fn(),
  },
}));

vi.mock("../../github/index.js", () => ({
  GitHubClient: vi.fn().mockImplementation(() => ({
    isConfigured: vi.fn().mockReturnValue(false),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────
function makeRequest(overrides?: Partial<ExecutionRequest>): ExecutionRequest {
  return {
    taskId: "task-test-1",
    instruction: "Add a health check endpoint",
    workDir: "/tmp/test",
    timeout: 5000,
    ...overrides,
  };
}

describe("ClaudeBridge", () => {
  let bridge: ClaudeBridge;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new ClaudeBridge();
    // Clear API key by default (simulate mode)
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── isAvailable ───────────────────────────────────────────────
  describe("isAvailable", () => {
    it("returns false when ANTHROPIC_API_KEY is not set", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const available = await bridge.isAvailable();
      expect(available).toBe(false);
    });

    it("returns true when ANTHROPIC_API_KEY is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-key-123";
      const available = await bridge.isAvailable();
      expect(available).toBe(true);
    });

    it("returns false for empty string API key", async () => {
      process.env.ANTHROPIC_API_KEY = "";
      const available = await bridge.isAvailable();
      expect(available).toBe(false);
    });
  });

  // ── simulate (no API key) ─────────────────────────────────────
  describe("simulate (no API key)", () => {
    it("returns a simulated result when no API key is set", async () => {
      const request = makeRequest();
      const result = await bridge.execute(request);

      expect(result.simulated).toBe(true);
      expect(result.status).toBe("completed");
      expect(result.taskId).toBe("task-test-1");
      expect(result.output).toContain("[simulated]");
      expect(result.output).toContain("Add a health check endpoint");
    });

    it("simulated result has a positive duration", async () => {
      const result = await bridge.execute(makeRequest());
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it("simulated result has exitCode null", async () => {
      const result = await bridge.execute(makeRequest());
      expect(result.exitCode).toBeNull();
    });
  });

  // ── execute (with API key — mock fetch) ───────────────────────
  describe("execute (with mocked API)", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "sk-test-key-123";
    });

    it("returns completed result on successful API response", async () => {
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: [{ text: "Here is your health check implementation..." }],
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await bridge.execute(makeRequest());

      expect(result.status).toBe("completed");
      expect(result.simulated).toBe(false);
      expect(result.output).toContain("health check");
      expect(result.exitCode).toBe(0);
    });

    it("returns failed result on API error response", async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue("Rate limited"),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await bridge.execute(makeRequest());

      expect(result.status).toBe("failed");
      expect(result.output).toContain("API error: 429");
    });

    it("returns timeout status on timeout error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("The operation was aborted due to timeout")),
      );

      const result = await bridge.execute(makeRequest());

      expect(result.status).toBe("timeout");
      expect(result.output).toContain("timeout");
    });

    it("returns failed status on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("fetch failed")),
      );

      const result = await bridge.execute(makeRequest());

      expect(result.status).toBe("failed");
      expect(result.output).toContain("fetch failed");
    });

    it("includes project context in the API request when provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: [{ text: "Done" }],
          usage: { input_tokens: 50, output_tokens: 20 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await bridge.execute(makeRequest({ projectContext: "my-api" }));

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages[0].content).toContain("Project: my-api");
    });

    it("truncates output to 3000 characters", async () => {
      const longOutput = "x".repeat(5000);
      const mockResponse = {
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: [{ text: longOutput }],
          usage: { input_tokens: 100, output_tokens: 5000 },
        }),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await bridge.execute(makeRequest());

      expect(result.output.length).toBeLessThanOrEqual(3000);
    });
  });

  // ── executeStreaming ──────────────────────────────────────────
  describe("executeStreaming", () => {
    it("falls back to simulate when no API key", async () => {
      delete process.env.ANTHROPIC_API_KEY;
      const chunks: string[] = [];
      const result = await bridge.executeStreaming(makeRequest(), (text) => chunks.push(text));

      expect(result.simulated).toBe(true);
      expect(result.status).toBe("completed");
    });

    it("returns failed on API error", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test-key-123";
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("Internal error"),
      };
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const chunks: string[] = [];
      const result = await bridge.executeStreaming(makeRequest(), (text) => chunks.push(text));

      expect(result.status).toBe("failed");
      expect(result.output).toContain("API error: 500");
    });
  });

  // ── buildUserContent (text only vs. with images) ──────────────
  describe("buildUserContent (via execute)", () => {
    beforeEach(() => {
      process.env.ANTHROPIC_API_KEY = "sk-test-key-123";
    });

    it("sends plain text when no images are provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          content: [{ text: "Done" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await bridge.execute(makeRequest());

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      // Without images, content should be a plain string
      expect(typeof body.messages[0].content).toBe("string");
    });

    it("sends array content when images are provided (even if download fails)", async () => {
      // The image fetch will fail, so it falls back to plain text
      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url.includes("anthropic.com")) {
          return Promise.resolve({
            ok: true,
            json: vi.fn().mockResolvedValue({
              content: [{ text: "Done" }],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
          });
        }
        // Image download fails
        return Promise.reject(new Error("Image not found"));
      });
      vi.stubGlobal("fetch", fetchMock);

      await bridge.execute(
        makeRequest({
          imageUrls: [{ url: "https://example.com/screenshot.png", mimeType: "image/png" }],
        }),
      );

      const body = JSON.parse(fetchMock.mock.calls.at(-1)![1].body);
      // Falls back to string since image download failed
      expect(typeof body.messages[0].content).toBe("string");
    });
  });
});
