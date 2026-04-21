/**
 * OSS contract test — runs the full SessionBase conformance suite against
 * a locally started WebhookServer.
 *
 * Port 13001 is fixed because WebhookServer.app is private and does not
 * expose the bound port after start(), preventing port-0 ephemeral binding.
 * A follow-on issue should add WebhookServer.boundPort so this can be
 * changed to 0.
 *
 * No real credentials are required. The OSS server accepts any
 * syntactically valid Bearer token when ENGINE_API_TOKEN is unset.
 */

import { WebhookServer } from "../server/webhook-server.js";
import { runContractSuite } from "@codespar/types/testing";

const PORT = 13001;
let server: WebhookServer | undefined;
let savedApiKey: string | undefined;

beforeAll(async () => {
  // Remove the Anthropic API key so send() uses the instant OSS fallback
  // rather than a live API call. This test verifies the HTTP contract, not
  // AI response quality, and keeps CI and local runs consistent.
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  server = new WebhookServer({ port: PORT });
  await server.start();

  // Verify the server is accepting requests before handing off to the suite.
  // start() waits for Fastify to be ready, but a port conflict or silent bind
  // failure can still produce a server that returns no responses.
  const res = await fetch(`http://localhost:${PORT}/health`);
  if (!res.ok) {
    throw new Error(`OSS runtime health check failed: ${res.status}`);
  }
}, 15_000);

afterAll(async () => {
  await server?.stop();
  if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
});

runContractSuite(`http://localhost:${PORT}`, "csk_live_oss_test_key");
