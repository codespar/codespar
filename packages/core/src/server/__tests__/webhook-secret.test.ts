/**
 * The runtime provisions the webhook signing secret, so that rejecting
 * unsigned deliveries becomes possible without anyone configuring anything.
 *
 * The bug this closes was not a plain gap. `createWebhook` registered hooks
 * with no `secret`, so GitHub signed nothing, so `WEBHOOK_STRICT_MODE` could
 * not be turned on without rejecting the runtime's own integration — and an
 * operator who set `GITHUB_WEBHOOK_SECRET` to be responsible made it worse,
 * because verification switched on while GitHub still sent nothing to verify.
 * Trying to secure it broke it.
 *
 * The tests below drive the real client against a stub GitHub so what is
 * asserted is the request that would go over the wire: a fake that just
 * recorded "createWebhook was called" would have passed for the entire life of
 * the bug, since the call always happened — it was the body that was wrong.
 *
 * Note the scope this does NOT cover: turning strict mode on. That stays a
 * separate decision (#138), so nothing here asserts a default flip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitHubClient } from "../../github/github-client.js";
import {
  provisionWebhookSecret,
  resolveWebhookSecret,
  GENERATED_SECRET_KEY,
  OPERATOR_SECRET_KEY,
} from "../webhook-secret.js";
import type { StorageProvider } from "../../storage/types.js";

/** In-memory channel config, the only part of storage these paths touch. */
function fakeStorage(initial: Record<string, string> = {}) {
  let config: Record<string, string> = { ...initial };
  const provider = {
    getChannelConfig: async () => (Object.keys(config).length ? { ...config } : null),
    saveChannelConfig: async (_channel: string, next: Record<string, string>) => {
      config = { ...next };
    },
  } as unknown as StorageProvider;
  return { provider, read: () => config };
}

/** Captures every fetch the client makes, and scripts the responses. */
function stubGitHub(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  let i = 0;
  const impl = vi.fn(async (url: any, init: any) => {
    const next = responses[Math.min(i++, responses.length - 1)];
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", impl);
  return calls;
}

describe("webhook secret: provisioning", () => {
  const saved = process.env.GITHUB_WEBHOOK_SECRET;

  beforeEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = saved;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("generates and stores a secret when the install has none", async () => {
    const { provider, read } = fakeStorage();
    const { secret, source } = await provisionWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);

    expect(source).toBe("generated");
    expect(secret).toBeDefined();
    expect(secret!.length).toBeGreaterThanOrEqual(32);
    expect(read()[GENERATED_SECRET_KEY]).toBe(secret);
  });

  it("reuses the stored secret on the next call", async () => {
    const { provider } = fakeStorage();
    const first = await provisionWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);
    const second = await provisionWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);
    expect(second.secret).toBe(first.secret);
  });

  it("lets an operator-set value win over the generated one", async () => {
    // Same rule as ENGINE_API_TOKEN over the generated API credential: what the
    // operator configured is authoritative, and the generated value is a floor.
    const { provider } = fakeStorage({ [GENERATED_SECRET_KEY]: "ours" });

    const fromEnv = await resolveWebhookSecret(provider, "default", {
      GITHUB_WEBHOOK_SECRET: "operator-env",
    } as NodeJS.ProcessEnv);
    expect(fromEnv).toEqual({ secret: "operator-env", source: "operator_env" });

    const { provider: withStored } = fakeStorage({
      [OPERATOR_SECRET_KEY]: "operator-stored",
      [GENERATED_SECRET_KEY]: "ours",
    });
    const stored = await resolveWebhookSecret(withStored, "default", {
      GITHUB_WEBHOOK_SECRET: "operator-env",
    } as NodeJS.ProcessEnv);
    expect(stored).toEqual({ secret: "operator-stored", source: "operator_storage" });
  });

  it("finds a stored secret for the default org", async () => {
    // The old inline lookup skipped storage whenever orgId was "default",
    // which is what a single-tenant `docker compose up` install always is. A
    // secret provisioned there would have been written somewhere nothing read.
    const { provider } = fakeStorage({ [GENERATED_SECRET_KEY]: "stored-for-default" });
    const resolved = await resolveWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);
    expect(resolved.secret).toBe("stored-for-default");
  });

  it("does not hand back a secret it could not persist", async () => {
    // A secret GitHub knows and this runtime cannot look up again is worse
    // than none: deliveries would arrive signed with something unverifiable.
    const provider = {
      getChannelConfig: async () => null,
      saveChannelConfig: async () => {
        throw new Error("disk full");
      },
    } as unknown as StorageProvider;

    const resolved = await provisionWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);
    expect(resolved.secret).toBeUndefined();
    expect(resolved.source).toBe("none");
  });

  it("never resolves to a secret when nothing is configured", async () => {
    const { provider } = fakeStorage();
    const resolved = await resolveWebhookSecret(provider, "default", {} as NodeJS.ProcessEnv);
    expect(resolved).toEqual({ secret: undefined, source: "none" });
  });
});

describe("webhook secret: what actually reaches GitHub", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the secret in the config when creating a hook", async () => {
    // The assertion that would have caught the original bug. `createWebhook`
    // was always called and always succeeded; the defect was the absence of
    // one field in the body.
    const calls = stubGitHub([
      { status: 200, body: [] }, // list: no existing hook
      { status: 201, body: { id: 7, config: { url: "https://ops.example/webhooks/github" } } },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook(
      "acme",
      "widgets",
      "https://ops.example/webhooks/github",
      undefined,
      "the-signing-secret",
    );

    const create = calls.find((c) => c.method === "POST");
    expect(create, "no POST was made").toBeDefined();
    expect(create!.body.config.secret).toBe("the-signing-secret");
    expect(create!.body.config.url).toBe("https://ops.example/webhooks/github");
  });

  it("omits the secret field entirely when there is none to send", async () => {
    const calls = stubGitHub([
      { status: 200, body: [] },
      { status: 201, body: { id: 7, config: { url: "https://ops.example/webhooks/github" } } },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook("acme", "widgets", "https://ops.example/webhooks/github");

    const create = calls.find((c) => c.method === "POST");
    expect(create!.body.config).not.toHaveProperty("secret");
  });

  it("patches an EXISTING hook so old installs are repaired", async () => {
    // The migration path. A hook created by an earlier release has no secret
    // and nothing in normal operation would ever revisit it, so without this
    // the fix would reach new installs only.
    const calls = stubGitHub([
      {
        status: 200,
        body: [{ id: 42, config: { url: "https://ops.example/webhooks/github" } }],
      },
      { status: 200, body: { id: 42, config: { url: "https://ops.example/webhooks/github" } } },
    ]);

    const client = new GitHubClient("token");
    const hook = await client.createWebhook(
      "acme",
      "widgets",
      "https://ops.example/webhooks/github",
      undefined,
      "the-signing-secret",
    );

    // `secretConfigured` reports whether the secret actually landed, so a
    // caller doing a repair can tell a real fix from "the hook exists". The
    // reconciliation keys its marker off this; without it a refused PATCH was
    // recorded as done and never retried.
    expect(hook).toEqual({
      id: 42,
      url: "https://ops.example/webhooks/github",
      secretConfigured: true,
    });

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch, "existing hook was left unsigned").toBeDefined();
    expect(patch!.url).toContain("/hooks/42");
    expect(patch!.body.config.secret).toBe("the-signing-secret");
  });

  it("always sends a complete config on patch, whatever PATCH semantics are", async () => {
    // Deliberately does not depend on whether PATCH merges or replaces the
    // config object. GitHub's docs read as a merge with a caveat, an earlier
    // comment here asserted a wholesale replace, and that disagreement was
    // never resolved by measurement. Sending the complete config is correct
    // under both readings: if it replaces, nothing was dropped; if it merges,
    // these are the values already there. What the docs DO state is that a
    // secret must be resent or it is removed, which this does.
    const calls = stubGitHub([
      {
        status: 200,
        body: [{ id: 42, config: { url: "https://ops.example/webhooks/github" } }],
      },
      { status: 200, body: {} },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook(
      "acme",
      "widgets",
      "https://ops.example/webhooks/github",
      undefined,
      "s",
    );

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.config.url).toBe("https://ops.example/webhooks/github");
    expect(patch.body.config.content_type).toBe("json");
  });

  it("preserves a config the operator customised, changing only the secret", async () => {
    // The repair must not become the outage. A hook adjusted by hand carries
    // settings this code never chose: a private-CA host needs
    // insecure_ssl "1", and some receivers are on content_type "form".
    // Sending fixed values preserved the fields the author remembered and
    // silently reset the rest, during a startup repair that is deliberately
    // quiet — so the operator would learn about it from deliveries stopping.
    //
    // The delivery URL is NOT at risk on this path, and the test says so by
    // using the same one: createWebhook finds the hook BY its url, so a hook
    // pointing somewhere else is never matched and never patched. Worth
    // stating, because "it also overwrites a custom url" is the natural third
    // item to assume and it is not reachable here.
    const calls = stubGitHub([
      {
        status: 200,
        body: [
          {
            id: 42,
            config: {
              // Same delivery URL: that is how the hook is found at all.
              url: "https://ops.example/webhooks/github",
              // These two are the operator's, and nothing here chose them.
              content_type: "form",
              insecure_ssl: "1",
            },
          },
        ],
      },
      { status: 200, body: {} },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook(
      "acme",
      "widgets",
      "https://ops.example/webhooks/github",
      undefined,
      "the-signing-secret",
    );

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect(patch!.body.config.secret).toBe("the-signing-secret");
    // Everything else is exactly what the hook already had.
    expect(patch!.body.config.insecure_ssl, "reset a private-CA setting").toBe("1");
    expect(patch!.body.config.content_type, "reset the payload encoding").toBe("form");
    expect(patch!.body.config.url).toBe("https://ops.example/webhooks/github");
  });

  it("still sends a usable target when the hook reports no config", async () => {
    // Belt and braces for a shape we have not seen: if the listing came back
    // without a config, the spread contributes nothing and the defaults have
    // to stand in, or the PATCH could leave the hook without a delivery URL.
    const calls = stubGitHub([
      { status: 200, body: [{ id: 42, config: { url: "https://ops.example/webhooks/github" } }] },
      { status: 200, body: {} },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook(
      "acme",
      "widgets",
      "https://ops.example/webhooks/github",
      undefined,
      "s",
    );

    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.body.config.url).toBe("https://ops.example/webhooks/github");
    expect(patch.body.config.content_type).toBe("json");
    expect(patch.body.config.secret).toBe("s");
  });

  it("leaves an existing hook alone when there is no secret to set", async () => {
    const calls = stubGitHub([
      {
        status: 200,
        body: [{ id: 42, config: { url: "https://ops.example/webhooks/github" } }],
      },
    ]);

    const client = new GitHubClient("token");
    await client.createWebhook("acme", "widgets", "https://ops.example/webhooks/github");

    expect(calls.find((c) => c.method === "PATCH")).toBeUndefined();
  });
});
