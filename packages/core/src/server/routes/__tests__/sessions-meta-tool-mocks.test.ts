/**
 * Test mode covers meta-tools on POST /sessions/:id/execute (oss-sdk#4).
 *
 * docs/test-mode.md says a declared mock answers before the hook runs, and
 * `chat-loop/index.ts` implements exactly that for the same registry — its own
 * comment says it "mirrors the `/execute` route's meta-tool branch". The mirror
 * had the mocks-first seam and the original did not, so the invariant everything
 * else is written against was violated in precisely one place.
 *
 * What that cost: a test-mode agent calling a meta-tool through `/execute` ran
 * the REGISTERED HOOK. Not a stale fixture, not an error — the real registrant,
 * which is what a payment meta-tool's hook is. The point of the flag is that it
 * cannot happen.
 *
 * The second half is the environment label. The hook received a hardcoded
 * `environment: "live"`, so a registrant that branches on it — the reason the
 * field exists — took the live branch inside a test-mode deployment.
 *
 * Every assertion here distinguishes the two answers by VALUE (the mock and the
 * hook return different payloads) and by whether the hook ran at all, so
 * "answered by the mock" is proved rather than inferred from a shape.
 */

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { pluginRegistry } from "../../../plugins/index.js";
import type { MetaToolExecutionContext, MetaToolHook } from "../../../plugins/index.js";
import type { Session } from "../../../storage/types.js";
import { clearSessionStore, registerSessionRoutes } from "../sessions.js";
import type { ServerContext } from "../types.js";
import { TEST_API_TOKEN } from "../../__tests__/test-credential.js";

process.env.ENGINE_API_TOKEN = TEST_API_TOKEN;

/** Not exported from test-mode-flag.ts; the sibling mocks suites declare it the
 *  same way. Named once here so a rename of the flag shows up as a red test
 *  rather than as a suite that quietly stops exercising test mode. */
const TEST_MODE_ENV_KEY = "CODESPAR_TEST_MODE_ENABLED";

const META_TOOL = "codespar_pay";
const HOOK_MARKER = "answered-by-the-hook";
const MOCK_MARKER = "answered-by-the-mock";

/** Calls the hook records, so "the hook did not run" is observable. */
const calls: MetaToolExecutionContext[] = [];

function makeHook(): MetaToolHook {
  return {
    id: "fixture-meta",
    handles: [META_TOOL],
    definitions: () => [
      {
        name: META_TOOL,
        description: "fixture meta-tool",
        input_schema: { type: "object", properties: {} },
      },
    ],
    async execute(_name: string, _input: unknown, ctx: MetaToolExecutionContext) {
      calls.push(ctx);
      return {
        output: { marker: HOOK_MARKER },
        duration_ms: 1,
        server_id: "fixture-server",
      };
    },
  } as unknown as MetaToolHook;
}

function clearMetaTools(): void {
  (pluginRegistry as unknown as { metaTools: Map<string, MetaToolHook> }).metaTools = new Map();
  (pluginRegistry as unknown as { sealed: boolean }).sealed = false;
}

/** A context carrying only what these routes read: the credential and,
 *  optionally, a storage provider that answers with a non-HTTP session. */
function makeCtx(storedSession?: Session): ServerContext {
  return {
    apiToken: TEST_API_TOKEN,
    storageProvider: storedSession
      ? ({ getSession: async (id: string) => (id === storedSession.id ? storedSession : null) } as never)
      : null,
    getOrgId: () => "default",
    resolveProjectId: async () => "default",
  } as unknown as ServerContext;
}

function createTestApp(ctx: ServerContext) {
  const app = Fastify({ logger: false });
  const route = (
    method: "get" | "post" | "delete" | "patch",
    path: string,
    handler: unknown,
    // biome-ignore lint/suspicious/noExplicitAny: mirrors registerSessionRoutes' signature
  ) => (app as any)[method](path, handler);
  registerSessionRoutes(route, ctx);
  return app;
}

const auth = { authorization: `Bearer ${TEST_API_TOKEN}` };
const savedFlag = process.env[TEST_MODE_ENV_KEY];

beforeEach(() => {
  calls.length = 0;
  clearSessionStore();
  clearMetaTools();
  pluginRegistry.registerMetaTool(makeHook());
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env[TEST_MODE_ENV_KEY];
  else process.env[TEST_MODE_ENV_KEY] = savedFlag;
  clearMetaTools();
  clearSessionStore();
});

async function createSession(
  app: ReturnType<typeof createTestApp>,
  payload: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({ method: "POST", url: "/sessions", headers: auth, payload });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function execute(app: ReturnType<typeof createTestApp>, id: string) {
  return app.inject({
    method: "POST",
    url: `/sessions/${id}/execute`,
    headers: auth,
    payload: { tool: META_TOOL, input: { amount: 1 } },
  });
}

describe("/execute meta-tool dispatch with test mode ON", () => {
  beforeEach(() => {
    process.env[TEST_MODE_ENV_KEY] = "true";
  });

  it("answers from the declared mock and never runs the hook", async () => {
    const app = createTestApp(makeCtx());
    const id = await createSession(app, {
      servers: [],
      user_id: "u",
      mocks: { [META_TOOL]: { marker: MOCK_MARKER } },
    });
    const res = await execute(app, id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ marker: MOCK_MARKER });
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("refuses with tool_not_mocked when the session declares no entry for it", async () => {
    const app = createTestApp(makeCtx());
    const id = await createSession(app, {
      servers: [],
      user_id: "u",
      mocks: { "asaas/create_payment": { id: "pay_test" } },
    });
    const res = await execute(app, id);
    // Same status and envelope the raw `server/tool` path already returns for
    // this outcome; a meta-tool must not be the one surface that falls through
    // to the real registrant instead.
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("tool_not_mocked");
    expect(calls).toHaveLength(0);
    await app.close();
  });

  it("labels the hook's environment 'test' when the seam does not answer", async () => {
    // The seam short-circuits for a non-HTTP session, so this is the path on
    // which the hook still runs under the flag — and the one where a hardcoded
    // "live" reaches a registrant inside a test-mode deployment.
    const stored: Session = {
      id: "sess-channel-1",
      orgId: "default",
      projectId: "default",
      channelType: "whatsapp",
      channelUserId: "u",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { servers: [] },
    } as unknown as Session;
    const app = createTestApp(makeCtx(stored));
    const res = await execute(app, stored.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ marker: HOOK_MARKER });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.environment).toBe("test");
    await app.close();
  });
});

describe("/execute meta-tool dispatch with test mode OFF", () => {
  beforeEach(() => {
    delete process.env[TEST_MODE_ENV_KEY];
  });

  it("control: the hook runs and the seam is inert", async () => {
    // The flag-off path must be byte-identical to life before the seam
    // existed. Without this control, "the mock answered" above would be
    // indistinguishable from a route that stopped calling hooks at all.
    const app = createTestApp(makeCtx());
    const id = await createSession(app, { servers: [], user_id: "u" });
    const res = await execute(app, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ marker: HOOK_MARKER });
    expect(calls).toHaveLength(1);
    await app.close();
  });

  it("labels the hook's environment 'live'", async () => {
    const app = createTestApp(makeCtx());
    const id = await createSession(app, { servers: [], user_id: "u" });
    await execute(app, id);
    expect(calls[0]!.environment).toBe("live");
    await app.close();
  });
});
