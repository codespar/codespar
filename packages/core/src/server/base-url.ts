/**
 * Base-URL resolution for the MIT runtime.
 *
 * Two independent rules live here, and they are not the same rule:
 *
 * 1. No phone-home. The runtime must never embed a CodeSpar host as a default
 *    webhook / OAuth / agent-card target (README.md: "no phone-home, fully
 *    operable without codespar infrastructure"). There is deliberately no
 *    fallback constant in this file.
 *
 * 2. Request headers are attacker-controlled. `host` and `x-forwarded-host`
 *    are set by whoever opened the socket, and /api/* is unauthenticated when
 *    ENGINE_API_TOKEN is unset (see webhook-server.ts registerApiAuth, which
 *    only logs a warning). So a value derived from a request may be used to
 *    DISPLAY a URL back to that same caller, and must never be used to WRITE a
 *    target into a third-party system: a GitHub webhook created in the
 *    operator's repo with the operator's GITHUB_TOKEN, or an OAuth
 *    redirect_uri that will receive an authorization code.
 *
 * Hence the split:
 *   displayBaseUrl(request) -> WEBHOOK_BASE_URL, else the request host.
 *                              Display only (GET /api/webhooks/url, agent cards).
 *   writableBaseUrl()       -> WEBHOOK_BASE_URL only. `null` means "refuse and
 *                              tell the operator", never "guess a host".
 *
 * x-forwarded-proto / x-forwarded-host are honoured only when the operator
 * opts in via TRUST_PROXY. The same env value is fed to Fastify's own
 * `trustProxy` option (webhook-server.ts), so request.protocol / request.ip
 * and this module always agree about whether the proxy chain is trusted.
 *
 * Scheme is never guessed from the hostname. The runtime itself serves plain
 * HTTP (Dockerfile / docker-compose publish 3000:3000), so the default is
 * http; https only comes from a real TLS socket (request.protocol) or from a
 * trusted x-forwarded-proto.
 */

import { createLogger } from "../observability/logger.js";

const log = createLogger("server/base-url");

/** Authority part of a URL: host[:port], or [ipv6][:port]. */
const HOST_RE = /^[A-Za-z0-9._-]+(?::\d{1,5})?$/;
const IPV6_HOST_RE = /^\[[0-9A-Fa-f:.]+\](?::\d{1,5})?$/;

/** Minimal request shape this module needs. Fastify's request satisfies it. */
export interface BaseUrlRequest {
  headers?: Record<string, unknown>;
  /** Fastify-derived scheme ("http" | "https"). Absent outside Fastify. */
  protocol?: unknown;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** True when `value` parses as an absolute http(s) URL with a host. */
export function isHttpUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && !!parsed.hostname;
}

/**
 * TRUST_PROXY as Fastify's `trustProxy` option.
 *
 * Unset / "false" / "0" / "off" / "no"  -> false (default: trust nothing).
 * "true" / "1" / "on" / "yes"           -> true.
 * A bare integer                        -> hop count.
 * Anything else                         -> passed through as the IP/CIDR list.
 */
export function fastifyTrustProxy(env: NodeJS.ProcessEnv = process.env): boolean | number | string {
  const raw = env.TRUST_PROXY?.trim();
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (lower === "false" || lower === "0" || lower === "off" || lower === "no") return false;
  if (lower === "true" || lower === "1" || lower === "on" || lower === "yes") return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Whether x-forwarded-* may be honoured at all. */
export function trustProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return fastifyTrustProxy(env) !== false;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && typeof raw[0] === "string") return raw[0];
  return undefined;
}

/** First hop of a comma-separated forwarded header, trimmed. */
function firstHop(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const first = value.split(",")[0]?.trim();
  return first || undefined;
}

function normalizeScheme(value: string | undefined): "http" | "https" | undefined {
  const v = value?.trim().toLowerCase();
  return v === "http" || v === "https" ? v : undefined;
}

/**
 * WEBHOOK_BASE_URL if the operator set it and it parses as http(s).
 * No CodeSpar fallback, no request-derived value.
 */
export function configuredBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.WEBHOOK_BASE_URL?.trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) {
    log.warn("WEBHOOK_BASE_URL is not a valid http(s) URL — ignoring it");
    return null;
  }
  return stripTrailingSlash(raw);
}

/**
 * DASHBOARD_URL if the operator set it and it parses as http(s).
 * Unset means "this install has no external dashboard": the runtime then
 * renders its own OAuth result page instead of redirecting anywhere.
 */
export function configuredDashboardUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.DASHBOARD_URL?.trim();
  if (!raw) return null;
  if (!isHttpUrl(raw)) {
    log.warn("DASHBOARD_URL is not a valid http(s) URL — ignoring it");
    return null;
  }
  return stripTrailingSlash(raw);
}

/**
 * Derive the base URL from the incoming request.
 *
 * ATTACKER-CONTROLLED. Display only — never pass this to createWebhook or to
 * an OAuth redirect_uri. x-forwarded-host / x-forwarded-proto are read only
 * when TRUST_PROXY is set; otherwise the `host` header is used as-is and the
 * scheme comes from the socket (request.protocol), defaulting to http.
 */
export function baseUrlFromRequest(request?: BaseUrlRequest | null): string | null {
  const headers = (request?.headers ?? {}) as Record<string, unknown>;
  const trusted = trustProxyEnabled();

  const forwardedHost = trusted ? firstHop(headerValue(headers, "x-forwarded-host")) : undefined;
  const host = forwardedHost || headerValue(headers, "host")?.trim();
  if (!host) return null;
  if (!HOST_RE.test(host) && !IPV6_HOST_RE.test(host)) {
    log.warn("Ignoring malformed host header when deriving the base URL");
    return null;
  }

  const forwardedProto = trusted
    ? normalizeScheme(firstHop(headerValue(headers, "x-forwarded-proto")))
    : undefined;
  const socketProto = normalizeScheme(
    typeof request?.protocol === "string" ? request.protocol : undefined,
  );
  const scheme = forwardedProto ?? socketProto ?? "http";

  const url = `${scheme}://${host}`;
  return isHttpUrl(url) ? stripTrailingSlash(url) : null;
}

/**
 * Base URL for DISPLAY: explicit WEBHOOK_BASE_URL wins, else the request host.
 * Returns null when neither is available.
 */
export function displayBaseUrl(request?: BaseUrlRequest | null): string | null {
  return configuredBaseUrl() ?? baseUrlFromRequest(request);
}

/**
 * Base URL for WRITES (a webhook created in someone else's repo, an OAuth
 * redirect_uri). Only the explicitly configured value qualifies, because a
 * request-derived host is forgeable by any unauthenticated caller.
 * Returns null when WEBHOOK_BASE_URL is unset or invalid.
 */
export function writableBaseUrl(): string | null {
  return configuredBaseUrl();
}

/** Machine-readable code returned when a write path has no configured base URL. */
export const BASE_URL_NOT_CONFIGURED = "base_url_not_configured";

/** Operator-facing instruction for the same condition. */
export const BASE_URL_NOT_CONFIGURED_MESSAGE =
  "WEBHOOK_BASE_URL is not configured. Set it to this runtime's public URL " +
  "(for example https://agents.example.com, or http://localhost:3000 for a " +
  "local test) and retry. The runtime refuses to derive a webhook or OAuth " +
  "target from request headers, which any caller can forge.";
