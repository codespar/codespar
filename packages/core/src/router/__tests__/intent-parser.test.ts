import { describe, it, expect, vi } from "vitest";

/**
 * Mock the NLU parser so parseIntent never makes API calls.
 * This lets us test the regex-only path deterministically.
 */
vi.mock("../nlu-parser.js", () => ({
  parseWithNLU: vi.fn().mockResolvedValue(null),
}));

import { parseIntent } from "../intent-parser.js";

describe("Intent Parser — regex classification", () => {
  // ── status ──────────────────────────────────────────────────────
  it('parses "status" → status with target "all"', async () => {
    const result = await parseIntent("status");
    expect(result.type).toBe("status");
    expect(result.params.target).toBe("all");
    expect(result.confidence).toBe(1.0);
  });

  it('parses "status build" → status with target "build"', async () => {
    const result = await parseIntent("status build");
    expect(result.type).toBe("status");
    expect(result.params.target).toBe("build");
  });

  it('parses "status agent" → status with target "agent"', async () => {
    const result = await parseIntent("status agent");
    expect(result.type).toBe("status");
    expect(result.params.target).toBe("agent");
  });

  // ── help ────────────────────────────────────────────────────────
  it('parses "help" → help', async () => {
    const result = await parseIntent("help");
    expect(result.type).toBe("help");
    expect(result.params).toEqual({});
  });

  // ── logs ────────────────────────────────────────────────────────
  it('parses "logs" → logs with default count 10', async () => {
    const result = await parseIntent("logs");
    expect(result.type).toBe("logs");
    expect(result.params.count).toBe("10");
  });

  it('parses "logs 20" → logs with count 20', async () => {
    const result = await parseIntent("logs 20");
    expect(result.type).toBe("logs");
    expect(result.params.count).toBe("20");
  });

  // ── instruct ───────────────────────────────────────────────────
  it('parses "instruct add a health check" → instruct', async () => {
    const result = await parseIntent("instruct add a health check");
    expect(result.type).toBe("instruct");
    expect(result.params.instruction).toBe("add a health check");
  });

  // ── fix ─────────────────────────────────────────────────────────
  it('parses "fix the auth bug" → fix', async () => {
    const result = await parseIntent("fix the auth bug");
    expect(result.type).toBe("fix");
    expect(result.params.issue).toBe("the auth bug");
  });

  // ── deploy ──────────────────────────────────────────────────────
  it('parses "deploy" → deploy with default environment staging', async () => {
    const result = await parseIntent("deploy");
    expect(result.type).toBe("deploy");
    expect(result.params.environment).toBe("staging");
  });

  it('parses "deploy production" → deploy with environment production', async () => {
    const result = await parseIntent("deploy production");
    expect(result.type).toBe("deploy");
    expect(result.params.environment).toBe("production");
  });

  // ── rollback ────────────────────────────────────────────────────
  it('parses "rollback staging" → rollback', async () => {
    const result = await parseIntent("rollback staging");
    expect(result.type).toBe("rollback");
    expect(result.params.environment).toBe("staging");
  });

  it('parses "rollback" → rollback with default staging', async () => {
    const result = await parseIntent("rollback");
    expect(result.type).toBe("rollback");
    expect(result.params.environment).toBe("staging");
  });

  // ── approve ─────────────────────────────────────────────────────
  it('parses "approve abc123" → approve with token', async () => {
    const result = await parseIntent("approve abc123");
    expect(result.type).toBe("approve");
    expect(result.params.token).toBe("abc123");
  });

  // ── autonomy ────────────────────────────────────────────────────
  it('parses "autonomy L3" → autonomy with level 3', async () => {
    const result = await parseIntent("autonomy L3");
    expect(result.type).toBe("autonomy");
    expect(result.params.level).toBe("3");
  });

  it('parses "autonomy 5" → autonomy with level 5', async () => {
    const result = await parseIntent("autonomy 5");
    expect(result.type).toBe("autonomy");
    expect(result.params.level).toBe("5");
  });

  // ── review ──────────────────────────────────────────────────────
  it('parses "review PR #42" → review with prNumber 42', async () => {
    const result = await parseIntent("review PR #42");
    expect(result.type).toBe("review");
    expect(result.params.prNumber).toBe("42");
  });

  it('parses "review PR 7" → review with prNumber 7', async () => {
    const result = await parseIntent("review PR 7");
    expect(result.type).toBe("review");
    expect(result.params.prNumber).toBe("7");
  });

  // ── prs ─────────────────────────────────────────────────────────
  it('parses "prs" → prs with default state open', async () => {
    const result = await parseIntent("prs");
    expect(result.type).toBe("prs");
    expect(result.params.state).toBe("open");
  });

  it('parses "prs closed" → prs with state closed', async () => {
    const result = await parseIntent("prs closed");
    expect(result.type).toBe("prs");
    expect(result.params.state).toBe("closed");
  });

  // ── link ────────────────────────────────────────────────────────
  it('parses "link owner/repo" → link with repo', async () => {
    const result = await parseIntent("link owner/repo");
    expect(result.type).toBe("link");
    expect(result.params.repo).toBe("owner/repo");
  });

  it('parses "link https://github.com/owner/repo" → link with URL', async () => {
    const result = await parseIntent("link https://github.com/owner/repo");
    expect(result.type).toBe("link");
    expect(result.params.repo).toBe("https://github.com/owner/repo");
  });

  // ── unlink ──────────────────────────────────────────────────────
  it('parses "unlink" → unlink', async () => {
    const result = await parseIntent("unlink");
    expect(result.type).toBe("unlink");
  });

  // ── kill ────────────────────────────────────────────────────────
  it('parses "kill" → kill', async () => {
    const result = await parseIntent("kill");
    expect(result.type).toBe("kill");
  });

  // ── whoami ──────────────────────────────────────────────────────
  it('parses "whoami" → whoami', async () => {
    const result = await parseIntent("whoami");
    expect(result.type).toBe("whoami");
  });

  // ── register ────────────────────────────────────────────────────
  it('parses "register John" → register with name', async () => {
    const result = await parseIntent("register John");
    expect(result.type).toBe("register");
    expect(result.params.name).toBe("John");
  });

  // ── unknown ─────────────────────────────────────────────────────
  it('parses "random gibberish" → unknown', async () => {
    const result = await parseIntent("random gibberish");
    expect(result.type).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  // ── edge cases ──────────────────────────────────────────────────
  it("handles leading/trailing whitespace", async () => {
    const result = await parseIntent("  status  ");
    expect(result.type).toBe("status");
  });

  it("is case-insensitive", async () => {
    const result = await parseIntent("DEPLOY PRODUCTION");
    expect(result.type).toBe("deploy");
    expect(result.params.environment).toBe("PRODUCTION");
  });

  it("preserves rawText", async () => {
    const result = await parseIntent("fix the tests");
    expect(result.rawText).toBe("fix the tests");
  });

  it("assigns correct risk levels", async () => {
    const status = await parseIntent("status");
    expect(status.risk).toBe("low");

    const deploy = await parseIntent("deploy");
    expect(deploy.risk).toBe("high");

    const kill = await parseIntent("kill");
    expect(kill.risk).toBe("critical");

    const instruct = await parseIntent("instruct do something");
    expect(instruct.risk).toBe("medium");
  });
});
