/**
 * BLOCKER oss-sdk#1 regression guard.
 *
 * The MIT runtime must not phone home. README.md promises "no phone-home,
 * fully operable without codespar infrastructure" (README.md:39, :358).
 *
 * Two guards, because the first one alone is not enough:
 *
 * 1. STATIC — no shipped file may carry a CodeSpar (or railway.app) host as a
 *    URL. The first version of this test matched one exact string in
 *    packages/**\/*.ts, which stayed green while four
 *    `process.env.DASHBOARD_URL || "https://codespar.dev"` defaults sat in
 *    oauth-github.ts. It now matches any codespar / railway.app URL, over the
 *    whole repo, across .ts/.mjs/.js/.json/.yml/.yaml/Dockerfile.
 *
 * 2. BEHAVIOURAL — the value the runtime actually writes into a third party
 *    must come from the operator's configuration, and must not be steerable by
 *    request headers. Replacing a CodeSpar constant with a caller-controlled
 *    x-forwarded-host would be a worse bug than the one being fixed: it turns
 *    a fixed phone-home into an arbitrary one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Importing the server drags in chat-loop -> @anthropic-ai/sdk, which is
// unrelated to anything asserted here and is not installed in every dev
// environment. Stub it so this guard runs everywhere. Nothing below calls it.
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));

import { WebhookServer } from "../webhook-server.js";
import { GitHubClient } from "../../github/github-client.js";
import type { StorageProvider } from "../../storage/types.js";

// ── 1. Static scan ───────────────────────────────────────────────────

/** Historical default. It has no legitimate use anywhere, in any form. */
const FORBIDDEN_LITERAL = "codespar-production.up.railway.app";

/** Any absolute URL. Trailing punctuation is trimmed below. */
const URL_RE = /https?:\/\/[^\s"'`<>)\\]+/g;

/** A URL is suspect when it names us, or the PaaS our own deploy lives on. */
const SUSPECT_RE = /codespar|railway\.app/i;

/**
 * Hosts that may legitimately appear with "codespar" or "railway" in the URL.
 * Each entry is a third party's address, never our own infrastructure:
 *   github.com / raw.githubusercontent.com — source repo paths such as
 *     "https://github.com/codespar/codespar" in help text.
 *   registry.npmjs.org — package-lock.json resolution of our published SDK.
 *   backboard.railway.app — Railway's public GraphQL API, called only when the
 *     operator sets RAILWAY_API_TOKEN (routes/observability.ts).
 */
const ALLOWED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
  "backboard.railway.app",
]);

const SCANNED_EXTENSIONS = [".ts", ".mjs", ".js", ".json", ".yml", ".yaml"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".git",
  ".next",
  ".vercel",
  ".codespar",
  "coverage",
]);

// This file lives at packages/core/src/server/__tests__/ — five levels down.
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");

function isScanned(entry: string): boolean {
  if (entry.startsWith("Dockerfile")) return true;
  if (entry.endsWith(".d.ts")) return false;
  return SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext));
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectFiles(full, acc);
    } else if (isScanned(entry)) {
      // Skip this guard itself: it names the forbidden host on purpose.
      if (full.endsWith("no-phone-home.test.ts")) continue;
      acc.push(full);
    }
  }
  return acc;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function offendingUrls(src: string): string[] {
  const out: string[] = [];
  for (const raw of src.match(URL_RE) ?? []) {
    const url = raw.replace(/[.,;:!?]+$/, "");
    if (!SUSPECT_RE.test(url)) continue;
    const host = hostOf(url);
    if (host && ALLOWED_HOSTS.has(host)) continue;
    out.push(url);
  }
  return out;
}

describe("MIT runtime: no phone-home, static scan (BLOCKER oss-sdk#1)", () => {
  const files = collectFiles(REPO_ROOT);

  it("scans a non-trivial set of shipped files", () => {
    // Guards the guard: a broken root or filter would silently pass.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith("routes/oauth-github.ts"))).toBe(true);
    expect(files.some((f) => f.endsWith("docker-compose.yml"))).toBe(true);
    expect(files.some((f) => f.endsWith("Dockerfile"))).toBe(true);
    expect(files.some((f) => f.endsWith("server/start.mjs"))).toBe(true);
  });

  it("no shipped file carries a CodeSpar or railway.app URL", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf-8");
      const lines = src.split("\n");
      for (const url of offendingUrls(src)) {
        const line = lines.findIndex((l) => l.includes(url)) + 1;
        offenders.push(`${file.replace(REPO_ROOT, ".")}:${line} -> ${url}`);
      }
    }
    expect(
      offenders,
      "The MIT runtime must not embed a CodeSpar host. Derive display URLs " +
        "from the request host and require WEBHOOK_BASE_URL / DASHBOARD_URL " +
        `for anything written elsewhere. Offending sites:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the historical production host appears nowhere, in any form", () => {
    const offenders = files
      .filter((f) => readFileSync(f, "utf-8").includes(FORBIDDEN_LITERAL))
      .map((f) => f.replace(REPO_ROOT, "."));
    expect(offenders).toEqual([]);
  });
});

// ── 2. Behavioural: the webhook target cannot be poisoned ────────────

const ENV_KEYS = [
  "WEBHOOK_BASE_URL",
  "DASHBOARD_URL",
  "TRUST_PROXY",
  "GITHUB_TOKEN",
  "GITHUB_CLIENT_ID",
  "GITHUB_OAUTH_REDIRECT_URI",
  "ENGINE_API_TOKEN",
] as const;

/** In-memory storage: only what POST /api/projects touches. */
function fakeStorage(): { provider: StorageProvider; added: unknown[] } {
  const added: unknown[] = [];
  const provider = {
    getProjectsList: async () => [],
    addProject: async (p: unknown) => {
      added.push(p);
    },
  } as unknown as StorageProvider;
  return { provider, added };
}

function makeServer(): { server: WebhookServer; added: unknown[] } {
  const { provider, added } = fakeStorage();
  const server = new WebhookServer({ port: 0 });
  server.setStorageProvider(provider);
  server.setAgentFactory({ createAgent: async () => {} });
  return { server, added };
}

describe("MIT runtime: webhook target is not steerable by headers (BLOCKER oss-sdk#1)", () => {
  const saved: Record<string, string | undefined> = {};
  let createWebhook: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    createWebhook = vi
      .spyOn(GitHubClient.prototype, "createWebhook")
      .mockResolvedValue({ id: 1, url: "stub" });
  });

  afterEach(() => {
    createWebhook.mockRestore();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("writes the configured base URL, ignoring a forged x-forwarded-host", async () => {
    process.env.GITHUB_TOKEN = "gh-token-for-test";
    process.env.WEBHOOK_BASE_URL = "https://agents.example.com";
    const { server } = makeServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo: "acme/widgets" },
      headers: {
        host: "runtime.internal:3000",
        "x-forwarded-host": "attacker.example.net",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(createWebhook).toHaveBeenCalledTimes(1);
    const args = createWebhook.mock.calls[0] as unknown[];
    expect(args[2]).toBe("https://agents.example.com/webhooks/github");
    expect(JSON.stringify(args)).not.toContain("attacker.example.net");
    expect(JSON.stringify(args)).not.toMatch(SUSPECT_RE);
  });

  it("keeps ignoring the forged host even with TRUST_PROXY on", async () => {
    process.env.GITHUB_TOKEN = "gh-token-for-test";
    process.env.WEBHOOK_BASE_URL = "https://agents.example.com";
    process.env.TRUST_PROXY = "true";
    const { server } = makeServer();

    await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo: "acme/widgets" },
      headers: { host: "runtime.internal:3000", "x-forwarded-host": "attacker.example.net" },
    });

    const args = createWebhook.mock.calls[0] as unknown[];
    expect(args[2]).toBe("https://agents.example.com/webhooks/github");
  });

  it("refuses with 412 instead of guessing a host, and writes nothing", async () => {
    process.env.GITHUB_TOKEN = "gh-token-for-test";
    const { server, added } = makeServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo: "acme/widgets" },
      headers: { host: "runtime.internal:3000", "x-forwarded-host": "attacker.example.net" },
    });

    expect(res.statusCode).toBe(412);
    expect(JSON.parse(res.body).code).toBe("base_url_not_configured");
    expect(createWebhook).not.toHaveBeenCalled();
    expect(added).toEqual([]);
  });

  it("does not hand GitHub a forged OAuth redirect_uri", async () => {
    process.env.GITHUB_CLIENT_ID = "client-id-for-test";
    const { server } = makeServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/github/install",
      headers: { host: "runtime.internal:3000", "x-forwarded-host": "attacker.example.net" },
    });

    expect(res.statusCode).toBe(412);
    expect(res.headers.location).toBeUndefined();
    expect(res.body).not.toContain("attacker.example.net");
  });

  it("OAuth ends on the runtime's own page when DASHBOARD_URL is unset", async () => {
    const { server } = makeServer();

    const res = await server.inject({
      method: "GET",
      url: "/api/slack/callback",
      query: { error: "access_denied" },
      headers: { host: "runtime.internal:3000" },
    });

    expect(res.headers.location).toBeUndefined();
    expect(res.body).not.toMatch(SUSPECT_RE);
    expect(res.body).toContain("not connected");
  });
});

// ── 3. Behavioural: display URLs use the request host, over http ─────

describe("MIT runtime: display URLs follow the request, not a CodeSpar host", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("uses the Host header over http, ignoring x-forwarded-* by default", async () => {
    const server = new WebhookServer({ port: 0 });
    const res = await server.inject({
      method: "GET",
      url: "/api/webhooks/url",
      headers: {
        host: "runtime.internal:3000",
        "x-forwarded-host": "attacker.example.net",
        "x-forwarded-proto": "https",
      },
    });

    const body = JSON.parse(res.body) as { github: string };
    // http, not https: the runtime serves plain HTTP (compose maps 3000:3000).
    // Guessing https by hostname produced webhooks GitHub accepted and never
    // delivered.
    expect(body.github).toBe("http://runtime.internal:3000/webhooks/github?orgId=default");
    expect(res.body).not.toContain("attacker.example.net");
    expect(res.body).not.toMatch(SUSPECT_RE);
  });

  it("honours x-forwarded-* once the operator opts in with TRUST_PROXY", async () => {
    process.env.TRUST_PROXY = "true";
    const server = new WebhookServer({ port: 0 });
    const res = await server.inject({
      method: "GET",
      url: "/api/webhooks/url",
      headers: {
        host: "runtime.internal:3000",
        "x-forwarded-host": "agents.example.com",
        "x-forwarded-proto": "https",
      },
    });

    const body = JSON.parse(res.body) as { github: string };
    expect(body.github).toBe("https://agents.example.com/webhooks/github?orgId=default");
  });

  it("advertises the request host in the A2A agent card, never a CodeSpar host", async () => {
    const server = new WebhookServer({ port: 0 });
    const res = await server.inject({
      method: "GET",
      url: "/.well-known/agent.json",
      headers: { host: "runtime.internal:3000", "x-forwarded-host": "attacker.example.net" },
    });

    const body = JSON.parse(res.body) as { url: string };
    expect(body.url).toBe("http://runtime.internal:3000");
  });
});
