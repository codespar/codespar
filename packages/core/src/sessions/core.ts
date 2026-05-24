/**
 * Session core — shared module behind both the HTTP `/sessions` route
 * handlers and the channel → session bridge (F10.M2).
 *
 * Two surfaces share this module:
 *
 *   1. HTTP `/sessions`             — `createSessionForHttp`, `getSessionById`,
 *                                      `sendInboundMessage`, `closeSessionById`
 *   2. Channel webhook bridges       — `findOrCreateSession`,
 *      (WhatsApp, etc.)               `sendInboundMessage`, `closeSessionById`
 *
 * The HTTP route stays auth/transport-only; tenancy resolution and
 * session persistence live here so the WhatsApp bridge calls the same
 * functions in-process (no loopback HTTP, no bearer bootstrap).
 *
 * Storage model:
 *
 *   * HTTP-created sessions live in an in-memory `Map` keyed by id so
 *     the @codespar/types contract test suite continues to pass without
 *     any database — same behaviour as before the F10 refactor.
 *   * Channel-created (bridged) sessions persist via `StorageProvider`
 *     (FileStorage on JSON, PgStorage on the `sessions` table).
 *   * `getSessionById` checks the in-memory store first, then storage.
 */

import { randomUUID } from "node:crypto";
import type { MockValue, Session, StorageProvider } from "../storage/types.js";
import type { McpServerSpec } from "../mcp/types.js";
import { runChatLoop } from "../chat-loop/index.js";

/** Channel type for sessions created via the HTTP `/sessions` route. */
export const HTTP_CHANNEL_TYPE = "http" as const;

/**
 * Runtime shape of an HTTP-route session. Adds the test-mode `mocks`
 * field to the persistent `Session`, since OSS holds mocks in process
 * memory only — the storage layer does not carry a `mocks` column. The
 * field is structurally optional so callers that don't care about test
 * mode continue to treat HTTP sessions as plain `Session` values.
 */
export type HttpSession = Session & {
  mocks?: Record<string, MockValue> | null;
};

/**
 * In-memory store for HTTP sessions. Scoped to process lifetime; CI
 * creates a fresh process per test run so cross-test contamination is
 * impossible. Channel-bridge sessions persist to storage instead.
 */
const httpSessions = new Map<string, HttpSession>();

/**
 * Per-HTTP-session per-tool consume counters. The persistent counter
 * mirror lives on the StorageProvider; HTTP-route sessions never reach
 * storage so we keep an in-process map indexed by `${sessionId}::${tool}`.
 * Lifetime is tied to the process the same way `httpSessions` is.
 */
const httpSessionToolCallCounts = new Map<string, number>();

function counterKey(sessionId: string, toolName: string): string {
  return `${sessionId}::${toolName}`;
}

/** Exported for test teardown — clears the in-memory session map AND
 *  the in-memory counter mirror. */
export function clearSessionStore(): void {
  httpSessions.clear();
  httpSessionToolCallCounts.clear();
}

/** Advance the in-memory consume counter for an HTTP session, capped
 *  at `cap`. Matches the shape the mocks engine expects via its
 *  `MockCounterStorage` slice. */
export function bumpHttpSessionToolCallCount(
  sessionId: string,
  toolName: string,
  cap: number,
): { n: number; bumped: boolean } {
  const key = counterKey(sessionId, toolName);
  const prior = httpSessionToolCallCounts.get(key) ?? 0;
  if (prior >= cap) return { n: prior, bumped: false };
  const next = prior + 1;
  httpSessionToolCallCounts.set(key, next);
  return { n: next, bumped: true };
}

/** Result of sending an inbound message into a session. Shape matches
 *  the SendResult contract the HTTP `/sessions/:id/send` route returns. */
export interface SendResult {
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_calls: any[];
  iterations: number;
}

export interface CreateHttpSessionInput {
  orgId: string;
  projectId: string;
  userId: string;
  servers: string[];
  /** Optional inline MCP server specs. When present, dispatch passes the
   *  spec to the bridge as `specOverride` and skips the registry — lets
   *  callers configure MCP servers per session without a shared
   *  `mcp-servers.json` file. Stored on `metadata.serverSpecs` for HTTP
   *  (in-memory) sessions; channel sessions never carry this field. */
  serverSpecs?: Record<string, McpServerSpec>;
  /** Optional canonical-keyed mock store. When present and non-empty,
   *  the session enters strict-mode — tool calls without a matching
   *  entry return `tool_not_mocked` instead of reaching the bridge. */
  mocks?: Record<string, MockValue>;
}

/** Create an HTTP-route session. The session is held in-memory only —
 *  this matches the behaviour the SessionBase contract test asserts. */
export function createSessionForHttp(input: CreateHttpSessionInput): HttpSession {
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const metadata: Record<string, unknown> = { servers: input.servers };
  if (input.serverSpecs !== undefined) metadata["serverSpecs"] = input.serverSpecs;
  const session: HttpSession = {
    id,
    orgId: input.orgId,
    projectId: input.projectId,
    channelType: HTTP_CHANNEL_TYPE,
    channelUserId: input.userId,
    status: "active",
    createdAt: nowIso,
    updatedAt: nowIso,
    metadata,
    ...(input.mocks !== undefined ? { mocks: input.mocks } : {}),
  };
  httpSessions.set(id, session);
  return session;
}

/** Internal accessor for the HTTP map — exported only for the legacy
 *  send route which mutates `servers` in metadata. Channel-bridge code
 *  should NOT use this; it goes through storage. */
export function getHttpSessionMap(): Map<string, HttpSession> {
  return httpSessions;
}

/**
 * Resolve a session by id. Checks the in-memory HTTP store first; falls
 * back to `storage.getSession` for channel-bridge sessions when storage
 * is available.
 */
export async function getSessionById(
  id: string,
  storage: StorageProvider | null,
): Promise<Session | null> {
  const inMemory = httpSessions.get(id);
  if (inMemory) return inMemory;
  if (!storage) return null;
  return storage.getSession(id);
}

export interface FindOrCreateSessionInput {
  orgId: string;
  projectId: string;
  channelType: string;
  channelUserId: string;
  /** Optional Evolution-API instance label (or analogous channel
   *  instance) — recorded for diagnostics, not part of the lookup key. */
  instanceId?: string;
}

/** Default idle TTL for durable sessions, in days (F10.M4 / #366). */
export const DEFAULT_SESSION_IDLE_TTL_DAYS = 30;

/** Read the configured TTL window (in days) from the env, with sane
 *  bounds. Returns Infinity when explicitly set to 0 or a negative
 *  value so tests can disable TTL by exporting WHATSAPP_SESSION_IDLE_TTL_DAYS=0. */
export function readIdleTtlDays(): number {
  const raw = process.env.WHATSAPP_SESSION_IDLE_TTL_DAYS;
  if (raw === undefined || raw === "") return DEFAULT_SESSION_IDLE_TTL_DAYS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SESSION_IDLE_TTL_DAYS;
  if (parsed <= 0) return Number.POSITIVE_INFINITY;
  return parsed;
}

/** ISO timestamp that marks the boundary between "fresh" and "stale"
 *  sessions for the given TTL window. Anything with `updatedAt`
 *  strictly less than this cutoff is closable. */
export function ttlCutoffIso(ttlDays: number, now: number = Date.now()): string {
  if (!Number.isFinite(ttlDays)) return new Date(0).toISOString();
  return new Date(now - ttlDays * 86_400_000).toISOString();
}

export interface FindOrCreateOptions {
  /** Override the TTL window (days). Used by tests; production reads
   *  WHATSAPP_SESSION_IDLE_TTL_DAYS via [[readIdleTtlDays]]. */
  ttlDays?: number;
  /** Override `Date.now()`-derived clock for deterministic tests. */
  now?: number;
}

/**
 * Find the active session for the (project, channelType, channelUserId)
 * tuple, or create a new one. Channel-bridge sessions persist via the
 * storage provider so they survive process restarts.
 *
 * Lazy TTL (F10.M4): when the existing session's `updatedAt` is older
 * than the configured idle window the row is closed and a fresh session
 * is created in its place. When the session is fresh, `updatedAt` is
 * bumped so continued activity extends the idle window.
 */
export async function findOrCreateSession(
  input: FindOrCreateSessionInput,
  storage: StorageProvider,
  options?: FindOrCreateOptions,
): Promise<Session> {
  const ttlDays = options?.ttlDays ?? readIdleTtlDays();
  const cutoff = ttlCutoffIso(ttlDays, options?.now);
  const existing = await storage.findSessionByChannelUser(
    input.projectId,
    input.channelType,
    input.channelUserId,
  );
  if (existing) {
    if (existing.updatedAt < cutoff) {
      await storage.closeSession(existing.id);
      // Fall through to create a fresh session.
    } else {
      // Touch updatedAt so continued activity extends the idle window.
      return storage.setSession({
        id: existing.id,
        orgId: existing.orgId,
        projectId: existing.projectId,
        channelType: existing.channelType,
        channelUserId: existing.channelUserId,
        ...(existing.instanceId !== undefined
          ? { instanceId: existing.instanceId }
          : input.instanceId !== undefined
            ? { instanceId: input.instanceId }
            : {}),
        status: existing.status,
        metadata: existing.metadata,
        createdAt: existing.createdAt,
      });
    }
  }

  return storage.setSession({
    orgId: input.orgId,
    projectId: input.projectId,
    channelType: input.channelType,
    channelUserId: input.channelUserId,
    ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
    status: "active",
    metadata: {},
  });
}

/**
 * Sweep stale sessions out of storage. Intended for an optional cron
 * sweeper; the OSS bridge runs lazy-close on lookup instead. Returns
 * the count of rows transitioned.
 */
export async function closeStaleSessions(
  storage: StorageProvider,
  olderThanIso: string,
): Promise<number> {
  return storage.closeStaleSessions(olderThanIso);
}

/**
 * Mark a session closed. Updates the in-memory HTTP store if the id
 * lives there, otherwise propagates to storage. Returns true when a
 * row transitioned.
 */
export async function closeSessionById(
  id: string,
  storage: StorageProvider | null,
): Promise<boolean> {
  const inMemory = httpSessions.get(id);
  if (inMemory) {
    if (inMemory.status === "closed") return false;
    inMemory.status = "closed";
    inMemory.updatedAt = new Date().toISOString();
    return true;
  }
  if (!storage) return false;
  return storage.closeSession(id);
}

/**
 * Send an inbound message into a session and return the AI response.
 * Delegates to the chat loop so both call sites — the HTTP route
 * (`POST /sessions/:id/send`) and channel webhook bridges (WhatsApp
 * inbound, etc.) — converge on the same agent reasoning path. Without
 * this, the HTTP route would use the real chat loop while inbound
 * channel traffic would silently hit a different code path.
 *
 * The `storage` argument is forwarded to the chat loop's tool-dispatch
 * path for non-mock concerns (e.g. session row reads on channel
 * bridges). Test-mode mocks themselves live in process memory on the
 * HTTP session — no storage is consulted for them.
 */
export async function sendInboundMessage(
  session: Session,
  message: string,
  storage?: StorageProvider | null,
): Promise<SendResult> {
  const trimmed = message.trim() || "hello";
  return runChatLoop(trimmed, session, { storage: storage ?? null });
}
