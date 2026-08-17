/**
 * Base-URL resolution for the MIT runtime.
 *
 * The runtime must not phone home: it must never embed a CodeSpar host as a
 * default webhook / OAuth-callback target (README.md: "no phone-home, fully
 * operable without codespar infrastructure"). Callers derive the base URL
 * from the incoming request host, or from an explicit WEBHOOK_BASE_URL the
 * operator sets — never from a hardcoded CodeSpar fallback. When neither is
 * available the caller must treat the result as "cannot auto-configure" and
 * fall back to manual setup, not to any CodeSpar URL.
 */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** WEBHOOK_BASE_URL if the operator set it, else null. No CodeSpar fallback. */
export function configuredBaseUrl(): string | null {
  const v = process.env.WEBHOOK_BASE_URL?.trim();
  return v ? stripTrailingSlash(v) : null;
}

/**
 * Derive the base URL from the incoming request, honouring reverse-proxy
 * headers (x-forwarded-proto / x-forwarded-host). Returns null when no host
 * header is present.
 */
export function baseUrlFromRequest(
  request: { headers?: Record<string, unknown> } | null | undefined,
): string | null {
  const headers = request?.headers ?? {};
  const host =
    (headers["x-forwarded-host"] as string | undefined) ||
    (headers["host"] as string | undefined);
  if (!host) return null;
  const proto =
    (headers["x-forwarded-proto"] as string | undefined) ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  return stripTrailingSlash(`${proto}://${host}`);
}

/**
 * Resolve a base URL: an explicit WEBHOOK_BASE_URL wins, else the request
 * host. Returns null when neither is available.
 */
export function resolveBaseUrl(
  request?: { headers?: Record<string, unknown> } | null,
): string | null {
  return configuredBaseUrl() ?? baseUrlFromRequest(request ?? undefined);
}
