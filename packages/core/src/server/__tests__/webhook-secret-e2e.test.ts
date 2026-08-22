/**
 * The provisioned secret actually VERIFIES a delivery. Not just "was stored".
 *
 * Every other test in this change proves the reconciliation RAN: that a PATCH
 * went to GitHub carrying a secret, that the value was persisted, that the
 * project was marked. None of them proves it WORKED, and those are different
 * claims. The two ends of this feature are written by different code in
 * different files — one provisions and stores, the other resolves and
 * verifies — so they can disagree while every individual test passes.
 *
 * That is not hypothetical. It already happened once here: the resolver
 * skipped storage whenever `orgId` was "default", which is what every
 * single-tenant `docker compose up` install is. Provisioning wrote to a slot
 * the verifier never read. Storage assertions were green, the PATCH assertion
 * was green, and verification was broken end to end.
 *
 * So this file closes the loop the only way that means anything: provision the
 * secret, sign a payload with the value that came back, send it at the real
 * route, and require that it is accepted. Then send a payload signed with the
 * wrong key and require that it is refused — without that second half, a route
 * that ignored signatures entirely would pass the first.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookServer } from "../webhook-server.js";
import { provisionWebhookSecret } from "../webhook-secret.js";
import type { StorageProvider } from "../../storage/types.js";

/** Channel config in memory, which is all these paths touch. */
function fakeStorage() {
  let config: Record<string, string> = {};
  const provider = {
    getChannelConfig: async () => (Object.keys(config).length ? { ...config } : null),
    saveChannelConfig: async (_c: string, next: Record<string, string>) => {
      config = { ...next };
    },
    appendAudit: async () => ({}) as never,
    getProjectsList: async () => [],
  } as unknown as StorageProvider;
  return provider;
}

const PAYLOAD = { action: "completed", repository: { full_name: "acme/widgets" } };

function sign(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const ENV_KEYS = ["ENGINE_API_TOKEN", "CODESPAR_STATE_DIR", "GITHUB_WEBHOOK_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

describe("provisioned secret verifies a real delivery", () => {
  let stateDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    stateDir = mkdtempSync(join(tmpdir(), "codespar-wh-e2e-"));
    process.env.CODESPAR_STATE_DIR = stateDir;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key]!;
    }
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("accepts a delivery signed with the secret the runtime provisioned", async () => {
    const storage = fakeStorage();
    const { secret } = await provisionWebhookSecret(storage, "default");
    expect(secret, "nothing was provisioned, so the rest proves nothing").toBeTruthy();

    const server = new WebhookServer({ port: 0 });
    server.setStorageProvider(storage);
    const body = JSON.stringify(PAYLOAD);

    // Positive control FIRST, inside this test rather than only beside it.
    // "not 401" is satisfied both by "our signature verified" and by "this
    // route is not verifying anything", and those are opposite outcomes.
    // Measured, not assumed: with the default-org resolver bug reintroduced,
    // the acceptance assertion below still passed, because no secret resolved
    // and the route waved everything through. So prove the check is live
    // against this exact server before believing it accepted us on merit.
    const wrong = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": sign("some-other-key", body),
      },
    });
    expect(wrong.statusCode, "this route is not verifying at all, so the next assertion is vacuous").toBe(401);

    const res = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": sign(secret!, body),
      },
    });

    // The signature was computed with what the provisioner returned and
    // checked by what the route resolves. If those two ever point at
    // different storage again, this is the assertion that fails.
    expect(res.statusCode, `verification rejected our own signature: ${res.body}`).not.toBe(401);
  });

  it("refuses a delivery signed with the wrong key", async () => {
    // Positive control for the instrument. Without this, a route that skipped
    // verification entirely would satisfy the test above.
    const storage = fakeStorage();
    await provisionWebhookSecret(storage, "default");

    const server = new WebhookServer({ port: 0 });
    server.setStorageProvider(storage);

    const body = JSON.stringify(PAYLOAD);
    const res = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: body,
      headers: {
        "content-type": "application/json",
        "x-github-event": "workflow_run",
        "x-hub-signature-256": sign("not-the-provisioned-secret", body),
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it("refuses an unsigned delivery once a secret exists", async () => {
    // Provisioning is what turns the route from "accepts anything" into
    // "requires a signature", without WEBHOOK_STRICT_MODE being involved:
    // the strict flag governs the case where NO secret is configured.
    const storage = fakeStorage();
    await provisionWebhookSecret(storage, "default");

    const server = new WebhookServer({ port: 0 });
    server.setStorageProvider(storage);

    const res = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify(PAYLOAD),
      headers: { "content-type": "application/json", "x-github-event": "workflow_run" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("still accepts unsigned deliveries when nothing was provisioned", async () => {
    // The default this change deliberately does NOT flip. Stated as a test so
    // that flipping it later is a visible, deliberate edit rather than a side
    // effect somebody notices in production.
    const storage = fakeStorage();

    const server = new WebhookServer({ port: 0 });
    server.setStorageProvider(storage);

    const res = await server.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: JSON.stringify(PAYLOAD),
      headers: { "content-type": "application/json", "x-github-event": "workflow_run" },
    });

    expect(res.statusCode).not.toBe(401);
  });
});
