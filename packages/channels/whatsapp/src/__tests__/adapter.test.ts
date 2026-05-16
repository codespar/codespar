import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChannelAdapter, ChannelCapabilities } from "@codespar/core";

// Mock fastify — prevent real server startup. We need access to the route
// callbacks for direct invocation in inbound webhook tests.
type RouteHandler = (req: { body: unknown; headers?: Record<string, string> }) =>
  | unknown
  | Promise<unknown>;
type PreHandler = (
  req: { headers: Record<string, string>; body?: unknown },
  reply: { code: (status: number) => { send: (body?: unknown) => void } }
) => unknown | Promise<unknown>;

interface FakeFastify {
  __routes: Map<string, RouteHandler>;
  __preHandlers: PreHandler[];
  post: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  addHook: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let lastFakeFastify: FakeFastify | null = null;

const qrGenerate = vi.fn();
vi.mock("qrcode-terminal", () => ({
  __esModule: true,
  default: { generate: (text: string, opts?: { small?: boolean }) => qrGenerate(text, opts) },
  generate: (text: string, opts?: { small?: boolean }) => qrGenerate(text, opts),
}));

vi.mock("fastify", () => {
  const factory = vi.fn(() => {
    const f: FakeFastify = {
      __routes: new Map(),
      __preHandlers: [],
      post: vi.fn((path: string, handler: RouteHandler) => {
        f.__routes.set(`POST ${path}`, handler);
      }),
      get: vi.fn((path: string, handler: RouteHandler) => {
        f.__routes.set(`GET ${path}`, handler);
      }),
      addHook: vi.fn((name: string, handler: PreHandler) => {
        if (name === "preHandler") f.__preHandlers.push(handler);
      }),
      listen: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    lastFakeFastify = f;
    return f;
  });
  return { __esModule: true, default: factory };
});

import { WhatsAppAdapter, renderQrAscii } from "../adapter.js";

// Snapshot env vars we mutate so other tests don't bleed.
const ENV_KEYS = [
  "WHATSAPP_WEBHOOK_URL",
  "WHATSAPP_WEBHOOK_HOST",
  "WHATSAPP_WEBHOOK_PORT",
  "WHATSAPP_WEBHOOK_STRICT_MODE",
  "EVOLUTION_WEBHOOK_SECRET",
  "EVOLUTION_API_URL",
  "EVOLUTION_API_KEY",
  "EVOLUTION_INSTANCE",
];
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
  lastFakeFastify = null;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
  vi.restoreAllMocks();
});

describe("WhatsAppAdapter", () => {
  it("creates an instance", () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  it("has type 'whatsapp'", () => {
    const adapter = new WhatsAppAdapter();
    expect(adapter.type).toBe("whatsapp");
  });

  it("implements ChannelAdapter interface methods", () => {
    const adapter: ChannelAdapter = new WhatsAppAdapter();
    expect(typeof adapter.connect).toBe("function");
    expect(typeof adapter.disconnect).toBe("function");
    expect(typeof adapter.onMessage).toBe("function");
    expect(typeof adapter.sendToChannel).toBe("function");
    expect(typeof adapter.sendDM).toBe("function");
    expect(typeof adapter.getCapabilities).toBe("function");
  });

  it("returns expected capabilities", () => {
    const adapter = new WhatsAppAdapter();
    const caps: ChannelCapabilities = adapter.getCapabilities();
    expect(caps).toEqual({
      threads: false,
      buttons: false,
      modals: false,
      messageEdit: false,
      ephemeral: false,
      reactions: true,
    });
  });

  it("registers a message handler via onMessage", () => {
    const adapter = new WhatsAppAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
  });
});

// ---------------------------------------------------------------------------
// M1.A — Pairing preservation (#365)
// ---------------------------------------------------------------------------

describe("WhatsAppAdapter.disconnect — pairing preservation (F10.M1.A)", () => {
  it("does NOT call /instance/logout/ on disconnect", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new WhatsAppAdapter();
    // Force a webhookServer reference so close() runs.
    await (
      adapter as unknown as { startWebhookServer: () => Promise<void> }
    ).startWebhookServer();
    await adapter.disconnect();

    for (const call of fetchSpy.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain("/instance/logout/");
    }
  });

  it("still closes the webhook server", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { startWebhookServer: () => Promise<void> }
    ).startWebhookServer();
    const fastify = lastFakeFastify;
    expect(fastify).not.toBeNull();
    await adapter.disconnect();
    expect(fastify!.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M1.B — Webhook URL configurable (#363)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M3 — Signature verification preHandler (#364)
// ---------------------------------------------------------------------------

interface MockReply {
  statusCode: number | null;
  body: unknown;
  status: (code: number) => MockReply;
  send: (body?: unknown) => MockReply;
}

function makeReply(): MockReply {
  const r: MockReply = {
    statusCode: null,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return r;
}

async function runPreHandler(
  fastify: FakeFastify,
  headers: Record<string, string>,
  url = "/webhook",
): Promise<MockReply> {
  const reply = makeReply();
  for (const handler of fastify.__preHandlers) {
    await handler(
      { headers, url, routerPath: url } as Parameters<PreHandler>[0],
      reply as unknown as Parameters<PreHandler>[1],
    );
  }
  return reply;
}

describe("WhatsAppAdapter webhook preHandler (F10.M3 #364)", () => {
  it.each([
    {
      name: "valid signature → no 401",
      env: { EVOLUTION_WEBHOOK_SECRET: "shared-secret" },
      headers: { apikey: "shared-secret" },
      expectStatus: null,
    },
    {
      name: "invalid signature → 401",
      env: { EVOLUTION_WEBHOOK_SECRET: "shared-secret" },
      headers: { apikey: "wrong" },
      expectStatus: 401,
    },
    {
      name: "missing signature with strict mode on → 401",
      env: { WHATSAPP_WEBHOOK_STRICT_MODE: "true" },
      headers: {},
      expectStatus: 401,
    },
    {
      name: "missing signature with strict mode off → no 401 + warn log",
      env: {},
      headers: {},
      expectStatus: null,
    },
  ])("$name", async ({ env, headers, expectStatus }) => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));

    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { startWebhookServer: () => Promise<void> }
    ).startWebhookServer();
    const fastify = lastFakeFastify!;
    expect(fastify.__preHandlers.length).toBeGreaterThan(0);

    const reply = await runPreHandler(fastify, headers);
    expect(reply.statusCode).toBe(expectStatus);

    if (env.WHATSAPP_WEBHOOK_STRICT_MODE !== "true" && !env.EVOLUTION_WEBHOOK_SECRET) {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("EVOLUTION_WEBHOOK_SECRET not set"),
      );
    }
  });

  it("health route is exempt from signature verification", async () => {
    process.env.WHATSAPP_WEBHOOK_STRICT_MODE = "true";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { startWebhookServer: () => Promise<void> }
    ).startWebhookServer();
    const fastify = lastFakeFastify!;
    const reply = await runPreHandler(fastify, {}, "/health");
    expect(reply.statusCode).toBeNull();
  });
});

describe("WhatsAppAdapter — webhook URL resolution (F10.M1.B)", () => {
  it.each([
    {
      name: "WHATSAPP_WEBHOOK_URL explicit override",
      env: { WHATSAPP_WEBHOOK_URL: "https://callback.example.com/hook" },
      expected: "https://callback.example.com/hook",
    },
    {
      name: "WHATSAPP_WEBHOOK_HOST overrides host segment",
      env: { WHATSAPP_WEBHOOK_HOST: "core", WHATSAPP_WEBHOOK_PORT: "3001" },
      expected: "http://core:3001/webhook",
    },
    {
      name: "default host.docker.internal when nothing set",
      env: { WHATSAPP_WEBHOOK_PORT: "3001" },
      expected: "http://host.docker.internal:3001/webhook",
    },
  ])("posts $name when registering webhook", async ({ env, expected }) => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchSpy);

    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { registerWebhook: () => Promise<void> }
    ).registerWebhook();

    const setCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/webhook/set/")
    );
    expect(setCall).toBeDefined();
    const body = JSON.parse(setCall![1].body as string) as { url: string };
    expect(body.url).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// M4 — Resilience (idempotency, attachments, QR ASCII) (#366)
// ---------------------------------------------------------------------------

type WebhookHandler = (req: { body: unknown; headers?: Record<string, string> }) =>
  | unknown
  | Promise<unknown>;

async function startAdapter(): Promise<{ adapter: WhatsAppAdapter; handler: WebhookHandler }> {
  const adapter = new WhatsAppAdapter();
  await (
    adapter as unknown as { startWebhookServer: () => Promise<void> }
  ).startWebhookServer();
  const fastify = lastFakeFastify!;
  const handler = fastify.__routes.get("POST /webhook") as WebhookHandler;
  return { adapter, handler };
}

function makeMessagesUpsert(id: string, body: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "messages.upsert",
    data: {
      key: { remoteJid: "55119@s.whatsapp.net", fromMe: false, id },
      message: { conversation: "olá" },
      pushName: "Tester",
      messageTimestamp: Math.floor(Date.now() / 1000),
      ...body,
    },
  };
}

describe("WhatsAppAdapter webhook idempotency (F10.M4 #366)", () => {
  it("invokes the message handler exactly once for duplicate (channelType, eventId)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { adapter, handler } = await startAdapter();
    const messageHandler = vi.fn();
    adapter.onMessage(messageHandler);

    await handler({ body: makeMessagesUpsert("dup-1"), headers: {} });
    await handler({ body: makeMessagesUpsert("dup-1"), headers: {} });
    await handler({ body: makeMessagesUpsert("dup-1"), headers: {} });

    expect(messageHandler).toHaveBeenCalledTimes(1);
  });

  it("processes distinct event ids", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const { adapter, handler } = await startAdapter();
    const messageHandler = vi.fn();
    adapter.onMessage(messageHandler);

    await handler({ body: makeMessagesUpsert("evt-A"), headers: {} });
    await handler({ body: makeMessagesUpsert("evt-B"), headers: {} });

    expect(messageHandler).toHaveBeenCalledTimes(2);
  });
});

describe("WhatsAppAdapter webhook attachments warn-log (F10.M4 #366)", () => {
  it("logs a WARN for image attachments and still forwards the normalized message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, handler } = await startAdapter();
    const messageHandler = vi.fn();
    adapter.onMessage(messageHandler);

    await handler({
      body: makeMessagesUpsert("msg-img", {
        message: {
          imageMessage: {
            url: "https://example.com/img.jpg",
            mimetype: "image/jpeg",
            caption: "look at this",
          },
        },
      }),
      headers: {},
    });

    const warnCall = warnSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("attachment received but not retrieved"),
    );
    expect(warnCall).toBeDefined();
    const payload = JSON.parse(warnCall![1] as string) as {
      messageId: string;
      type: string;
      mimeType: string;
    };
    expect(payload.messageId).toBe("msg-img");
    expect(payload.type).toBe("image");
    expect(payload.mimeType).toBe("image/jpeg");

    // Wait one tick for the void this.messageHandler() to resolve.
    await new Promise<void>((r) => setImmediate(r));
    expect(messageHandler).toHaveBeenCalledTimes(1);
    const normalized = messageHandler.mock.calls[0]![0] as {
      text: string;
      attachments?: unknown[];
    };
    expect(normalized.text).toBe("look at this");
    expect(normalized.attachments?.length).toBe(1);
  });

  it("logs a WARN for document attachments", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, handler } = await startAdapter();
    adapter.onMessage(vi.fn());

    await handler({
      body: makeMessagesUpsert("msg-doc", {
        message: {
          conversation: "see attached",
          documentMessage: {
            url: "https://example.com/file.pdf",
            mimetype: "application/pdf",
            fileName: "spec.pdf",
          },
        },
      }),
      headers: {},
    });

    const warnCall = warnSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("attachment received but not retrieved"),
    );
    expect(warnCall).toBeDefined();
    const payload = JSON.parse(warnCall![1] as string) as { type: string; mimeType: string };
    expect(payload.type).toBe("document");
    expect(payload.mimeType).toBe("application/pdf");
  });

  it("does NOT WARN for a caption-only text message with no attachments", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { adapter, handler } = await startAdapter();
    adapter.onMessage(vi.fn());

    await handler({
      body: makeMessagesUpsert("msg-text"),
      headers: {},
    });

    const warnCall = warnSpy.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0].includes("attachment received but not retrieved"),
    );
    expect(warnCall).toBeUndefined();
  });
});

describe("WhatsAppAdapter QR rendering — ASCII path (F10.M4 #366)", () => {
  beforeEach(() => {
    qrGenerate.mockReset();
  });

  it("calls qrcode-terminal with the raw code when the response is not a data URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        statusText: "OK",
        json: async () => ({ code: "2@QR_CODE_PAYLOAD" }),
      }),
    );
    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { printQRCode: () => Promise<void> }
    ).printQRCode();

    expect(qrGenerate).toHaveBeenCalledWith("2@QR_CODE_PAYLOAD", { small: true });
  });

  it("does NOT call qrcode-terminal when the response is a data URI", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        statusText: "OK",
        json: async () => ({ base64: "data:image/png;base64,iVBORw0KGgo=" }),
      }),
    );
    const adapter = new WhatsAppAdapter();
    await (
      adapter as unknown as { printQRCode: () => Promise<void> }
    ).printQRCode();

    expect(qrGenerate).not.toHaveBeenCalled();
  });

  it("renderQrAscii calls qrcode-terminal.generate with the input value", async () => {
    await renderQrAscii("RAW_QR_DATA");
    expect(qrGenerate).toHaveBeenCalledWith("RAW_QR_DATA", { small: true });
  });
});
