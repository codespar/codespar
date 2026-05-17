/**
 * Unit tests for sessions/core.ts (F10.M2).
 *
 * Drives the channel → session bridge invariants:
 *   - findOrCreateSession returns existing active session when present.
 *   - Otherwise persists a new one with non-null projectId.
 *   - Per-user keying: two participants in the same group produce two
 *     distinct sessions (W2 / W5 contract).
 *
 * Storage is mocked end-to-end so the test doesn't depend on Postgres /
 * filesystem; the integration test exercises the real round-trip.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the chat-loop before importing core.js so sendInboundMessage's
// delegation can be observed without a real Anthropic call.
vi.mock("../../chat-loop/index.js", () => ({
  runChatLoop: vi.fn(async (message: string) => ({
    message: `echo:${message}`,
    tool_calls: [],
    iterations: 1,
  })),
}));

import {
  clearSessionStore,
  closeSessionById,
  closeStaleSessions,
  createSessionForHttp,
  findOrCreateSession,
  getSessionById,
  readIdleTtlDays,
  sendInboundMessage,
  ttlCutoffIso,
  DEFAULT_SESSION_IDLE_TTL_DAYS,
} from "../core.js";
import { runChatLoop } from "../../chat-loop/index.js";
import type { Session, StorageProvider } from "../../storage/types.js";

// Minimal StorageProvider mock — only the methods sessions/core uses.
function mockStorage(): {
  storage: StorageProvider;
  sessions: Map<string, Session>;
  spies: {
    getSession: ReturnType<typeof vi.fn>;
    findSessionByChannelUser: ReturnType<typeof vi.fn>;
    setSession: ReturnType<typeof vi.fn>;
    closeSession: ReturnType<typeof vi.fn>;
    closeStaleSessions: ReturnType<typeof vi.fn>;
  };
} {
  const sessions = new Map<string, Session>();
  let n = 0;
  const setSession = vi.fn(async (input: Parameters<StorageProvider["setSession"]>[0]) => {
    const id = input.id ?? `sess-${++n}`;
    const now = new Date().toISOString();
    const prior = sessions.get(id);
    const full: Session = {
      id,
      orgId: input.orgId,
      projectId: input.projectId,
      channelType: input.channelType,
      channelUserId: input.channelUserId,
      ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
      status: input.status,
      createdAt: prior?.createdAt ?? input.createdAt ?? now,
      updatedAt: now,
      metadata: input.metadata ?? {},
    };
    sessions.set(id, full);
    return full;
  });
  const findSessionByChannelUser = vi.fn(
    async (projectId: string, channelType: string, channelUserId: string) => {
      for (const s of sessions.values()) {
        if (
          s.projectId === projectId &&
          s.channelType === channelType &&
          s.channelUserId === channelUserId &&
          s.status === "active"
        )
          return s;
      }
      return null;
    },
  );
  const getSession = vi.fn(async (id: string) => sessions.get(id) ?? null);
  const closeSession = vi.fn(async (id: string) => {
    const s = sessions.get(id);
    if (!s || s.status === "closed") return false;
    s.status = "closed";
    return true;
  });
  const closeStaleSessionsMock = vi.fn(async (olderThanIso: string) => {
    let closed = 0;
    for (const s of sessions.values()) {
      if (s.status === "active" && s.updatedAt < olderThanIso) {
        s.status = "closed";
        closed++;
      }
    }
    return closed;
  });

  const storage = {
    getSession,
    findSessionByChannelUser,
    setSession,
    closeSession,
    closeStaleSessions: closeStaleSessionsMock,
  } as unknown as StorageProvider;

  return {
    storage,
    sessions,
    spies: {
      getSession,
      findSessionByChannelUser,
      setSession,
      closeSession,
      closeStaleSessions: closeStaleSessionsMock,
    },
  };
}

beforeEach(() => {
  clearSessionStore();
});

describe("sessions/core — findOrCreateSession", () => {
  it("returns the existing active session when one matches", async () => {
    const { storage, sessions } = mockStorage();
    const seed: Session = {
      id: "sess-seed",
      orgId: "org-1",
      projectId: "prj_1234",
      channelType: "whatsapp",
      channelUserId: "55119...",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    sessions.set(seed.id, seed);

    const result = await findOrCreateSession(
      {
        orgId: seed.orgId,
        projectId: seed.projectId,
        channelType: seed.channelType,
        channelUserId: seed.channelUserId,
      },
      storage,
    );
    expect(result.id).toBe("sess-seed");
  });

  it("persists a new session with non-null projectId when none exists", async () => {
    const { storage, spies } = mockStorage();
    const created = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_default",
        channelType: "whatsapp",
        channelUserId: "55119...",
      },
      storage,
    );
    expect(spies.setSession).toHaveBeenCalledTimes(1);
    expect(created.projectId).toBe("prj_default");
    expect(created.status).toBe("active");
    expect(created.channelType).toBe("whatsapp");
  });

  it("keys per channelUserId — two participants in the same group get two sessions", async () => {
    const { storage } = mockStorage();
    const a = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_1",
        channelType: "whatsapp",
        channelUserId: "user-A",
      },
      storage,
    );
    const b = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_1",
        channelType: "whatsapp",
        channelUserId: "user-B",
      },
      storage,
    );
    expect(a.id).not.toBe(b.id);
    expect(a.channelUserId).toBe("user-A");
    expect(b.channelUserId).toBe("user-B");
  });

  it("records the optional instanceId on creation", async () => {
    const { storage } = mockStorage();
    const created = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_1",
        channelType: "whatsapp",
        channelUserId: "user-A",
        instanceId: "codespar-bz",
      },
      storage,
    );
    expect(created.instanceId).toBe("codespar-bz");
  });
});

describe("sessions/core — HTTP-route surface", () => {
  it("createSessionForHttp stores in-memory and returns id + status", () => {
    const session = createSessionForHttp({
      orgId: "default",
      projectId: "default",
      userId: "alice",
      servers: ["github", "linear"],
    });
    expect(session.status).toBe("active");
    expect(session.channelType).toBe("http");
    expect(session.channelUserId).toBe("alice");
    expect(session.metadata.servers).toEqual(["github", "linear"]);
  });

  it("getSessionById finds in-memory entries before storage", async () => {
    const { storage } = mockStorage();
    const session = createSessionForHttp({
      orgId: "default",
      projectId: "default",
      userId: "alice",
      servers: [],
    });
    const found = await getSessionById(session.id, storage);
    expect(found?.id).toBe(session.id);
  });

  it("closeSessionById transitions an in-memory session to closed", async () => {
    const session = createSessionForHttp({
      orgId: "default",
      projectId: "default",
      userId: "alice",
      servers: [],
    });
    const closed = await closeSessionById(session.id, null);
    expect(closed).toBe(true);
    // Idempotent: second close returns false.
    expect(await closeSessionById(session.id, null)).toBe(false);
  });

  it("closeSessionById falls through to storage for non-HTTP sessions", async () => {
    const { storage, sessions } = mockStorage();
    const persisted: Session = {
      id: "sess-pg",
      orgId: "org-1",
      projectId: "prj_1",
      channelType: "whatsapp",
      channelUserId: "user-A",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    sessions.set(persisted.id, persisted);
    expect(await closeSessionById(persisted.id, storage)).toBe(true);
    expect(sessions.get("sess-pg")?.status).toBe("closed");
  });
});

describe("sessions/core — sendInboundMessage", () => {
  it("delegates to runChatLoop so HTTP and channel-bridge call sites share the same agent path", async () => {
    const session: Session = {
      id: "sess-msg",
      orgId: "org-1",
      projectId: "prj_1",
      channelType: "whatsapp",
      channelUserId: "user-A",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const result = await sendInboundMessage(session, "olá");
    expect(runChatLoop).toHaveBeenCalledWith("olá", session);
    expect(result.message).toBe("echo:olá");
  });

  it("falls back to 'hello' when the inbound message is empty so the chat loop never sees an empty user turn", async () => {
    const session: Session = {
      id: "sess-msg-empty",
      orgId: "org-1",
      projectId: "prj_1",
      channelType: "whatsapp",
      channelUserId: "user-B",
      status: "active",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {},
    };
    const result = await sendInboundMessage(session, "   ");
    expect(runChatLoop).toHaveBeenCalledWith("hello", session);
    expect(result.message).toBe("echo:hello");
  });
});

describe("sessions/core — TTL helpers (F10.M4 / #366)", () => {
  it("readIdleTtlDays defaults to 30 when env unset", () => {
    const prior = process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
    delete process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
    try {
      expect(readIdleTtlDays()).toBe(DEFAULT_SESSION_IDLE_TTL_DAYS);
    } finally {
      if (prior !== undefined) process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS = prior;
    }
  });

  it("readIdleTtlDays honours integer overrides", () => {
    const prior = process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
    process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS = "7";
    try {
      expect(readIdleTtlDays()).toBe(7);
    } finally {
      if (prior === undefined) delete process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
      else process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS = prior;
    }
  });

  it("readIdleTtlDays treats 0 / negative as 'disabled' (Infinity)", () => {
    const prior = process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
    process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS = "0";
    try {
      expect(readIdleTtlDays()).toBe(Number.POSITIVE_INFINITY);
    } finally {
      if (prior === undefined) delete process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
      else process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS = prior;
    }
  });

  it("ttlCutoffIso returns the start of epoch when ttl is Infinity (nothing is stale)", () => {
    expect(ttlCutoffIso(Number.POSITIVE_INFINITY)).toBe(new Date(0).toISOString());
  });

  it("ttlCutoffIso subtracts the TTL window from the supplied clock", () => {
    const now = Date.parse("2026-05-16T00:00:00.000Z");
    const cutoff = ttlCutoffIso(30, now);
    expect(cutoff).toBe(new Date(now - 30 * 86_400_000).toISOString());
  });
});

describe("sessions/core — findOrCreateSession TTL semantics (F10.M4 / #366)", () => {
  it("lazy-closes a stale session and reifies a new one with a fresh id", async () => {
    const { storage, sessions, spies } = mockStorage();
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const stale: Session = {
      id: "sess-stale",
      orgId: "org-1",
      projectId: "prj_1",
      channelType: "whatsapp",
      channelUserId: "user-A",
      status: "active",
      createdAt: old,
      updatedAt: old,
      metadata: {},
    };
    sessions.set(stale.id, stale);

    const fresh = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_1",
        channelType: "whatsapp",
        channelUserId: "user-A",
      },
      storage,
      { ttlDays: 30 },
    );

    expect(fresh.id).not.toBe(stale.id);
    expect(spies.closeSession).toHaveBeenCalledWith("sess-stale");
    expect(sessions.get("sess-stale")?.status).toBe("closed");
    expect(fresh.status).toBe("active");
  });

  it("keeps a fresh session and touches updatedAt to extend the idle window", async () => {
    const { storage, sessions } = mockStorage();
    const recent = new Date(Date.now() - 60_000).toISOString();
    const seed: Session = {
      id: "sess-warm",
      orgId: "org-1",
      projectId: "prj_1",
      channelType: "whatsapp",
      channelUserId: "user-A",
      status: "active",
      createdAt: recent,
      updatedAt: recent,
      metadata: {},
    };
    sessions.set(seed.id, seed);

    const result = await findOrCreateSession(
      {
        orgId: "org-1",
        projectId: "prj_1",
        channelType: "whatsapp",
        channelUserId: "user-A",
      },
      storage,
      { ttlDays: 30 },
    );

    expect(result.id).toBe("sess-warm");
    // updatedAt was bumped past the seed value.
    expect(new Date(result.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(recent).getTime(),
    );
  });
});

describe("sessions/core — closeStaleSessions sweeper", () => {
  it("delegates to storage and returns the row count", async () => {
    const { storage, sessions, spies } = mockStorage();
    const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
    const recent = new Date().toISOString();
    sessions.set("a", {
      id: "a",
      orgId: "o",
      projectId: "p",
      channelType: "whatsapp",
      channelUserId: "u1",
      status: "active",
      createdAt: old,
      updatedAt: old,
      metadata: {},
    });
    sessions.set("b", {
      id: "b",
      orgId: "o",
      projectId: "p",
      channelType: "whatsapp",
      channelUserId: "u2",
      status: "active",
      createdAt: recent,
      updatedAt: recent,
      metadata: {},
    });

    const cutoff = ttlCutoffIso(30);
    const closed = await closeStaleSessions(storage, cutoff);
    expect(closed).toBe(1);
    expect(spies.closeStaleSessions).toHaveBeenCalledWith(cutoff);
    expect(sessions.get("a")?.status).toBe("closed");
    expect(sessions.get("b")?.status).toBe("active");
  });
});
