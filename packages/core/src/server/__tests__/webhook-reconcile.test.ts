/**
 * Existing installs get repaired without anyone touching GitHub by hand.
 *
 * Provisioning the secret at creation time only helps hooks created from now
 * on. Every install that linked a repo before carries a hook with no secret,
 * and nothing in normal operation revisits it — so without this pass the fix
 * would reach new installs only and everyone else would need the manual step
 * the design exists to avoid.
 *
 * The failure modes matter as much as the happy path here: this runs at
 * startup against a third-party API, so "cannot reach GitHub" and "no base URL
 * configured" must be quiet no-ops rather than anything that delays or breaks
 * a boot.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { reconcileWebhookSecrets } from "../webhook-reconcile.js";
import type { ProjectConfig, StorageProvider } from "../../storage/types.js";

const BASE = "https://ops.example";

function projectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    repoUrl: "https://github.com/acme/widgets",
    repoOwner: "acme",
    repoName: "widgets",
    linkedAt: new Date().toISOString(),
    linkedBy: "test",
    webhookConfigured: true,
    ...overrides,
  };
}

function fakeStorage(configs: Record<string, ProjectConfig>) {
  const saved: Record<string, ProjectConfig> = {};
  let channel: Record<string, string> = {};
  const provider = {
    getProjectsList: async () =>
      Object.keys(configs).map((agentId) => ({
        id: agentId,
        agentId,
        repo: "acme/widgets",
        createdAt: new Date().toISOString(),
      })),
    getProjectConfig: async (agentId: string) => configs[agentId] ?? null,
    setProjectConfig: async (agentId: string, config: ProjectConfig) => {
      saved[agentId] = config;
    },
    getChannelConfig: async () => (Object.keys(channel).length ? { ...channel } : null),
    saveChannelConfig: async (_c: string, next: Record<string, string>) => {
      channel = { ...next };
    },
  } as unknown as StorageProvider;
  return { provider, saved: () => saved };
}

/** Scripted GitHub: list returns one existing hook, then PATCH succeeds. */
function stubGitHub(patchStatus = 200) {
  const calls: Array<{ url: string; method: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      const method = init?.method ?? "GET";
      calls.push({
        url: String(url),
        method,
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      if (method === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: 42, config: { url: `${BASE}/webhooks/github` } }],
          text: async () => "[]",
        } as unknown as Response;
      }
      return {
        ok: patchStatus >= 200 && patchStatus < 300,
        status: patchStatus,
        json: async () => ({ id: 42, config: { url: `${BASE}/webhooks/github` } }),
        text: async () => "",
      } as unknown as Response;
    }),
  );
  return calls;
}

const ENV_KEYS = ["GITHUB_TOKEN", "WEBHOOK_BASE_URL", "GITHUB_WEBHOOK_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

describe("startup reconciliation of webhook secrets", () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sets the secret on a hook linked before this existed", async () => {
    setEnv({ GITHUB_TOKEN: "t", WEBHOOK_BASE_URL: BASE });
    const { provider, saved: savedConfigs } = fakeStorage({
      "agent-widgets": projectConfig(), // no webhookSecretProvisioned marker
    });
    const calls = stubGitHub();

    const result = await reconcileWebhookSecrets(provider, "default");

    expect(result.reconciled).toBe(1);
    expect(result.failed).toBe(0);

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch, "the existing hook was left unsigned").toBeDefined();
    expect(patch!.body.config.secret).toBeTruthy();

    // Marked, so the next boot does not call GitHub for this project again.
    expect(savedConfigs()["agent-widgets"]?.webhookSecretProvisioned).toBe(true);
  });

  it("skips a project already reconciled, without calling GitHub", async () => {
    setEnv({ GITHUB_TOKEN: "t", WEBHOOK_BASE_URL: BASE });
    const { provider } = fakeStorage({
      "agent-widgets": projectConfig({ webhookSecretProvisioned: true }),
    });
    const calls = stubGitHub();

    const result = await reconcileWebhookSecrets(provider, "default");

    expect(result.alreadyDone).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(calls, "a reconciled project should cost no API calls").toHaveLength(0);
  });

  it("does nothing, quietly, with no GitHub token", async () => {
    setEnv({ WEBHOOK_BASE_URL: BASE });
    const { provider } = fakeStorage({ "agent-widgets": projectConfig() });

    const result = await reconcileWebhookSecrets(provider, "default");

    expect(result.skippedReason).toBe("no GitHub token configured");
    expect(result.reconciled).toBe(0);
  });

  it("does nothing, quietly, without WEBHOOK_BASE_URL", async () => {
    // The hook is identified by its delivery URL, and that URL is never
    // guessed from a request.
    setEnv({ GITHUB_TOKEN: "t" });
    const { provider } = fakeStorage({ "agent-widgets": projectConfig() });

    const result = await reconcileWebhookSecrets(provider, "default");

    expect(result.skippedReason).toBe("WEBHOOK_BASE_URL is not configured");
  });

  it("does not mark a project done when GitHub refused the secret", async () => {
    // Found by probing rather than by reading: with a 422 on the PATCH, the
    // hook still comes back from the list, so the pass counted the project as
    // reconciled AND wrote the marker. The install stayed unsigned forever
    // while its stored state claimed the repair had happened, and no later
    // boot would retry. A marker that can lie is worse than no marker.
    setEnv({ GITHUB_TOKEN: "t", WEBHOOK_BASE_URL: BASE });
    const { provider, saved: savedConfigs } = fakeStorage({
      "agent-widgets": projectConfig(),
    });
    stubGitHub(422);

    const result = await reconcileWebhookSecrets(provider, "default");

    expect(result.failed).toBe(1);
    expect(result.reconciled).toBe(0);
    expect(
      savedConfigs()["agent-widgets"],
      "marked as provisioned even though the secret never landed",
    ).toBeUndefined();
  });

  it("never throws, because it runs after the server reports Ready", async () => {
    setEnv({ GITHUB_TOKEN: "t", WEBHOOK_BASE_URL: BASE });
    const { provider } = fakeStorage({ "agent-widgets": projectConfig() });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );

    await expect(reconcileWebhookSecrets(provider, "default")).resolves.toMatchObject({
      failed: 1,
    });
  });

  it("is a no-op with no storage at all", async () => {
    setEnv({ GITHUB_TOKEN: "t", WEBHOOK_BASE_URL: BASE });
    const result = await reconcileWebhookSecrets(null, "default");
    expect(result.skippedReason).toBe("no storage");
  });
});
