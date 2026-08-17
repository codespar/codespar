/**
 * BLOCKER oss-sdk#1 regression guard.
 *
 * The MIT runtime must not phone home. README.md promises "no phone-home,
 * fully operable without codespar infrastructure" (README.md:39, :358).
 *
 * Four guards, because each earlier one alone proved insufficient:
 *
 * 1. STATIC — no shipped file may carry a CodeSpar (or railway.app) host as a
 *    URL. The first version of this test matched one exact string in
 *    packages/**\/*.ts, which stayed green while four
 *    `process.env.DASHBOARD_URL || "https://codespar.dev"` defaults sat in
 *    oauth-github.ts. It now matches any codespar / railway.app URL, over the
 *    whole repo, across .ts/.mjs/.js/.json/.yml/.yaml/Dockerfile.
 *
 * 1b. The static scan must survive a rename. Matching only the literal
 *    spelling left `"https://codespar" + ".dev"` and `` `https://${"codespar"}.dev` ``
 *    green, and the historical-host check used includes(), which
 *    `"codespar" + "-production..."` walked straight past. Both are closed and
 *    the bypasses themselves are asserted, so a future simplification of the
 *    normalisers turns red instead of quiet.
 *
 * 2. BEHAVIOURAL — the value the runtime actually writes into a third party
 *    must come from the operator's configuration, and must not be steerable by
 *    request headers. Replacing a CodeSpar constant with a caller-controlled
 *    x-forwarded-host would be a worse bug than the one being fixed: it turns
 *    a fixed phone-home into an arbitrary one. Note what is asserted: nothing
 *    reaches GitHub without a configured base URL. NOT a status code — an
 *    earlier revision enforced that by failing the whole request, which broke
 *    the shipped .env.example default (GITHUB_TOKEN set, WEBHOOK_BASE_URL
 *    blank) to prevent a write that simply not making it already prevents.
 *
 * 3. IDENTITY AND POLICY — a self-hoster must not announce our name on the A2A
 *    network (not a URL, so guard 1 is blind to it), and the proxy-trust switch
 *    must mean one thing: it is boolean-only so Fastify and base-url.ts cannot
 *    disagree, and the rate-limit ceiling is keyed off the socket peer so it
 *    does not move when that switch is on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Importing the server drags in chat-loop -> @anthropic-ai/sdk, which is
// unrelated to anything asserted here and is not installed in every dev
// environment. Stub it so this guard runs everywhere. Nothing below calls it.
vi.mock("@anthropic-ai/sdk", () => ({ default: class Anthropic {} }));

import { WebhookServer } from "../webhook-server.js";
import { fastifyTrustProxy, trustProxyEnabled } from "../base-url.js";
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

/**
 * Undo the ways a host can be spelled without ever appearing as one literal.
 * Matching the raw source only would let
 *   "https://codespar" + ".dev"       and       `https://${"codespar"}.dev`
 * through a scan that the plain literal fails, which is a rename away from
 * being the same bug this file exists to catch.
 *
 * Three collapses, applied to a copy used for scanning only:
 *   1. \uXXXX / \u{...} / \xXX escapes -> the character they denote.
 *   2. `${"lit"}` / `${'lit'}` -> lit.
 *   3. "a" + "b" -> "ab" (any quote style, across newlines), to a fixed point.
 * Known reach, stated honestly so nobody trusts this further than it goes:
 *   - Indirection through a variable ("const h = ...; `https://${h}/x`") is out
 *     of reach of any regex over one file.
 *   - hostAlphabet below extends that reach only when the fragments sit
 *     ADJACENT in the source. Split across separate declarations
 *     ("const a = 'codespar-produc'; const b = 'tion.up.railway.app'") it does
 *     NOT catch them.
 *   - URL_RE requires an http(s) scheme, so a bare host with no scheme
 *     ("const DEFAULT_HOST = 'api.codespar.dev'", used later as
 *     `https://${DEFAULT_HOST}`) is invisible to both checks.
 * This guard raises the cost of reintroducing the defect by accident. It does
 * not stop someone determined to route around it, and it is not a substitute
 * for the behavioural tests further down this file, which assert what the
 * runtime actually writes rather than what the source looks like.
 */
function collapseAssembly(src: string): string {
  let out = src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (m, hex) => {
      const code = parseInt(hex, 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));

  out = out.replace(/\$\{\s*(["'`])([^"'`\r\n]*)\1\s*\}/g, "$2");

  for (let i = 0; i < 8; i++) {
    const next = out.replace(/(["'`])\s*\+\s*(["'`])/g, "");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Lowercased source reduced to the characters a hostname can contain. Quotes,
 * plus signs, whitespace and newlines all vanish, so any concatenation of
 * adjacent pieces reads as the host it spells:
 *   "codespar" + "-production.up.railway.app"  ->  codespar-production.up.railway.app
 * This is what makes the historical-literal check un-bypassable by splitting,
 * which a plain includes() on the raw source was not.
 */
function hostAlphabet(src: string): string {
  return src.toLowerCase().replace(/[^a-z0-9.-]+/g, "");
}

/** True when the file spells the historical production host in ANY form. */
function carriesForbiddenLiteral(src: string): boolean {
  return (
    src.includes(FORBIDDEN_LITERAL) ||
    collapseAssembly(src).includes(FORBIDDEN_LITERAL) ||
    hostAlphabet(src).includes(FORBIDDEN_LITERAL)
  );
}

function offendingUrls(src: string): string[] {
  const out = new Set<string>();
  // Scan the source as written AND as assembled: the second is a superset in
  // practice, the first guarantees no collapse can hide something.
  for (const text of [src, collapseAssembly(src)]) {
    for (const raw of text.match(URL_RE) ?? []) {
      const url = raw.replace(/[.,;:!?]+$/, "");
      if (!SUSPECT_RE.test(url)) continue;
      const host = hostOf(url);
      if (host && ALLOWED_HOSTS.has(host)) continue;
      out.add(url);
    }
  }
  return [...out];
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
        const idx = lines.findIndex((l) => l.includes(url));
        const where = idx >= 0 ? `:${idx + 1}` : " (assembled across lines)";
        offenders.push(`${file.replace(REPO_ROOT, ".")}${where} -> ${url}`);
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
      .filter((f) => carriesForbiddenLiteral(readFileSync(f, "utf-8")))
      .map((f) => f.replace(REPO_ROOT, "."));
    expect(offenders).toEqual([]);
  });
});

// ── 1b. The static scan cannot be walked around ──────────────────────
//
// A guard that only matches the literal spelling is a rename away from being
// useless. These cases are the ones a reviewer would reach for first, and they
// were all green against the previous version of the scan.

describe("MIT runtime: the static scan resists assembled hosts", () => {
  it("catches a URL built by string concatenation", () => {
    expect(offendingUrls('const u = "https://codespar" + ".dev/dashboard";')).toContain(
      "https://codespar.dev/dashboard",
    );
    expect(offendingUrls("const u = 'https://x.up.rail' + 'way.app/hook';")).toContain(
      "https://x.up.railway.app/hook",
    );
    // Across lines, the way a formatter would leave it.
    expect(
      offendingUrls(['const u =\n  "https://code' + '"', '  + "spar.dev/x";'].join("\n")),
    ).toContain("https://codespar.dev/x");
  });

  it("catches a URL built by template interpolation of a literal", () => {
    expect(offendingUrls('const u = `https://${"codespar"}.dev/dashboard`;')).toEqual([
      "https://codespar.dev/dashboard",
    ]);
    expect(offendingUrls("const u = `https://${'x.up.railway.app'}/hook`;")).toEqual([
      "https://x.up.railway.app/hook",
    ]);
  });

  it("catches a URL hidden behind unicode / hex escapes", () => {
    // "https://codespar.dev/x" with the leading c written as an escape.
    expect(offendingUrls('const u = "https://\\u0063odespar.dev/x";')).toEqual([
      "https://codespar.dev/x",
    ]);
    expect(offendingUrls('const u = "https://\\x63odespar.dev/x";')).toEqual([
      "https://codespar.dev/x",
    ]);
  });

  it("catches the historical production host split across concatenation", () => {
    expect(carriesForbiddenLiteral('const h = "codespar" + "-production.up.railway.app";')).toBe(
      true,
    );
    expect(
      carriesForbiddenLiteral('const h = "https://codespar-produc" + "tion.up.railway.app";'),
    ).toBe(true);
    expect(
      carriesForbiddenLiteral(
        ["const h =", '  "codespar-production" +', '  ".up.railway.app";'].join("\n"),
      ),
    ).toBe(true);
    expect(carriesForbiddenLiteral('const h = `${"codespar-production"}.up.railway.app`;')).toBe(
      true,
    );
    // Built once, used somewhere else: no scheme, no single literal.
    expect(
      carriesForbiddenLiteral(
        ['const h = "codespar-production" + ".up.railway.app";', "const u = `https://${h}/x`;"].join(
          "\n",
        ),
      ),
    ).toBe(true);
  });

  it("still lets a github.com repo path through", () => {
    const src = 'log("clone https://github.com/codespar/codespar and run make dev");';
    expect(offendingUrls(src)).toEqual([]);
    expect(carriesForbiddenLiteral(src)).toBe(false);
  });

  it("still lets the package scope and the compose DB user through", () => {
    const src = '{"name":"@codespar/core"}\nDATABASE_URL: postgres://codespar:pw@postgres:5432/db';
    expect(offendingUrls(src)).toEqual([]);
    expect(carriesForbiddenLiteral(src)).toBe(false);
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
  "AGENT_CARD_NAME",
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

  // The property under test is "nothing is written to GitHub", not a status
  // code. The shipped .env.example has GITHUB_TOKEN filled in and
  // WEBHOOK_BASE_URL blank, so refusing the request would break the default
  // install to prevent a write that is already prevented by not making it.
  it("creates the project and skips the webhook when no base URL is configured", async () => {
    process.env.GITHUB_TOKEN = "gh-token-for-test";
    const { server, added } = makeServer();

    const res = await server.inject({
      method: "POST",
      url: "/api/projects",
      payload: { repo: "acme/widgets" },
      headers: { host: "runtime.internal:3000", "x-forwarded-host": "attacker.example.net" },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.id).toBe("widgets");
    expect(body.webhookConfigured).toBe(false);
    expect(body.webhookSkipped).toBe("base_url_not_configured");
    expect(String(body.webhookMessage)).toContain("WEBHOOK_BASE_URL");
    // The security property, unchanged: no host was guessed, nothing was
    // written into the operator's repo.
    expect(createWebhook).not.toHaveBeenCalled();
    expect(body.webhookUrl).toBeNull();
    expect(res.body).not.toContain("attacker.example.net");
    expect(res.body).not.toContain("runtime.internal");
    // The local half of the operation did happen.
    expect(added).toEqual([{ id: "widgets", agentId: "agent-widgets", repo: "acme/widgets" }]);
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

  // The static scan is blind here: an identity is not a URL. A self-hoster
  // must not introduce themselves to the A2A network under our name.
  it("does not announce a CodeSpar identity in the agent card by default", async () => {
    const server = new WebhookServer({ port: 0 });
    const res = await server.inject({
      method: "GET",
      url: "/.well-known/agent.json",
      headers: { host: "runtime.internal:3000" },
    });

    const body = JSON.parse(res.body) as { name: string };
    expect(body.name).not.toMatch(SUSPECT_RE);
    expect(body.name).toBe("Agent Runtime");
  });

  it("lets the operator name their own install", async () => {
    process.env.AGENT_CARD_NAME = "Acme Ops Runtime";
    const server = new WebhookServer({ port: 0 });
    const res = await server.inject({
      method: "GET",
      url: "/.well-known/agent.json",
      headers: { host: "runtime.internal:3000" },
    });

    expect((JSON.parse(res.body) as { name: string }).name).toBe("Acme Ops Runtime");
  });
});

// ── 4. TRUST_PROXY is a boolean, and the rate limiter ignores it ─────

describe("MIT runtime: TRUST_PROXY is boolean-only", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved.TRUST_PROXY = process.env.TRUST_PROXY;
    delete process.env.TRUST_PROXY;
  });

  afterEach(() => {
    if (saved.TRUST_PROXY === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = saved.TRUST_PROXY;
  });

  it("reads the boolean spellings, unset means false", () => {
    expect(fastifyTrustProxy({} as NodeJS.ProcessEnv)).toBe(false);
    for (const v of ["true", "TRUE", " 1 ", "on", "yes"]) {
      expect(fastifyTrustProxy({ TRUST_PROXY: v } as NodeJS.ProcessEnv), v).toBe(true);
    }
    for (const v of ["false", "0", "off", "no", ""]) {
      expect(fastifyTrustProxy({ TRUST_PROXY: v } as NodeJS.ProcessEnv), v).toBe(false);
    }
  });

  it("rejects a non-boolean by name instead of dying inside Fastify", () => {
    // Previously this string was handed straight to Fastify, which compiles
    // trustProxy as an IP/CIDR list and threw "invalid IP address: banana"
    // from the constructor, naming neither the variable nor this file.
    expect(() => fastifyTrustProxy({ TRUST_PROXY: "banana" } as NodeJS.ProcessEnv)).toThrow(
      /TRUST_PROXY/,
    );
    // Rejected on purpose: Fastify would evaluate these against the peer
    // address while base-url.ts honoured x-forwarded-host from anyone.
    expect(() => fastifyTrustProxy({ TRUST_PROXY: "10.0.0.0/8" } as NodeJS.ProcessEnv)).toThrow(
      /TRUST_PROXY/,
    );
    expect(() => fastifyTrustProxy({ TRUST_PROXY: "2" } as NodeJS.ProcessEnv)).toThrow(
      /TRUST_PROXY/,
    );
  });

  it("fails server construction by name, not from inside Fastify", () => {
    process.env.TRUST_PROXY = "banana";
    // Before: Fastify compiled it as an IP/CIDR list and the process died with
    // "invalid IP address: banana", which names no variable and no file.
    expect(() => new WebhookServer({ port: 0 })).toThrow(/TRUST_PROXY/);
    expect(() => new WebhookServer({ port: 0 })).not.toThrow(/invalid IP address/);
  });

  it("means the same thing to Fastify and to the header helper", () => {
    // The docblock used to claim they "always agree" while a CIDR list made
    // them disagree. Boolean-only is what makes the claim true.
    for (const v of [undefined, "true", "false", "1", "0"]) {
      const env = (v === undefined ? {} : { TRUST_PROXY: v }) as NodeJS.ProcessEnv;
      expect(trustProxyEnabled(env), String(v)).toBe(fastifyTrustProxy(env));
    }
  });
});

describe("MIT runtime: the rate limit ceiling is not header-steerable", () => {
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

  it("keys on the socket peer, so rotating x-forwarded-for does not lift it", async () => {
    // TRUST_PROXY on is the dangerous combination: Fastify then derives
    // request.ip from x-forwarded-for, and /api/* is unauthenticated with no
    // ENGINE_API_TOKEN, so keying the limiter on request.ip gave an anonymous
    // caller an unlimited budget for the price of one header.
    process.env.TRUST_PROXY = "true";
    const server = new WebhookServer({ port: 0 });
    // A peer of its own, so the other tests in this file share no bucket.
    const peer = "203.0.113.9";

    let statusCode = 0;
    let sent = 0;
    for (let i = 0; i < 130; i++) {
      const res = await server.inject({
        method: "GET",
        url: "/api/webhooks/url",
        remoteAddress: peer,
        headers: {
          host: "runtime.internal:3000",
          // A different claimed client on every single request.
          "x-forwarded-for": `198.51.100.${i % 250}`,
        },
      });
      sent++;
      statusCode = res.statusCode;
      if (statusCode === 429) break;
    }

    expect(statusCode).toBe(429);
    // The /api/* ceiling is 100 per minute; the header bought nothing.
    expect(sent).toBeLessThanOrEqual(101);
  });
});
