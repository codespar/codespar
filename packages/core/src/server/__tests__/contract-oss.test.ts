/**
 * OSS runtime conformance against the published session contract.
 *
 * `@codespar/types/testing` ships `runContractSuite`, the same Vitest suite
 * the managed runtime is held to. Until this file existed, the OSS runtime
 * only claimed conformance (routes/sessions.ts, docs/test-mode.md) and was
 * never actually run through the suite, which is how the `POST /v1/sessions`
 * 201 body drifted from what `@codespar/sdk` reads. This file makes the
 * published suite the gate: a shape the SDK depends on cannot regress here
 * without failing the build.
 *
 * Setup mirrors the neighbouring socket-level suites: the real
 * `WebhookServer` (auth guard, `/v1` mirrors, tenancy resolution, rate
 * limiting) listens on an ephemeral port and the suite drives it over HTTP,
 * exactly as an SDK consumer would. Nothing is injected through `inject()`.
 *
 * Choices worth knowing:
 *
 * - **All published legs run.** The suite is invoked with no `legs` filter,
 *   so whatever the installed `@codespar/types` version asserts is asserted
 *   here. A version bump that tightens an assertion needs no edit to this
 *   file, only to the runtime if it fails.
 * - **No tenancy headers.** The suite sends neither `x-org-id` nor
 *   `x-codespar-project`; the runtime's fallback to org "default" and its
 *   default project is part of what is under test.
 * - **The model upstream is a scripted double.** The `send` and
 *   `sendStream` legs run the chat loop, which calls the Anthropic Messages
 *   API. The contract covers the runtime's wire shapes, not the model's
 *   output, so `ANTHROPIC_BASE_URL` points at an in-process server that
 *   answers every completion with one text block. This is the same
 *   redirection the runtime documents for its own test mode; the suite
 *   itself is untouched.
 * - **`localhost`, not `127.0.0.1`.** The suite refuses plain-http base URLs
 *   unless the hostname is literally `localhost` (so a misconfigured CI never
 *   ships the bearer token to a stranger over cleartext). The server binds on
 *   `localhost`, which Fastify expands to both loopback families.
 */

import { afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContractSuite } from "@codespar/types/testing";
import { WebhookServer } from "../webhook-server.js";
import { TEST_API_TOKEN } from "./test-credential.js";

/**
 * Minimal stand-in for the Anthropic Messages API. Every `POST /v1/messages`
 * ends the turn with a single text block, so the chat loop completes in one
 * iteration with no tool dispatch. Any other request is answered with an
 * error envelope, so a runtime that starts calling something else fails
 * loudly instead of hanging.
 */
function startScriptedModel(): Promise<{ server: Server; baseURL: string }> {
  return new Promise((resolve) => {
    let n = 0;
    const server = createServer((req, res) => {
      if (req.url !== "/v1/messages" || req.method !== "POST") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "not_found_error", message: `unexpected ${req.method} ${req.url}` },
          }),
        );
        return;
      }
      // Drain the body; the reply does not depend on it.
      req.resume();
      req.on("end", () => {
        n += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_contract_${n}`,
            type: "message",
            role: "assistant",
            model: "scripted",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("scripted model: no bound port");
      resolve({ server, baseURL: `http://127.0.0.1:${addr.port}` });
    });
  });
}

// ---------------------------------------------------------------------------
// Environment. Set before the server is constructed: the constructor reads
// the credential, and the storage layer reads its directory on first use.
// Everything is restored in afterAll.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ENGINE_API_TOKEN",
  "CODESPAR_STATE_DIR",
  "CODESPAR_STORAGE_DIR",
  "DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
for (const key of ENV_KEYS) {
  const value = process.env[key];
  if (value !== undefined) savedEnv[key] = value;
}

const scratchDir = mkdtempSync(join(tmpdir(), "codespar-contract-oss-"));

// Same credential every other protected-route suite uses; verified by the
// same comparison a production token goes through.
process.env.ENGINE_API_TOKEN = TEST_API_TOKEN;
// Hermetic state: the minted-token file and FileStorage both live under the
// scratch dir, and a developer's DATABASE_URL must not turn this into a
// Postgres test.
process.env.CODESPAR_STATE_DIR = scratchDir;
process.env.CODESPAR_STORAGE_DIR = join(scratchDir, "storage");
delete process.env.DATABASE_URL;
// The chat loop must reach the scripted double, never the real API.
delete process.env.ANTHROPIC_API_KEY;
const model = await startScriptedModel();
process.env.ANTHROPIC_BASE_URL = model.baseURL;

// ---------------------------------------------------------------------------
// Runtime under test. Listening through the Fastify instance rather than
// WebhookServer.start(): start() also boots the event bus and probes Docker
// to warm a container pool, none of which the session contract touches.
// ---------------------------------------------------------------------------

const runtime = new WebhookServer({ port: 0, host: "localhost" });
await runtime.fastifyInstance.listen({ port: 0, host: "localhost" });
const bound = runtime.fastifyInstance.server.address();
if (!bound || typeof bound === "string") throw new Error("runtime: no bound port");
const baseUrl = `http://localhost:${bound.port}`;

afterAll(async () => {
  await runtime.fastifyInstance.close();
  await new Promise<void>((resolve) => model.server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratchDir, { recursive: true, force: true });
});

// The suite registers its own describe/it blocks. No `legs` filter and no
// `servers`: the default run is the contract.
runContractSuite(baseUrl, TEST_API_TOKEN);
